import nock from 'nock';

import Configuration from '../../src/configuration.js';
import { GqlMeetupClient } from '../../src/lib/client/meetup/gqlClient.js';
import { getPaginatedData } from '../../src/lib/client/meetup/paginationHelper.js';
import { GroupEventFilter } from '../../src/lib/client/meetup/types.js';

// These tests intercept the real HTTP calls graphql-request makes (rather
// than mocking GqlMeetupClient itself), so they exercise the full chain used
// by helpers like getUserRoles: GqlMeetupClient -> paginationHelper ->
// cachedClientRequest -> a real ApplicationCache -- with only the network
// boundary to Meetup's API stubbed out.

const ENDPOINT = new URL(Configuration.meetup.endpoint);

function graphqlScope() {
  return nock(ENDPOINT.origin).post(ENDPOINT.pathname);
}

describe('GqlMeetupClient (integration)', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it('sends the access token as a bearer header and parses the response', async () => {
    const scope = graphqlScope()
      .matchHeader('authorization', 'Bearer test-access-token')
      .reply(200, {
        data: {
          groupByUrlname: {
            id: '1',
            name: 'test group',
            isMember: true,
            membershipMetadata: {
              status: 'ACTIVE',
              joinTime: '2020-01-01T00:00:00-04:00',
              rsvpStats: { noShowCount: 0 },
            },
          },
        },
      });

    const client = new GqlMeetupClient('test-access-token');
    const result = await client.getUserMembershipInfo();

    expect(result.groupByUrlname.isMember).toBe(true);
    expect(result.groupByUrlname.membershipMetadata.status).toBe('ACTIVE');
    expect(scope.isDone()).toBe(true);
  });

  it('rejects when Meetup returns a GraphQL error', async () => {
    graphqlScope().reply(200, {
      errors: [{ message: 'not authorized' }],
    });

    const client = new GqlMeetupClient('test-access-token');
    await expect(client.getUserMembershipInfo()).rejects.toThrow();
  });

  it('paginates through getGroupEvents via getPaginatedData, following the cursor across pages', async () => {
    const scope = graphqlScope()
      .reply(200, (_uri, body: { variables: { after?: string } }) => {
        expect(body.variables.after).toBeUndefined();
        return {
          data: {
            groupByUrlname: {
              events: {
                edges: [{ node: { id: 'event-1' } }],
                pageInfo: {
                  endCursor: 'cursor-1',
                  hasNextPage: true,
                  hasPreviousPage: false,
                  startCursor: 'cursor-1',
                },
                totalCount: 2,
              },
            },
          },
        };
      })
      .post(ENDPOINT.pathname)
      .reply(200, (_uri, body: { variables: { after?: string } }) => {
        expect(body.variables.after).toBe('cursor-1');
        return {
          data: {
            groupByUrlname: {
              events: {
                edges: [{ node: { id: 'event-2' } }],
                pageInfo: {
                  endCursor: 'cursor-2',
                  hasNextPage: false,
                  hasPreviousPage: true,
                  startCursor: 'cursor-2',
                },
                totalCount: 2,
              },
            },
          },
        };
      });

    const client = new GqlMeetupClient('test-access-token');
    const events = await getPaginatedData(async (paginationInput) => {
      const result = await client.getGroupEvents(paginationInput, {
        status: ['PAST'],
        hostId: 'host-1',
      });
      return result.groupByUrlname.events;
    });

    expect(events).toEqual([{ id: 'event-1' }, { id: 'event-2' }]);
    expect(scope.isDone()).toBe(true);
  });

  it('caches getGroupEvents so an identical request only hits the network once', async () => {
    const scope = graphqlScope().reply(200, {
      data: {
        groupByUrlname: {
          events: {
            edges: [{ node: { id: 'cached-event' } }],
            pageInfo: {
              endCursor: 'cursor-1',
              hasNextPage: false,
              hasPreviousPage: false,
              startCursor: 'cursor-1',
            },
            totalCount: 1,
          },
        },
      },
    });

    const client = new GqlMeetupClient('test-access-token');
    const input = { first: 100 };
    const filter: GroupEventFilter = {
      status: ['PAST'],
      hostId: 'cache-test-host',
    };

    const first = await client.getGroupEvents(input, filter);
    const second = await client.getGroupEvents(input, filter);

    expect(first).toEqual(second);
    // nock would throw on the second call if it actually reached the
    // network again, since the interceptor above is single-use by default.
    expect(scope.isDone()).toBe(true);
  });
});
