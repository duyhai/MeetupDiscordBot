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
import { refreshMeetupToken } from '../client/oauth/providers.js';
import {
  LockedCredential,
  PostgresCredentialRepository,
} from '../repositories/postgresCredentialRepository.js';
import { logAlert } from './discordLogger.js';

const logger = new Logger({ name: 'organizerMeetupClient' });

/**
 * A stored access token with more than this left is handed out as is. Every
 * process reads it under the credential lock, so one that another process
 * just refreshed is reused rather than refreshed again (which, with rotating
 * refresh tokens, would race that process for the successor).
 */
export const ORGANIZER_TOKEN_REUSE_MS = 5 * 60 * 1000;

const MEMBER_ID_PATTERN = /^[0-9]{1,20}$/;

// Per-process member-id state. A mismatch persists until someone renews, so
// the lookup runs once per process (memberIdChecked), and the wrong-account
// alert is posted once, by the first caller that has a client.
let memberIdChecked = false;
let wrongAccountDetected = false;
let wrongAccountAlerted = false;

const RESTORED_ALERT = {
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

/** What the locked transaction decided; acted on only after it commits. */
interface LockedOutcome {
  accessToken: string | undefined;
  /** clearFailing closed an open episode: post the recovery message. */
  recovered: boolean;
  /** markFailing opened a new episode: post the alert. */
  episodeStarted: boolean;
  memberIdMissing: boolean;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error';
}

/**
 * Records the episode outcome on the transaction's own client. A failure is
 * logged and reported as "no change": episode bookkeeping must never cost
 * the caller its token.
 */
async function recordEpisode(
  record: () => Promise<boolean>,
  what: string,
): Promise<boolean> {
  try {
    return await record();
  } catch (error: unknown) {
    logger.error(
      `Could not ${what} the organizer credential failure episode: ${errorName(error)}`,
    );
    return false;
  }
}

/**
 * Runs inside the credential lock. Never throws for a Meetup or write
 * failure: returning is what commits, and the failure path must commit so
 * its markFailing persists. `onRefreshed` hands the fresh tokens out at once,
 * so they survive a COMMIT that fails afterwards.
 */
async function resolveLocked(
  locked: LockedCredential,
  forceRefresh: boolean,
  refusedAccessToken: string | undefined,
  onRefreshed: (tokens: Tokens) => void,
): Promise<LockedOutcome> {
  const memberIdMissing = locked.meta.memberId === null;
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
      recovered: false,
      episodeStarted: false,
      memberIdMissing,
    };
  }

  // Stored pair first; the Heroku config var is the seed and the recovery
  // path. Deduplicated: in steady state they are often the same string, and
  // trying it twice means two identical failed refreshes for one problem.
  const candidates = [
    ...new Set(
      [
        current?.refreshToken,
        Configuration.meetup.organizerRefreshToken,
      ].filter((token): token is string => Boolean(token)),
    ),
  ];

  let lastError: unknown;
  for (const candidate of candidates) {
    let refreshed: Tokens;
    try {
      // Sequential by intent: the seed is tried only when the stored pair
      // fails. Bounded (10 s), so it is safe to hold the lock across it.
      // eslint-disable-next-line no-await-in-loop
      refreshed = await refreshMeetupToken(candidate);
    } catch (error: unknown) {
      lastError = error;
      // The error embeds Meetup's raw response body: process log only.
      logger.warn(`Meetup credential refresh failed: ${String(error)}`);
      continue;
    }
    onRefreshed(refreshed);

    // Close the episode BEFORE writing: if this statement fails, Postgres
    // aborts the transaction, so the write below fails too and is logged as
    // the persist failure it is -- rather than a write that appeared to
    // succeed and was silently discarded by the aborted COMMIT.
    // eslint-disable-next-line no-await-in-loop
    const recovered = await recordEpisode(() => locked.clearFailing(), 'close');

    // Persisting is a SEPARATE failure from refreshing. If Meetup rotates
    // refresh tokens, `refreshed` holds the only valid one; treating a write
    // failure as a refresh failure would fall through to a seed Meetup just
    // invalidated. So: loud in the log, and this run proceeds on the fresh
    // token; the next run re-refreshes from whatever is stored or seeded.
    let stored = true;
    try {
      // eslint-disable-next-line no-await-in-loop
      await locked.write(refreshed);
    } catch (error: unknown) {
      // Postgres has aborted the transaction: nothing in it is durable,
      // including the episode close above.
      stored = false;
      logger.error(
        'Meetup credential refreshed but could NOT be stored; this run ' +
          'continues on the fresh token, but if Meetup rotates refresh ' +
          `tokens the stored pair is now stale: ${String(error)}`,
      );
    }
    return {
      accessToken: refreshed.accessToken,
      recovered: stored && recovered,
      episodeStarted: false,
      memberIdMissing,
    };
  }

  logger.error(`No usable Meetup credential: ${String(lastError)}`);
  return {
    accessToken: undefined,
    recovered: false,
    episodeStarted: await recordEpisode(() => locked.markFailing(), 'open'),
    memberIdMissing,
  };
}

async function postAlert(
  client: Client,
  entry: { title: string; description: string },
): Promise<void> {
  try {
    await logAlert(client, entry);
  } catch (error: unknown) {
    logger.error(`Could not post "${entry.title}": ${errorName(error)}`);
  }
}

/**
 * Best-effort: learn the organizer account's member id from its own token
 * and store it, in a separate short locked call. The lookup is bounded,
 * but it runs outside the token transaction anyway: Meetup calls stay out
 * of the lock so its hold time is the refresh alone.
 *
 * When MEETUP_ORGANIZER_MEMBER_ID is set, only that id is stored: a token
 * seeded from someone's personal account must not become the stored
 * organizer identity that later renewals are checked against. When it is
 * unset, the observed id is recorded (bootstrap). Neither id is ever shown.
 */
async function recordMemberId(
  credentials: PostgresCredentialRepository,
  accessToken: string,
): Promise<void> {
  try {
    const info = await new GqlMeetupClient(accessToken).getUserInfo();
    const memberId = info?.self?.id;
    if (typeof memberId !== 'string' || !MEMBER_ID_PATTERN.test(memberId)) {
      logger.warn('Meetup returned no usable member id for the organizer');
      return;
    }
    const expected = Configuration.meetup.organizerMemberId;
    if (expected && expected !== memberId) {
      memberIdChecked = true;
      wrongAccountDetected = true;
      logger.error(
        'The stored Meetup organizer credential belongs to a different ' +
          'account than MEETUP_ORGANIZER_MEMBER_ID; its member id was not recorded',
      );
      return;
    }
    await credentials.withLockedCredential(
      MEETUP_ORGANIZER_CREDENTIAL_KEY,
      (locked) => locked.setMemberId(memberId),
    );
  } catch (error: unknown) {
    logger.warn(
      `Could not record the organizer's Meetup member id: ${errorName(error)}`,
    );
  }
}

async function resolveOrganizerAccessToken(
  forceRefresh: boolean,
  refusedAccessToken: string | undefined,
  client: Client | undefined,
): Promise<string | undefined> {
  let refreshedAccessToken: string | undefined;
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
        resolveLocked(locked, forceRefresh, refusedAccessToken, (tokens) => {
          refreshedAccessToken = tokens.accessToken;
        }),
    );
  } catch (error: unknown) {
    if (refreshedAccessToken !== undefined) {
      // Refreshed, but the transaction did not commit: same rule as a failed
      // write. Episode state is unknown, so nothing is posted.
      logger.error(
        'Meetup credential refreshed but could NOT be stored (the ' +
          'transaction failed to commit); this run continues on the fresh ' +
          `token, but the stored pair may now be stale: ${errorName(error)}`,
      );
      return refreshedAccessToken;
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
          `Could not read the shared Meetup organizer credential from the database (${errorName(error)}), ` +
          'so Meetup identity monitoring was skipped this time. It retries on the next run.',
      });
    }
    return undefined;
  }

  if (outcome.accessToken === undefined) {
    if (!client) {
      logger.error(organizerFailureRemedy());
    } else if (outcome.episodeStarted) {
      await postAlert(client, {
        title: 'Meetup identity monitoring is not running',
        description: organizerFailureRemedy(),
      });
    }
    return undefined;
  }

  if (outcome.recovered && client) {
    await postAlert(client, RESTORED_ALERT);
  }
  if (outcome.memberIdMissing && !memberIdChecked) {
    await recordMemberId(credentials, outcome.accessToken);
  }
  if (wrongAccountDetected && client && !wrongAccountAlerted) {
    wrongAccountAlerted = true;
    await postAlert(client, {
      title: 'Meetup organizer credential belongs to a different account',
      description:
        'The stored Meetup organizer credential is not the shared organizer account set in MEETUP_ORGANIZER_MEMBER_ID. ' +
        `Renew it at ${BASE_DISCORD_BOT_URL}/dashboard/organizer-login while signed in to Meetup as the shared organizer account.`,
    });
  }
  return outcome.accessToken;
}

// One resolution per process at a time, per kind: concurrent callers share
// it. A forced call never joins an unforced one -- its caller has just seen
// the token refused, so the reused one would be no help.
// Joined callers share the first caller's client (there is one Discord client
// per process) and, for forced calls, the first caller's refusedAccessToken.
const inFlight = new Map<boolean, Promise<string | undefined>>();

/**
 * A usable organizer access token, or undefined when none can be obtained.
 * Never throws. Every read-to-refresh and write happens under the shared
 * credential lock, so processes refreshing the rotating token serialize.
 *
 * `client` is used for the once-per-episode alert and the recovery message;
 * without one, a failure logs the remedy instead.
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
  let pending = inFlight.get(forceRefresh);
  if (pending === undefined) {
    const started: Promise<string | undefined> = resolveOrganizerAccessToken(
      forceRefresh,
      opts.refusedAccessToken,
      opts.client,
    ).finally(() => {
      if (inFlight.get(forceRefresh) === started) {
        inFlight.delete(forceRefresh);
      }
    });
    pending = started;
    inFlight.set(forceRefresh, pending);
  }
  return pending;
}

/** Test-only: forget any in-flight resolution so tests cannot leak into each other. */
export function resetOrganizerTokenStateForTest(): void {
  inFlight.clear();
  memberIdChecked = false;
  wrongAccountDetected = false;
  wrongAccountAlerted = false;
}
