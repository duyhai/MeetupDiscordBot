import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Configuration from '../../../../src/configuration.js';
import { GqlMeetupClient } from '../../../../src/lib/client/meetup/gqlClient.js';
import { hostedAttendance } from '../../../../src/lib/client/meetup/types.js';
import { ApplicationCache } from '../../../../src/util/cache.js';
import { FakeCache } from '../../../web/fakeCache.js';

vi.mock('../../../../src/util/cache.js', () => ({ ApplicationCache: vi.fn() }));

const ENDPOINT = new URL(Configuration.meetup.endpoint);

beforeEach(() => {
  vi.mocked(ApplicationCache).mockResolvedValue(new FakeCache() as never);
});

afterEach(() => {
  nock.cleanAll();
  vi.restoreAllMocks();
});

function answer(body: unknown): {
  query: () => string;
  variables: () => Record<string, unknown>;
} {
  let sent = { query: '', variables: {} as Record<string, unknown> };
  nock(ENDPOINT.origin)
    .post(ENDPOINT.pathname, (b: typeof sent) => {
      sent = b;
      return true;
    })
    .reply(200, body);
  return { query: () => sent.query, variables: () => sent.variables };
}

const node = {
  id: '1',
  title: 'Hot Pot',
  dateTime: '2026-05-01T19:00:00-07:00',
  eventUrl: 'https://www.meetup.com/e/1/',
  eventHosts: [],
  maxTickets: 0,
  status: 'PAST' as const,
  attendance: { totalCount: 14 },
};

describe('getHostedEvents', () => {
  it('asks for past events hosted by the member with a yes+attended count', async () => {
    const sent = answer({
      data: {
        groupByUrlname: {
          id: 'g',
          events: {
            edges: [{ node }],
            pageInfo: { hasNextPage: false, hasPreviousPage: false },
            totalCount: 1,
          },
        },
      },
    });
    const client = new GqlMeetupClient('t', { bypassCache: true });

    const result = await client.getHostedEvents('42', { first: 100 });

    expect(result.groupByUrlname.events.edges[0].node.attendance).toEqual({
      totalCount: 14,
    });
    expect(sent.variables()).toEqual({
      urlname: Configuration.meetup.groupUrlName,
      first: 100,
      filter: { status: ['PAST'], hostId: '42' },
    });
    expect(sent.query()).toMatch(
      /attendance:\s*rsvps\(filter:\s*\{\s*rsvpStatus:\s*\[YES,\s*ATTENDED\]\s*\}\)\s*\{\s*totalCount\s*\}/,
    );
    // Nothing about other people: no co-host names, ids or profile URLs.
    expect(sent.query()).not.toMatch(/eventHosts|UserDetails|memberUrl/);
  });

  it('serves a second read from the request cache under its own name', async () => {
    const cache = new FakeCache();
    vi.mocked(ApplicationCache).mockResolvedValue(cache as never);
    answer({
      data: {
        groupByUrlname: {
          id: 'g',
          events: {
            edges: [],
            pageInfo: { hasNextPage: false, hasPreviousPage: false },
            totalCount: 0,
          },
        },
      },
    });
    const client = new GqlMeetupClient('t');

    await client.getHostedEvents('42', { first: 100 });
    await client.getHostedEvents('42', { first: 100 });

    expect(
      [...cache.values.keys()].some((k) => k.includes('getHostedEvents')),
    ).toBe(true);
    expect(nock.isDone()).toBe(true);
  });
});

describe('hostedAttendance', () => {
  it('attendance defaults to 0 when the node has none', () => {
    expect(hostedAttendance({ ...node, attendance: null })).toBe(0);
    expect(hostedAttendance({ ...node, attendance: undefined })).toBe(0);
    expect(
      hostedAttendance({ ...node, attendance: { totalCount: Number.NaN } }),
    ).toBe(0);
    expect(hostedAttendance(node)).toBe(14);
  });
});
