import { describe, expect, it, vi } from 'vitest';

import { AuditEventNode } from '../../../src/lib/client/meetup/types.js';
import {
  HOST_NAME_MAX,
  MEETUP_EVENT_URL,
  TITLE_MAX,
  gqlAuditReader,
  toObservation,
} from '../../../src/lib/eventAudit/meetup.js';
import { attendanceUrl } from '../../../src/lib/hosts/hostEvents.js';

const NOW = new Date('2026-11-10T18:00:00Z');
const URL_1 = 'https://www.meetup.com/1-5genasians/events/311000001/';

const node = (overrides: Partial<AuditEventNode> = {}): AuditEventNode => ({
  id: '311000001',
  title: 'Board games',
  status: 'ACTIVE',
  dateTime: '2026-12-05T19:00-08:00',
  createdTime: '2026-10-01T00:00:00Z',
  duration: 'PT2H',
  eventUrl: URL_1,
  yes: { totalCount: 20 },
  waitlist: { totalCount: 2 },
  rsvpSettings: { rsvpsClosed: false },
  venue: { id: '27' },
  featuredEventPhoto: { id: '500' },
  eventHosts: [{ member: { id: '4242', name: 'Hana' } }],
  ...overrides,
});

describe('toObservation', () => {
  it('maps a full node', () => {
    expect(toObservation(node())).toEqual({
      eventId: '311000001',
      title: 'Board games',
      status: 'ACTIVE',
      startAt: new Date('2026-12-06T03:00:00Z'),
      createdAt: new Date('2026-10-01T00:00:00Z'),
      duration: 'PT2H',
      eventUrl: URL_1,
      venueId: '27',
      photoId: '500',
      hosts: [{ id: '4242', name: 'Hana' }],
      rsvpYes: 20,
      waitlist: 2,
      rsvpsClosed: false,
      lastEditedAt: null,
    });
  });

  it('drops a node without a usable id or start', () => {
    expect(toObservation(node({ id: 'abc' }))).toBeUndefined();
    expect(toObservation(node({ dateTime: 'nope' }))).toBeUndefined();
    expect(toObservation(null)).toBeUndefined();
    expect(toObservation('x')).toBeUndefined();
  });

  it('keeps member text verbatim but bounded, and unknown values as null', () => {
    const long = toObservation(node({ title: 'x'.repeat(10_000) }));
    expect(long?.title).toHaveLength(TITLE_MAX);
    expect(toObservation(node({ title: '<script>' }))?.title).toBe('<script>');
    expect(toObservation(node({ title: null }))?.title).toBe('');
    const host = toObservation(
      node({
        eventHosts: [
          { member: { id: '1', name: 'y'.repeat(500) } },
          { member: { id: 'nope', name: 'Z' } },
          null,
          { member: null },
        ],
      }),
    );
    expect(host?.hosts).toEqual([{ id: '1', name: 'y'.repeat(HOST_NAME_MAX) }]);
    expect(
      toObservation(node({ yes: { totalCount: '7' } }))?.rsvpYes,
    ).toBeNull();
    expect(
      toObservation(node({ yes: { totalCount: -1 } }))?.rsvpYes,
    ).toBeNull();
    expect(toObservation(node({ yes: null }))?.rsvpYes).toBeNull();
    expect(
      toObservation(node({ waitlist: { totalCount: 1.5 } }))?.waitlist,
    ).toBeNull();
    expect(toObservation(node({ createdTime: 'nope' }))?.createdAt).toBeNull();
    expect(toObservation(node({ createdTime: null }))?.createdAt).toBeNull();
    expect(toObservation(node({ rsvpSettings: null }))?.rsvpsClosed).toBeNull();
    expect(toObservation(node({ status: 'WHATEVER' }))?.status).toBe('UNKNOWN');
    expect(toObservation(node({ duration: '2 hours' }))?.duration).toBeNull();
    expect(toObservation(node({ venue: null }))?.venueId).toBeNull();
    expect(
      toObservation(node({ featuredEventPhoto: { id: 'x' } }))?.photoId,
    ).toBeNull();
  });

  it('keeps only a Meetup event URL', () => {
    expect(
      toObservation(node({ eventUrl: 'javascript:alert(1)' }))?.eventUrl,
    ).toBeNull();
    expect(
      toObservation(node({ eventUrl: 'https://evil.example/' }))?.eventUrl,
    ).toBeNull();
    expect(MEETUP_EVENT_URL.test(URL_1)).toBe(true);
    // hostEvents still uses the shared pattern.
    expect(attendanceUrl(URL_1)).toBe(`${URL_1}attendees/`);
  });
});

const page = (nodes: AuditEventNode[], endCursor?: string) => ({
  edges: nodes.map((n) => ({ node: n })),
  pageInfo: {
    hasNextPage: endCursor !== undefined,
    hasPreviousPage: false,
    startCursor: undefined,
    endCursor,
  },
  totalCount: nodes.length,
});

describe('gqlAuditReader', () => {
  function fakeClient() {
    const upcoming = [node(), node({ id: '311000002', title: 'Hike' })];
    const past = [
      node({ id: '311000002', title: 'Hike (past copy)', status: 'PAST' }),
      node({ id: '311000003', status: 'PAST' }),
    ];
    const list = vi.fn(
      async (input: { after?: string }, filter: { status?: string[] }) => {
        if (filter.status?.[0] === 'ACTIVE') {
          return input.after === undefined
            ? page([upcoming[0], node({ id: 'bad' })], 'c1')
            : page([upcoming[1]]);
        }
        return page(past);
      },
    );
    const one = vi.fn(async (id: string): Promise<AuditEventNode | null> => {
      return id === '311000001' ? node() : null;
    });
    return { getGroupEventsForAudit: list, getEventForAudit: one };
  }

  it('lists upcoming (all pages) and the last two days of past events, upcoming winning, bad nodes dropped', async () => {
    const client = fakeClient();
    const reader = gqlAuditReader(client);
    const events = await reader.listEvents(NOW);
    expect(events.map((e) => [e.eventId, e.title])).toEqual([
      ['311000001', 'Board games'],
      ['311000002', 'Hike'],
      ['311000003', 'Board games'],
    ]);
    expect(client.getGroupEventsForAudit).toHaveBeenCalledWith(
      { after: undefined, first: 100 },
      { status: ['ACTIVE'] },
    );
    expect(client.getGroupEventsForAudit).toHaveBeenLastCalledWith(
      { after: undefined, first: 100 },
      {
        status: ['PAST'],
        afterDateTime: '2026-11-08T18:00:00.000Z',
        beforeDateTime: '2026-11-10T18:00:00.000Z',
      },
    );
  });

  it('getEvent maps the node, or says null', async () => {
    const reader = gqlAuditReader(fakeClient());
    expect((await reader.getEvent('311000001'))?.title).toBe('Board games');
    expect(await reader.getEvent('999')).toBeNull();
  });

  it('an unreadable node from getEvent is an error, never "gone"', async () => {
    const client = fakeClient();
    client.getEventForAudit.mockResolvedValueOnce({ id: 'bad' });
    const reader = gqlAuditReader(client);
    await expect(reader.getEvent('311000001')).rejects.toThrow(/unreadable/);
  });

  it('other errors propagate', async () => {
    const client = fakeClient();
    client.getGroupEventsForAudit.mockRejectedValueOnce(new Error('502'));
    const reader = gqlAuditReader(client);
    await expect(reader.listEvents(NOW)).rejects.toThrow('502');
  });
});
