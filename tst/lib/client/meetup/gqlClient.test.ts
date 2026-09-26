import nock from 'nock';
import { afterEach, describe, expect, it } from 'vitest';

import Configuration from '../../../../src/configuration.js';
import { GqlMeetupClient } from '../../../../src/lib/client/meetup/gqlClient.js';

// Mirrors tst/integration/gqlMeetupClient.test.ts: intercepts the real HTTP
// call so the exact GraphQL variables sent to Meetup can be asserted.
const ENDPOINT = new URL(Configuration.meetup.endpoint);

function graphqlScope() {
  return nock(ENDPOINT.origin).post(ENDPOINT.pathname);
}

describe('GqlMeetupClient.getGroupEventsCount', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it('sends the beforeDateTime filter unmodified, with no +1-month expansion', async () => {
    const beforeIso = '2026-03-01T00:00:00.000Z';
    const scope = graphqlScope().reply(
      200,
      (_uri, body: { variables: { filter?: { beforeDateTime?: string } } }) => {
        // getGroupEvents pads beforeDateTime by +1 month to catch multi-day
        // events; getGroupEventsCount must NOT do that, since it exists
        // specifically to answer "is the count within this exact window".
        expect(body.variables.filter?.beforeDateTime).toBe(beforeIso);
        return {
          data: {
            groupByUrlname: {
              id: '1',
              events: { totalCount: 3 },
            },
          },
        };
      },
    );

    const client = new GqlMeetupClient('test-access-token');
    const count = await client.getGroupEventsCount({
      hostId: 'host-1',
      beforeDateTime: beforeIso,
      status: ['PAST'],
    });

    expect(count).toBe(3);
    expect(scope.isDone()).toBe(true);
  });

  it('returns 0 when the group has no matching events', async () => {
    graphqlScope().reply(200, {
      data: {
        groupByUrlname: {
          id: '1',
          events: { totalCount: 0 },
        },
      },
    });

    const client = new GqlMeetupClient('test-access-token');
    const count = await client.getGroupEventsCount({
      hostId: 'host-2',
      beforeDateTime: '2026-01-01T00:00:00.000Z',
      status: ['PAST'],
    });

    expect(count).toBe(0);
  });
});

describe('GqlMeetupClient.getGroupMembersByIds', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it('sends numeric member IDs and returns the resolved members', async () => {
    const scope = graphqlScope().reply(
      200,
      (_uri, body: { variables: { memberIds?: number[]; first?: number } }) => {
        expect(body.variables.memberIds).toEqual([186415647, 123]);
        expect(body.variables.first).toBe(2);
        return {
          data: {
            groupByUrlname: {
              id: '1',
              memberships: {
                edges: [
                  {
                    node: {
                      id: '186415647',
                      name: 'Alice',
                      gender: 'NONE',
                      memberUrl: 'https://www.meetup.com/members/186415647',
                    },
                  },
                ],
              },
            },
          },
        };
      },
    );

    const client = new GqlMeetupClient('test-access-token');
    const members = await client.getGroupMembersByIds(['186415647', '123']);

    expect(members).toHaveLength(1);
    expect(members[0].name).toBe('Alice');
    expect(scope.isDone()).toBe(true);
  });

  it('returns an empty list without a request for no IDs', async () => {
    const client = new GqlMeetupClient('test-access-token');
    expect(await client.getGroupMembersByIds([])).toEqual([]);
  });
});
