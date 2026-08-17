import { GuildMember } from 'discord.js';
import { Logger } from 'tslog';

import { ApplicationIdentityRepository } from '../../util/identityRepository.js';
import { ChangeSource, IdentityChange } from '../repositories/identityTypes.js';
import { diffIdentity } from './identityDiff.js';
import { snapshotMember } from './identitySnapshot.js';
import { fetchChangeThumbs } from './identityThumbs.js';

const logger = new Logger({ name: 'identityMonitor' });

/**
 * Diffs a member against their stored baseline, persists any changes with
 * thumbnails, and advances the baseline.
 *
 * Returns the changes so callers can log them. An unchanged member costs no
 * write at all, which matters because the daily sweep calls this for every
 * member in the guild.
 */
export async function recordIdentityFor(
  member: GuildMember,
  source: ChangeSource,
): Promise<IdentityChange[]> {
  if (member.user.bot) {
    return [];
  }
  const repo = await ApplicationIdentityRepository();
  if (!repo) {
    return [];
  }

  const after = snapshotMember(member);
  const before = await repo.getSnapshot(member.id);
  const changes = diffIdentity(before, after);

  if (!before) {
    await repo.putSnapshot(after);
    return [];
  }
  if (changes.length === 0) {
    return [];
  }

  const thumbs = await fetchChangeThumbs(changes, member.guild.id);
  // Record before advancing the baseline, not after. Crash here and the
  // next sweep just re-diffs and records a harmless duplicate row. Reversed,
  // a crash would advance the baseline while losing the evidence for good --
  // the old snapshot is gone, so the change can't be reconstructed.
  await repo.recordChanges(changes, source, thumbs);
  await repo.putSnapshot(after);
  logger.info(
    `Recorded ${changes.length} identity change(s) for ${member.id} via ${source}`,
  );
  return changes;
}

/**
 * Advances the baseline without recording anything. Used after the bot writes
 * a member's nickname during onboarding, so its own writes never appear in
 * the digest as suspicious name changes.
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
  await repo.putSnapshot(snapshotMember(member));
}
