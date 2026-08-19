import { Client } from 'discord.js';
import { Logger } from 'tslog';

import Configuration from '../../../configuration.js';
import { boundedFetch } from '../../../util/boundedFetch.js';
import {
  ApplicationCredentialRepository,
  MEETUP_ORGANIZER_CREDENTIAL_KEY,
} from '../../../util/credentialRepository.js';
import { ApplicationIdentityRepository } from '../../../util/identityRepository.js';
import { Tokens } from '../../client/discord/types.js';
import { GqlMeetupClient } from '../../client/meetup/gqlClient.js';
import { getPaginatedData } from '../../client/meetup/paginationHelper.js';
import { MeetupGroupMember } from '../../client/meetup/types.js';
import { refreshMeetupToken } from '../../client/oauth/providers.js';
import { PostgresIdentityRepository } from '../../repositories/postgresIdentityRepository.js';
import {
  ChangeSource,
  IdentityChange,
} from '../../repositories/identityTypes.js';
import { logAlert } from '../discordLogger.js';
import { diffMeetupIdentity, snapshotMeetupMember } from './meetupSnapshot.js';

const logger = new Logger({ name: 'meetupIdentitySweep' });

const THUMB_FETCH_TIMEOUT_MS = 5_000;

/**
 * Fraction of the roster that may change in one sweep before the sweep stops
 * fetching thumbnails. Above this the cause is systemic (Meetup re-issuing
 * photo ids), not 600 people independently changing their photo overnight.
 */
const SYSTEMIC_CHANGE_RATIO = 0.1;

/**
 * Resolution order: the stored pair first, the Heroku config var as seed and
 * as the recovery path. Whatever refresh token comes back is persisted, so
 * rotation is absorbed whether or not Meetup rotates -- which cannot be
 * determined without performing a refresh.
 *
 * Returns undefined when there is no usable credential; the caller alerts.
 */
async function resolveOrganizerTokens(): Promise<Tokens | undefined> {
  const credentials = await ApplicationCredentialRepository();
  if (!credentials) {
    return undefined;
  }
  const stored = await credentials.get(MEETUP_ORGANIZER_CREDENTIAL_KEY);
  const seed = Configuration.meetup.organizerRefreshToken;

  // Deduplicated: on the common steady-state path the stored refresh token
  // and the config seed are the same string, and trying it twice means two
  // identical failed refreshes and two identical warnings for one problem.
  const candidates = [
    ...new Set(
      [stored?.refreshToken, seed].filter((token): token is string =>
        Boolean(token),
      ),
    ),
  ];
  if (candidates.length === 0) {
    return undefined;
  }

  let lastError: unknown;
  for (const candidate of candidates) {
    let refreshed: Tokens;
    try {
      // Sequential by intent: try the stored pair, and only fall back to the
      // config seed if it fails. Falling back is also how an organizer
      // recovers -- paste a fresh token into Heroku and the next sweep uses it.
      // eslint-disable-next-line no-await-in-loop
      refreshed = await refreshMeetupToken(candidate);
    } catch (error: unknown) {
      lastError = error;
      // refreshMeetupToken's thrown error embeds Meetup's raw response body.
      // Treat it as untrusted even here, where it only reaches the process
      // log via String(): never let it flow into the Discord alert below.
      logger.warn(`Meetup credential refresh failed: ${String(error)}`);
      continue;
    }

    // Persisting is a SEPARATE failure from refreshing, and conflating the
    // two is how a working credential dies permanently.
    //
    // If Meetup rotates refresh tokens, `refreshed.refreshToken` is now the
    // only valid one and the token we just sent has been invalidated. A
    // Postgres blip on the way to storing it used to be caught by the same
    // handler as a refresh failure: the fresh token was discarded, the loop
    // fell through to the seed -- which Meetup had just invalidated -- and
    // the organizer was alerted to re-paste a config var that would not help.
    // The credential was dead with no way back.
    //
    // So: a put failure is loud in the process log and otherwise ignored.
    // This run proceeds on the tokens it holds, and the next run re-refreshes
    // from whatever is stored or seeded, which is exactly the recovery the
    // rotation design already relies on.
    try {
      // eslint-disable-next-line no-await-in-loop
      await credentials.put(MEETUP_ORGANIZER_CREDENTIAL_KEY, refreshed);
    } catch (error: unknown) {
      logger.error(
        'Meetup credential refreshed but could NOT be stored; this sweep ' +
          'continues on the fresh token, but if Meetup rotates refresh ' +
          `tokens the stored pair is now stale: ${String(error)}`,
      );
    }
    return refreshed;
  }
  logger.error(`No usable Meetup credential: ${String(lastError)}`);
  return undefined;
}

/**
 * Fetches one photo's bytes with a bounded timeout, mirroring
 * fetchChangeThumbs's fetchOne. Not reused directly: fetchChangeThumbs builds
 * its URL from a Discord CDN path template (avatarThumbUrl), which has
 * nothing in common with Meetup's opaque, API-provided thumbUrl.
 */
async function fetchThumbBytes(url: string): Promise<Buffer | null> {
  try {
    const response = await boundedFetch(url, undefined, THUMB_FETCH_TIMEOUT_MS);
    if (!response.ok) {
      return null;
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (error: unknown) {
    logger.warn(`Meetup thumbnail fetch failed for ${url}: ${String(error)}`);
    return null;
  }
}

/**
 * Thumbnails for one member's changes. Only the *new* photo's bytes are ever
 * reachable here: the stored baseline keeps a photoId, not the URL that
 * produced it, so by the time a change is detected the superseded photo's
 * URL is already gone. oldThumb is therefore always null for Meetup photo
 * changes -- the same best-effort outcome the rest of the pipeline already
 * tolerates for a failed fetch.
 */
async function fetchMeetupChangeThumbs(
  changes: IdentityChange[],
  member: MeetupGroupMember,
): Promise<Map<string, { oldThumb: Buffer | null; newThumb: Buffer | null }>> {
  const thumbs = new Map<
    string,
    { oldThumb: Buffer | null; newThumb: Buffer | null }
  >();
  for (const change of changes) {
    if (change.field !== 'photo') {
      continue;
    }
    const url = member.memberPhoto?.thumbUrl;
    // One photo per change, sequential: batching would fan out unbounded
    // concurrent fetches within a single member's change set.
    // eslint-disable-next-line no-await-in-loop
    const newThumb = url ? await fetchThumbBytes(url) : null;
    // recordChanges reads back with the same four-part key: platform and
    // scopeId scope the identity, subjectId and field pick the row within it.
    thumbs.set(
      `${change.platform}:${change.scopeId}:${change.subjectId}:${change.field}`,
      { oldThumb: null, newThumb },
    );
  }
  return thumbs;
}

/**
 * Diffs one member against their stored Meetup baseline, persists any
 * changes with thumbnails, and advances the baseline. Returns the number of
 * changes so the caller can tally how many members changed.
 */
async function recordMeetupMember(
  repo: PostgresIdentityRepository,
  member: MeetupGroupMember,
  scopeId: string,
  source: ChangeSource,
  withThumbs: boolean,
): Promise<number> {
  const after = snapshotMeetupMember(member, scopeId);
  const before = await repo.getMeetupSnapshot(scopeId, member.id);
  const changes = diffMeetupIdentity(before, after);

  if (!before) {
    await repo.putMeetupSnapshot(after);
    return 0;
  }
  if (changes.length === 0) {
    return 0;
  }

  const thumbs = withThumbs
    ? await fetchMeetupChangeThumbs(changes, member)
    : new Map<string, { oldThumb: Buffer | null; newThumb: Buffer | null }>();
  // Record before advancing the baseline, not after -- same crash-ordering
  // rationale as the Discord monitor. Crash here and the next sweep just
  // re-diffs and records a harmless duplicate row. Reversed, a crash would
  // advance the baseline while losing the evidence for good -- the old
  // snapshot is gone, so the change can't be reconstructed.
  await repo.recordChanges(changes, source, thumbs);
  await repo.putMeetupSnapshot(after);
  return changes.length;
}

/**
 * Full reconciliation pass over the Meetup group's roster (~6,000 members).
 * Also performs the initial backfill when called with source 'backfill':
 * members with no baseline are stored silently, via diffMeetupIdentity's
 * absent-baseline rule, so enabling the feature does not report every member
 * of the group as having changed.
 *
 * The client is optional because the two callers differ: the digest has one
 * and wants a credential failure alerted to the organizers' channel, while
 * the backfill script runs standalone with no Discord connection and
 * surfaces failure through its own non-zero exit. With no client the sweep
 * logs the error instead of alerting.
 */
export async function runMeetupSweep(
  source: ChangeSource,
  client?: Client,
): Promise<{ scanned: number; changed: number }> {
  const tokens = await resolveOrganizerTokens();
  if (!tokens) {
    const remedy =
      'Could not obtain a Meetup organizer token, so the Meetup sweep was skipped. ' +
      'To fix: run `/meetup_get_token`, copy the refresh token, and set ' +
      '`MEETUP_ORGANIZER_REFRESH_TOKEN` in Heroku config.';
    // The only way credential expiry becomes visible. A sweep that fails
    // quietly leaves monitoring looking healthy while watching nothing, so
    // this fires on the first failure rather than after a retry streak. The
    // backfill script has no client and surfaces this through its exit code
    // instead. This is a fixed remedy string, not the caught error: that
    // error embeds Meetup's raw response body and must never reach Discord.
    if (client) {
      await logAlert(client, {
        title: 'Meetup identity monitoring is not running',
        description: remedy,
      });
    } else {
      logger.error(remedy);
    }
    return { scanned: 0, changed: 0 };
  }

  const repo = await ApplicationIdentityRepository();
  if (!repo) {
    logger.error('Meetup sweep skipped: identity repository unavailable');
    return { scanned: 0, changed: 0 };
  }

  const scopeId = Configuration.meetup.groupId;
  const meetupClient = new GqlMeetupClient(tokens.accessToken);
  const members = await getPaginatedData<MeetupGroupMember>((input) =>
    meetupClient
      .getGroupMemberships(input)
      .then((result) => result.groupByUrlname.memberships),
  );

  // Thumbnails are fetched one at a time, each with a 5s ceiling. That is
  // fine for the handful of photo changes a normal day produces, and
  // catastrophic if Meetup ever re-issues photo ids en masse: 6,000 members
  // x 5s is an eight-hour fetch marathon inside the digest, holding the day
  // and finishing long after anyone would notice.
  //
  // Past this many changed members the sweep stops fetching thumbnails and
  // keeps recording changes. The changes are the evidence; the thumbnails are
  // an aid to reading them, and the pipeline already treats a null thumb as
  // normal. A systemic id change is also the case where thumbnails are least
  // informative -- every member's photo would look unchanged to a human.
  const thumbBudget = Math.ceil(members.length * SYSTEMIC_CHANGE_RATIO);

  let scanned = 0;
  let changed = 0;
  let thumbsSkipped = false;
  for (const member of members) {
    scanned += 1;
    try {
      // Sequential on purpose: ~6,000 concurrent diffs would each want a
      // Postgres connection from a pool of two.
      // eslint-disable-next-line no-await-in-loop
      const changeCount = await recordMeetupMember(
        repo,
        member,
        scopeId,
        source,
        !thumbsSkipped,
      );
      if (changeCount > 0) {
        changed += 1;
      }
      if (!thumbsSkipped && changed > thumbBudget) {
        thumbsSkipped = true;
        logger.warn(
          `Meetup sweep: ${changed} changed members exceeds ${thumbBudget} ` +
            '(10% of the roster); recording the rest without thumbnails.',
        );
      }
    } catch (error: unknown) {
      // One bad member must not abandon the rest of the roster.
      logger.warn(`Meetup sweep failed for ${member.id}: ${String(error)}`);
    }
  }

  if (thumbsSkipped) {
    const notice =
      `Systemic photo-id change detected: more than ${thumbBudget} of ` +
      `${members.length} Meetup members changed in one sweep, which is far ` +
      'beyond normal. Thumbnails were skipped for the remainder to avoid a ' +
      'multi-hour fetch; the changes themselves are all recorded. This most ' +
      'likely means Meetup re-issued photo ids rather than that members ' +
      'changed their photos.';
    if (client) {
      await logAlert(client, {
        title: 'Meetup identity sweep: thumbnails skipped',
        description: notice,
      });
    } else {
      logger.error(notice);
    }
  }

  logger.info(
    `Meetup identity sweep (${source}): ${scanned} scanned, ${changed} changed`,
  );
  return { scanned, changed };
}
