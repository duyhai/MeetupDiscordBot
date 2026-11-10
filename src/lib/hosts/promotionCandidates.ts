import dayjs from 'dayjs';

import { GUEST_HOST_MEETUP_BLACKLIST } from '../../constants.js';
import { mapWithConcurrency } from '../client/meetup/paginationHelper.js';
import { HostEvent, HostEventsDeps } from './hostEvents.js';

/** Past hosted events a regular host needs to be listed (spec "Promotion"). */
export const PROMOTION_MIN_EVENTS = 20;
/**
 * Hosts are found among the past year's events: someone who has not hosted
 * in a year is not someone to promote, and the group's whole history would
 * be thousands of events to read.
 */
export const CANDIDATE_WINDOW_DAYS = 365;
const COUNT_CONCURRENCY = 4;

export interface HostSeen {
  meetupMemberId: string;
  name: string;
  /** ISO start of their latest past event in the window. */
  lastHosted: string;
}

export interface PromotionCandidate extends HostSeen {
  /** Every PAST group event they hosted, not just the window's. */
  pastCount: number;
}

export interface CandidateDeps {
  fetchGroupEvents: HostEventsDeps['fetchGroupEvents'];
  /** All-time PAST hosted events for one member (a totalCount query). */
  pastHostedCount: (meetupMemberId: string) => Promise<number>;
  now: () => Date;
}

/** Every host of the window's past events, latest event each. */
export function hostsSeen(events: HostEvent[]): Map<string, HostSeen> {
  const seen = new Map<string, HostSeen>();
  for (const event of events) {
    for (const host of event.hosts) {
      if (!/^[1-9][0-9]{0,19}$/.test(host.id)) {
        continue;
      }
      const known = seen.get(host.id);
      if (
        known === undefined ||
        dayjs(event.dateTime).isAfter(dayjs(known.lastHosted))
      ) {
        seen.set(host.id, {
          meetupMemberId: host.id,
          name: host.name,
          lastHosted: event.dateTime,
        });
      }
    }
  }
  return seen;
}

/**
 * Regular hosts with PROMOTION_MIN_EVENTS or more past hosted events, most
 * first: hosts of the past year's events, less anyone in `excluded` (the
 * active Community Hosts) or on the Meetup blacklist.
 */
export async function promotionCandidates(
  deps: CandidateDeps,
  excluded: ReadonlySet<string>,
): Promise<{ candidates: PromotionCandidate[]; seen: Map<string, HostSeen> }> {
  const now = dayjs(deps.now());
  const events = await deps.fetchGroupEvents({
    status: ['PAST'],
    afterDateTime: now.subtract(CANDIDATE_WINDOW_DAYS, 'day').toISOString(),
    beforeDateTime: now.toISOString(),
  });
  const seen = hostsSeen(events);
  const toCount = [...seen.values()].filter(
    (h) =>
      !excluded.has(h.meetupMemberId) &&
      !GUEST_HOST_MEETUP_BLACKLIST.includes(h.meetupMemberId),
  );
  const counted = await mapWithConcurrency(
    toCount,
    COUNT_CONCURRENCY,
    async (host) => ({
      ...host,
      pastCount: await deps.pastHostedCount(host.meetupMemberId),
    }),
  );
  const candidates = counted
    .filter((c) => c.pastCount >= PROMOTION_MIN_EVENTS)
    .sort(
      (a, b) =>
        b.pastCount - a.pastCount ||
        a.name.localeCompare(b.name) ||
        a.meetupMemberId.localeCompare(b.meetupMemberId),
    );
  return { candidates, seen };
}

/**
 * `read` kept for `ttlMs`, one read at a time (a second caller awaits the
 * first). A failure is not kept, so the next call reads again. The read
 * carries on after a caller stops waiting, so a slow first read is ready
 * for the reload.
 */
export function singleFlight<T>(
  read: () => Promise<T>,
  ttlMs: number,
  now: () => number = Date.now,
): () => Promise<T> {
  let kept: { at: number; value: T } | undefined;
  let inFlight: Promise<T> | undefined;
  return async () => {
    if (kept !== undefined && now() - kept.at < ttlMs) {
      return kept.value;
    }
    if (inFlight === undefined) {
      const pending = read()
        .then((value) => {
          kept = { at: now(), value };
          return value;
        })
        .finally(() => {
          inFlight = undefined;
        });
      // A caller that gave up still leaves this handled.
      pending.catch(() => undefined);
      inFlight = pending;
    }
    return inFlight;
  };
}
