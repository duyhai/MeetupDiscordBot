import nock from 'nock';
import { Logger } from 'tslog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Configuration from '../../../../src/configuration.js';
import { GqlMeetupClient } from '../../../../src/lib/client/meetup/gqlClient.js';
import { ApplicationCache } from '../../../../src/util/cache.js';
import { installMeetupResponder } from '../../../fixtures/meetup/graphqlResponder.js';
import { WORLD_2026 } from '../../../fixtures/meetup/world2026.js';
import { FakeCache } from '../../../web/fakeCache.js';

// A fresh cache per test, as the golden tests do: cached answers skip the log.
vi.mock('../../../../src/util/cache.js', () => ({ ApplicationCache: vi.fn() }));

const ENDPOINT = new URL(Configuration.meetup.endpoint);

let infoCalls: () => unknown[][];

beforeEach(() => {
  vi.mocked(ApplicationCache).mockResolvedValue(new FakeCache() as never);
  const spy = vi.spyOn(Logger.prototype, 'info');
  infoCalls = () => spy.mock.calls;
});

afterEach(() => {
  nock.cleanAll();
  vi.restoreAllMocks();
});

/** Every string argument of every info call. */
function logged(): string[] {
  return infoCalls().flatMap((args) =>
    args.filter((a): a is string => typeof a === 'string'),
  );
}

function expectNoMemberData(lines: string[]) {
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    expect(line).not.toContain('/members/');
    for (const member of WORLD_2026.members) {
      expect(line).not.toContain(member.name);
    }
  }
}

describe('GqlMeetupClient result logs', () => {
  it('getGroupEvents logs counts, not host names', async () => {
    const responder = installMeetupResponder(WORLD_2026);
    const result = await new GqlMeetupClient('t').getGroupEvents(
      { first: 50 },
      {
        status: ['PAST'],
        afterDateTime: '2026-09-01T07:00:00.000Z',
        beforeDateTime: '2026-10-01T07:00:00.000Z',
      },
    );
    const edges = result.groupByUrlname.events.edges;
    // The fixture month has hosted events, so names were there to leak.
    expect(edges.length).toBeGreaterThan(0);
    expect(responder.unhandled()).toEqual([]);
    expectNoMemberData(logged());
    expect(logged()).toContain(
      `getGroupEvents page: ${edges.length} events, hasNextPage=false`,
    );
  });

  it('getGroupMembersByIds logs counts only', async () => {
    nock(ENDPOINT.origin)
      .post(ENDPOINT.pathname)
      .reply(200, {
        data: {
          groupByUrlname: {
            id: '1',
            memberships: {
              edges: WORLD_2026.members.slice(0, 2).map((m) => ({
                node: {
                  id: m.id,
                  name: m.name,
                  gender: 'NONE',
                  memberUrl: `https://www.meetup.com/members/${m.id}`,
                },
              })),
            },
          },
        },
      });
    const members = await new GqlMeetupClient('t').getGroupMembersByIds([
      WORLD_2026.members[0].id,
      WORLD_2026.members[1].id,
    ]);
    expect(members).toHaveLength(2);
    expectNoMemberData(logged());
    expect(logged()).toContain('getGroupMembersByIds: 2 members');
  });
});
