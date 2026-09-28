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

  it('looks up large lists in pages, so no real member is dropped', async () => {
    // This lookup decides which suspension rows are recorded. A single
    // oversized request that Meetup truncated would make every member past
    // the cap look unknown, and their suspensions would be skipped.
    const ids = Array.from({ length: 150 }, (_unused, i) => String(1000 + i));
    const sent: { memberIds: number[]; first: number }[] = [];
    graphqlScope()
      .times(2)
      .reply(
        200,
        (_uri, body: { variables: { memberIds: number[]; first: number } }) => {
          sent.push(body.variables);
          return {
            data: {
              groupByUrlname: {
                id: '1',
                memberships: {
                  edges: body.variables.memberIds.map((id) => ({
                    node: {
                      id: String(id),
                      name: `Member ${id}`,
                      gender: 'NONE',
                      memberUrl: `https://www.meetup.com/members/${id}`,
                    },
                  })),
                },
              },
            },
          };
        },
      );

    const client = new GqlMeetupClient('test-access-token');
    const members = await client.getGroupMembersByIds(ids);

    expect(sent.map((vars) => vars.memberIds.length)).toEqual([100, 50]);
    expect(sent.map((vars) => vars.first)).toEqual([100, 50]);
    expect(members.map((member) => member.id)).toEqual(ids);
  });
});

describe('GqlMeetupClient.getMemberRsvpEvents', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  function rsvpPage(
    events: { id: string; dateTime: string }[],
    hasNextPage = false,
  ) {
    return {
      data: {
        groupByUrlname: {
          id: '7595882',
          memberships: {
            edges: [
              {
                node: {
                  id: '100',
                  rsvps: {
                    pageInfo: {
                      hasNextPage,
                      hasPreviousPage: false,
                      startCursor: 's',
                      endCursor: `after-${events.at(-1)?.id}`,
                    },
                    totalCount: events.length,
                    edges: events.map((e) => ({
                      node: {
                        event: {
                          ...e,
                          title: `Event ${e.id}`,
                          eventUrl: `https://meetup.com/e/${e.id}`,
                        },
                      },
                    })),
                  },
                },
              },
            ],
          },
        },
      },
    };
  }

  it("queries one member's RSVPs in this group and pages through them", async () => {
    type Vars = {
      memberIds: number[];
      after?: string;
      filter: { groupId: string; rsvpStatus: string[]; eventStatus: string[] };
    };
    const sent: Vars[] = [];
    graphqlScope()
      .times(2)
      .reply(200, (_uri, body: { variables: Vars }) => {
        sent.push(body.variables);
        return body.variables.after
          ? rsvpPage([{ id: 'e2', dateTime: '2026-09-12T18:00:00-07:00' }])
          : rsvpPage(
              [{ id: 'e1', dateTime: '2026-09-05T18:00:00-07:00' }],
              true,
            );
      });

    const client = new GqlMeetupClient('test-access-token');
    const events = await client.getMemberRsvpEvents('100', '7595882', {
      rsvpStatus: ['NO_SHOW'],
      eventStatus: ['PAST'],
    });

    expect(events?.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(events?.[0].title).toBe('Event e1');
    expect(sent[0].memberIds).toEqual([100]);
    expect(sent[0].filter).toEqual({
      groupId: '7595882',
      rsvpStatus: ['NO_SHOW'],
      eventStatus: ['PAST'],
    });
    expect(sent[1].after).toBe('after-e1');
  });

  it('returns undefined for someone who is no longer a group member', async () => {
    graphqlScope().reply(200, {
      data: { groupByUrlname: { id: '7595882', memberships: { edges: [] } } },
    });

    const client = new GqlMeetupClient('test-access-token');
    expect(
      await client.getMemberRsvpEvents('999', '7595882', {
        rsvpStatus: ['NO_SHOW'],
        eventStatus: ['PAST'],
      }),
    ).toBeUndefined();
  });
});
