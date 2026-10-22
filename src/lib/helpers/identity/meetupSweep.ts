import { Client } from 'discord.js';
import { Logger } from 'tslog';

import Configuration from '../../../configuration.js';
import { boundedFetch } from '../../../util/boundedFetch.js';
import { ApplicationIdentityRepository } from '../../../util/identityRepository.js';
import { GqlMeetupClient } from '../../client/meetup/gqlClient.js';
import { getPaginatedData } from '../../client/meetup/paginationHelper.js';
import { MeetupGroupMember } from '../../client/meetup/types.js';
import { PostgresIdentityRepository } from '../../repositories/postgresIdentityRepository.js';
import {
  ChangeThumbMap,
  IdentityChange,
  WritableChangeSource,
} from '../../repositories/identityTypes.js';
import { logAlert } from '../discordLogger.js';
import {
  getOrganizerAccessToken,
  isMeetupUnauthorized,
} from '../organizerMeetupClient.js';
import { HealBudget } from './healBudget.js';
import {
  MeetupBaselineThumbs,
  MeetupSnapshot,
  StoredMeetupSnapshot,
  diffMeetupIdentity,
  snapshotMeetupMember,
} from './meetupSnapshot.js';

const logger = new Logger({ name: 'meetupIdentitySweep' });

const THUMB_FETCH_TIMEOUT_MS = 5_000;

/**
 * Fraction of the roster that may change in one sweep before the sweep stops
 * fetching thumbnails. Above this the cause is systemic (Meetup re-issuing
 * photo ids), not 600 people independently changing their photo overnight.
 */
const SYSTEMIC_CHANGE_RATIO = 0.1;

/**
 * Fetches one photo's bytes with a bounded timeout, mirroring identityThumbs'
 * fetchOne. Not reused directly: that one builds its URL from a Discord CDN
 * path template (avatarThumbUrl), which has nothing in common with Meetup's
 * opaque, API-provided thumbUrl.
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

/** The member's current photo bytes, or null when they have no photo. */
async function fetchCurrentPhoto(
  member: MeetupGroupMember,
): Promise<Buffer | null> {
  const url = member.memberPhoto?.thumbUrl;
  return url ? fetchThumbBytes(url) : null;
}

/**
 * Thumbnails for one member's changes, plus the thumb the advanced baseline
 * should carry.
 *
 * The old side is never fetched, and here it never could be: the stored
 * baseline keeps a photoId, not the URL that served it, so the superseded
 * photo is unreachable the moment it changes. It comes from the baseline's
 * own stored bytes instead -- captured at first sighting, which is what makes
 * a Meetup before-image possible at all.
 */
async function resolveMeetupChangeThumbs(
  changes: IdentityChange[],
  member: MeetupGroupMember,
  baseline: StoredMeetupSnapshot,
): Promise<{ thumbs: ChangeThumbMap; baselineThumbs: MeetupBaselineThumbs }> {
  const thumbs: ChangeThumbMap = new Map();
  const baselineThumbs: MeetupBaselineThumbs = {};
  for (const change of changes) {
    if (change.field !== 'photo') {
      continue;
    }
    // One photo per change, sequential: batching would fan out unbounded
    // concurrent fetches within a single member's change set.
    // eslint-disable-next-line no-await-in-loop
    const newThumb = await fetchCurrentPhoto(member);
    // recordChanges reads back with the same four-part key: platform and
    // scopeId scope the identity, subjectId and field pick the row within it.
    thumbs.set(
      `${change.platform}:${change.scopeId}:${change.subjectId}:${change.field}`,
      { oldThumb: baseline.photoThumb, newThumb },
    );
    // Set even when the fetch failed: the baseline thumb describes the
    // photo_id stored beside it, and a stale image under a new id would make
    // the next change's before-image wrong rather than merely missing.
    baselineThumbs.photoThumb = newThumb;
  }
  return { thumbs, baselineThumbs };
}

/**
 * Fills in the photo an unchanged baseline is missing -- photo_id set,
 * photo_thumb empty -- from the roster's current thumbUrl, within the run's
 * time budget. Covers every baseline whose first-sighting fetch failed.
 *
 * A heal is NOT a change: it records nothing and the caller does not count
 * it toward the systemic-change thumbnail cap, and that cap (which guards
 * change-time fetches) does not stop heals. The two limits bound different
 * work and stay independent. Best-effort: a failed fetch writes nothing and
 * any error is logged and swallowed.
 */
async function healMeetupPhoto(
  repo: PostgresIdentityRepository,
  member: MeetupGroupMember,
  baseline: StoredMeetupSnapshot,
  current: MeetupSnapshot,
  budget: HealBudget,
): Promise<void> {
  if (
    baseline.photoId === null ||
    baseline.photoThumb !== null ||
    budget.exhausted
  ) {
    return;
  }
  try {
    await budget.spend(async () => {
      const photoThumb = await fetchCurrentPhoto(member);
      if (photoThumb) {
        // Only the photo key: the conditional upsert touches nothing else.
        await repo.putMeetupSnapshot(current, { photoThumb });
      }
    });
  } catch (error: unknown) {
    logger.warn(`Meetup photo heal failed for ${member.id}: ${String(error)}`);
  }
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
  source: WritableChangeSource,
  withThumbs: boolean,
  healBudget: HealBudget,
): Promise<number> {
  const after = snapshotMeetupMember(member, scopeId);
  const before = await repo.getMeetupSnapshot(scopeId, member.id);
  const changes = diffMeetupIdentity(before, after);

  if (!before) {
    // No change to record -- the first sighting IS the baseline -- but this
    // is the only moment this photo's URL is in hand, so capture the bytes
    // now or the member's eventual photo change has no before-image.
    //
    // Deliberately NOT gated on `withThumbs`: that budget guards against a
    // systemic photo-id re-issue, which is counted from members that
    // *changed*, and a first sighting changes nothing. Gating it here would
    // have the effect of skipping the backfill's fetches, which are the
    // entire point -- a backfill is 100% first sightings.
    const photoThumb = await fetchCurrentPhoto(member);
    await repo.putMeetupSnapshot(after, { photoThumb });
    return 0;
  }
  if (changes.length === 0) {
    await healMeetupPhoto(repo, member, before, after, healBudget);
    return 0;
  }

  const { thumbs, baselineThumbs } = withThumbs
    ? await resolveMeetupChangeThumbs(changes, member, before)
    : // Over the systemic-change budget: record the changes without images.
      // The baseline keeps whatever thumb it already has rather than being
      // cleared -- a mass photo-id re-issue leaves the actual pictures
      // unchanged, so 6,000 good before-images are worth more than strict
      // agreement with the new ids.
      { thumbs: new Map() as ChangeThumbMap, baselineThumbs: {} };
  // Record before advancing the baseline, not after -- same crash-ordering
  // rationale as the Discord monitor. Crash here and the next sweep just
  // re-diffs and records a harmless duplicate row. Reversed, a crash would
  // advance the baseline while losing the evidence for good -- the old
  // snapshot is gone, so the change can't be reconstructed.
  await repo.recordChanges(changes, source, thumbs);
  await repo.putMeetupSnapshot(after, baselineThumbs);
  return changes.length;
}

/**
 * Full reconciliation pass over the Meetup group's roster (~6,000 members).
 * Also performs the initial backfill when called with source 'backfill':
 * members with no baseline are stored silently, via diffMeetupIdentity's
 * absent-baseline rule, so enabling the feature does not report every member
 * of the group as having changed. Each of those first sightings does fetch
 * the member's current photo, so a backfill is roughly one HTTP request per
 * photo-having member and takes correspondingly longer than a steady-state
 * sweep -- see the README's deployment notes.
 *
 * The client is optional because the two callers differ: the digest has one,
 * so the token helper can alert the organizers' channel about a credential
 * failure, while the backfill script runs standalone with no Discord
 * connection, where the helper logs the remedy instead.
 */
export async function runMeetupSweep(
  source: WritableChangeSource,
  client?: Client,
): Promise<{
  scanned: number;
  changed: number;
  /** The roster this run fetched, for the ban photo fill. */
  roster?: readonly MeetupGroupMember[];
}> {
  // The helper owns the shared credential: it refreshes under the cross-process
  // lock and alerts (once per failure episode) itself, so an undefined token
  // needs no alert here.
  const accessToken = await getOrganizerAccessToken({ client });
  if (!accessToken) {
    return { scanned: 0, changed: 0 };
  }

  const repo = await ApplicationIdentityRepository();
  if (!repo) {
    logger.error('Meetup sweep skipped: identity repository unavailable');
    return { scanned: 0, changed: 0 };
  }

  const scopeId = Configuration.meetup.groupId;
  const fetchRoster = (token: string): Promise<MeetupGroupMember[]> => {
    const meetupClient = new GqlMeetupClient(token);
    return getPaginatedData<MeetupGroupMember>((input) =>
      meetupClient
        .getGroupMemberships(input)
        .then((result) => result.groupByUrlname.memberships),
    );
  };

  let members: MeetupGroupMember[];
  try {
    members = await fetchRoster(accessToken);
  } catch (error: unknown) {
    if (!isMeetupUnauthorized(error)) {
      throw error;
    }
    // Meetup refused the token (revoked or rotated since it was handed out).
    // One forced refresh and one retry; a second failure propagates.
    const retryToken = await getOrganizerAccessToken({
      forceRefresh: true,
      refusedAccessToken: accessToken,
      client,
    });
    if (!retryToken) {
      return { scanned: 0, changed: 0 }; // the helper has alerted
    }
    members = await fetchRoster(retryToken);
  }

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
  //
  // The budget counts CHANGED members only, so it can never fire on the
  // backfill: a first sighting records no change and does not increment
  // `changed`. That is deliberate -- the backfill is 100% first sightings and
  // its fetches are the whole reason later changes have a before-image.
  const thumbBudget = Math.ceil(members.length * SYSTEMIC_CHANGE_RATIO);

  // Separate from thumbBudget above and charged only for heals; see
  // HEAL_BUDGET_MS for why it is measured in time rather than members.
  const healBudget = new HealBudget();

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
        healBudget,
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
  return { scanned, changed, roster: members };
}
