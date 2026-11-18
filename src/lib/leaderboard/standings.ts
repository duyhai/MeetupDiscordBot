/**
 * The host leaderboard's arithmetic, kept pure: monthly places, medals and
 * hosting streaks from the snapshot's past events. Rules (design note
 * docs/superpowers/specs/2026-11-18-host-leaderboard-design.md):
 *
 * - An event counts for every one of its hosts (deduped per event), as the
 *   staff Hall of Fame counts, and only if countsAsHosted (countedEvents.ts).
 * - Months and days are Pacific; weeks are Monday-first Pacific weeks.
 * - Places are standard competition ranking: tied hosts share a place and the
 *   next place is skipped (1, 1, 3).
 *
 * Every event carries its Pacific day, computed once (in SQL), so nothing
 * here formats a time zone per event: the page runs in the bot's process.
 */
import dayjs from 'dayjs';

import { countsAsHosted } from '../helpers/countedEvents.js';
import { EventStatus } from '../client/meetup/types.js';
import { tz } from '../../util/timezone.js';
import type { EventPlace } from '../snapshot/meetup.js';

export interface LeaderboardEvent {
  id: string;
  title: string;
  /** Always PAST from the store; kept so the counting rule sees it. */
  status: EventStatus;
  /** Meetup member ids, possibly repeated. */
  hostIds: string[];
  /** YYYY-MM-DD: the Pacific calendar day the event started. */
  day: string;
  /**
   * The venue's ~1 km grid cell and city; null for an online event or no
   * venue; undefined when the snapshot has not collected it yet.
   */
  place?: EventPlace | null;
}

/** A month's medals: gold, silver, bronze. */
export type MedalPlace = 1 | 2 | 3;

export interface Medal {
  /** YYYY-MM, Pacific. */
  month: string;
  memberId: string;
  place: MedalPlace;
  events: number;
}

export interface Standing {
  memberId: string;
  events: number;
  /** 1-based, shared by ties. */
  place: number;
}

export interface Streak {
  /** 0 when broken. */
  current: number;
  best: number;
}

export interface HostStreaks {
  daily: Streak;
  weekly: Streak;
}

/** Days after a month ends before its medals are awarded. */
export const AWARD_SETTLE_DAYS = 2;
const AWARD_SETTLE_MS = AWARD_SETTLE_DAYS * 24 * 60 * 60_000;
/** The most months one read awards (the oldest due first); later reads take the rest. */
export const MAX_AWARD_MONTHS = 12;

/** The events that count as hosted. */
export const countedEvents = (events: LeaderboardEvent[]): LeaderboardEvent[] =>
  events.filter((e) => countsAsHosted(e));

/** YYYY-MM-DD, Pacific. */
export const pacificDayOf = (at: Date): string =>
  tz(dayjs(at)).format('YYYY-MM-DD');

/** YYYY-MM of an event, Pacific. */
export const monthOf = (event: LeaderboardEvent): string =>
  event.day.slice(0, 7);

const uniqueHosts = (event: LeaderboardEvent): string[] => [
  ...new Set(event.hostIds),
];

/** Each host's counted events, in the order given. */
export function eventsByHost(
  events: LeaderboardEvent[],
): Map<string, LeaderboardEvent[]> {
  const byHost = new Map<string, LeaderboardEvent[]>();
  countedEvents(events).forEach((event) => {
    uniqueHosts(event).forEach((id) => {
      const list = byHost.get(id);
      if (list) {
        list.push(event);
      } else {
        byHost.set(id, [event]);
      }
    });
  });
  return byHost;
}

/** Events hosted per host, per Pacific month: one pass. */
export function countsByMonth(
  events: LeaderboardEvent[],
): Map<string, Map<string, number>> {
  const byMonth = new Map<string, Map<string, number>>();
  countedEvents(events).forEach((event) => {
    const month = monthOf(event);
    let counts = byMonth.get(month);
    if (!counts) {
      counts = new Map();
      byMonth.set(month, counts);
    }
    const into = counts;
    uniqueHosts(event).forEach((id) => {
      into.set(id, (into.get(id) ?? 0) + 1);
    });
  });
  return byMonth;
}

/**
 * Places by events hosted, competition-ranked. Ties are listed by
 * `nameOf` (then id), which never changes a place.
 */
export function rank(
  counts: Map<string, number>,
  nameOf: (memberId: string) => string = (id) => id,
): Standing[] {
  const rows = [...counts.entries()]
    .filter(([, n]) => n > 0)
    .map(([memberId, events]) => ({ memberId, events }))
    .sort(
      (a, b) =>
        b.events - a.events ||
        nameOf(a.memberId).localeCompare(nameOf(b.memberId)) ||
        a.memberId.localeCompare(b.memberId),
    );
  let place = 0;
  return rows.map((row, i) => {
    if (i === 0 || rows[i - 1].events !== row.events) {
      place = i + 1;
    }
    return { ...row, place };
  });
}

/** The medals a month's standings earn: every host placed 1st to 3rd. */
export function medalsFor(month: string, standings: Standing[]): Medal[] {
  return standings
    .filter((s) => s.place <= 3)
    .map((s) => ({
      month,
      memberId: s.memberId,
      place: s.place as MedalPlace,
      events: s.events,
    }));
}

const nextMonth = (month: string): string =>
  dayjs(`${month}-01`).add(1, 'month').format('YYYY-MM');

/**
 * The months ready to award and not yet awarded, oldest first and at most
 * `limit`: from `firstMonth`, every month whose end (Pacific midnight after
 * its last day) is at least AWARD_SETTLE_DAYS × 24 h before `listedAt`, the
 * end of the latest complete snapshot listing. Work is per month, never per
 * event.
 */
export function monthsToAward(
  firstMonth: string | undefined,
  awarded: ReadonlySet<string>,
  listedAt: Date,
  limit = MAX_AWARD_MONTHS,
): string[] {
  const months: string[] = [];
  if (firstMonth === undefined) {
    return months;
  }
  for (
    let month = firstMonth;
    months.length < limit;
    month = nextMonth(month)
  ) {
    const end = dayjs.tz(`${nextMonth(month)}-01`, 'America/Los_Angeles');
    // Plain milliseconds: a tz'd dayjs's add() moves across a DST change.
    if (end.valueOf() + AWARD_SETTLE_MS > listedAt.getTime()) {
      break;
    }
    if (!awarded.has(month)) {
      months.push(month);
    }
  }
  return months;
}

/** The earliest month with a counted event. */
export function firstMonthOf(events: LeaderboardEvent[]): string | undefined {
  let first: string | undefined;
  events.forEach((e) => {
    const month = monthOf(e);
    if (first === undefined || month < first) {
      first = month;
    }
  });
  return first;
}

/** The Monday (YYYY-MM-DD) of a YYYY-MM-DD day's week. */
export const mondayOf = (day: string): string => {
  const d = dayjs(day);
  return d.subtract((d.day() + 6) % 7, 'day').format('YYYY-MM-DD');
};

const addDays = (day: string, n: number): string =>
  dayjs(day).add(n, 'day').format('YYYY-MM-DD');

/**
 * Runs of consecutive units in unique keys, where `step` gives the key
 * after one. Current is the run ending at `latest` or the unit before it
 * (`previous`), else 0.
 */
function streakOf(
  keys: Set<string>,
  step: (key: string) => string,
  latest: string,
  previous: string,
): Streak {
  const sorted = [...keys].sort();
  let best = 0;
  let run = 0;
  sorted.forEach((key, i) => {
    run = i > 0 && step(sorted[i - 1]) === key ? run + 1 : 1;
    best = Math.max(best, run);
  });
  const last = sorted[sorted.length - 1];
  const current =
    last !== undefined && (last === latest || last === previous) ? run : 0;
  return { current, best };
}

/**
 * Daily: consecutive Pacific days with a counted hosted event; weekly:
 * consecutive Monday-first weeks. A current streak survives until a whole
 * day (week) has passed without hosting: today's (this week's) events may
 * not be over yet. `today` is the snapshot's day, not the wall clock's.
 */
export function streaksOf(
  events: LeaderboardEvent[],
  today: string,
): HostStreaks {
  const days = new Set(events.map((e) => e.day));
  const weeks = new Set([...days].map(mondayOf));
  const thisWeek = mondayOf(today);
  return {
    daily: streakOf(days, (d) => addDays(d, 1), today, addDays(today, -1)),
    weekly: streakOf(
      weeks,
      (w) => addDays(w, 7),
      thisWeek,
      addDays(thisWeek, -7),
    ),
  };
}
