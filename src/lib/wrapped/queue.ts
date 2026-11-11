/**
 * The queue for throttled Wrapped requests: a member who hits the hourly
 * limit with nothing cached is queued (one year per member) and told when
 * the backfill tick (backfill.ts) will have built it. The tick drains the
 * queue first, MEMBERS_PER_TICK a tick, so the promise is a count of ticks
 * from the next one, pushed past the identity sweep's quiet hour.
 */
import dayjs from 'dayjs';

import { KeyValueCache } from '../cache/base.js';
import { IDENTITY_DIGEST_UTC_HOUR } from '../helpers/identity/digest.js';
import { WrappedBackfillStore } from '../repositories/postgresWrappedBackfillRepository.js';
import { tz } from '../../util/timezone.js';
import { WrappedTiers, readEntry } from './store.js';

export const BACKFILL_TICK_MS = 5 * 60_000;
export const MEMBERS_PER_TICK = 4;
/** The scheduler writes the next tick's start here (ISO) on every tick. */
export const NEXT_TICK_KEY = 'wrapped-backfill-next-tick';

/** The identity sweep's hour (18:00–19:00 UTC): no tick does any work in it. */
function quietHourEnd(at: Date): Date | undefined {
  if (at.getUTCHours() !== IDENTITY_DIGEST_UTC_HOUR) {
    return undefined;
  }
  const end = new Date(at);
  end.setUTCHours(IDENTITY_DIGEST_UTC_HOUR + 1, 0, 0, 0);
  return end;
}

/**
 * When a request at `position` (1-based) in the queue will have been built:
 * the next tick, plus one tick per MEMBERS_PER_TICK entries ahead of it, each
 * tick moved past the quiet hour when it would fall inside.
 */
export function readyBy(nextTickAt: Date, position: number): Date {
  let at = new Date(nextTickAt);
  const ticksAhead = Math.floor((Math.max(1, position) - 1) / MEMBERS_PER_TICK);
  for (let tick = 0; tick <= ticksAhead; tick += 1) {
    if (tick > 0) {
      at = new Date(at.getTime() + BACKFILL_TICK_MS);
    }
    const end = quietHourEnd(at);
    if (end) {
      at = end;
    }
  }
  return at;
}

export type QueueOutcome =
  | { kind: 'queued' | 'already'; year: number; readyBy: Date }
  | { kind: 'cached' };

/**
 * Queues the member's year unless a copy for their current Meetup id is
 * already stored (then there is nothing to wait for: 'cached'). The same
 * year queued again reads as 'queued'; another year already queued is
 * 'already' with that year. The ready-by time counts from the recorded next
 * tick, or one tick from now when the job has not recorded one yet.
 */
export async function queueForLater(
  store: WrappedBackfillStore,
  tiers: WrappedTiers,
  member: { discordUserId: string; meetupId: string },
  year: number,
  now: Date,
): Promise<QueueOutcome> {
  const { cache } = tiers;
  if (
    await readEntry(tiers, member.discordUserId, year, member.meetupId, now)
  ) {
    return { kind: 'cached' };
  }
  const result = await store.enqueue({
    discordUserId: member.discordUserId,
    meetupId: member.meetupId,
    year,
  });
  const nextTick = await nextTickAt(cache, now);
  const position = (await store.position(member.discordUserId))?.position ?? 1;
  const at = readyBy(nextTick, position);
  return result === 'queued' || result.already === year
    ? { kind: 'queued', year, readyBy: at }
    : { kind: 'already', year: result.already, readyBy: at };
}

/** The next tick the scheduler recorded, if it is running and the time is still ahead. */
export async function recordedNextTick(
  cache: KeyValueCache,
  now: Date,
): Promise<Date | undefined> {
  const raw = await cache.get(NEXT_TICK_KEY);
  const parsed = raw ? new Date(raw) : undefined;
  return parsed && Number.isFinite(parsed.getTime()) && parsed > now
    ? parsed
    : undefined;
}

/** The recorded next tick, else one tick from now (the promise still needs a time). */
export async function nextTickAt(
  cache: KeyValueCache,
  now: Date,
): Promise<Date> {
  return (
    (await recordedNextTick(cache, now)) ??
    new Date(now.getTime() + BACKFILL_TICK_MS)
  );
}

export function queuedText(
  outcome: Exclude<QueueOutcome, { kind: 'cached' }>,
  format: (at: Date) => string,
): string {
  const when = format(outcome.readyBy);
  return outcome.kind === 'queued'
    ? `Queued — it'll be ready by about ${when}.`
    : `You already have ${outcome.year} queued; it'll be ready by about ${when}.`;
}

/** Pacific wall-clock time for the website. */
export const pacificClock = (at: Date): string =>
  tz(dayjs(at)).format('h:mm a');
/** Discord's short-time timestamp, rendered in each reader's own zone. */
export const discordClock = (at: Date): string =>
  `<t:${Math.floor(at.getTime() / 1000)}:t>`;
