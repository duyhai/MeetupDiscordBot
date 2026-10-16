import { Client } from 'discord.js';
import { ClientError } from 'graphql-request';
import { Logger } from 'tslog';

import Configuration from '../../configuration.js';
import { BASE_DISCORD_BOT_URL } from '../../constants.js';
import {
  ApplicationCredentialRepository,
  MEETUP_ORGANIZER_CREDENTIAL_KEY,
} from '../../util/credentialRepository.js';
import { Tokens } from '../client/discord/types.js';
import { GqlMeetupClient } from '../client/meetup/gqlClient.js';
import {
  MeetupTokenRefreshError,
  refreshMeetupToken,
} from '../client/oauth/providers.js';
import {
  LockedCredential,
  PostgresCredentialRepository,
} from '../repositories/postgresCredentialRepository.js';
import { logAlert } from './discordLogger.js';

const logger = new Logger({ name: 'organizerMeetupClient' });

/**
 * A stored access token with more than this left is handed out as is. Every
 * process reads it under the credential lock, so one that another process
 * just refreshed is reused rather than refreshed again (which, if Meetup
 * rotates refresh tokens -- not documented; assume it does -- would race that
 * process for the successor).
 */
export const ORGANIZER_TOKEN_REUSE_MS = 5 * 60 * 1000;

const MEMBER_ID_PATTERN = /^[0-9]{1,20}$/;

/**
 * Bound on the organizer account lookup after a refresh. It runs inside the
 * credential lock, whose idle-in-transaction timeout is 45 s: a stored
 * refresh (10 s) plus a seed refresh (10 s) plus this check stay under it.
 */
export const ORGANIZER_ACCOUNT_CHECK_TIMEOUT_MS = 10_000;

// Per-process memo of the reuse-path account check: a stored token's own
// member id is looked up once per distinct access token, and the verdict
// (wrong account or not) is kept for it.
let checkedAccessToken: string | undefined;
let checkedWrongAccount = false;
// Bumped by noteOrganizerCredentialRenewed: a resolution that began before a
// renewal checked the old credential, so what it learns about the account
// must not land on the new one.
let credentialGeneration = 0;

/** Posted to the alerts channel when a failure episode ends. */
export const ORGANIZER_RESTORED_ALERT = {
  title: 'Meetup organizer login restored',
  description:
    'The shared Meetup organizer credential works again; Meetup identity monitoring resumes with the next sweep.',
};

/** Fixed text: never carries an error, so no Meetup body can reach Discord. */
export function organizerFailureRemedy(): string {
  return (
    'Could not obtain a Meetup organizer token, so Meetup identity monitoring is paused. ' +
    `To fix: a Moderator or 1.5 Leadership Team member opens ${BASE_DISCORD_BOT_URL}/dashboard/organizer-login ` +
    'in a private window, signs in with Discord, then signs in to Meetup as the shared organizer account. ' +
    '(Fallback: /meetup_get_token sweep_credential:True and set MEETUP_ORGANIZER_REFRESH_TOKEN in Heroku.) ' +
    'Do not use a personal Meetup account.'
  );
}

/** A graphql-request error for an HTTP 401: the access token was refused. */
export function isMeetupUnauthorized(error: unknown): boolean {
  return error instanceof ClientError && error.response?.status === 401;
}

/**
 * Why no token was handed out. `unusable`: no refresh worked.
 * `wrong-account`: a refresh worked but for another Meetup account.
 * `unverified`: a refresh worked, but its account could not be confirmed
 * where it had to be. `wrong-account-stored`: the stored, unexpired token
 * belongs to another account.
 */
type OrganizerFailure =
  'unusable' | 'wrong-account' | 'unverified' | 'wrong-account-stored';

const renewAsOrganizer = (): string =>
  `from ${BASE_DISCORD_BOT_URL}/dashboard/organizer-login while signed in to Meetup as the shared organizer account.`;

/**
 * The episode alert for each failure. Fixed text: never an error, a Meetup
 * body or a member id.
 */
export function organizerFailureAlert(failure: OrganizerFailure): {
  title: string;
  description: string;
} {
  const title = 'Meetup identity monitoring is not running';
  switch (failure) {
    case 'wrong-account':
      return {
        title,
        description:
          'The shared Meetup organizer credential now belongs to a different Meetup account than the one on record, ' +
          `so it was not saved or used. Renew it ${renewAsOrganizer()}`,
      };
    case 'wrong-account-stored':
      return {
        title,
        description:
          'The stored Meetup organizer credential belongs to a different Meetup account than the one on record, ' +
          `so it is not used. Renew it ${renewAsOrganizer()}`,
      };
    case 'unverified':
      return {
        title,
        description:
          'Could not confirm which Meetup account the refreshed Meetup organizer credential belongs to, ' +
          'so it was not saved or used, and Meetup identity monitoring was skipped this time. ' +
          `It retries on the next run; if this keeps happening, renew it ${renewAsOrganizer()}`,
      };
    default:
      return { title, description: organizerFailureRemedy() };
  }
}

/** What the locked transaction decided; acted on only after it commits. */
interface LockedOutcome {
  accessToken: string | undefined;
  /** Set when accessToken is undefined. */
  failure?: OrganizerFailure;
  /**
   * The token came from a refresh in this transaction, so its account was
   * already handled under the lock; otherwise it is the stored one, reused.
   */
  refreshed: boolean;
  /** A refreshed token's account was confirmed (or recorded) under the lock. */
  accountConfirmed: boolean;
  /** The refreshed pair could not be written: retry the save once. */
  writeFailed?: boolean;
  /** clearFailing closed an open episode: post the recovery message. */
  recovered: boolean;
  /** markFailing opened a new episode: post the alert. */
  episodeStarted: boolean;
  /** The organizer member id on record when the lock was taken. */
  storedMemberId: string | null;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error';
}

/**
 * Meetup definitely refused the refresh token itself: `invalid_grant`, or a
 * bare 401 with no OAuth code. Nothing else says the grant is dead -- not a
 * timeout, a network error, a 5xx or 429, nor `invalid_client` (OUR client
 * credentials are wrong) -- so nothing else may fall through to the seed.
 */
export function isDefiniteRefreshRejection(error: unknown): boolean {
  return (
    error instanceof MeetupTokenRefreshError &&
    (error.oauthError === 'invalid_grant' ||
      (error.status === 401 && error.oauthError === undefined))
  );
}

/**
 * What may be logged about a failed refresh: its message embeds Meetup's raw
 * response body, so only the HTTP status, OAuth code or error name is kept.
 */
function describeRefreshFailure(error: unknown): string {
  if (error instanceof MeetupTokenRefreshError) {
    return error.oauthError
      ? `HTTP ${error.status} ${error.oauthError}`
      : `HTTP ${error.status}`;
  }
  return errorName(error);
}

/** One refresh attempt; a failure is logged by status or name only. */
async function tryRefresh(
  refreshToken: string,
  which: string,
): Promise<{ tokens: Tokens } | { error: unknown }> {
  try {
    return { tokens: await refreshMeetupToken(refreshToken) };
  } catch (error: unknown) {
    logger.warn(
      `Meetup credential refresh from the ${which} failed: ${describeRefreshFailure(error)}`,
    );
    return { error };
  }
}

/**
 * Records the episode outcome on the transaction's own client, inside a
 * savepoint: a failed statement then undoes only itself, and cannot abort
 * the transaction (and with it the credential write). A failure is logged
 * and reported as "no change": bookkeeping must never cost the caller its
 * token.
 */
async function recordEpisode(
  locked: LockedCredential,
  record: () => Promise<boolean>,
  what: 'open' | 'close',
): Promise<boolean> {
  const result = await locked.savepoint(`${what}_episode`, record);
  if (result.ok) {
    return result.value === true;
  }
  logger.error(
    `Could not ${what} the organizer credential failure episode: ${errorName(result.error)}`,
  );
  return false;
}

/** A refreshed pair, and the stored pair as read when the lock was taken. */
interface RefreshedPair {
  tokens: Tokens;
  previousRefreshToken: string | undefined;
  previousAccessToken: string | undefined;
}

/**
 * The token holder's member id, or undefined when the lookup failed or gave
 * no all-digit id. Logged by error name only; no id is ever logged.
 */
async function lookUpMemberId(
  accessToken: string,
  timeoutMs?: number,
): Promise<string | undefined> {
  try {
    const memberId = await new GqlMeetupClient(
      accessToken,
      timeoutMs === undefined ? undefined : { timeoutMs },
    ).getSelfId();
    if (MEMBER_ID_PATTERN.test(memberId)) {
      return memberId;
    }
    logger.warn('Meetup returned no usable member id for the organizer');
  } catch (error: unknown) {
    logger.warn(
      `Could not check the organizer's Meetup member id: ${errorName(error)}`,
    );
  }
  return undefined;
}

/**
 * Runs inside the credential lock. Never throws for a Meetup failure:
 * returning is what commits, and the failure path must commit so its
 * markFailing persists. A write failure is caught here too, but Postgres has
 * then aborted the transaction, so it surfaces as a commit failure
 * (withLockedCredential rejects). `onRefreshed` hands a verified pair out
 * before the write, so the caller still uses it and retries the save once.
 */
async function resolveLocked(
  locked: LockedCredential,
  forceRefresh: boolean,
  refusedAccessToken: string | undefined,
  onRefreshed: (pair: RefreshedPair) => void,
  recordEpisodes: boolean,
): Promise<LockedOutcome> {
  const storedMemberId = locked.meta.memberId;
  const { current } = locked;
  // A forced call reuses the stored token only when it is not the one its
  // caller saw refused: another process has already rotated it.
  const reusable =
    !forceRefresh ||
    (refusedAccessToken !== undefined &&
      current?.accessToken !== refusedAccessToken);
  if (
    reusable &&
    current &&
    current.expiresAt - Date.now() > ORGANIZER_TOKEN_REUSE_MS
  ) {
    // The episode stays as it is: only a successful refresh proves the grant
    // works, and an unexpired token may be the one Meetup just refused.
    return {
      accessToken: current.accessToken,
      refreshed: false,
      accountConfirmed: false,
      recovered: false,
      episodeStarted: false,
      storedMemberId,
    };
  }

  // Stored pair first; the Heroku config var is the seed and the recovery
  // path, tried ONLY when nothing is stored or Meetup definitely rejected the
  // stored token. After a timeout, outage or invalid_client the stored token
  // may well be fine: the seed is older, and if Meetup rotates, sending it
  // could trip reuse detection and revoke the whole token family -- or, if
  // it is another account's, overwrite a good credential after one hiccup.
  // Each attempt is bounded (10 s), so it is safe to hold the lock across it.
  const seed = Configuration.meetup.organizerRefreshToken || undefined;
  let lastError: unknown;
  let refreshed: Tokens | undefined;
  let fromSeed = false;
  if (current?.refreshToken) {
    const attempt = await tryRefresh(current.refreshToken, 'stored token');
    if ('tokens' in attempt) {
      refreshed = attempt.tokens;
    } else {
      lastError = attempt.error;
    }
  }
  if (
    refreshed === undefined &&
    seed !== undefined &&
    // Deduplicated: in steady state they are often the same string.
    seed !== current?.refreshToken &&
    (!current?.refreshToken || isDefiniteRefreshRejection(lastError))
  ) {
    const attempt = await tryRefresh(seed, 'config seed');
    if ('tokens' in attempt) {
      refreshed = attempt.tokens;
      fromSeed = true;
    } else {
      lastError = attempt.error;
    }
  }

  const failed = async (failure: OrganizerFailure): Promise<LockedOutcome> => ({
    accessToken: undefined,
    failure,
    refreshed: false,
    accountConfirmed: false,
    recovered: false,
    // Only a run that can post the alert opens the episode: a client-less
    // one would mark it alerted while nobody was told.
    episodeStarted:
      recordEpisodes &&
      (await recordEpisode(locked, () => locked.markFailing(), 'open')),
    storedMemberId,
  });

  if (refreshed !== undefined) {
    // Hai's rule: a personal account must never become the sweep
    // credential. So the refreshed token's account is checked BEFORE
    // anything is stored or used, against the recorded id, else
    // MEETUP_ORGANIZER_MEMBER_ID. Bounded (ORGANIZER_ACCOUNT_CHECK_TIMEOUT_MS).
    const expected =
      storedMemberId ?? (Configuration.meetup.organizerMemberId || null);
    const observed = await lookUpMemberId(
      refreshed.accessToken,
      ORGANIZER_ACCOUNT_CHECK_TIMEOUT_MS,
    );
    if (expected !== null) {
      if (observed === undefined) {
        // Refreshing the STORED token cannot change accounts: it is the same
        // grant, verified when it was stored. So with an id on record the
        // check is best-effort there, and a lookup hiccup must not discard
        // a freshly rotated token. A seed, or a stored token with no id on
        // record, is unverified: it must be confirmed before it is kept.
        if (fromSeed || storedMemberId === null) {
          logger.error(
            'Meetup credential refreshed, but its account could not be confirmed; ' +
              'it was not stored or used',
          );
          return failed('unverified');
        }
        logger.warn(
          'Could not confirm the account of the refreshed stored organizer token; ' +
            'keeping it (same grant as the one on record)',
        );
      } else if (observed !== expected) {
        logger.error(
          'The refreshed Meetup organizer credential belongs to a different account than ' +
            'the recorded organizer (or MEETUP_ORGANIZER_MEMBER_ID); it was not stored or used',
        );
        return failed('wrong-account');
      }
    }
    // Bootstrap (nothing expected): kept, and recorded as observed.
    const recordMemberId =
      storedMemberId === null && observed !== undefined ? observed : undefined;

    onRefreshed({
      tokens: refreshed,
      previousRefreshToken: current?.refreshToken,
      previousAccessToken: current?.accessToken,
    });

    // The credential write comes FIRST. Persisting is a separate failure from
    // refreshing: if Meetup rotates refresh tokens (not documented; assume it
    // does), `refreshed` holds the only valid one, so a write failure must
    // not fall through to the seed. Postgres has then aborted the
    // transaction, so the caller retries the save once, in a fresh locked
    // call, and this run proceeds on the fresh token either way.
    try {
      await locked.write(refreshed);
    } catch (error: unknown) {
      logger.error(
        'Meetup credential refreshed but could NOT be stored; this run ' +
          `continues on the fresh token and retries the save once: ${errorName(error)}`,
      );
      return {
        accessToken: refreshed.accessToken,
        refreshed: true,
        accountConfirmed: observed !== undefined,
        writeFailed: true,
        recovered: false,
        episodeStarted: false,
        storedMemberId,
      };
    }

    // Bookkeeping AFTER the write, each in its own savepoint, so neither can
    // abort the transaction and undo the write.
    if (recordMemberId !== undefined) {
      const recorded = await locked.savepoint('record_member_id', () =>
        locked.setMemberId(recordMemberId),
      );
      if (!recorded.ok) {
        logger.warn(
          `Could not record the organizer's Meetup member id: ${errorName(recorded.error)}`,
        );
      }
    }
    // Only a run that can post the recovery message closes the episode: a
    // client-less one (a script) would close it silently.
    const recovered =
      recordEpisodes &&
      (await recordEpisode(locked, () => locked.clearFailing(), 'close'));

    return {
      accessToken: refreshed.accessToken,
      refreshed: true,
      accountConfirmed: observed !== undefined,
      recovered,
      episodeStarted: false,
      storedMemberId,
    };
  }

  logger.error(
    `No usable Meetup credential: ${lastError === undefined ? 'none configured' : describeRefreshFailure(lastError)}`,
  );
  return failed('unusable');
}

/** True iff the alert was posted. Never throws. */
async function postAlert(
  client: Client,
  entry: { title: string; description: string },
): Promise<boolean> {
  try {
    if (await logAlert(client, entry)) {
      return true;
    }
    logger.error(`Could not post "${entry.title}": Discord refused the post`);
  } catch (error: unknown) {
    logger.error(`Could not post "${entry.title}": ${errorName(error)}`);
  }
  return false;
}

/**
 * An episode post failed after the episode transition committed. Undo the
 * transition in a short locked call of its own (never from inside the token
 * transaction), so the next run sees it again and retries the post.
 */
async function undoEpisodeTransition(
  credentials: PostgresCredentialRepository,
  undo: (locked: LockedCredential) => Promise<boolean>,
  what: string,
): Promise<void> {
  logger.error(
    `The organizer ${what} could not be posted; re-arming it for the next run`,
  );
  try {
    await credentials.withLockedCredential(
      MEETUP_ORGANIZER_CREDENTIAL_KEY,
      undo,
    );
  } catch (error: unknown) {
    logger.error(
      `Could not re-arm the organizer ${what}, so it will not be retried: ${errorName(error)}`,
    );
  }
}

/**
 * Is the stored, reused token another account's? Looks up the token's own
 * member id (once per distinct token) and compares it with the recorded id,
 * else MEETUP_ORGANIZER_MEMBER_ID. True only for a known mismatch. A failed
 * lookup is logged and counts as no mismatch: unlike a refresh, this token
 * is already stored, so failing closed would only stop monitoring on a
 * Meetup hiccup without protecting anything. The lookup runs outside the
 * token transaction: Meetup calls on this path stay out of the lock.
 *
 * With nothing recorded, the observed id is stored in a separate short
 * locked call, but only when it equals MEETUP_ORGANIZER_MEMBER_ID or that is
 * unset (bootstrap). No id is ever shown.
 */
async function isStoredTokenWrongAccount(
  credentials: PostgresCredentialRepository,
  accessToken: string,
  storedMemberId: string | null,
  generation: number,
): Promise<boolean> {
  if (accessToken === checkedAccessToken) {
    return checkedWrongAccount;
  }
  const memberId = await lookUpMemberId(accessToken);
  if (memberId === undefined || generation !== credentialGeneration) {
    // Lookup failed (best-effort), or renewed meanwhile: this token is no
    // longer the credential, so what was learned about it does not apply.
    return false;
  }
  checkedAccessToken = accessToken;
  const expected =
    storedMemberId ?? (Configuration.meetup.organizerMemberId || undefined);
  checkedWrongAccount = expected !== undefined && expected !== memberId;
  if (checkedWrongAccount) {
    logger.error(
      'The stored Meetup organizer credential belongs to a different account than ' +
        'the recorded organizer (or MEETUP_ORGANIZER_MEMBER_ID); it is not used',
    );
    return true;
  }
  if (storedMemberId === null) {
    try {
      await credentials.withLockedCredential(
        MEETUP_ORGANIZER_CREDENTIAL_KEY,
        async (locked) => {
          // Re-read under the lock: never overwrite an id recorded meanwhile,
          // and record it only for the token that was looked up -- another
          // process may have replaced the credential during the lookup.
          if (
            locked.meta.memberId === null &&
            locked.current?.accessToken === accessToken
          ) {
            await locked.setMemberId(memberId);
          }
        },
      );
    } catch (error: unknown) {
      logger.warn(
        `Could not record the organizer's Meetup member id: ${errorName(error)}`,
      );
    }
  }
  return false;
}

/**
 * No token for this run: open (or keep) the episode and post its alert once.
 * `episodeStarted` is what the token transaction already decided, or, when
 * it opened none, `openEpisode` opens it in a short locked call of its own.
 * Client-less runs log only and leave the episode alone.
 */
async function reportFailure(
  credentials: PostgresCredentialRepository,
  failure: OrganizerFailure,
  client: Client | undefined,
  episodeStarted: boolean | 'open now',
): Promise<undefined> {
  const entry = organizerFailureAlert(failure);
  if (!client) {
    logger.error(entry.description);
    return undefined;
  }
  let started = episodeStarted === true;
  if (episodeStarted === 'open now') {
    try {
      started = await credentials.withLockedCredential(
        MEETUP_ORGANIZER_CREDENTIAL_KEY,
        (locked) => recordEpisode(locked, () => locked.markFailing(), 'open'),
      );
    } catch (error: unknown) {
      logger.error(
        `Could not open the organizer credential failure episode: ${errorName(error)}`,
      );
    }
  }
  if (started && !(await postAlert(client, entry))) {
    await undoEpisodeTransition(
      credentials,
      (locked) => locked.clearFailing(),
      'alert',
    );
  }
  return undefined;
}

/**
 * The refreshed pair was not durably stored (the write or the COMMIT
 * failed). Try once more in a fresh locked call, but only if the stored
 * pair (refresh AND access token) is still the one this run's transaction
 * read: otherwise
 * another process has already advanced the credential, and its pair wins.
 * Logged by outcome and error name only. Never throws.
 */
async function retryStore(
  credentials: PostgresCredentialRepository,
  pair: RefreshedPair,
): Promise<void> {
  try {
    const stored = await credentials.withLockedCredential(
      MEETUP_ORGANIZER_CREDENTIAL_KEY,
      async (locked) => {
        // Both halves: without rotation another process's newer pair keeps
        // the same refresh token, and must not be overwritten either.
        if (
          locked.current?.refreshToken !== pair.previousRefreshToken ||
          locked.current?.accessToken !== pair.previousAccessToken
        ) {
          return false;
        }
        await locked.write(pair.tokens);
        return true;
      },
    );
    if (stored) {
      logger.info('Refreshed organizer credential stored on the retry');
    } else {
      logger.warn(
        'Refreshed organizer credential not stored on the retry: another ' +
          'process already advanced the stored credential',
      );
    }
  } catch (error: unknown) {
    logger.error(
      'Retry storing the refreshed organizer credential failed; the stored ' +
        `pair may now be stale: ${errorName(error)}`,
    );
  }
}

async function resolveOrganizerAccessToken(
  forceRefresh: boolean,
  refusedAccessToken: string | undefined,
  client: Client | undefined,
): Promise<string | undefined> {
  const generation = credentialGeneration;
  let refreshedPair: RefreshedPair | undefined;
  let credentials: PostgresCredentialRepository | undefined;
  let outcome: LockedOutcome;
  try {
    // Inside the try: opening the store ensures its schema, which rejects
    // when Postgres is unreachable -- the same outage as a failed lock.
    credentials = await ApplicationCredentialRepository();
    if (!credentials) {
      return undefined; // no DATABASE_URL: monitoring disabled, no alert
    }
    outcome = await credentials.withLockedCredential(
      MEETUP_ORGANIZER_CREDENTIAL_KEY,
      (locked) =>
        resolveLocked(
          locked,
          forceRefresh,
          refusedAccessToken,
          (pair) => {
            refreshedPair = pair;
          },
          client !== undefined,
        ),
    );
  } catch (error: unknown) {
    if (refreshedPair !== undefined && credentials) {
      // Refreshed and verified, but the transaction did not commit: same
      // rule as a failed write. Episode state is unknown, so nothing is
      // posted.
      logger.error(
        'Meetup credential refreshed but could NOT be stored (the ' +
          'transaction failed to commit); this run continues on the fresh ' +
          `token and retries the save once: ${errorName(error)}`,
      );
      await retryStore(credentials, refreshedPair);
      return refreshedPair.tokens.accessToken;
    }
    // The store or lock failed before any refresh: nothing was obtained and
    // nothing could be recorded. Not deduplicated -- there is nowhere to
    // record an episode -- matching the old sweep, which alerted every time.
    logger.error(
      `Could not read the organizer credential under its lock: ${errorName(error)}`,
    );
    if (client) {
      await postAlert(client, {
        title: 'Meetup organizer credential store unavailable',
        description:
          `Could not read the shared Meetup organizer credential from the database (it is unavailable or busy: ${errorName(error)}), ` +
          'so Meetup identity monitoring was skipped this time. It retries on the next run.',
      });
    }
    return undefined;
  }

  if (outcome.accessToken === undefined) {
    return reportFailure(
      credentials,
      outcome.failure ?? 'unusable',
      client,
      outcome.episodeStarted,
    );
  }

  if (outcome.writeFailed && refreshedPair !== undefined) {
    await retryStore(credentials, refreshedPair);
  }

  if (outcome.refreshed) {
    // Its account was handled under the lock, before it was stored. Memoise
    // a confirmed one so the reuse path does not look it up again.
    if (outcome.accountConfirmed && generation === credentialGeneration) {
      checkedAccessToken = outcome.accessToken;
      checkedWrongAccount = false;
    }
  } else if (
    await isStoredTokenWrongAccount(
      credentials,
      outcome.accessToken,
      outcome.storedMemberId,
      generation,
    )
  ) {
    // Fail closed: the stored token is another account's. Never a recovery.
    return reportFailure(
      credentials,
      'wrong-account-stored',
      client,
      'open now',
    );
  }

  if (
    outcome.recovered &&
    client &&
    !(await postAlert(client, ORGANIZER_RESTORED_ALERT))
  ) {
    await undoEpisodeTransition(
      credentials,
      (locked) => locked.markFailing(),
      'recovery',
    );
  }
  return outcome.accessToken;
}

// One resolution per process at a time, per kind: concurrent callers share
// it. A forced call never joins an unforced one -- its caller has just seen
// the token refused, so the reused one would be no help.
// It is keyed on whether a client was passed too: a client-less call records
// no episode, so a caller with a client must never join one. Joined callers
// share the first caller's client (there is one Discord client per process)
// and, for forced calls, the first caller's refusedAccessToken.
const inFlight = new Map<string, Promise<string | undefined>>();

/**
 * A usable organizer access token, or undefined when none can be obtained.
 * Never throws. Every read-to-refresh and write happens under the shared
 * credential lock, so processes refreshing the (possibly rotating) token
 * serialize.
 *
 * `client` is used for the once-per-episode alert and the recovery message.
 * Only a call with a client opens or closes a failure episode: without one
 * (a script), a failure logs the remedy and a success says nothing, and the
 * episode is left for the next call that can post about it. If an episode
 * post fails, the transition is undone so the next run posts it again.
 */
export async function getOrganizerAccessToken(
  opts: {
    forceRefresh?: boolean;
    /** With forceRefresh: the token Meetup refused, so a rotated one is reused. */
    refusedAccessToken?: string;
    client?: Client;
  } = {},
): Promise<string | undefined> {
  const forceRefresh = opts.forceRefresh ?? false;
  const key = `${String(forceRefresh)}:${String(opts.client !== undefined)}`;
  let pending = inFlight.get(key);
  if (pending === undefined) {
    const started: Promise<string | undefined> = resolveOrganizerAccessToken(
      forceRefresh,
      opts.refusedAccessToken,
      opts.client,
    ).finally(() => {
      if (inFlight.get(key) === started) {
        inFlight.delete(key);
      }
    });
    pending = started;
    inFlight.set(key, pending);
  }
  return pending;
}

/**
 * Called after the dashboard stores a renewed organizer credential: forget
 * this process's verdict about the old one (the member-id check) and stop handing new callers a resolution that began before the
 * renewal, so the renewed credential is picked up at once.
 */
export function noteOrganizerCredentialRenewed(): void {
  credentialGeneration += 1;
  inFlight.clear();
  checkedAccessToken = undefined;
  checkedWrongAccount = false;
}

/** Test-only: forget any in-flight resolution so tests cannot leak into each other. */
export function resetOrganizerTokenStateForTest(): void {
  inFlight.clear();
  checkedAccessToken = undefined;
  checkedWrongAccount = false;
}
