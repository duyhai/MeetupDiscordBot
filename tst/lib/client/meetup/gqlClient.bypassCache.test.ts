import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Configuration from '../../../../src/configuration.js';
import { GqlMeetupClient } from '../../../../src/lib/client/meetup/gqlClient.js';

const fake = vi.hoisted(() => ({
  store: new Map<string, string>(),
  gets: [] as string[],
  sets: [] as string[],
}));

vi.mock('../../../../src/util/cache.js', () => ({
  ApplicationCache: vi.fn(async () => ({
    get: async (key: string) => {
      fake.gets.push(key);
      return fake.store.get(key);
    },
    set: async (key: string, value: string) => {
      fake.sets.push(key);
      fake.store.set(key, value);
    },
    remove: async (key: string) => {
      fake.store.delete(key);
    },
  })),
}));

const ENDPOINT = new URL(Configuration.meetup.endpoint);
const graphqlScope = () => nock(ENDPOINT.origin).post(ENDPOINT.pathname);

const eventsAnswer = (dateTimes: string[]) => ({
  data: {
    groupByUrlname: {
      id: '1',
      events: {
        totalCount: dateTimes.length,
        pageInfo: { hasNextPage: false, endCursor: null },
        edges: dateTimes.map((dateTime, i) => ({
          node: { id: `e${i}`, title: `T${i}`, dateTime },
        })),
      },
    },
  },
});

const membersAnswer = {
  data: {
    groupByUrlname: {
      id: '1',
      memberships: {
        edges: [{ node: { id: '123', name: 'A Member' } }],
      },
    },
  },
};

const rsvpsAnswer = {
  data: {
    event: {
      id: 'e1',
      rsvps: {
        pageInfo: { hasNextPage: false, endCursor: null },
        edges: [{ node: { id: 'r1', status: 'NO_SHOW', member: { id: '9' } } }],
      },
    },
  },
};

const calls: Record<string, (c: GqlMeetupClient) => Promise<unknown>> = {
  getGroupEvents: (c) => c.getGroupEvents({ first: 10 }, { status: ['PAST'] }),
  getGroupEventsCount: (c) => c.getGroupEventsCount({ status: ['PAST'] }),
  getGroupMembersByIds: (c) => c.getGroupMembersByIds(['123']),
  getEventRsvps: (c) =>
    c.getEventRsvps('e1', { first: 100 }, { rsvpStatus: ['NO_SHOW'] }),
};

const answers: Record<string, unknown> = {
  getGroupEvents: eventsAnswer(['2026-03-05T00:00:00.000Z']),
  getGroupEventsCount: {
    data: { groupByUrlname: { id: '1', events: { totalCount: 4 } } },
  },
  getGroupMembersByIds: membersAnswer,
  getEventRsvps: rsvpsAnswer,
};

describe('GqlMeetupClient bypassCache', () => {
  beforeEach(() => {
    fake.store.clear();
    fake.gets.length = 0;
    fake.sets.length = 0;
  });

  afterEach(() => {
    nock.cleanAll();
  });

  describe.each(Object.keys(calls))('%s', (name) => {
    it('a bypassCache client never reads or writes the request cache', async () => {
      const scope = graphqlScope().times(2).reply(200, answers[name]);
      const client = new GqlMeetupClient('tok', { bypassCache: true });

      await calls[name](client);
      await calls[name](client);

      expect(scope.isDone()).toBe(true);
      expect(fake.gets).toEqual([]);
      expect(fake.sets).toEqual([]);
    });

    it('the default client still caches', async () => {
      const scope = graphqlScope().reply(200, answers[name]);
      const client = new GqlMeetupClient('tok');

      await calls[name](client);
      await calls[name](client);

      expect(scope.isDone()).toBe(true);
      expect(fake.sets).toHaveLength(1);
    });
  });

  it('a bypassCache client ignores a poisoned entry under the exact key', async () => {
    const seed = new GqlMeetupClient('seed');
    graphqlScope().reply(200, rsvpsAnswer);
    await seed.getEventRsvps('e1', { first: 100 }, { rsvpStatus: ['NO_SHOW'] });
    const [key] = fake.sets;
    fake.store.set(key, JSON.stringify({ data: 'poisoned' }));
    fake.sets.length = 0;

    graphqlScope().reply(200, rsvpsAnswer);
    const client = new GqlMeetupClient('tok', { bypassCache: true });
    const result = await client.getEventRsvps(
      'e1',
      { first: 100 },
      { rsvpStatus: ['NO_SHOW'] },
    );

    expect(JSON.stringify(result)).not.toContain('poisoned');
    expect(fake.sets).toEqual([]);
    expect(fake.store.get(key)).toContain('poisoned');
  });

  it("keeps getGroupEvents' start-time filtering", async () => {
    graphqlScope().reply(
      200,
      eventsAnswer(['2026-03-05T00:00:00.000Z', '2026-04-20T00:00:00.000Z']),
    );
    const client = new GqlMeetupClient('tok', { bypassCache: true });

    const result = await client.getGroupEvents(
      { first: 10 },
      {
        afterDateTime: '2026-03-01T00:00:00.000Z',
        beforeDateTime: '2026-04-01T00:00:00.000Z',
      },
    );

    const ids = result.groupByUrlname?.events?.edges.map((e) => e.node.id);
    expect(ids).toEqual(['e0']);
  });
});
