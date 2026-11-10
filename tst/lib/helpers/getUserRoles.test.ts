import { describe, expect, it, vi } from 'vitest';

import { getUserRoles } from '../../../src/lib/helpers/getUserRoles.js';
import { addServerRole } from '../../../src/lib/helpers/onboardUser.js';

vi.mock('../../../src/lib/helpers/onboardUser.js', () => ({
  addServerRole: vi.fn().mockResolvedValue(undefined),
}));

const USER = {
  guild: {} as never,
  userId: '123456789012345678',
  username: 'Ann',
};

/** A member (not an organizer) whose PAST hosted events are `nodes`. */
function meetup(nodes: { title: string; status: string }[], status = 'ACTIVE') {
  return {
    getUserMembershipInfo: vi.fn().mockResolvedValue({
      groupByUrlname: { isMember: true, membershipMetadata: { status } },
    }),
    getUserInfo: vi.fn().mockResolvedValue({ self: { id: '4242' } }),
    getGroupEvents: vi.fn().mockResolvedValue({
      groupByUrlname: {
        id: 'g',
        events: {
          pageInfo: { hasNextPage: false, endCursor: null },
          totalCount: nodes.length,
          edges: nodes.map((n, i) => ({
            node: {
              id: String(i),
              dateTime: '2026-01-01T19:00:00-08:00',
              ...n,
            },
          })),
        },
      },
    }),
  } as never;
}

describe('getUserRoles', () => {
  it('grants Guest Host for a counted hosted event', async () => {
    await expect(
      getUserRoles(meetup([{ title: 'Hike', status: 'PAST' }]), USER),
    ).resolves.toEqual(['Guest Host']);
    expect(addServerRole).toHaveBeenCalledWith({}, USER.userId, 'guest_host');
  });

  it('a host whose only events are Open Houses or cancelled gets no role', async () => {
    vi.mocked(addServerRole).mockClear();
    await expect(
      getUserRoles(
        meetup([
          { title: '[Open House] Pickleball', status: 'PAST' },
          { title: 'Trivia', status: 'CANCELLED' },
          { title: 'Cancelled: Boba', status: 'PAST' },
        ]),
        USER,
      ),
    ).resolves.toEqual([]);
    expect(addServerRole).not.toHaveBeenCalled();
  });

  it('an organizer gets both roles without any event count', async () => {
    const client = meetup([], 'LEADER');
    await expect(getUserRoles(client, USER)).resolves.toEqual([
      'Organizer',
      'Guest Host',
    ]);
    expect(
      (client as { getGroupEvents: unknown }).getGroupEvents,
    ).not.toHaveBeenCalled();
  });
});
