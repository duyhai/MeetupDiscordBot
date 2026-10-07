import { GuildMember } from 'discord.js';
import { Logger } from 'tslog';

import { ApplicationIdentityRepository } from '../../../util/identityRepository.js';
import { PostgresIdentityRepository } from '../../repositories/postgresIdentityRepository.js';
import {
  IdentityBaselineThumbs,
  IdentityChange,
  IdentitySnapshot,
  StoredIdentitySnapshot,
  WritableChangeSource,
} from '../../repositories/identityTypes.js';
import { diffIdentity } from './diff.js';
import { HealBudget } from './healBudget.js';
import { snapshotMember } from './snapshot.js';
import {
  fetchBaselineThumbs,
  fetchMissingBaselineThumbs,
  needsThumbHeal,
  resolveChangeThumbs,
} from './thumbs.js';

const logger = new Logger({ name: 'identityMonitor' });

/**
 * Fills in the images an unchanged baseline is missing, within the run's
 * time budget. Best-effort end to end: a failed fetch writes nothing, and
 * any error is logged and swallowed -- healing is an aid to future evidence,
 * never a reason for the sweep to report this member as failed.
 *
 * The write passes ONLY the healed thumb keys, so the conditional upsert
 * leaves every other column's image alone; the snapshot is the current one,
 * which (no change having been found) matches the stored baseline.
 */
async function healBaselineThumbs(
  repo: PostgresIdentityRepository,
  baseline: StoredIdentitySnapshot,
  current: IdentitySnapshot,
  guildId: string,
  budget: HealBudget,
): Promise<void> {
  if (!needsThumbHeal(baseline) || budget.exhausted) {
    return;
  }
  try {
    await budget.spend(async () => {
      const healed = await fetchMissingBaselineThumbs(baseline, guildId);
      if (Object.keys(healed).length > 0) {
        await repo.putSnapshot(current, healed);
      }
    });
  } catch (error: unknown) {
    logger.warn(
      `Baseline thumbnail heal failed for ${baseline.discordUserId}: ${String(error)}`,
    );
  }
}

/**
 * Diffs a member against their stored baseline, persists any changes with
 * thumbnails, and advances the baseline.
 *
 * Returns the changes so callers can log them. An unchanged member whose
 * baseline already has its images costs no write at all, which matters
 * because the daily sweep calls this for every member in the guild.
 *
 * `healBudget`, when given, lets an unchanged member's missing baseline
 * images be fetched and stored (see healBaselineThumbs). The sweep passes
 * one budget for its whole run; without one, nothing is healed.
 */
export async function recordIdentityFor(
  member: GuildMember,
  source: WritableChangeSource,
  healBudget?: HealBudget,
): Promise<IdentityChange[]> {
  if (member.user.bot) {
    return [];
  }
  const repo = await ApplicationIdentityRepository();
  if (!repo) {
    return [];
  }

  const after = snapshotMember(member);

  const before = await repo.getSnapshot(after.scopeId, member.id);
  const changes = diffIdentity(before, after);

  if (!before) {
    // No change to record -- the first sighting IS the baseline -- but this
    // is the only moment the member's current avatars are still fetchable at
    // a URL we can construct. Capture them now so their eventual replacement
    // has a real before-image.
    const baselineThumbs = await fetchBaselineThumbs(after, member.guild.id);
    await repo.putSnapshot(after, baselineThumbs);
    return [];
  }
  if (changes.length === 0) {
    if (healBudget) {
      await healBaselineThumbs(
        repo,
        before,
        after,
        member.guild.id,
        healBudget,
      );
    }
    return [];
  }

  // `before` is the pre-advance baseline read above, so the old thumbs it
  // carries are the images being superseded. Reading it again after
  // putSnapshot would return the new ones instead.
  const { thumbs, baselineThumbs } = await resolveChangeThumbs(
    changes,
    member.guild.id,
    before,
  );
  // Record before advancing the baseline, not after. Crash here and the
  // next sweep just re-diffs and records a harmless duplicate row. Reversed,
  // a crash would advance the baseline while losing the evidence for good --
  // the old snapshot is gone, so the change can't be reconstructed.
  await repo.recordChanges(changes, source, thumbs);
  await repo.putSnapshot(after, baselineThumbs);
  logger.info(
    `Recorded ${changes.length} identity change(s) for ${member.id} via ${source}`,
  );
  return changes;
}

/**
 * Advances the baseline without recording anything. Used after the bot writes
 * a member's nickname during onboarding, so its own writes never appear in
 * the digest as suspicious name changes.
 *
 * Fetches no thumbs: this runs inline in an onboarding interaction, where
 * CDN fetches would be latency a user waits on. But it cannot simply leave
 * the stored images untouched either: if the member changed an avatar since
 * the last sweep, this write advances the hash, and a stale thumb surviving
 * under the new hash is non-null -- so needsThumbHeal never fires and the
 * member's next change records the wrong before-image. So the stored
 * baseline is read first, and any thumbed field whose hash this write moves
 * gets an explicit null (clear); the sweep's heal path then fetches the
 * right image next run. Unmoved hashes keep their images (key omitted).
 */
export async function updateBaselineSilently(
  member: GuildMember,
): Promise<void> {
  if (member.user.bot) {
    return;
  }
  const repo = await ApplicationIdentityRepository();
  if (!repo) {
    return;
  }
  const after = snapshotMember(member);
  const before = await repo.getSnapshot(after.scopeId, member.id);
  const staleThumbClears: IdentityBaselineThumbs = {};
  if (before && before.userAvatarHash !== after.userAvatarHash) {
    staleThumbClears.userAvatarThumb = null;
  }
  if (before && before.memberAvatarHash !== after.memberAvatarHash) {
    staleThumbClears.memberAvatarThumb = null;
  }
  await repo.putSnapshot(
    after,
    Object.keys(staleThumbClears).length > 0 ? staleThumbClears : undefined,
  );
}
