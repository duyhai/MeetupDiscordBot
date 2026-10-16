import { describe, expect, it, vi } from 'vitest';

import { GqlMeetupClient } from '../../../src/lib/client/meetup/gqlClient.js';
import { Event, Rsvp } from '../../../src/lib/client/meetup/types.js';
import {
  buildHallOfFameReport,
  formatHostingStatsText,
} from '../../../src/lib/reports/hallOfFameReport.js';
import { MonthData } from '../../../src/lib/reports/meetupMonth.js';

const member = (id: string, name = `Member ${id}`) => ({
  id,
  name,
  memberUrl: `https://www.meetup.com/members/${id}/`,
  gender: 'FEMALE' as const,
  description: 'private bio',
});

const makeEvent = (
  id: string,
  title: string,
  hosts: ReturnType<typeof member>[],
  dateTime = '2026-09-05T20:00:00Z',
) =>
  ({
    id,
    title,
    dateTime,
    eventUrl: `https://www.meetup.com/g/events/${id}/`,
    maxTickets: 12,
    status: 'PAST',
    description: 'secret description',
    feeSettings: { amount: 5 },
    eventHosts: hosts.map((m) => ({ member: m })),
  }) as unknown as Event;

const rsvp = (status: string) =>
  ({ member: member('9'), status }) as unknown as Rsvp;

const fakeClient = (counts: Record<string, number> = {}) => {
  const getGroupEventsCount = vi.fn(({ hostId }: { hostId: string }) =>
    Promise.resolve(counts[hostId] ?? 1),
  );
  return {
    client: { getGroupEventsCount } as unknown as Pick<
      GqlMeetupClient,
      'getGroupEventsCount'
    >,
    getGroupEventsCount,
  };
};

const window = { year: 2026, month: 9 };
const asOf = new Date('2026-10-01T07:00:00Z');

describe('buildHallOfFameReport', () => {
  it('counts attendance from one RSVP pass', async () => {
    const e1 = makeEvent('e1', 'Hike', [member('1')]);
    const data: MonthData = {
      events: [e1],
      rsvps: new Map([
        ['e1', [rsvp('ATTENDED'), rsvp('YES'), rsvp('NO_SHOW')]],
      ]),
    };
    const { client } = fakeClient();

    const payload = await buildHallOfFameReport(client, window, data, asOf);

    expect(payload.hosts[0].events[0].attendance).toBe(2);
    expect(payload.hosts[0].events[0].maxTickets).toBe(12);
  });

  it('marks new hosts from PAST events before the window', async () => {
    const data: MonthData = {
      events: [
        makeEvent('e1', 'Hike', [member('1')]),
        makeEvent('e2', 'Picnic', [member('2')]),
      ],
      rsvps: new Map(),
    };
    const { client, getGroupEventsCount } = fakeClient({ '1': 0, '2': 4 });

    const payload = await buildHallOfFameReport(client, window, data, asOf);

    expect(getGroupEventsCount).toHaveBeenCalledWith({
      hostId: '1',
      beforeDateTime: '2026-09-01T07:00:00.000Z',
      status: ['PAST'],
    });
    expect(payload.hosts.map((h) => [h.host.id, h.isNew])).toEqual([
      ['1', true],
      ['2', false],
    ]);
    expect(payload.summary.newHosts).toBe(1);
    expect(payload.summary.hosts).toBe(2);
  });

  it('excludes cancelled and Open House events', async () => {
    const data: MonthData = {
      events: [
        makeEvent('e1', 'Hike', [member('1')]),
        makeEvent('e2', 'Hike (Cancelled)', [member('1')]),
        makeEvent('e3', '[Open House] Welcome', [member('1')]),
      ],
      rsvps: new Map(),
    };
    const { client } = fakeClient();

    const payload = await buildHallOfFameReport(client, window, data, asOf);

    expect(payload.totalEvents).toBe(1);
    expect(payload.summary.events).toBe(1);
    expect(payload.hosts[0].events).toHaveLength(1);
  });

  it('payload is JSON round-trippable and carries no private fields', async () => {
    const data: MonthData = {
      events: [makeEvent('e1', 'Hike', [member('1'), member('2')])],
      rsvps: new Map([['e1', [rsvp('YES')]]]),
    };
    const { client } = fakeClient({ '1': 0 });

    const payload = await buildHallOfFameReport(client, window, data, asOf);
    const json = JSON.stringify(payload);

    expect(JSON.parse(json)).toStrictEqual(payload);
    for (const forbidden of [
      '"gender"',
      '"description"',
      '"feeSettings"',
      '"status"',
    ]) {
      expect(json).not.toContain(forbidden);
    }
    expect(payload.period).toBe('2026-09');
    expect(payload.asOf).toBe('2026-10-01T07:00:00.000Z');
  });
});

describe('formatHostingStatsText', () => {
  it('keeps the old layout', async () => {
    const data: MonthData = {
      events: [makeEvent('e1', 'Hike', [member('1', 'Ann')])],
      rsvps: new Map([['e1', [rsvp('YES'), rsvp('ATTENDED')]]]),
    };
    const { client } = fakeClient({ '1': 0 });
    const payload = await buildHallOfFameReport(client, window, data, asOf);

    const text = formatHostingStatsText(payload, {
      periodLabel: '2026 September',
      showDates: false,
      includeLinks: false,
    });

    expect(text).toBe(`
**Hosting stats for 2026 September**

**#1: 1 Ann ID: 1** 🆕
    Hike (2/12) 

**Total: 1**

----- READY TO POST -----

**Hall of Fame — 2026 September**

**#1: Ann — 1 event** 🆕
    Hike (Sep 5)

New hosts: Ann (no co-hosts)

**Hosts: 1 · Events: 1**`);
  });
});
