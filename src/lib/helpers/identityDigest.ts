import { Client } from 'discord.js';
import { Logger } from 'tslog';

import { ApplicationCache } from '../../util/cache.js';
import { ApplicationIdentityRepository } from '../../util/identityRepository.js';
import {
  IdentityChangeMetadata,
  IdentityField,
} from '../repositories/identityTypes.js';
import { LogEntry, logAlert } from './discordLogger.js';
import { runIdentitySweep } from './identitySweep.js';

const logger = new Logger({ name: 'identityDigest' });

// One hour after the unlinked digest (DIGEST_UTC_HOUR = 17), deliberately.
// Both digests make a full-guild member pass; sharing an hour meant two
// concurrent 2,008-member fetches on a dyno with an R14 history.
export const IDENTITY_DIGEST_UTC_HOUR = 18; // ≈ 10-11am Pacific
const TICK_MS = 60 * 60 * 1000; // hourly
const MAX_DESCRIPTION = 4096; // Discord's hard embed description limit

const FIELD_LABELS: Record<IdentityField, string> = {
  user_avatar: 'user avatar',
  member_avatar: 'server avatar',
  nickname: 'nickname',
  username: 'username',
  global_name: 'display name',
};

export type AnnotatedChange = IdentityChangeMetadata & { revertedAt?: Date };

export function shouldRunIdentityDigestNow(now: Date): boolean {
  return now.getUTCHours() === IDENTITY_DIGEST_UTC_HOUR;
}

/**
 * Marks a change that was later undone by the same member on the same field.
 * A transient change is the signature of impersonation-then-cleanup, and it
 * is invisible to a snapshot diff -- both endpoints look identical.
 */
export function annotateReverts(
  changes: IdentityChangeMetadata[],
): AnnotatedChange[] {
  return changes.map((change) => {
    const revert = changes.find(
      (other) =>
        other.id !== change.id &&
        other.discordUserId === change.discordUserId &&
        other.field === change.field &&
        other.detectedAt > change.detectedAt &&
        other.newValue === change.oldValue,
    );
    return revert ? { ...change, revertedAt: revert.detectedAt } : change;
  });
}

function line(change: AnnotatedChange): string {
  const time = change.detectedAt.toISOString().slice(11, 16);
  const label = FIELD_LABELS[change.field];
  const reverted = change.revertedAt
    ? ` (reverted ${change.revertedAt.toISOString().slice(11, 16)})`
    : '';
  if (change.field === 'user_avatar' || change.field === 'member_avatar') {
    return `${time}  <@${change.discordUserId}>  ${label} changed${reverted}`;
  }
  return `${time}  <@${change.discordUserId}>  ${label} "${
    change.oldValue ?? '—'
  }" → "${change.newValue ?? '—'}"${reverted}`;
}

export function formatIdentityDigest(
  changes: AnnotatedChange[],
  stats: { changeCount: number; totalBytes: number },
): LogEntry | undefined {
  if (changes.length === 0) {
    return undefined;
  }
  const footer = `\n\nStorage: ${stats.changeCount.toLocaleString(
    'en-US',
  )} changes on record, ${Math.round(stats.totalBytes / 1_000_000)} MB`;

  const lines: string[] = [];
  let used = footer.length;
  let shown = 0;
  for (const change of changes) {
    const next = `${line(change)}\n`;
    // Reserve room for the overflow note so a flood degrades to a truncated
    // digest rather than a rejected one.
    if (used + next.length > MAX_DESCRIPTION - 40) {
      break;
    }
    lines.push(next);
    used += next.length;
    shown += 1;
  }
  const overflow = changes.length - shown;
  const overflowNote = overflow > 0 ? `…and ${overflow} more\n` : '';

  return {
    title: `Identity changes: ${changes.length} in the last 24h`,
    description: `${lines.join('')}${overflowNote}${footer}`,
  };
}

/**
 * The 24h window this digest covers, anchored to the digest hour rather than
 * to "now".
 *
 * The claim is keyed by calendar date, so the window has to line up with it.
 * A `now - 24h` window drifts with the actual run time: yesterday's run at
 * 18:03 and today's at 18:41 leave the 18:03-18:41 changes in neither digest,
 * and a run that slips earlier reports the same changes twice. Anchoring both
 * ends to the digest hour makes consecutive days exactly contiguous.
 */
export function identityDigestWindow(now: Date): { since: Date; until: Date } {
  const until = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      IDENTITY_DIGEST_UTC_HOUR,
      0,
      0,
      0,
    ),
  );
  return { since: new Date(until.getTime() - 24 * 60 * 60 * 1000), until };
}

export async function runIdentityDigestOnce(client: Client): Promise<void> {
  const repo = await ApplicationIdentityRepository();
  if (!repo) {
    return;
  }

  // Claim the day BEFORE the sweep, not after. The sweep is a full
  // 2,008-member pass; running it first means any dyno restart during the
  // digest hour -- a mid-morning Pacific deploy being the likeliest -- pays
  // for a second full pass whose work is then thrown away at the claim.
  // exclusive_set guards against double-posts across restarts; the cache TTL
  // is fine because the key encodes the date.
  const cache = await ApplicationCache();
  const claimKey = `identity-digest-${new Date().toISOString().slice(0, 10)}`;
  const claimed = await cache.exclusive_set(claimKey, '1');
  if (!claimed) {
    return;
  }

  try {
    // Reconcile first so the digest includes anything missed while the dyno
    // was restarting. `since` stays anchored to the digest hour (computed
    // before the sweep runs) so consecutive days remain exactly contiguous.
    // The sweep itself is a full 2,008-member pass that finishes some time
    // after that boundary, and every row it writes is stamped with
    // `detected_at` at or after that moment -- so `until` is extended to the
    // time the sweep actually finished, not left at the fixed boundary it
    // ran past. Without that, the sweep's own findings -- the changes least
    // likely to have been caught any other way -- would miss today's digest
    // and only surface in tomorrow's, 24 hours late.
    const { since, until: boundary } = identityDigestWindow(new Date());
    await runIdentitySweep(client, 'sweep');
    const until = new Date(Math.max(boundary.getTime(), Date.now()));

    const changes = await repo.listChangesMetadataBetween(since, until);
    const stats = await repo.storageStats();

    const entry = formatIdentityDigest(annotateReverts(changes), stats);
    if (entry) {
      // logAlert swallows every error by design, so an outage or a permission
      // change would otherwise leave the claim consumed, a success logged, no
      // digest, and no retry. Verify the post landed.
      const posted = await logAlert(client, entry);
      if (!posted) {
        throw new Error(
          'identity digest could not be posted to the alerts channel',
        );
      }
    }
    logger.info(`Identity digest ran: ${changes.length} changes`);
  } catch (error) {
    // Release the day so a restart inside the digest hour retries. That is
    // the only retry path: `setInterval` is anchored to process boot, so the
    // next hourly tick lands at the same minute of hour 19 and
    // `shouldRunIdentityDigestNow` rejects it -- without a restart, the day
    // is simply skipped, not retried. Guard the release itself: if the cache
    // is unavailable, `remove` can throw too, and letting that escape would
    // replace the original failure with a cache error while still leaving
    // the claim consumed.
    try {
      await cache.remove(claimKey);
    } catch (releaseError) {
      logger.error(
        `Failed to release identity digest claim: ${String(releaseError)}`,
      );
    }
    throw error;
  }
}

export function startIdentityDigestScheduler(client: Client): void {
  const tick = () => {
    if (!shouldRunIdentityDigestNow(new Date())) {
      return;
    }
    runIdentityDigestOnce(client).catch((error) =>
      logger.error(`Identity digest failed: ${String(error)}`),
    );
  };
  tick();
  setInterval(tick, TICK_MS);
}
