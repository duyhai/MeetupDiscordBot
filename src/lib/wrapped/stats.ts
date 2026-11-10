/**
 * 1.5 Gen Wrapped: the pure part. Takes a member's event lists and the
 * attendee lists of this year's events, returns the stats and a ranking of
 * co-attendees by Meetup id. Nothing here knows about Discord or linking:
 * naming people is the next step's job (companions.ts), so no name of
 * another member can leak from here.
 */
import dayjs, { Dayjs } from 'dayjs';

import {
  CountedEventLike,
  countsAsAttended,
  countsAsHosted,
} from '../helpers/countedEvents.js';
import {
  EVENT_TYPES,
  EventType,
  classifyEventType,
} from '../hosts/eventTypes.js';
import { tz } from '../../util/timezone.js';

export interface WrappedEvent {
  id: string;
  title: string;
  dateTime: string;
  eventUrl: string;
}

export interface WrappedInput {
  year: number;
  selfMeetupId: string;
  attended: WrappedEvent[];
  hosted: WrappedEvent[];
  /** Attendee Meetup ids per event id, for the Wrapped year's events only. */
  attendeesByEvent: Record<string, string[]>;
}

export interface Companion {
  meetupId: string;
  sharedCount: number;
}

export interface WrappedStats {
  year: number;
  firstEvent: WrappedEvent | null;
  attendedThisYear: number;
  /** As of 31 December of the Wrapped year. */
  attendedAllTime: number;
  topTypes: { type: EventType; count: number }[];
  hosting: { thisYear: number; allTime: number } | null;
  /** 0 = January. */
  busiestMonth: { month: number; count: number } | null;
  longestStreakMonths: number;
}

const TOP_TYPES = 3;

/** [1 Jan 00:00, 1 Jan next year 00:00) in the group's timezone. */
export function yearBounds(year: number): { start: Dayjs; end: Dayjs } {
  const start = tz(dayjs()).year(year).startOf('year');
  return { start, end: start.add(1, 'year') };
}

export function isInYear(dateTime: string, year: number): boolean {
  const { start, end } = yearBounds(year);
  const at = dayjs(dateTime).valueOf();
  return at >= start.valueOf() && at < end.valueOf();
}

/**
 * Deduped by id (first occurrence wins), keeping what `counts` says counts
 * (the shared rule; these lists carry no status, so it goes by title).
 */
function cleanEvents(
  events: WrappedEvent[],
  counts: (event: CountedEventLike) => boolean,
): WrappedEvent[] {
  const byId = new Map<string, WrappedEvent>();
  events.forEach((event) => {
    if (!byId.has(event.id) && counts(event)) {
      byId.set(event.id, event);
    }
  });
  return [...byId.values()];
}

const byDate = (a: WrappedEvent, b: WrappedEvent) =>
  dayjs(a.dateTime).valueOf() - dayjs(b.dateTime).valueOf();

function topTypes(
  events: WrappedEvent[],
): { type: EventType; count: number }[] {
  const counts = new Map<EventType, number>();
  events.forEach((event) => {
    const type = classifyEventType(event.title);
    counts.set(type, (counts.get(type) ?? 0) + 1);
  });
  return EVENT_TYPES.filter((type) => counts.has(type))
    .map((type) => ({ type, count: counts.get(type) ?? 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_TYPES);
}

function monthCounts(events: WrappedEvent[]): number[] {
  const counts = Array.from({ length: 12 }, () => 0);
  events.forEach((event) => {
    counts[tz(dayjs(event.dateTime)).month()] += 1;
  });
  return counts;
}

function busiestMonth(
  counts: number[],
): { month: number; count: number } | null {
  let best: { month: number; count: number } | null = null;
  counts.forEach((count, month) => {
    if (count > 0 && (best === null || count > best.count)) {
      best = { month, count };
    }
  });
  return best;
}

function longestStreak(counts: number[]): number {
  let longest = 0;
  let run = 0;
  counts.forEach((count) => {
    run = count > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  });
  return longest;
}

function rankCompanions(
  yearEvents: WrappedEvent[],
  attendeesByEvent: Record<string, string[]>,
  selfMeetupId: string,
): Companion[] {
  const counts = new Map<string, number>();
  yearEvents.forEach((event) => {
    new Set(attendeesByEvent[event.id] ?? []).forEach((meetupId) => {
      if (meetupId !== selfMeetupId) {
        counts.set(meetupId, (counts.get(meetupId) ?? 0) + 1);
      }
    });
  });
  return [...counts.entries()]
    .map(([meetupId, sharedCount]) => ({ meetupId, sharedCount }))
    .sort(
      (a, b) =>
        b.sharedCount - a.sharedCount ||
        a.meetupId.localeCompare(b.meetupId, undefined, { numeric: true }),
    );
}

export function computeWrapped(input: WrappedInput): {
  stats: WrappedStats;
  companions: Companion[];
} {
  const { year, selfMeetupId, attendeesByEvent } = input;
  const { end } = yearBounds(year);
  const cutoff = (event: WrappedEvent) =>
    dayjs(event.dateTime).valueOf() < end.valueOf();

  // A hosted event counts as attended, even without an RSVP.
  const attended = cleanEvents(
    [...input.attended, ...input.hosted],
    countsAsAttended,
  )
    .filter(cutoff)
    .sort(byDate);
  const hosted = cleanEvents(input.hosted, countsAsHosted).filter(cutoff);
  const thisYear = attended.filter((event) => isInYear(event.dateTime, year));
  const hostedThisYear = hosted.filter((event) =>
    isInYear(event.dateTime, year),
  );
  const months = monthCounts(thisYear);

  return {
    stats: {
      year,
      firstEvent: attended[0] ?? null,
      attendedThisYear: thisYear.length,
      attendedAllTime: attended.length,
      topTypes: topTypes(thisYear),
      hosting:
        hosted.length > 0
          ? { thisYear: hostedThisYear.length, allTime: hosted.length }
          : null,
      busiestMonth: busiestMonth(months),
      longestStreakMonths: longestStreak(months),
    },
    companions: rankCompanions(thisYear, attendeesByEvent, selfMeetupId),
  };
}
