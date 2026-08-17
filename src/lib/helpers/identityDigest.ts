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

export const IDENTITY_DIGEST_UTC_HOUR = 17; // ≈ 9-10am Pacific
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

export async function runIdentityDigestOnce(client: Client): Promise<void> {
  const repo = await ApplicationIdentityRepository();
  if (!repo) {
    return;
  }

  // Reconcile first so the digest includes anything missed while the dyno was
  // restarting, then report.
  await runIdentitySweep(client, 'sweep');

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const changes = await repo.listChangesSince(since);
  const stats = await repo.storageStats();

  // Claim the day only after the fallible work succeeds, so a failed run
  // leaves the claim unconsumed and a restart within the hour can retry.
  const cache = await ApplicationCache();
  const today = new Date().toISOString().slice(0, 10);
  const claimed = await cache.exclusive_set(`identity-digest-${today}`, '1');
  if (!claimed) {
    return;
  }

  const entry = formatIdentityDigest(annotateReverts(changes), stats);
  if (entry) {
    await logAlert(client, entry);
  }
  logger.info(`Identity digest ran: ${changes.length} changes`);
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
