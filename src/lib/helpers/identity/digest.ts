import { Client } from 'discord.js';
import { Logger } from 'tslog';

import { ApplicationCache } from '../../../util/cache.js';
import { ApplicationIdentityRepository } from '../../../util/identityRepository.js';
import { ApplicationMemberRepository } from '../../../util/memberRepository.js';
import {
  IdentityChangeMetadata,
  IdentityField,
  IdentityPlatform,
} from '../../repositories/identityTypes.js';
import { LogEntry, logAlert } from '../discordLogger.js';
import { runMeetupSweep } from './meetupSweep.js';
import { runIdentitySweep } from './sweep.js';

const logger = new Logger({ name: 'identityDigest' });

// One hour after the unlinked digest (DIGEST_UTC_HOUR = 17), deliberately.
// Both digests make a full-guild member pass; sharing an hour meant two
// concurrent 2,008-member fetches on a dyno with an R14 history.
export const IDENTITY_DIGEST_UTC_HOUR = 18; // ≈ 10-11am Pacific

/**
 * Ticks are quarter-hourly, not hourly, and the difference is the whole point
 * of the claim/done split below.
 *
 * `setInterval` is anchored to process boot, so with an hourly tick there is
 * exactly ONE opportunity per process inside the digest hour. A run killed
 * mid-flight therefore had no "next tick" to retry it -- the following tick
 * lands in hour 19 and `shouldRunIdentityDigestNow` rejects it. An expiring
 * lease only helps if something is still checking after it expires.
 *
 * Four opportunities per hour, each a no-op outside hour 18 and each stopped
 * immediately by the done-marker or the live claim inside it, is enough for a
 * lapsed lease to be picked up while costing nothing on a normal day.
 */
const TICK_MS = 15 * 60 * 1000;

/**
 * How long a run may hold the day before another tick may take it over.
 *
 * Sized above a plausible worst-case run (two sequential roster passes over
 * ~8,000 members, ~60 paginated API requests, plus thumbnail fetches: minutes,
 * not tens of minutes) and below the digest hour, so a killed run's lease
 * lapses while ticks are still checking.
 *
 * The residual risk is a run that genuinely exceeds this, where a second tick
 * could start a concurrent pass and post a second digest. That is the right
 * way round: this feature's own failure doctrine already prefers a duplicate
 * row to lost evidence, and a duplicate digest is noise while a skipped day
 * is a change that is never reported at all.
 */
const CLAIM_TTL_SEC = 30 * 60;

/**
 * Long enough to outlast the digest hour comfortably, and set explicitly
 * because neither cache default is safe here: InMemoryCache expires items
 * after 50 minutes, which is shorter than the hour this marker has to cover.
 * The key encodes the date, so a generous value cannot block tomorrow.
 */
const DONE_TTL_SEC = 12 * 60 * 60;

const MAX_DESCRIPTION = 4096; // Discord's hard embed description limit

// Short on purpose: every line already carries a platform label (below), so
// these do not need to repeat "Meetup" -- they only need to read as distinct
// from Discord's "user avatar"/"server avatar"/"display name" at a glance.
const FIELD_LABELS: Record<IdentityField, string> = {
  user_avatar: 'user avatar',
  member_avatar: 'server avatar',
  nickname: 'nickname',
  username: 'username',
  global_name: 'display name',
  photo: 'profile photo',
  name: 'name',
};

const PLATFORM_LABELS: Record<IdentityPlatform, string> = {
  discord: 'Discord',
  meetup: 'Meetup',
};

// Fields whose stored value is an opaque id/hash, not human-readable text --
// rendering "old" -> "new" for these would show hashes, not information.
const PHOTO_LIKE_FIELDS = new Set<IdentityField>([
  'user_avatar',
  'member_avatar',
  'photo',
]);

export type AnnotatedChange = IdentityChangeMetadata & { revertedAt?: Date };

export function shouldRunIdentityDigestNow(now: Date): boolean {
  return now.getUTCHours() === IDENTITY_DIGEST_UTC_HOUR;
}

/**
 * What an organizer may be told about a failure.
 *
 * Errors this codebase composes itself (PaginationCapError,
 * MeetupGroupUnreadableError) mark themselves `organizerSafeMessage` and
 * their text is the actionable part. Everything else -- a graphql-request
 * ClientError above all -- embeds the raw upstream response body, which must
 * never reach Discord, so only the class name is surfaced and the full error
 * goes to the process log.
 */
function safeErrorSummary(error: unknown): string {
  if (
    error instanceof Error &&
    (error as { organizerSafeMessage?: boolean }).organizerSafeMessage === true
  ) {
    return error.message;
  }
  if (error instanceof Error) {
    return `${error.name} (details in the process log)`;
  }
  return 'unknown error (details in the process log)';
}

/**
 * Runs one reconciliation sweep so that its failure DEGRADES the digest
 * instead of cancelling it.
 *
 * Both sweeps used to run bare inside the claim's try. A single 502 or 429 on
 * one Meetup roster page propagated out, released the claim, and was swallowed
 * by the scheduler's catch -- producing no digest for EITHER platform, no
 * alert, and (because the reporting window only ever moves forward) no later
 * report of the changes that were already recorded. A Meetup outage silently
 * erased a day of Discord monitoring too.
 *
 * Reconciliation is an enhancement to the digest, not a precondition for it:
 * the change log already holds everything the event listeners caught, and the
 * next sweep re-detects whatever this one missed. So a failure here is
 * announced and stepped over.
 */
async function runSweepOrDegrade(
  platform: string,
  client: Client,
  sweep: () => Promise<unknown>,
): Promise<void> {
  try {
    await sweep();
  } catch (error: unknown) {
    logger.error(`${platform} identity sweep failed: ${String(error)}`);
    await logAlert(client, {
      title: `${platform} identity sweep failed`,
      description:
        `Today's ${platform} reconciliation pass did not complete: ` +
        `${safeErrorSummary(error)}\n\n` +
        `The rest of the digest is unaffected -- changes already recorded ` +
        `are still reported below, and the next sweep re-checks whatever ` +
        `this pass missed.`,
    });
  }
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
        other.subjectId === change.subjectId &&
        other.field === change.field &&
        other.detectedAt > change.detectedAt &&
        other.newValue === change.oldValue,
    );
    return revert ? { ...change, revertedAt: revert.detectedAt } : change;
  });
}

/**
 * A Discord change's subject IS a Discord user id -- `<@id>` always renders.
 * A Meetup change's subject is a Meetup member id, which is meaningless as a
 * Discord mention; resolve it through the link table when possible, and fall
 * back to the raw id (never to a broken `<@undefined>`) when it is not.
 */
function mentionFor(
  change: AnnotatedChange,
  meetupToDiscord: Map<string, string>,
): string {
  if (change.platform === 'discord') {
    return `<@${change.subjectId}>`;
  }
  const discordId = meetupToDiscord.get(change.subjectId);
  return discordId ? `<@${discordId}>` : change.subjectId;
}

function line(
  change: AnnotatedChange,
  meetupToDiscord: Map<string, string>,
): string {
  const time = change.detectedAt.toISOString().slice(11, 16);
  const label = FIELD_LABELS[change.field];
  const platform = PLATFORM_LABELS[change.platform];
  const who = mentionFor(change, meetupToDiscord);
  const reverted = change.revertedAt
    ? ` (reverted ${change.revertedAt.toISOString().slice(11, 16)})`
    : '';
  if (PHOTO_LIKE_FIELDS.has(change.field)) {
    return `${time}  ${platform}  ${who}  ${label} changed${reverted}`;
  }
  return `${time}  ${platform}  ${who}  ${label} "${
    change.oldValue ?? '—'
  }" → "${change.newValue ?? '—'}"${reverted}`;
}

export function formatIdentityDigest(
  changes: AnnotatedChange[],
  stats: { changeCount: number; totalBytes: number },
  since: Date,
  meetupToDiscord: Map<string, string>,
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
    const next = `${line(change, meetupToDiscord)}\n`;
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
    title: `Identity changes: ${changes.length} since ${since
      .toISOString()
      .slice(0, 16)
      .replace('T', ' ')} UTC`,
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

  // Two keys, because "someone is running this" and "this day is finished"
  // are different facts and were previously conflated into one.
  //
  // A single long-lived claim meant a run killed mid-flight consumed the day
  // silently: the claim is only released on a thrown error, and SIGTERM does
  // not throw. Heroku sends SIGTERM on every deploy, and deploys land in the
  // 17:00-19:00 UTC window (mid-morning Pacific) routinely -- so the digest
  // hour is exactly when the process is most likely to be killed.
  //
  // Now: the DONE marker records completion and is checked first, so a
  // finished day never re-runs. The CLAIM is only a lease held while the work
  // is in progress, with a TTL sized to how long the work plausibly takes, so
  // a killed run's claim lapses and a later tick in the same hour picks the
  // day back up.
  const cache = await ApplicationCache();
  const today = new Date().toISOString().slice(0, 10);
  const doneKey = `identity-digest-done-${today}`;
  const claimKey = `identity-digest-${today}`;

  // Completion first. Without this the more frequent ticks below would
  // re-sweep and re-post all afternoon once the lease expired.
  if (await cache.get(doneKey)) {
    return;
  }

  // Claim the day BEFORE the sweep, not after. The sweep is a full
  // 2,008-member pass; running it first means any dyno restart during the
  // digest hour pays for a second full pass whose work is then thrown away
  // at the claim.
  const claimed = await cache.exclusive_set(claimKey, '1', CLAIM_TTL_SEC);
  if (!claimed) {
    return;
  }

  try {
    // Reconcile first so the digest includes anything missed while the dyno
    // was restarting. `since` stays anchored to the digest hour (computed
    // before the sweep runs) so consecutive days remain exactly contiguous.
    // Both sweeps are full passes (Discord: ~2,008 members; Meetup: ~6,000)
    // that finish some time after that boundary, and every row either writes
    // is stamped with `detected_at` at or after that moment -- so `until` is
    // extended to the time the sweeps actually finished, not left at the
    // fixed boundary they ran past. Without that, the sweeps' own findings --
    // the changes least likely to have been caught any other way -- would
    // miss today's digest and only surface in tomorrow's, 24 hours late.
    const { since, until: boundary } = identityDigestWindow(new Date());
    // Each sweep is guarded independently: one platform's API being down
    // must not cost the other platform its digest. See runSweepOrDegrade.
    await runSweepOrDegrade('Discord', client, () =>
      runIdentitySweep(client, 'sweep'),
    );
    await runSweepOrDegrade('Meetup', client, () =>
      runMeetupSweep('sweep', client),
    );
    const until = new Date(Math.max(boundary.getTime(), Date.now()));

    const changes = await repo.listChangesMetadataBetween(since, until);
    const stats = await repo.storageStats();

    // Built fresh each run rather than cached: a link created between
    // yesterday's digest and today's should resolve today, not tomorrow.
    const memberRepo = await ApplicationMemberRepository();
    const members = await memberRepo.listAll();
    const meetupToDiscord = new Map<string, string>();
    for (const member of members) {
      if (member.meetupId) {
        meetupToDiscord.set(member.meetupId, member.discordUserId);
      }
    }

    const entry = formatIdentityDigest(
      annotateReverts(changes),
      stats,
      since,
      meetupToDiscord,
    );
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
    // The day is finished. Written on a silent day too: nothing was posted,
    // but the work was done and redoing two full roster passes to re-discover
    // that nothing changed is pure waste.
    //
    // Written only here, after the post is confirmed landed, so every path
    // that throws above leaves the day unfinished and retryable.
    await cache.set(doneKey, '1', DONE_TTL_SEC);
    logger.info(`Identity digest ran: ${changes.length} changes`);
  } catch (error) {
    // Release the lease so a later tick inside the digest hour retries.
    // Guard the release itself: if the cache is unavailable, `remove` can
    // throw too, and letting that escape would replace the original failure
    // with a cache error while still leaving the claim consumed.
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
