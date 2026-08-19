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

/**
 * Caps how many rows a single digest run will read.
 *
 * The high-water mark removed the old ~24h time window, so if `logAlert`
 * fails for a stretch (an outage, a permission change) the mark never
 * advances and the next successful run would otherwise process everything
 * recorded since -- unbounded. Without this cap that both blows up the min/
 * max pass below at large sizes and makes `annotateReverts`'s O(n^2) scan
 * expensive. 5000 is comfortably above a busy day's volume and comfortably
 * below where either of those costs matters.
 */
export const DIGEST_PAGE_LIMIT = 5000;

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
        // M3: platform is part of the identity of a subject, not decoration.
        // Meetup member ids and Discord user ids are both opaque numeric
        // strings drawn from separate namespaces, so without this a collision
        // between the two lets one platform's change be reported as a revert
        // of the other's -- and `username` and `name` exist on both sides,
        // so the field check does not rule it out either.
        other.platform === change.platform &&
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

const stamp = (date: Date) => date.toISOString().slice(0, 16).replace('T', ' ');

export function formatIdentityDigest(
  changes: AnnotatedChange[],
  stats: { changeCount: number; totalBytes: number },
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
    // Reserve room for the overflow note (comfortably above its longest
    // realistic length -- "…and 5000 more — run /meetup_identity_report for
    // the full list\n" is 63 characters) so a flood degrades to a truncated
    // digest rather than a rejected one.
    if (used + next.length > MAX_DESCRIPTION - 80) {
      break;
    }
    lines.push(next);
    used += next.length;
    shown += 1;
  }
  const overflow = changes.length - shown;
  // The high-water mark still advances past these rows -- they are never
  // shown by a later digest -- so the note points at the one place they are
  // still visible.
  const overflowNote =
    overflow > 0
      ? `…and ${overflow} more — run /meetup_identity_report for the full list\n`
      : '';

  // The actual span of the rows included, not a nominal window. The digest no
  // longer selects by time at all -- it selects by change id -- so quoting a
  // notional 24h window would describe something that is not what was
  // queried. The rows are ordered by id, which is chronological.
  //
  // A single-pass reduce, not Math.min(...times)/Math.max(...times): spread
  // arguments blow the call stack around ~1e5 elements, and DIGEST_PAGE_LIMIT
  // still allows thousands of rows through here in one run.
  const { min: minTime, max: maxTime } = changes.reduce(
    (acc, change) => {
      const t = change.detectedAt.getTime();
      return { min: Math.min(acc.min, t), max: Math.max(acc.max, t) };
    },
    { min: Infinity, max: -Infinity },
  );
  const from = new Date(minTime);
  const to = new Date(maxTime);
  const range =
    from.getTime() === to.getTime()
      ? `at ${stamp(from)} UTC`
      : `${stamp(from)} to ${stamp(to)} UTC`;

  return {
    title: `Identity changes: ${changes.length} ${range}`,
    description: `${lines.join('')}${overflowNote}${footer}`,
  };
}

/**
 * The hour-anchored boundary used ONLY on the very first run, before a
 * high-water mark exists.
 *
 * Coverage is otherwise tracked by change id, not by time (see
 * listChangesMetadataAfterId). But the first digest after deploy has no mark
 * to start from, and starting from nothing would report the entire backfill --
 * thousands of rows -- as today's news. So the first run translates this
 * boundary into a starting id once, and every run after it is pure id
 * arithmetic.
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
    // Coverage is a high-water mark on the change log's BIGSERIAL id, not a
    // time window.
    //
    // The old window anchored `since` to the fixed digest hour but extended
    // `until` to whenever the sweeps finished, so the span
    // [boundary, sweep-finish] belonged to two consecutive digests at once.
    // Meetup rows are 100% sweep-detected and land squarely in that span, so
    // every Meetup change was reported exactly twice. Narrowing `until` back
    // to the boundary would have swapped double-reporting for a permanent
    // gap. An id mark has no seam to get wrong, and it also removes any
    // dependence on the dyno and Postgres clocks agreeing.
    const stored = await repo.getDigestCursor();
    // First run only: translate the hour boundary into an id, so the first
    // digest after deploy is bounded instead of replaying the whole backfill.
    const afterId =
      stored ??
      (await repo.changeIdBefore(identityDigestWindow(new Date()).since));

    // Reconcile before reading, so the digest includes what the sweeps find
    // as well as anything the event listeners caught. Each sweep is guarded
    // independently: one platform's API being down must not cost the other
    // platform its digest. See runSweepOrDegrade.
    await runSweepOrDegrade('Discord', client, () =>
      runIdentitySweep(client, 'sweep'),
    );
    await runSweepOrDegrade('Meetup', client, () =>
      runMeetupSweep('sweep', client),
    );

    // Fix the ceiling BEFORE reading the rows. Advancing to "the highest id
    // that exists when the digest finishes" instead would silently skip any
    // gateway event recorded between the read and the write -- a change that
    // is then never reported by any digest, which is the one outcome this
    // feature cannot tolerate. Anything above the ceiling simply waits for
    // tomorrow.
    const ceiling = await repo.maxChangeId();
    const changes = ceiling
      ? await repo.listChangesMetadataAfterId(
          afterId,
          ceiling,
          DIGEST_PAGE_LIMIT,
        )
      : [];
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
    // Advance to the id of the LAST ROW ACTUALLY RETURNED, not the
    // pre-computed ceiling: DIGEST_PAGE_LIMIT can cap the read below the
    // ceiling, and advancing past rows that were never read would skip them
    // forever, since the mark only moves forward. When nothing was returned
    // (a quiet stretch, or the range above the mark is empty) the ceiling is
    // exactly what was covered, so it is the correct value to fall back to.
    //
    // Advance the mark only once the digest has demonstrably been delivered.
    // Ordered before the done-marker on purpose: if this write fails, the run
    // throws, the day stays unfinished, and a retry reports the same rows
    // again. Duplicating a digest is recoverable by reading it twice; losing
    // the rows is not recoverable at all.
    const advanceTo =
      changes.length > 0 ? changes[changes.length - 1].id : ceiling;
    if (advanceTo) {
      await repo.setDigestCursor(advanceTo);
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
