import { ClientError } from 'graphql-request';
import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Configuration from '../../../../src/configuration.js';
import {
  GqlMeetupClient,
  MeetupGroupUnreadableError,
} from '../../../../src/lib/client/meetup/gqlClient.js';
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

function answer(
  status: number,
  body: unknown,
): { query: () => string; variables: () => Record<string, unknown> } {
  let sent = { query: '', variables: {} as Record<string, unknown> };
  nock(ENDPOINT.origin)
    .post(ENDPOINT.pathname, (b: typeof sent) => {
      sent = b;
      return true;
    })
    .reply(status, body);
  return { query: () => sent.query, variables: () => sent.variables };
}

const client = () => new GqlMeetupClient('t', { bypassCache: true });
const page = {
  edges: [{ node: { id: '1' } }],
  pageInfo: { hasNextPage: false, hasPreviousPage: false },
  totalCount: 1,
};

describe('getGroupEventsForAudit', () => {
  it('sends the filter as given and asks for the audit fields', async () => {
    const sent = answer(200, {
      data: { groupByUrlname: { id: 'g', events: page } },
    });
    const result = await client().getGroupEventsForAudit(
      { first: 100 },
      { status: ['PAST'], beforeDateTime: '2026-11-10T18:00:00.000Z' },
    );
    expect(result.edges).toHaveLength(1);
    expect(sent.variables().filter).toEqual({
      status: ['PAST'],
      beforeDateTime: '2026-11-10T18:00:00.000Z',
    });
    expect(sent.query()).toMatch(/going\s+waiting/);
    expect(sent.query()).toMatch(/rsvpSettings\s*\{\s*rsvpsClosed\s*\}/);
    expect(sent.query()).toMatch(/featuredEventPhoto\s*\{\s*id\s*\}/);
  });

  it('the core variant asks for the proven fields only', async () => {
    const sent = answer(200, {
      data: { groupByUrlname: { id: 'g', events: page } },
    });
    await client().getGroupEventsForAudit(
      { first: 100 },
      { status: ['ACTIVE'] },
      'core',
    );
    expect(sent.query()).not.toMatch(/going|waiting|rsvpSettings/);
    expect(sent.query()).toMatch(/rsvps\s*\{\s*yesCount\s*\}/);
  });

  it('an unreadable group is the named error', async () => {
    answer(200, { data: { groupByUrlname: null } });
    await expect(
      client().getGroupEventsForAudit({ first: 100 }, { status: ['ACTIVE'] }),
    ).rejects.toBeInstanceOf(MeetupGroupUnreadableError);
  });
});

describe('getEventForAudit', () => {
  it('returns the node', async () => {
    const sent = answer(200, { data: { event: { id: '5', title: 'T' } } });
    expect(await client().getEventForAudit('5')).toEqual({
      id: '5',
      title: 'T',
    });
    expect(sent.variables()).toEqual({ eventId: '5' });
  });

  it('a null event is null, with or without errors alongside', async () => {
    answer(200, { data: { event: null } });
    expect(await client().getEventForAudit('5')).toBeNull();
    answer(200, { data: { event: null }, errors: [{ message: 'not found' }] });
    expect(await client().getEventForAudit('5')).toBeNull();
  });

  it('anything else throws', async () => {
    answer(500, 'boom');
    await expect(client().getEventForAudit('5')).rejects.toBeInstanceOf(
      ClientError,
    );
    answer(200, { errors: [{ message: 'Cannot query field "going"' }] });
    await expect(client().getEventForAudit('5')).rejects.toBeInstanceOf(
      ClientError,
    );
  });
});
