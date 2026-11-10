import { Client } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import { GUILD_ID } from '../../../src/constants.js';
import { GqlMeetupClient } from '../../../src/lib/client/meetup/gqlClient.js';
import { getBadges } from '../../../src/lib/helpers/getBadges.js';
import { getUserRoles } from '../../../src/lib/helpers/getUserRoles.js';
import { selfOnboardUser } from '../../../src/lib/helpers/onboardUser.js';
import { verifyRunner } from '../../../src/web/host/hostServices.js';

vi.mock('../../../src/lib/helpers/onboardUser.js', () => ({
  selfOnboardUser: vi.fn().mockResolvedValue({
    meetupName: 'Ann',
    meetupMemberUrl: 'https://www.meetup.com/members/4242/',
  }),
}));
vi.mock('../../../src/lib/helpers/getUserRoles.js', () => ({
  getUserRoles: vi.fn().mockResolvedValue(['Guest Host']),
}));
vi.mock('../../../src/lib/helpers/getBadges.js', () => ({
  getBadges: vi.fn().mockResolvedValue({ hostedCount: 3, attendedCount: 12 }),
}));

describe('verifyRunner', () => {
  it('runs the Verify button’s three steps as the member, from the website', async () => {
    const guild = { id: GUILD_ID };
    const client = {
      guilds: { fetch: vi.fn().mockResolvedValue(guild) },
      users: { fetch: vi.fn().mockResolvedValue({ username: 'ann.n' }) },
    } as unknown as Client;
    const summary = await verifyRunner(() => client)(
      'meetup-token',
      '123456789012345678',
    );
    expect(summary).toEqual({
      meetupName: 'Ann',
      meetupMemberUrl: 'https://www.meetup.com/members/4242/',
      rolesGranted: ['Guest Host'],
      hostedCount: 3,
      attendedCount: 12,
    });
    const context = {
      guild,
      client,
      userId: '123456789012345678',
      username: 'ann.n',
      attempt: 'host dashboard',
    };
    for (const step of [selfOnboardUser, getUserRoles, getBadges]) {
      const [meetupClient, member] = vi.mocked(step).mock.calls[0];
      expect(meetupClient).toBeInstanceOf(GqlMeetupClient);
      expect(member).toEqual(context);
    }
    // One Meetup client, on the member's own token, for all three.
    expect(vi.mocked(getUserRoles).mock.calls[0][0]).toBe(
      vi.mocked(selfOnboardUser).mock.calls[0][0],
    );
  });

  it('refuses to run without a Discord client', async () => {
    await expect(
      verifyRunner(() => undefined)('t', '123456789012345678'),
    ).rejects.toThrow('not ready');
  });
});
