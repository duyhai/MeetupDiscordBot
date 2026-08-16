import nock from 'nock';
import { afterEach, describe, expect, it } from 'vitest';

import { GqlMeetupClient } from '../../src/lib/client/meetup/gqlClient.js';
import { getBadgeCounts } from '../../src/lib/helpers/badgeCounts.js';

const OUR_GROUP = '7595882';
const PAST = '2020-01-01T18:00:00-08:00';

const page = (
  nodes: { dateTime: string; groupId: string; id: string }[],
  hasNextPage = false,
) => ({
  self: {
    id: 'member-1',
    memberEvents: {
      pageInfo: { hasNextPage, endCursor: 'cursor-1' },
      totalCount: nodes.length,
      edges: nodes.map((n) => ({
        node: { id: n.id, dateTime: n.dateTime, group: { id: n.groupId } },
      })),
    },
  },
});

afterEach(() => {
  nock.cleanAll();
});

describe('getBadgeCounts (integration)', () => {
  it("counts the member's own past events in our group only", async () => {
    // Two GraphQL POSTs: hosted, then attended. The old implementation issued
    // one request per group event plus a paginated RSVP fetch for each --
    // ~1,400 for this group.
    const bodies: string[] = [];
    nock('https://api.meetup.com')
      .post('/gql-ext')
      .twice()
      .reply(200, (_uri, body) => {
        bodies.push(JSON.stringify(body));
        const isHosting = JSON.stringify(body).includes('isHosting: true');
        return {
          data: isHosting
            ? page([{ id: 'h1', groupId: OUR_GROUP, dateTime: PAST }])
            : page([
                { id: 'a1', groupId: OUR_GROUP, dateTime: PAST },
                { id: 'a2', groupId: OUR_GROUP, dateTime: PAST },
                // Another group the member belongs to; must not count.
                { id: 'a3', groupId: '1518941', dateTime: PAST },
                // Upcoming; must not count.
                {
                  id: 'a4',
                  groupId: OUR_GROUP,
                  dateTime: '2999-01-01T00:00:00Z',
                },
              ]),
        };
      });

    const counts = await getBadgeCounts(new GqlMeetupClient('token'));

    expect(counts).toEqual({ hostedCount: 1, attendedCount: 2 });
    expect(bodies).toHaveLength(2);
    expect(bodies.join()).toContain('isHosting: true');
    expect(bodies.join()).toContain('isHosting: false');
  });

  it('follows pagination and keeps counting across pages', async () => {
    nock('https://api.meetup.com')
      .post('/gql-ext')
      .reply(200, {
        data: page([{ id: 'h1', groupId: OUR_GROUP, dateTime: PAST }]),
      })
      .post('/gql-ext')
      .reply(200, {
        data: page(
          [{ id: 'a1', groupId: OUR_GROUP, dateTime: PAST }],
          true, // more attended pages follow
        ),
      })
      .post('/gql-ext')
      .reply(200, {
        data: page([{ id: 'a2', groupId: OUR_GROUP, dateTime: PAST }]),
      });

    const counts = await getBadgeCounts(new GqlMeetupClient('token'));

    expect(counts).toEqual({ hostedCount: 1, attendedCount: 2 });
  });
});
