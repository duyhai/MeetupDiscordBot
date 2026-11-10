import { ClientError } from 'graphql-request';
import { describe, expect, it, vi } from 'vitest';

import { AuditEventNode } from '../../../src/lib/client/meetup/types.js';
import {
  HOST_NAME_MAX,
  MEETUP_EVENT_URL,
  TITLE_MAX,
  createAuditQueryState,
  gqlAuditReader,
  isMeetupSchemaRefusal,
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
  duration: 'PT2H',
  eventUrl: URL_1,
  going: 20,
  waiting: 2,
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
    expect(toObservation(node({ going: '7' }))?.rsvpYes).toBeNull();
    expect(toObservation(node({ going: -1 }))?.rsvpYes).toBeNull();
    expect(toObservation(node({ waiting: 1.5 }))?.waitlist).toBeNull();
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

  it('takes the yes count from the core query shape too', () => {
    expect(
      toObservation({ ...node({ going: undefined }), rsvps: { yesCount: 9 } }),
    ).toMatchObject({ rsvpYes: 9, waitlist: 2 });
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

const refusal = (status: number, message = 'Cannot query field "going"') =>
  new ClientError({ status, errors: [{ message }] } as never, { query: 'q' });

describe('isMeetupSchemaRefusal', () => {
  it('is a 400, or a 200 whose errors name an unknown field', () => {
    expect(isMeetupSchemaRefusal(refusal(400, 'Bad Request'))).toBe(true);
    expect(isMeetupSchemaRefusal(refusal(200))).toBe(true);
    expect(
      isMeetupSchemaRefusal(
        refusal(200, 'Validation error of type FieldUndefined'),
      ),
    ).toBe(true);
    expect(isMeetupSchemaRefusal(refusal(200, 'not found'))).toBe(false);
    expect(isMeetupSchemaRefusal(refusal(500))).toBe(false);
    expect(isMeetupSchemaRefusal(new Error('x'))).toBe(false);
  });
});

describe('gqlAuditReader', () => {
  function fakeClient(options: { refuseFull?: boolean } = {}) {
    const upcoming = [node(), node({ id: '311000002', title: 'Hike' })];
    const past = [
      node({ id: '311000002', title: 'Hike (past copy)', status: 'PAST' }),
      node({ id: '311000003', status: 'PAST' }),
    ];
    const list = vi.fn(
      async (
        input: { after?: string },
        filter: { status?: string[] },
        variant: 'full' | 'core',
      ) => {
        if (options.refuseFull && variant === 'full') {
          throw refusal(400);
        }
        if (filter.status?.[0] === 'ACTIVE') {
          return input.after === undefined
            ? page([upcoming[0], node({ id: 'bad' })], 'c1')
            : page([upcoming[1]]);
        }
        return page(past);
      },
    );
    const one = vi.fn(async (id: string, variant: 'full' | 'core') => {
      if (options.refuseFull && variant === 'full') {
        throw refusal(400);
      }
      return id === '311000001' ? node() : null;
    });
    return { getGroupEventsForAudit: list, getEventForAudit: one };
  }

  it('lists upcoming (all pages) and the last two days of past events, upcoming winning, bad nodes dropped', async () => {
    const client = fakeClient();
    const reader = gqlAuditReader(client, createAuditQueryState());
    const events = await reader.listEvents(NOW);
    expect(events.map((e) => [e.eventId, e.title])).toEqual([
      ['311000001', 'Board games'],
      ['311000002', 'Hike'],
      ['311000003', 'Board games'],
    ]);
    expect(client.getGroupEventsForAudit).toHaveBeenCalledWith(
      { after: undefined, first: 100 },
      { status: ['ACTIVE'] },
      'full',
    );
    expect(client.getGroupEventsForAudit).toHaveBeenLastCalledWith(
      { after: undefined, first: 100 },
      {
        status: ['PAST'],
        afterDateTime: '2026-11-08T18:00:00.000Z',
        beforeDateTime: '2026-11-10T18:00:00.000Z',
      },
      'full',
    );
    expect(reader.usingFallback()).toBe(false);
  });

  it('getEvent maps the node, or says null', async () => {
    const reader = gqlAuditReader(fakeClient(), createAuditQueryState());
    expect((await reader.getEvent('311000001'))?.title).toBe('Board games');
    expect(await reader.getEvent('999')).toBeNull();
  });

  it('falls back to the core query once Meetup refuses the full one, and remembers it', async () => {
    const client = fakeClient({ refuseFull: true });
    const state = createAuditQueryState();
    const reader = gqlAuditReader(client, state);
    const events = await reader.listEvents(NOW);
    expect(events).toHaveLength(3);
    expect(reader.usingFallback()).toBe(true);
    const variants = client.getGroupEventsForAudit.mock.calls.map((c) => c[2]);
    expect(variants).toEqual(['full', 'core', 'core', 'core']);
    expect((await reader.getEvent('311000001'))?.title).toBe('Board games');
    expect(client.getEventForAudit).toHaveBeenCalledWith('311000001', 'core');
    // A new reader on the same state starts in the fallback.
    const again = gqlAuditReader(client, state);
    await again.getEvent('999');
    expect(client.getEventForAudit).toHaveBeenLastCalledWith('999', 'core');
  });

  it('other errors propagate', async () => {
    const client = fakeClient();
    client.getGroupEventsForAudit.mockRejectedValueOnce(refusal(500));
    const reader = gqlAuditReader(client, createAuditQueryState());
    await expect(reader.listEvents(NOW)).rejects.toBeInstanceOf(ClientError);
    expect(reader.usingFallback()).toBe(false);
  });
});
