import nock from 'nock';
import { afterEach, describe, expect, it } from 'vitest';

import { GqlMeetupClient } from '../../src/lib/client/meetup/gqlClient.js';
import { getBadgeCounts } from '../../src/lib/helpers/badgeCounts.js';

const OUR_GROUP = '7595882';

/**
 * The counts come from server-side filters, so what these tests can prove is
 * that the right filters are SENT and the response is read correctly. That
 * the filters actually mean what their names say was established against the
 * live API: self.rsvps with this filter returned 327 where the member's
 * unfiltered total was 413, and a different groupId returned 1.
 *
 * The previous implementation failed precisely here -- it sent a query whose
 * data was upcoming events, counted zero, and stripped everyone's badges --
 * so these assertions pin the filter arguments themselves, not just the math.
 */
afterEach(() => {
  nock.cleanAll();
});

function mockMeetup(onBody: (body: string) => object) {
  nock('https://api.meetup.com')
    .post('/gql-ext')
    .times(3)
    .reply(200, (_uri, body) => onBody(JSON.stringify(body)));
}

describe('getBadgeCounts (integration)', () => {
  it('asks for past RSVPs in our group and hosted events by this member', async () => {
    const sent: string[] = [];
    mockMeetup((body) => {
      sent.push(body);
      if (body.includes('groupByUrlname')) {
        return {
          data: {
            groupByUrlname: {
              id: OUR_GROUP,
              events: {
                pageInfo: { hasNextPage: false, endCursor: null },
                totalCount: 2,
                edges: [{ node: { id: 'e1' } }, { node: { id: 'e2' } }],
              },
            },
          },
        };
      }
      if (body.includes('eventStatus: PAST')) {
        return {
          data: { self: { id: 'member-1', rsvps: { totalCount: 327 } } },
        };
      }
      if (body.includes('UserDetails')) {
        return {
          data: {
            self: { id: 'member-1', name: 'M', gender: 'OTHER', memberUrl: '' },
          },
        };
      }
      throw new Error(`unexpected query: ${body.slice(0, 120)}`);
    });

    const counts = await getBadgeCounts(new GqlMeetupClient('token'));

    expect(counts).toEqual({ hostedCount: 2, attendedCount: 327 });

    const all = sent.join('\n');
    // Attendance must be scoped to past events in our group with the same
    // RSVP statuses the old per-event scan used.
    expect(all).toContain('eventStatus: PAST');
    expect(all).toContain('rsvpStatus: [YES, ATTENDED]');
    expect(all).toContain(OUR_GROUP);
    // Hosted must be server-filtered to this member, not scanned client-side.
    expect(all).toContain('"hostId":"member-1"');
    expect(all).toContain('PAST');
  });

  it("never falls back to scanning every event's RSVPs", async () => {
    const sent: string[] = [];
    mockMeetup((body) => {
      sent.push(body);
      if (body.includes('groupByUrlname')) {
        return {
          data: {
            groupByUrlname: {
              id: OUR_GROUP,
              events: {
                pageInfo: { hasNextPage: false, endCursor: null },
                totalCount: 0,
                edges: [],
              },
            },
          },
        };
      }
      if (body.includes('eventStatus: PAST')) {
        return { data: { self: { id: 'member-1', rsvps: { totalCount: 5 } } } };
      }
      return {
        data: {
          self: { id: 'member-1', name: 'M', gender: 'OTHER', memberUrl: '' },
        },
      };
    });

    await getBadgeCounts(new GqlMeetupClient('token'));

    // getEventRsvps is the per-event fan-out that caused the R14s.
    expect(sent.join('\n')).not.toContain('getEventRsvps');
    // A handful of requests, not one per group event. Not pinned to an exact
    // number: getUserInfo goes through the shared cache, so whether it hits
    // the network depends on what ran before it.
    expect(sent.length).toBeLessThanOrEqual(3);
  });
});
