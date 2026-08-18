import nock from 'nock';
import { afterEach, describe, expect, it } from 'vitest';

import { GqlMeetupClient } from '../../src/lib/client/meetup/gqlClient.js';

/**
 * Guards what actually goes on the wire for the membership roster query.
 *
 * memberPhoto.id is the change signal the identity sweep diffs against --
 * without it the sweep can never detect a photo change, only a name change.
 * A unit test against a hand-rolled fixture would keep passing if the query
 * silently dropped that field; only asserting the request body catches it.
 */
afterEach(() => {
  nock.cleanAll();
});

function membershipsPage(_uri: string, _body: unknown) {
  return {
    data: {
      groupByUrlname: {
        memberships: {
          pageInfo: {
            hasNextPage: false,
            hasPreviousPage: false,
            startCursor: null,
            endCursor: null,
          },
          totalCount: 1,
          edges: [
            {
              node: {
                id: 'm1',
                name: 'Jane D.',
                username: 'janed',
                memberPhoto: { id: 'p1', thumbUrl: 'https://x/p1.jpg' },
              },
            },
          ],
        },
      },
    },
  };
}

describe('getGroupMemberships wiring', () => {
  it('requests photo id and thumb url, paginated', async () => {
    const sent: string[] = [];
    nock('https://api.meetup.com')
      .post('/gql-ext')
      .times(2)
      .reply(200, (uri, body) => {
        sent.push(JSON.stringify(body));
        return membershipsPage(uri, body);
      });

    const client = new GqlMeetupClient('token');
    const result = await client.getGroupMemberships({ first: 100 });

    const all = sent.join('\n');
    // memberPhoto.id is the change signal -- without it the sweep can never
    // detect a photo change, only a name change.
    expect(all).toContain('memberPhoto');
    expect(all).toContain('thumbUrl');
    expect(
      result.groupByUrlname.memberships.edges[0].node.memberPhoto?.id,
    ).toBe('p1');
  });

  it('hits the API on every call rather than serving a cached roster', async () => {
    const scope = nock('https://api.meetup.com')
      .post('/gql-ext')
      .times(2)
      .reply(200, membershipsPage);

    const client = new GqlMeetupClient('token');
    await client.getGroupMemberships({ first: 100 });
    await client.getGroupMemberships({ first: 100 });

    // The sweep compares a stored baseline against what this returns. A
    // cached roster would satisfy one interceptor and leave the other
    // pending -- and would make every sweep diff against stale data.
    expect(scope.isDone()).toBe(true);
  });
});
