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

/** A hosted event with its yes+attended RSVP count as Meetup reported it at build time. */
export interface HostedEvent extends WrappedEvent {
  attendance: number;
}

export interface WrappedInput {
  year: number;
  selfMeetupId: string;
  attended: WrappedEvent[];
  hosted: HostedEvent[];
  /** Attendee Meetup ids per event id, for the Wrapped year's events only. */
  attendeesByEvent: Record<string, string[]>;
}

export interface Companion {
  meetupId: string;
  sharedCount: number;
  /** This year's events you were both at, date ascending. */
  sharedEventIds: string[];
}

/** A linked, present member from a type's early events: Discord id only. */
export interface CohortMember {
  discordUserId: string;
  /** Of the type's first events, how many they were at too. */
  earlyCount: number;
  /** This year's events shared. */
  sharedCount: number;
}

export interface NamedCohort {
  named: CohortMember[];
  /** Early-cohort people not named: an aggregate, never a name. */
  otherCount: number;
  /**
   * Set when an early event's attendee list was read in part (the backfill
   * reads the first page of 100 only): the counts are "at least".
   */
  partial?: boolean;
}

export interface TopType {
  type: EventType;
  count: number;
  /** The member's first events ever of this type, earliest first, as of the year's end. */
  firstEvents: WrappedEvent[];
  /** Empty from computeWrapped; build.ts fills it after naming. */
  cohort: NamedCohort;
}

export interface HostedRanked {
  event: WrappedEvent;
  attendance: number;
}

export interface WrappedStats {
  year: number;
  /** The first event they were at, attended or hosted. */
  firstEvent: WrappedEvent | null;
  /** Counted events attended this year that they did not host. */
  attendedThisYear: number;
  /** As attendedThisYear, as of 31 December of the Wrapped year. */
  attendedAllTime: number;
  /** By the events they were at this year, attended or hosted. */
  topTypes: TopType[];
  hosting: {
    thisYear: number;
    allTime: number;
    /** This year's hosted events by attendance desc, earliest first on a tie. */
    topThisYear: HostedRanked[];
    /** The best-attended hosted event ever, as of the year's end. */
    allTimeBest: HostedRanked | null;
  } | null;
  /** 0 = January. `events`: that month's attended (not hosted) events, date asc. */
  busiestMonth: { month: number; count: number; events: WrappedEvent[] } | null;
  /** Months in a row with an attended (not hosted) event. */
  longestStreakMonths: number;
  /**
   * Every Pacific year with at least one counted event attended or hosted, ascending,
   * NOT cut off at the Wrapped year: the website's year picker reads it
   * from whichever year's Wrapped is shown.
   */
  activeYears: number[];
}

const TOP_TYPES = 3;
export const FIRST_EVENTS_PER_TYPE = 10;
export const TOP_HOSTED = 5;

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
function cleanEvents<T extends WrappedEvent>(
  events: T[],
  counts: (event: CountedEventLike) => boolean,
): T[] {
  const byId = new Map<string, T>();
  events.forEach((event) => {
    if (!byId.has(event.id) && counts(event)) {
      byId.set(event.id, event);
    }
  });
  return [...byId.values()];
}

const byDate = (a: WrappedEvent, b: WrappedEvent) =>
  dayjs(a.dateTime).valueOf() - dayjs(b.dateTime).valueOf();

/** `attendedEver` is date-sorted, so each type's first events come out earliest first. */
function topTypes(
  events: WrappedEvent[],
  attendedEver: WrappedEvent[],
): TopType[] {
  const counts = new Map<EventType, number>();
  events.forEach((event) => {
    const type = classifyEventType(event.title);
    counts.set(type, (counts.get(type) ?? 0) + 1);
  });
  return EVENT_TYPES.filter((type) => counts.has(type))
    .map((type) => ({ type, count: counts.get(type) ?? 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_TYPES)
    .map(({ type, count }) => ({
      type,
      count,
      firstEvents: attendedEver
        .filter((event) => classifyEventType(event.title) === type)
        .slice(0, FIRST_EVENTS_PER_TYPE),
      cohort: { named: [], otherCount: 0 },
    }));
}

function monthCounts(events: WrappedEvent[]): number[] {
  const counts = Array.from({ length: 12 }, () => 0);
  events.forEach((event) => {
    counts[tz(dayjs(event.dateTime)).month()] += 1;
  });
  return counts;
}

/** `thisYear` is date-sorted, so the month's events come out in date order. */
function busiestMonth(
  counts: number[],
  thisYear: WrappedEvent[],
): WrappedStats['busiestMonth'] {
  let best: { month: number; count: number } | null = null;
  counts.forEach((count, month) => {
    if (count > 0 && (best === null || count > best.count)) {
      best = { month, count };
    }
  });
  if (best === null) {
    return null;
  }
  const { month, count } = best;
  return {
    month,
    count,
    events: thisYear.filter(
      (event) => tz(dayjs(event.dateTime)).month() === month,
    ),
  };
}

/** Attendance desc, then earliest first; `hosted` is date-sorted. */
function rankHosted(hosted: HostedEvent[]): HostedRanked[] {
  return [...hosted]
    .sort((a, b) => b.attendance - a.attendance || byDate(a, b))
    .map(({ attendance, ...event }) => ({ event, attendance }));
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
  const shared = new Map<string, string[]>();
  yearEvents.forEach((event) => {
    new Set(attendeesByEvent[event.id] ?? []).forEach((meetupId) => {
      if (meetupId !== selfMeetupId) {
        shared.set(meetupId, [...(shared.get(meetupId) ?? []), event.id]);
      }
    });
  });
  return [...shared.entries()]
    .map(([meetupId, sharedEventIds]) => ({
      meetupId,
      sharedCount: sharedEventIds.length,
      sharedEventIds,
    }))
    .sort(
      (a, b) =>
        b.sharedCount - a.sharedCount ||
        a.meetupId.localeCompare(b.meetupId, undefined, { numeric: true }),
    );
}

/** Ids of every event the member hosted, counted or not (an Open House too). */
function hostedIds(hosted: HostedEvent[]): Set<string> {
  return new Set(hosted.map((event) => event.id));
}

const stripAttendance = ({
  attendance: _attendance,
  ...event
}: HostedEvent): WrappedEvent => event;

const plainEvent = ({ id, title, dateTime, eventUrl }: WrappedEvent) => ({
  id,
  title,
  dateTime,
  eventUrl,
});

/**
 * The year's events for the heat map, by the rules behind the stats:
 * `attended` is every counted event attended in `year` that the member did
 * not host (attendedThisYear's events), `hosted` every counted hosted event
 * in `year` (the Hosting section's). Both date ascending. The website's
 * Wrapped heat map reads it from the snapshot's sources at render time.
 */
export function eventsInYear(
  attended: WrappedEvent[],
  hosted: HostedEvent[],
  year: number,
): { attended: WrappedEvent[]; hosted: WrappedEvent[] } {
  const hostedIdSet = hostedIds(hosted);
  const inYear = <T extends WrappedEvent>(events: T[]) =>
    events
      .filter((event) => isInYear(event.dateTime, year))
      .sort(byDate)
      .map(plainEvent);
  return {
    attended: inYear(
      cleanEvents(attended, countsAsAttended).filter(
        (event) => !hostedIdSet.has(event.id),
      ),
    ),
    hosted: inYear(cleanEvents(hosted, countsAsHosted)),
  };
}

export function computeWrapped(input: WrappedInput): {
  stats: WrappedStats;
  companions: Companion[];
} {
  const { year, selfMeetupId, attendeesByEvent } = input;
  const { end } = yearBounds(year);
  const cutoff = (event: WrappedEvent) =>
    dayjs(event.dateTime).valueOf() < end.valueOf();

  // Hai, 2026-11-17: an event counts as attended only if the member was not
  // one of its hosts (any hosted event, an Open House too: hosting one is not
  // attending it). Hosting has its own stats. `wereAt` is every event they
  // were at either way: their first event with us, the top activities, the
  // companions and the year picker read it.
  const hostedIdSet = hostedIds(input.hosted);
  const wereAtEver = cleanEvents(
    [...input.attended, ...input.hosted.map(stripAttendance)],
    countsAsAttended,
  );
  const wereAt = wereAtEver.filter(cutoff).sort(byDate);
  const attended = wereAt.filter((event) => !hostedIdSet.has(event.id));
  const hosted = cleanEvents(input.hosted, countsAsHosted)
    .filter(cutoff)
    .sort(byDate);
  const thisYear = attended.filter((event) => isInYear(event.dateTime, year));
  const wereAtThisYear = wereAt.filter((event) =>
    isInYear(event.dateTime, year),
  );
  const hostedThisYear = hosted.filter((event) =>
    isInYear(event.dateTime, year),
  );
  const months = monthCounts(thisYear);

  return {
    stats: {
      year,
      firstEvent: wereAt[0] ?? null,
      attendedThisYear: thisYear.length,
      attendedAllTime: attended.length,
      topTypes: topTypes(wereAtThisYear, wereAt),
      hosting:
        hosted.length > 0
          ? {
              thisYear: hostedThisYear.length,
              allTime: hosted.length,
              topThisYear: rankHosted(hostedThisYear).slice(0, TOP_HOSTED),
              allTimeBest: rankHosted(hosted)[0] ?? null,
            }
          : null,
      busiestMonth: busiestMonth(months, thisYear),
      longestStreakMonths: longestStreak(months),
      activeYears: [
        ...new Set(wereAtEver.map((event) => tz(dayjs(event.dateTime)).year())),
      ].sort((a, b) => a - b),
    },
    companions: rankCompanions(wereAtThisYear, attendeesByEvent, selfMeetupId),
  };
}
