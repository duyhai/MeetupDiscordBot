import { ButtonInteraction } from 'discord.js';
import crypto from 'crypto';
import nock from 'nock';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GqlMeetupClient } from '../../src/lib/client/meetup/gqlClient.js';
import { getBadges } from '../../src/lib/helpers/getBadges.js';

vi.mock('../../src/lib/helpers/onboardUser.js', () => ({
  syncRewardRoles: vi.fn().mockResolvedValue(undefined),
}));

const OUR_GROUP = '7595882';

// getGroupEvents is cached, and Redis retains entries between runs. A member
// id unique per execution keeps the cache key fresh, so these assertions see
// real network traffic rather than a hit left by a previous run.
const MEMBER_ID = `m-${crypto.randomUUID()}`;

/**
 * Guards the CALL SITE, not the helper.
 *
 * A previous release shipped the fast badge helper without wiring it into
 * getBadges: every unit test passed, the helper was correct, and production
 * quietly kept running the old group-wide scan (398 getEventRsvps requests in
 * one run). Testing the helper in isolation cannot catch that -- only
 * asserting what getBadges actually puts on the wire can.
 */
// getGroupEvents goes through cachedClientRequest, and CI runs against a real
// Redis shared by every integration file. A member id unique to this file
// keeps the cache key distinct, so the request actually reaches the wire
// where these assertions can see it -- with a shared id, whichever file ran
// first served the other from cache and the assertion failed only in CI.
afterEach(() => {
  nock.cleanAll();
});

function fakeInteraction() {
  return {
    guild: {},
    user: { id: 'discord-1', username: 'tester' },
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
  } as unknown as ButtonInteraction;
}

describe('getBadges wiring', () => {
  it('uses the member-scoped queries and never the per-event RSVP scan', async () => {
    const sent: string[] = [];
    nock('https://api.meetup.com')
      .post('/gql-ext')
      .times(5)
      .reply(200, (_uri, body) => {
        const text = JSON.stringify(body);
        sent.push(text);
        if (text.includes('groupByUrlname')) {
          return {
            data: {
              groupByUrlname: {
                id: OUR_GROUP,
                events: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  totalCount: 1,
                  edges: [{ node: { id: 'e1' } }],
                },
              },
            },
          };
        }
        if (text.includes('eventStatus: PAST')) {
          return {
            data: { self: { id: MEMBER_ID, rsvps: { totalCount: 327 } } },
          };
        }
        return {
          data: {
            self: { id: MEMBER_ID, name: 'M', gender: 'OTHER', memberUrl: '' },
          },
        };
      });

    await getBadges(new GqlMeetupClient('token'), fakeInteraction());

    const all = sent.join('\n');
    // The fan-out that exhausted the dyno's memory must be gone from this path.
    expect(all).not.toContain('getEventRsvps');
    expect(all).not.toContain('rsvps(first: $first');
    // ...and the replacement must actually be in use.
    expect(all).toContain('eventStatus: PAST');
    expect(all).toContain(`"hostId":"${MEMBER_ID}"`);
  });
});
