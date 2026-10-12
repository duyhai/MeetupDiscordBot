import { Logger } from 'tslog';

import { KeyValueCache } from '../cache/base.js';
import { Tokens } from '../client/discord/types.js';
import {
  MeetupTokenRefreshError,
  refreshMeetupToken,
} from '../client/oauth/providers.js';

const logger = new Logger({ name: 'MeetupTokens' });

/**
 * How long a member's token set is kept, counted from the last time it was
 * written -- which is every authorization and every refresh, so retention
 * slides with use.
 *
 * The cache's general-purpose default is 12 hours, and falling back to it is
 * what made members reconnect Meetup about once a day: the refresh token was
 * deleted along with the access token it could have renewed. Meetup's refresh
 * tokens do not expire on their own, so this is purely our retention choice:
 * long enough that anyone who uses a Meetup command at least once a month
 * never sees the connect prompt again, short enough that the credentials of
 * someone who has stopped using the bot are gone within the month. Someone
 * who leaves the server loses theirs at once (see memberLeave.ts).
 */
export const MEETUP_TOKEN_TTL_SEC = 30 * 24 * 60 * 60;

/**
 * Refresh a little before the stated expiry, so a token is not handed to a
 * command that will still be paging through Meetup when it lapses.
 */
const EXPIRY_SKEW_MS = 60 * 1000;

export const meetupTokenKey = (discordUserId: string) =>
  `${discordUserId}-meetup-tokens`;

export async function storeMeetupTokens(
  cache: KeyValueCache,
  discordUserId: string,
  tokens: Tokens,
): Promise<void> {
  await cache.set(
    meetupTokenKey(discordUserId),
    JSON.stringify(tokens),
    MEETUP_TOKEN_TTL_SEC,
  );
}

/**
 * Drops the member's saved Meetup connection, so the next Meetup command
 * asks them to connect again. This is how a wrong-account connection gets
 * undone: while a token set is stored it is reused and refreshed silently.
 */
export async function forgetMeetupTokens(
  cache: KeyValueCache,
  discordUserId: string,
): Promise<void> {
  await cache.remove(meetupTokenKey(discordUserId));
}

function parseTokens(rawTokens: string): Tokens | undefined {
  try {
    const tokens = JSON.parse(rawTokens) as Tokens;
    return typeof tokens?.accessToken === 'string' ? tokens : undefined;
  } catch {
    return undefined;
  }
}

// A set with no recorded expiry cannot be shown to be fresh, so it is treated
// as expired; every set written since the token exchange started recording
// `expiresAt` carries one.
const isFresh = (tokens: Tokens) =>
  Number.isFinite(tokens.expiresAt) &&
  tokens.expiresAt - EXPIRY_SKEW_MS > Date.now();

/**
 * The one answer that means this member's grant is dead. Everything else
 * says nothing about the grant, so the connection is kept for the next
 * attempt: a timeout, a network error, a 5xx, a 429 -- and `invalid_client`,
 * which is OUR credentials being wrong. A rotated or mistyped MEETUP_SECRET
 * fails every refresh at once, and must not cost every member who runs a
 * command their connection.
 */
const isRejectedGrant = (error: unknown) =>
  error instanceof MeetupTokenRefreshError &&
  error.oauthError === 'invalid_grant';

/**
 * What can safely be said about a failed refresh. The error's message embeds
 * Meetup's raw response body, which is untrusted and may echo the credential
 * that was sent, so only the HTTP status, the OAuth error code, or the
 * error's class name is kept.
 */
function describeRefreshFailure(error: unknown): string {
  if (error instanceof MeetupTokenRefreshError) {
    return error.oauthError
      ? `HTTP ${error.status} ${error.oauthError}`
      : `HTTP ${error.status}`;
  }
  return error instanceof Error ? error.name : 'unknown error';
}

/**
 * Whether the stored set is still the one a refresh started from. It may not
 * be: another process won the refresh during a deploy overlap, the member
 * just re-authorized, or a moderator unlinked them. Whatever is there now is
 * the truth, so a changed set is neither deleted nor overwritten; if it is a
 * usable one it is handed back for this command to run on.
 */
async function readSinceRefreshStarted(
  cache: KeyValueCache,
  key: string,
  rawTokens: string | undefined,
): Promise<{ changed: boolean; replacement?: Tokens }> {
  const current = await cache.get(key);
  if (current === rawTokens) {
    return { changed: false };
  }
  const tokens = current ? parseTokens(current) : undefined;
  return {
    changed: true,
    replacement: tokens && isFresh(tokens) ? tokens : undefined,
  };
}

/** Removes the set judged unusable, unless something else has replaced it. */
async function removeUnlessReplaced(
  cache: KeyValueCache,
  key: string,
  rawTokens: string | undefined,
): Promise<Tokens | undefined> {
  const { changed, replacement } = await readSinceRefreshStarted(
    cache,
    key,
    rawTokens,
  );
  if (!changed && rawTokens !== undefined) {
    await cache.remove(key);
  }
  return replacement;
}

async function refreshStoredTokens(
  cache: KeyValueCache,
  discordUserId: string,
): Promise<Tokens | undefined> {
  const key = meetupTokenKey(discordUserId);
  // Re-read rather than trust the caller's copy: a refresh that finished
  // between the caller's read and this one has already replaced the set, and
  // if Meetup rotates refresh tokens the caller's copy is now dead.
  const rawTokens = await cache.get(key);
  const tokens = rawTokens ? parseTokens(rawTokens) : undefined;
  if (tokens && isFresh(tokens)) {
    return tokens;
  }

  if (!tokens?.refreshToken) {
    // Nothing here can ever be refreshed.
    return removeUnlessReplaced(cache, key, rawTokens);
  }

  let refreshed: Tokens;
  try {
    refreshed = await refreshMeetupToken(tokens.refreshToken);
  } catch (error: unknown) {
    const failure = describeRefreshFailure(error);
    if (isRejectedGrant(error)) {
      logger.warn(
        `Could not refresh Meetup tokens for Discord user ${discordUserId} ` +
          `(${failure}); the grant was rejected, so they will be asked to reconnect`,
      );
      // A rejection is also what the loser of a deploy-overlap race sees,
      // after the winner has stored a good set: use that one.
      return removeUnlessReplaced(cache, key, rawTokens);
    }
    logger.warn(
      `Could not refresh Meetup tokens for Discord user ${discordUserId} ` +
        `(${failure}); keeping the connection for the next attempt`,
    );
    return undefined;
  }

  // Storing is a SEPARATE failure from refreshing, as in the Meetup sweep's
  // resolveOrganizerTokens: the tokens in hand are good, so this command runs
  // on them whatever happens to the write.
  try {
    const { changed, replacement } = await readSinceRefreshStarted(
      cache,
      key,
      rawTokens,
    );
    if (changed) {
      // Forgotten while the refresh was in the air: do not write the
      // connection back. Replaced: run on the replacement.
      return replacement;
    }
    await storeMeetupTokens(cache, discordUserId, refreshed);
    logger.info(`Refreshed Meetup tokens for Discord user ${discordUserId}`);
  } catch (error: unknown) {
    logger.error(
      `Meetup tokens for Discord user ${discordUserId} were refreshed but ` +
        'could not be stored; this command continues on the fresh token, ' +
        'but if Meetup rotates refresh tokens the stored set is now stale: ' +
        `${error instanceof Error ? error.name : 'unknown error'}`,
    );
  }
  return refreshed;
}

const refreshesInFlight = new Map<string, Promise<Tokens | undefined>>();

/**
 * The member's Meetup tokens with an access token that is good to use right
 * now, refreshing it first if it has expired. `undefined` means there is
 * nothing usable right now and the member is shown the connect prompt. That
 * does not always mean the stored set is gone: after an outage it is kept,
 * so callers waiting for a new authorization must not mistake it for one.
 * Never throws for a failed refresh.
 *
 * One refresh per member at a time: two commands arriving together would
 * otherwise both send the same refresh token, and if Meetup rotates them the
 * second request is rejected and that command falls to the connect prompt.
 * The guard is per process, which matches the bot running as a single dyno.
 */
export async function getUsableMeetupTokens(
  cache: KeyValueCache,
  discordUserId: string,
): Promise<Tokens | undefined> {
  const rawTokens = await cache.get(meetupTokenKey(discordUserId));
  if (!rawTokens) {
    return undefined;
  }
  const tokens = parseTokens(rawTokens);
  if (tokens && isFresh(tokens)) {
    return tokens;
  }

  let refresh = refreshesInFlight.get(discordUserId);
  if (refresh === undefined) {
    refresh = refreshStoredTokens(cache, discordUserId).finally(() => {
      refreshesInFlight.delete(discordUserId);
    });
    refreshesInFlight.set(discordUserId, refresh);
  }
  return refresh;
}
