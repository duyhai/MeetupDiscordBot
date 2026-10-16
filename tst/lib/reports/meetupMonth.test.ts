import { describe, expect, it, vi } from 'vitest';

import { GqlMeetupClient } from '../../../src/lib/client/meetup/gqlClient.js';
import {
  Event,
  GroupEventFilter,
  Rsvp,
  RsvpFilter,
} from '../../../src/lib/client/meetup/types.js';
import {
  MonthData,
  attendanceCount,
  attendanceEvidence,
  fetchMonthData,
  isAttendanceRecorded,
  windowKey,
  windowStart,
} from '../../../src/lib/reports/meetupMonth.js';

const member = (id: string) => ({
  id,
  name: `Member ${id}`,
  memberUrl: `https://www.meetup.com/members/${id}/`,
  gender: 'UNKNOWN' as const,
});

const makeEvent = (id: string, dateTime: string, title = `Event ${id}`) =>
  ({
    id,
    title,
    dateTime,
    eventUrl: `https://www.meetup.com/g/events/${id}/`,
    maxTickets: 10,
    status: 'PAST',
    eventHosts: [{ member: member('1') }],
  }) as unknown as Event;

const rsvp = (status: string, id = '9') =>
  ({ member: member(id), status }) as unknown as Rsvp;

const page = <T>(nodes: T[]) => ({
  edges: nodes.map((node) => ({ node, cursor: 'c' })),
  pageInfo: { hasNextPage: false, endCursor: '' },
  totalCount: nodes.length,
});

describe('fetchMonthData', () => {
  it("fetches each event's RSVPs once with ATTENDED, YES and NO_SHOW", async () => {
    const events = [
      makeEvent('e1', '2026-09-05T20:00:00Z'),
      makeEvent('e2', '2026-09-12T20:00:00Z'),
    ];
    const filters: (RsvpFilter | undefined)[] = [];
    const eventIds: string[] = [];
    const client = {
      getGroupEvents: vi.fn((_p: unknown, _f: GroupEventFilter) =>
        Promise.resolve({ groupByUrlname: { events: page(events) } }),
      ),
      getEventRsvps: vi.fn(
        (eventId: string, _p: unknown, filter?: RsvpFilter) => {
          eventIds.push(eventId);
          filters.push(filter);
          return Promise.resolve({
            event: { id: eventId, rsvps: page([rsvp('ATTENDED')]) },
          });
        },
      ),
    } as unknown as GqlMeetupClient;

    const data = await fetchMonthData(client, { year: 2026, month: 9 });

    expect(eventIds).toHaveLength(2);
    expect(eventIds.sort()).toEqual(['e1', 'e2']);
    const expected = { rsvpStatus: ['ATTENDED', 'YES', 'NO_SHOW'] };
    expect(filters).toEqual([expected, expected]);
    expect(data.events).toHaveLength(2);
    expect(data.rsvps.get('e1')).toHaveLength(1);
    expect(data.rsvps.get('e2')).toHaveLength(1);
  });
});

describe('attendanceCount', () => {
  it('counts ATTENDED and YES only', () => {
    expect(
      attendanceCount([
        rsvp('ATTENDED'),
        rsvp('YES'),
        rsvp('NO_SHOW'),
        rsvp('YES'),
      ]),
    ).toBe(3);
  });
});

describe('attendanceEvidence', () => {
  const asOf = new Date('2026-09-20T00:00:00Z');

  it('ignores cancelled and future events', () => {
    const past = makeEvent('p1', '2026-09-05T20:00:00Z');
    const pastNoRsvps = makeEvent('p2', '2026-09-06T20:00:00Z');
    const cancelled = makeEvent(
      'c1',
      '2026-09-07T20:00:00Z',
      'Board games (Cancelled)',
    );
    const future = makeEvent('f1', '2026-09-25T20:00:00Z');
    const data: MonthData = {
      events: [past, pastNoRsvps, cancelled, future],
      rsvps: new Map([
        ['p1', [rsvp('NO_SHOW'), rsvp('YES')]],
        ['p2', [rsvp('YES')]],
        ['c1', [rsvp('ATTENDED')]],
        ['f1', [rsvp('ATTENDED')]],
      ]),
    };

    expect(attendanceEvidence(data, asOf)).toEqual({
      pastEvents: 2,
      eventsWithAttendance: 1,
    });
  });
});

describe('isAttendanceRecorded', () => {
  it('is false for past events with no ATTENDED or NO_SHOW, true for an empty month', () => {
    expect(
      isAttendanceRecorded({ pastEvents: 3, eventsWithAttendance: 0 }),
    ).toBe(false);
    expect(
      isAttendanceRecorded({ pastEvents: 3, eventsWithAttendance: 1 }),
    ).toBe(true);
    expect(
      isAttendanceRecorded({ pastEvents: 0, eventsWithAttendance: 0 }),
    ).toBe(true);
  });
});

describe('windowStart and windowKey', () => {
  it('cover month and whole-year windows', () => {
    expect(windowStart({ year: 2026, month: 9 }).toISOString()).toBe(
      '2026-09-01T07:00:00.000Z',
    );
    expect(windowStart({ year: 2026, month: 0 }).toISOString()).toBe(
      '2026-01-01T08:00:00.000Z',
    );
    expect(windowKey({ year: 2026, month: 9 })).toBe('2026-09');
    expect(windowKey({ year: 2026, month: 0 })).toBe('2026');
  });
});
