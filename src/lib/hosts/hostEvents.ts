import dayjs from 'dayjs';
import { Client } from 'discord.js';

import { getPaginatedData } from '../client/meetup/paginationHelper.js';
import { EventStatus, GroupEventFilter } from '../client/meetup/types.js';
import { countsAsHosted } from '../helpers/countedEvents.js';
import { withOrganizerMeetup } from '../reports/organizerMeetup.js';
import { tz } from '../../util/timezone.js';
import { EventType, classifyEventType } from './eventTypes.js';

export interface HostEvent {
  id: string;
  title: string;
  /** ISO, as Meetup sends it. */
  dateTime: string;
  eventUrl: string;
  type: EventType;
  hosts: { id: string; name: string }[];
  /**
   * Whether it counts as a hosted event (countedEvents.ts): not cancelled,
   * not an Open House. Lists keep every event; counts and heat maps use
   * countedOnly.
   */
  counted: boolean;
}

/** The events that count as hosted, in the order given. */
export const countedOnly = (events: HostEvent[]): HostEvent[] =>
  events.filter((e) => e.counted);

export interface HostEventsDeps {
  fetchGroupEvents: (filter: GroupEventFilter) => Promise<HostEvent[]>;
  now: () => Date;
}

export interface CalendarDay {
  day: string; // YYYY-MM-DD, Pacific
  events: HostEvent[];
  /** 0 none, 1 one event, 2 two, 3 three or more. */
  busy: 0 | 1 | 2 | 3;
}

const PACIFIC = 'America/Los_Angeles';

const byTime = (a: HostEvent, b: HostEvent) =>
  dayjs(a.dateTime).valueOf() - dayjs(b.dateTime).valueOf();

/** The Pacific calendar day of an event's start. */
export const pacificDay = (dateTime: string | Date): string =>
  tz(dayjs(dateTime)).format('YYYY-MM-DD');

/**
 * The host's own events: PAST newest first, or upcoming (ACTIVE) soonest
 * first. Meetup's hostId filter decides; nothing else is trusted to.
 */
export async function hostedEvents(
  deps: HostEventsDeps,
  memberId: string,
  which: 'past' | 'upcoming',
): Promise<HostEvent[]> {
  const events = await deps.fetchGroupEvents({
    status: [which === 'past' ? 'PAST' : 'ACTIVE'],
    hostId: memberId,
  });
  const sorted = [...events].sort(byTime);
  return which === 'past' ? sorted.reverse() : sorted;
}

function busyOf(n: number): CalendarDay['busy'] {
  return n >= 3 ? 3 : (n as 0 | 1 | 2);
}

/**
 * The group's published events for `days` days from `startDay`
 * (YYYY-MM-DD, Pacific), one entry per Pacific day.
 */
async function calendarDays(
  deps: HostEventsDeps,
  startDay: string,
  days: number,
): Promise<CalendarDay[]> {
  // Day arithmetic on calendar dates, then each end turned into Pacific
  // midnight on its own: a tz'd dayjs keeps its offset through add(), so
  // across a DST change the window would be an hour off.
  const endDay = dayjs(startDay).add(days, 'day').format('YYYY-MM-DD');
  const start = dayjs.tz(startDay, PACIFIC);
  const end = dayjs.tz(endDay, PACIFIC);
  const events = await deps.fetchGroupEvents({
    status: ['ACTIVE'],
    afterDateTime: start.toISOString(),
    beforeDateTime: end.toISOString(),
  });
  const byDay = new Map<string, HostEvent[]>();
  for (const event of [...events].sort(byTime)) {
    const day = pacificDay(event.dateTime);
    byDay.set(day, [...(byDay.get(day) ?? []), event]);
  }
  return Array.from({ length: days }, (_, i) => {
    const day = dayjs(startDay).add(i, 'day').format('YYYY-MM-DD');
    const dayEvents = byDay.get(day) ?? [];
    return {
      day,
      events: dayEvents,
      busy: busyOf(dayEvents.length),
    };
  });
}

/** The Monday on or before a YYYY-MM-DD day. */
const mondayOf = (day: string): string => {
  const d = dayjs(day);
  // dayjs weeks start on Sunday; Monday-first: Sunday goes back 6 days.
  return d.subtract((d.day() + 6) % 7, 'day').format('YYYY-MM-DD');
};

/**
 * The group's published events for `weeks` weeks from the Monday of this
 * Pacific week, one entry per Pacific day.
 */
export async function groupCalendar(
  deps: HostEventsDeps,
  weeks = 8,
): Promise<CalendarDay[]> {
  const today = tz(dayjs(deps.now())).format('YYYY-MM-DD');
  return calendarDays(deps, mondayOf(today), weeks * 7);
}

/**
 * One month (YYYY-MM) as whole Monday-first weeks: from the Monday on or
 * before the 1st to the Sunday on or after the last day. The days around
 * the month are in the list too; the page leaves them blank.
 */
export async function monthCalendar(
  deps: HostEventsDeps,
  month: string,
): Promise<CalendarDay[]> {
  const first = `${month}-01`;
  const last = dayjs(first).endOf('month').format('YYYY-MM-DD');
  const start = mondayOf(first);
  const end = dayjs(mondayOf(last)).add(6, 'day');
  // Rounded hours, not diff('day'): a spring-forward day is 23 h long.
  const days = Math.round(end.diff(dayjs(start), 'hour') / 24) + 1;
  return calendarDays(deps, start, days);
}

const MEETUP_EVENT_URL =
  /^https:\/\/www\.meetup\.com\/[A-Za-z0-9_-]+\/events\/[0-9]+\/?$/;

/**
 * The event's attendee page on Meetup, where hosts mark check-ins and
 * no-shows. Only for a Meetup event URL; anything else has no link.
 */
export function attendanceUrl(eventUrl: string): string | undefined {
  if (typeof eventUrl !== 'string' || !MEETUP_EVENT_URL.test(eventUrl)) {
    return undefined;
  }
  return `${eventUrl.replace(/\/?$/, '/')}attendees/`;
}

interface RawEventNode {
  id: string;
  title: string;
  dateTime: string;
  eventUrl: string;
  status?: EventStatus | null;
  eventHosts?: { member?: { id?: unknown; name?: unknown } | null }[] | null;
}

export function toHostEvent(node: RawEventNode): HostEvent {
  const title = String(node.title ?? '');
  return {
    id: String(node.id),
    title,
    dateTime: String(node.dateTime),
    eventUrl: String(node.eventUrl ?? ''),
    type: classifyEventType(title),
    counted: countsAsHosted({ title, status: node.status ?? undefined }),
    hosts: (node.eventHosts ?? [])
      .map((h) => h?.member)
      .filter((m): m is { id?: unknown; name?: unknown } => Boolean(m))
      .map((m) => ({ id: String(m.id ?? ''), name: String(m.name ?? '') })),
  };
}

/** How long a list read from Meetup is reused, and how many lists are kept. */
export const HOST_EVENTS_TTL_MS = 5 * 60 * 1000;
export const HOST_EVENTS_MAX_ENTRIES = 200;

/**
 * Production fetchGroupEvents: the organizer credential, every page, kept
 * in this process for 5 minutes per filter, and one Meetup read per filter
 * at a time (single-flight). Never in Redis: the lists carry host names.
 */
export function organizerGroupEvents(
  getClient: () => Client | undefined,
  now: () => number = Date.now,
): HostEventsDeps['fetchGroupEvents'] {
  const cache = new Map<string, { at: number; events: HostEvent[] }>();
  const inFlight = new Map<string, Promise<HostEvent[]>>();
  return async (filter) => {
    const key = JSON.stringify(filter);
    const hit = cache.get(key);
    if (hit && now() - hit.at < HOST_EVENTS_TTL_MS) {
      return hit.events;
    }
    const pending = inFlight.get(key);
    if (pending !== undefined) {
      return pending;
    }
    const read = withOrganizerMeetup(getClient(), async (meetup) => {
      const nodes = await getPaginatedData(async (pagination) => {
        const result = await meetup.getGroupEvents(pagination, filter);
        return result.groupByUrlname.events;
      });
      return nodes.map((node) => toHostEvent(node as unknown as RawEventNode));
    })
      .then((events) => {
        cache.delete(key);
        cache.set(key, { at: now(), events });
        while (cache.size > HOST_EVENTS_MAX_ENTRIES) {
          cache.delete(cache.keys().next().value as string);
        }
        return events;
      })
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, read);
    return read;
  };
}
