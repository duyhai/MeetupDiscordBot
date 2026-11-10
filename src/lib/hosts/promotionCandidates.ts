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

export interface CandidateList {
  candidates: PromotionCandidate[];
  seen: Map<string, HostSeen>;
  /** Hosts whose count Meetup did not give: they may be missing. */
  uncounted: number;
}

/**
 * Regular hosts with PROMOTION_MIN_EVENTS or more past hosted events, most
 * first: hosts of the past year's events, less anyone in `excluded` (the
 * active Community Hosts) or on the Meetup blacklist. A host whose count
 * fails is left out and counted in `uncounted`, not the whole list.
 */
export async function promotionCandidates(
  deps: CandidateDeps,
  excluded: ReadonlySet<string>,
): Promise<CandidateList> {
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
    async (host) => {
      try {
        return {
          ...host,
          pastCount: await deps.pastHostedCount(host.meetupMemberId),
        };
      } catch {
        return undefined;
      }
    },
  );
  const candidates = counted
    .filter(
      (c): c is PromotionCandidate =>
        c !== undefined && c.pastCount >= PROMOTION_MIN_EVENTS,
    )
    .sort(
      (a, b) =>
        b.pastCount - a.pastCount ||
        a.name.localeCompare(b.name) ||
        a.meetupMemberId.localeCompare(b.meetupMemberId),
    );
  return {
    candidates,
    seen,
    uncounted: counted.filter((c) => c === undefined).length,
  };
}

/**
 * `read` kept for `ttlMs`, one read at a time (a second caller awaits the
 * first). A failure is not kept, so the next call reads again; nor is a
 * value `keep` refuses. A read slower than `timeoutMs` fails its callers
 * and frees the slot, so a hung read never pins every later caller. The
 * read carries on after a caller stops waiting, so a slow first read is
 * ready for the reload.
 */
export function singleFlight<T>(
  read: () => Promise<T>,
  ttlMs: number,
  options: {
    now?: () => number;
    timeoutMs?: number;
    keep?: (value: T) => boolean;
  } = {},
): () => Promise<T> {
  const now = options.now ?? Date.now;
  let kept: { at: number; value: T } | undefined;
  let inFlight: Promise<T> | undefined;
  return async () => {
    if (kept !== undefined && now() - kept.at < ttlMs) {
      return kept.value;
    }
    if (inFlight === undefined) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const reading = read().then((value) => {
        if (options.keep?.(value) ?? true) {
          kept = { at: now(), value };
        }
        return value;
      });
      const limited =
        options.timeoutMs === undefined
          ? reading
          : Promise.race([
              reading,
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                  reject(new Error('read timed out'));
                }, options.timeoutMs);
              }),
            ]);
      const pending = limited.finally(() => {
        clearTimeout(timer);
        if (inFlight === pending) {
          inFlight = undefined;
        }
      });
      // A caller that gave up still leaves these handled.
      reading.catch(() => undefined);
      pending.catch(() => undefined);
      inFlight = pending;
    }
    return inFlight;
  };
}
