import dayjs from 'dayjs';
import { Client } from 'discord.js';

import { getPaginatedData } from '../client/meetup/paginationHelper.js';
import { GroupEventFilter } from '../client/meetup/types.js';
import { withOrganizerMeetup } from '../reports/organizerMeetup.js';
import { tz } from '../../util/timezone.js';
import { EventType, classifyEventType } from './eventTypes.js';
import { calendarDates } from './holidays.js';

export interface HostEvent {
  id: string;
  title: string;
  /** ISO, as Meetup sends it. */
  dateTime: string;
  eventUrl: string;
  type: EventType;
  hosts: { id: string; name: string }[];
}

export interface HostEventsDeps {
  fetchGroupEvents: (filter: GroupEventFilter) => Promise<HostEvent[]>;
  now: () => Date;
}

export interface CalendarDay {
  day: string; // YYYY-MM-DD, Pacific
  events: HostEvent[];
  /** 0 none, 1 one event, 2 two, 3 three or more. */
  busy: 0 | 1 | 2 | 3;
  dates: { name: string; kind: 'holiday' | 'cultural' }[];
}

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
 * The group's published events for `weeks` weeks from the Monday of this
 * Pacific week, one entry per Pacific day, with holidays.
 */
export async function groupCalendar(
  deps: HostEventsDeps,
  weeks = 8,
): Promise<CalendarDay[]> {
  const today = tz(dayjs(deps.now())).startOf('day');
  // dayjs weeks start on Sunday; Monday-first: Sunday goes back 6 days.
  const start = today.subtract((today.day() + 6) % 7, 'day');
  const end = start.add(weeks * 7, 'day');
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
  const lastDay = end.subtract(1, 'day').format('YYYY-MM-DD');
  const dates = calendarDates(start.format('YYYY-MM-DD'), lastDay);
  return Array.from({ length: weeks * 7 }, (_, i) => {
    const day = start.add(i, 'day').format('YYYY-MM-DD');
    const dayEvents = byDay.get(day) ?? [];
    return {
      day,
      events: dayEvents,
      busy: busyOf(dayEvents.length),
      dates: dates
        .filter((d) => d.day === day)
        .map(({ name, kind }) => ({ name, kind })),
    };
  });
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
  eventHosts?: { member?: { id?: unknown; name?: unknown } | null }[] | null;
}

export function toHostEvent(node: RawEventNode): HostEvent {
  return {
    id: String(node.id),
    title: String(node.title ?? ''),
    dateTime: String(node.dateTime),
    eventUrl: String(node.eventUrl ?? ''),
    type: classifyEventType(String(node.title ?? '')),
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
