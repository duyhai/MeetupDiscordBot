import dayjs from 'dayjs';

import type { KeyValueCache } from '../cache/base.js';
import type { EventSummary } from '../client/meetup/types.js';
import {
  actByDate,
  paymentNote,
  upcomingEvents,
} from '../helpers/noShowReport.js';
import { toEventRef } from '../reports/types.js';

/**
 * Live upcoming RSVPs for the workspace's suspension cards. Only derived
 * fields are ever stored: id, title, URL, time and a fixed payment label.
 * The event description and fee never leave `toEntry`.
 */
export interface UpcomingEvent {
  id: string;
  title: string;
  eventUrl: string;
  dateTime: string;
  payment: string | null;
}
export type MemberUpcoming =
  | { state: 'ok'; events: UpcomingEvent[]; fetchedAt: string }
  | { state: 'left'; fetchedAt: string };
export type UpcomingEntry =
  MemberUpcoming | { state: 'pending' } | { state: 'unavailable' };

/** At most 12 h by the global constraint; 6 h here. */
export const UPCOMING_CACHE_TTL_SEC = 6 * 60 * 60;
export const UPCOMING_DEADLINE_MS = 6000;
export const UPCOMING_MAX_MEMBERS = 50;

export interface UpcomingDeps {
  now(): Date;
  cache(): Promise<KeyValueCache>;
  /** Organizer read for these members: undefined = left the group. Rejects when Meetup or the token fails. */
  fetchMany(
    memberIds: string[],
  ): Promise<Map<string, EventSummary[] | undefined>>;
}

const MEMBER_ID = /^[0-9]{1,20}$/;
const cacheKey = (id: string) => `workspace-upcoming-v1-${id}`;

function toEntry(
  events: EventSummary[] | undefined,
  now: Date,
): MemberUpcoming {
  const fetchedAt = now.toISOString();
  if (events === undefined) {
    return { state: 'left', fetchedAt };
  }
  return {
    state: 'ok',
    fetchedAt,
    events: upcomingEvents(events, dayjs(now)).map((e) => ({
      ...toEventRef(e),
      payment: paymentNote(e) ?? null,
    })),
  };
}

function parseCached(text: string | undefined): MemberUpcoming | undefined {
  try {
    const v =
      text === undefined ? undefined : (JSON.parse(text) as MemberUpcoming);
    return v &&
      (v.state === 'ok' ? Array.isArray(v.events) : v.state === 'left')
      ? v
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Cache hits answer at once; misses are read in one organizer batch,
 * single-flight per member across concurrent page loads. What is not back by
 * the deadline is 'pending' (it still lands in the cache for the next load);
 * a Meetup or token failure is 'unavailable' and is not cached. Never rejects.
 */
export function createUpcomingLoader(
  deps: UpcomingDeps,
  deadlineMs = UPCOMING_DEADLINE_MS,
) {
  const inFlight = new Map<string, Promise<MemberUpcoming>>();
  return async (memberIds: string[]): Promise<Map<string, UpcomingEntry>> => {
    const ids = [
      ...new Set(
        memberIds.filter((id) => typeof id === 'string' && MEMBER_ID.test(id)),
      ),
    ].slice(0, UPCOMING_MAX_MEMBERS);
    const out = new Map<string, UpcomingEntry>();
    if (ids.length === 0) {
      return out;
    }
    let cache: KeyValueCache | undefined;
    try {
      cache = await deps.cache();
    } catch {
      cache = undefined; // a cache outage only costs Meetup calls
    }
    const cached = await Promise.all(
      ids.map(async (id) => {
        try {
          return parseCached(cache ? await cache.get(cacheKey(id)) : undefined);
        } catch {
          return undefined;
        }
      }),
    );
    const misses: string[] = [];
    ids.forEach((id, i) => {
      const hit = cached[i];
      if (hit) {
        out.set(id, hit);
      } else {
        misses.push(id);
      }
    });
    const fresh = misses.filter((id) => !inFlight.has(id));
    if (fresh.length > 0) {
      let batch: Promise<Map<string, EventSummary[] | undefined>>;
      try {
        batch = deps.fetchMany(fresh);
      } catch (e) {
        batch = Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
      batch.catch(() => undefined); // observed per member below
      for (const id of fresh) {
        const one = batch
          .then(async (byId) => {
            const entry = toEntry(byId.get(id), deps.now());
            if (cache) {
              await cache
                .set(
                  cacheKey(id),
                  JSON.stringify(entry),
                  UPCOMING_CACHE_TTL_SEC,
                )
                .catch(() => undefined);
            }
            return entry;
          })
          .finally(() => inFlight.delete(id));
        one.catch(() => undefined);
        inFlight.set(id, one);
      }
    }
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'pending'>((resolve) => {
      timer = setTimeout(() => resolve('pending'), deadlineMs);
      timer.unref();
    });
    try {
      await Promise.all(
        misses.map(async (id) => {
          const pending = inFlight.get(id);
          if (pending === undefined) {
            out.set(id, { state: 'unavailable' });
            return;
          }
          try {
            const r = await Promise.race([pending, deadline]);
            out.set(id, r === 'pending' ? { state: 'pending' } : r);
          } catch {
            out.set(id, { state: 'unavailable' });
          }
        }),
      );
    } finally {
      clearTimeout(timer);
    }
    return out;
  };
}

export function actByFor(
  entry: UpcomingEntry,
  now: Date,
): { actBy: string; actNow: boolean } | undefined {
  if (entry.state !== 'ok' || entry.events.length === 0) {
    return undefined;
  }
  return actByDate(entry.events[0].dateTime, dayjs(now));
}
