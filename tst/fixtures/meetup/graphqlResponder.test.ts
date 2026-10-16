import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GqlMeetupClient } from '../../../src/lib/client/meetup/gqlClient.js';
import { getPaginatedData } from '../../../src/lib/client/meetup/paginationHelper.js';
import { ApplicationCache } from '../../../src/util/cache.js';
import { FakeCache } from '../../web/fakeCache.js';
import { installMeetupResponder } from './graphqlResponder.js';
import { WORLD_2026 } from './world2026.js';

vi.mock('../../../src/util/cache.js', () => ({ ApplicationCache: vi.fn() }));

const TOKEN = 'responder-test-token';
const page = { first: 100 };

let client: GqlMeetupClient;

beforeEach(() => {
  // A fresh cache per test: cachedClientRequest would otherwise serve a
  // previous test's answer and the responder would never be asked.
  vi.mocked(ApplicationCache).mockResolvedValue(new FakeCache() as never);
  client = new GqlMeetupClient(TOKEN);
});

afterEach(() => {
  nock.cleanAll();
});

const ids = (edges: { node: { id: string } }[]) => edges.map((e) => e.node.id);

describe('installMeetupResponder', () => {
  it('honours status, the start-time window and hostId on group events', async () => {
    installMeetupResponder(WORLD_2026);

    const open = await client.getGroupEvents(page, {
      status: ['PAST', 'ACTIVE'],
    });
    expect(ids(open.groupByUrlname.events.edges)).not.toContain('e110');
    expect(ids(open.groupByUrlname.events.edges)).toContain('e101');

    const september = await client.getGroupEvents(page, {
      status: ['PAST', 'ACTIVE'],
      afterDateTime: '2026-09-01T07:00:00.000Z',
      beforeDateTime: '2026-10-01T06:59:59.999Z',
    });
    expect(ids(september.groupByUrlname.events.edges)).toEqual([
      'e101',
      'e102',
      'e103',
      'e104',
      'e105',
      'e106',
    ]);

    const hosted = await client.getGroupEvents(page, { hostId: '104' });
    expect(ids(hosted.groupByUrlname.events.edges)).toEqual(['e102']);
  });

  it('getGroupEventsCount counts the exact window', async () => {
    installMeetupResponder(WORLD_2026);

    await expect(
      client.getGroupEventsCount({
        hostId: '102',
        status: ['PAST'],
        beforeDateTime: '2026-09-01T07:00:00.000Z',
      }),
    ).resolves.toBe(2);
    await expect(
      client.getGroupEventsCount({
        hostId: '104',
        status: ['PAST'],
        beforeDateTime: '2026-09-01T07:00:00.000Z',
      }),
    ).resolves.toBe(0);
  });

  it('filters event RSVPs by rsvpStatus and pages them by cursor', async () => {
    const responder = installMeetupResponder(WORLD_2026, { maxPageSize: 2 });

    const present = await getPaginatedData(async (input) => {
      const result = await client.getEventRsvps('e101', input, {
        rsvpStatus: ['ATTENDED', 'YES'],
      });
      return result.event.rsvps;
    });
    expect(present.map((r) => r.member.id)).toEqual([
      '208',
      '209',
      '210',
      '211',
    ]);
    expect(
      responder.calls.filter((c) => c.name === 'getEventRsvps'),
    ).toHaveLength(2);

    const noShows = await getPaginatedData(async (input) => {
      const result = await client.getEventRsvps('e101', input, {
        rsvpStatus: ['NO_SHOW'],
      });
      return result.event.rsvps;
    });
    expect(noShows.map((r) => r.member.name)).toEqual(['Dana Lee', 'Eli Park']);
    expect(responder.unhandled()).toEqual([]);
  });

  it('member RSVPs split PAST from UPCOMING and include payment fields only on request', async () => {
    const responder = installMeetupResponder(WORLD_2026, { maxPageSize: 2 });
    const { groupId } = WORLD_2026;

    const past = await client.getMemberRsvpEvents('202', groupId, {
      rsvpStatus: ['NO_SHOW'],
      eventStatus: ['PAST'],
    });
    expect(past.map((e) => e.id)).toEqual(['e090', 'e101', 'e102']);
    expect(
      responder.calls.filter((c) => c.name === 'getMemberRsvps'),
    ).toHaveLength(2);

    const upcomingFilter = {
      rsvpStatus: ['YES' as const],
      eventStatus: ['UPCOMING' as const],
    };
    const withPay = await client.getMemberRsvpEvents(
      '202',
      groupId,
      upcomingFilter,
      {
        withPaymentInfo: true,
      },
    );
    expect(withPay.map((e) => e.id)).toEqual(['e109', 'e108']);
    expect(withPay[0]).toMatchObject({
      description: 'Bring cash or Venmo for drinks.',
    });
    expect(withPay[1]).toMatchObject({
      feeSettings: { amount: 15, currency: 'USD' },
    });

    const without = await client.getMemberRsvpEvents(
      '202',
      groupId,
      upcomingFilter,
    );
    expect(without).toHaveLength(2);
    without.forEach((event) => {
      expect(event).not.toHaveProperty('description');
      expect(event).not.toHaveProperty('feeSettings');
    });
  });

  it('a departed member has no membership', async () => {
    installMeetupResponder(WORLD_2026);

    await expect(
      client.getMemberRsvpEvents('204', WORLD_2026.groupId, {
        rsvpStatus: ['NO_SHOW'],
        eventStatus: ['PAST'],
      }),
    ).resolves.toBeUndefined();
  });

  it('records the bearer token of every request', async () => {
    const responder = installMeetupResponder(WORLD_2026);

    await client.getGroupEventsCount({ status: ['PAST'] });

    expect(responder.calls.map((c) => c.authorization)).toEqual([
      `Bearer ${TOKEN}`,
    ]);
  });

  it('an unknown filter key or query fails loudly', async () => {
    const responder = installMeetupResponder(WORLD_2026);

    await expect(client.getGroupEvents(page, { title: 'x' })).rejects.toThrow(
      /unsupported group event filter "title"/,
    );

    await expect(
      client.customRequest('{ self { id } }', '{}'),
    ).rejects.toThrow();
    expect(responder.unhandled()).toHaveLength(1);
  });
});
