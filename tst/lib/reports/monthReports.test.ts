import { describe, expect, it, vi } from 'vitest';

import { GqlMeetupClient } from '../../../src/lib/client/meetup/gqlClient.js';
import {
  Event,
  GroupEventFilter,
  Rsvp,
  RsvpFilter,
} from '../../../src/lib/client/meetup/types.js';
import { buildMonthReports } from '../../../src/lib/reports/monthReports.js';
import { fakeSuspensionRepository } from '../../fixtures/meetup/fakeSuspensions.js';

const period = { year: 2026, month: 9 };
const asOf = new Date('2026-10-01T07:00:00.000Z');
const cutoff = new Date('2026-10-01T00:00:00.000Z');

const member = (id: string) => ({
  id,
  name: `Member ${id}`,
  memberUrl: `https://www.meetup.com/members/${id}/`,
  gender: 'UNKNOWN' as const,
});

const makeEvent = (id: string, dateTime: string) =>
  ({
    id,
    title: `Event ${id}`,
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

function fakeClient(events: Event[], rsvps: Record<string, Rsvp[]>) {
  const getGroupEvents = vi.fn((_p: unknown, _f: GroupEventFilter) =>
    Promise.resolve({ groupByUrlname: { events: page(events) } }),
  );
  const getEventRsvps = vi.fn(
    (eventId: string, _p: unknown, _filter?: RsvpFilter) =>
      Promise.resolve({
        event: { id: eventId, rsvps: page(rsvps[eventId] ?? []) },
      }),
  );
  const getGroupEventsCount = vi.fn(() => Promise.resolve(1));
  const getMemberRsvpEvents = vi.fn((memberId: string) =>
    Promise.resolve(
      events.filter((e) =>
        (rsvps[e.id] ?? []).some(
          (r) => r.member.id === memberId && r.status === 'NO_SHOW',
        ),
      ),
    ),
  );
  return {
    client: {
      getGroupEvents,
      getEventRsvps,
      getGroupEventsCount,
      getMemberRsvpEvents,
    } as unknown as GqlMeetupClient,
    getGroupEvents,
    getEventRsvps,
  };
}

const build = (client: GqlMeetupClient) =>
  buildMonthReports(client, period, {
    asOf,
    suspensionCutoff: cutoff,
    groupId: 'group-1',
    suspensions: fakeSuspensionRepository([]),
  });

describe('buildMonthReports', () => {
  it('builds both reports from one month fetch', async () => {
    const events = [
      makeEvent('e1', '2026-09-05T20:00:00Z'),
      makeEvent('e2', '2026-09-12T20:00:00Z'),
    ];
    const { client, getGroupEvents, getEventRsvps } = fakeClient(events, {
      e1: [rsvp('ATTENDED'), rsvp('NO_SHOW', '5')],
      e2: [rsvp('YES')],
    });

    const reports = await build(client);

    expect(getGroupEvents).toHaveBeenCalledTimes(1);
    expect(getGroupEvents.mock.calls[0][1]).toMatchObject({
      afterDateTime: '2026-09-01T07:00:00.000Z',
    });
    expect(getEventRsvps).toHaveBeenCalledTimes(2);
    expect(getEventRsvps.mock.calls.map((c) => c[0]).sort()).toEqual([
      'e1',
      'e2',
    ]);
    expect(reports.hallOfFame.period).toBe('2026-09');
    expect(reports.noShow.period).toBe('2026-09');
    expect(reports.hallOfFame.asOf).toBe(asOf.toISOString());
    expect(reports.noShow.asOf).toBe(asOf.toISOString());
    expect(reports.hallOfFame.totalEvents).toBe(2);
    expect(reports.noShow.summary.members).toBe(1);
    expect(reports.sourceComplete).toBe(true);
  });

  it('marks a month without attendance incomplete', async () => {
    const events = [
      makeEvent('e1', '2026-09-05T20:00:00Z'),
      makeEvent('e2', '2026-09-12T20:00:00Z'),
    ];
    const { client } = fakeClient(events, {
      e1: [rsvp('YES')],
      e2: [rsvp('YES'), rsvp('YES', '8')],
    });

    const reports = await build(client);

    expect(reports.noShow.attendance).toEqual({
      pastEvents: 2,
      eventsWithAttendance: 0,
    });
    expect(reports.sourceComplete).toBe(false);
  });

  it('one ATTENDED anywhere makes the month complete', async () => {
    const events = [
      makeEvent('e1', '2026-09-05T20:00:00Z'),
      makeEvent('e2', '2026-09-12T20:00:00Z'),
    ];
    const { client } = fakeClient(events, {
      e1: [rsvp('YES')],
      e2: [rsvp('YES'), rsvp('ATTENDED', '8')],
    });

    expect((await build(client)).sourceComplete).toBe(true);
  });

  it('a month with no past events is complete', async () => {
    const { client } = fakeClient([], {});

    const reports = await build(client);

    expect(reports.noShow.attendance).toEqual({
      pastEvents: 0,
      eventsWithAttendance: 0,
    });
    expect(reports.sourceComplete).toBe(true);
  });
});
