import { ButtonInteraction, Collection, Guild } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SERVER_ROLES } from '../../../src/constants.js';
import { GqlMeetupClient } from '../../../src/lib/client/meetup/gqlClient.js';
import {
  DuplicateMeetupAccountError,
  recordMeetupLink,
} from '../../../src/lib/helpers/memberLink.js';
import { selfOnboardUser } from '../../../src/lib/helpers/onboardUser.js';

vi.mock('../../../src/lib/helpers/memberLink.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../src/lib/helpers/memberLink.js')
  >()),
  recordMeetupLink: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../../src/lib/helpers/identity/monitor.js', () => ({
  updateBaselineSilently: vi.fn().mockResolvedValue(undefined),
}));

const USER_ID = 'discord-7';

function fakeInteraction() {
  const guildMember = {
    id: USER_ID,
    nickname: null,
    permissions: { has: vi.fn().mockReturnValue(false) },
    setNickname: vi.fn().mockResolvedValue(undefined),
    roles: {
      // The member still holds a role named Reverify: the bot leaves it be.
      cache: new Map([['reverify-role', {}]]),
      add: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
  };
  const rolesFetch = vi.fn((id?: string) =>
    Promise.resolve(
      id === undefined
        ? new Collection([
            ['reverify-role', { id: 'reverify-role', name: 'Reverify' }],
          ])
        : { id },
    ),
  );
  const guild = {
    members: { fetch: vi.fn().mockResolvedValue(guildMember) },
    roles: { fetch: rolesFetch },
  } as unknown as Guild;
  const interaction = {
    guild,
    client: {
      users: {
        fetch: vi.fn().mockResolvedValue({
          id: USER_ID,
          tag: 'member#0001',
          username: 'member',
        }),
      },
    },
    user: { id: USER_ID, username: 'member', toString: () => `<@${USER_ID}>` },
  } as unknown as ButtonInteraction;
  return { interaction, guildMember, rolesFetch };
}

const meetupClient = {
  getUserInfo: vi.fn().mockResolvedValue({
    self: {
      id: '300',
      name: 'jane doe',
      gender: 'FEMALE',
      memberUrl: 'https://www.meetup.com/members/300/',
    },
  }),
  getUserMembershipInfo: vi.fn().mockResolvedValue({
    groupByUrlname: { id: '7595882', name: '1.5 Gen Asians', isMember: true },
  }),
} as unknown as GqlMeetupClient;

describe('self link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records the link, then gives the lounge role and lifts Onboarding', async () => {
    const { interaction, guildMember, rolesFetch } = fakeInteraction();

    await expect(selfOnboardUser(meetupClient, interaction)).resolves.toEqual({
      meetupName: 'jane doe',
      meetupMemberUrl: 'https://www.meetup.com/members/300/',
    });

    expect(recordMeetupLink).toHaveBeenCalledWith(
      interaction,
      {
        meetupId: '300',
        meetupName: 'jane doe',
        meetupMemberUrl: 'https://www.meetup.com/members/300/',
      },
      'self_onboard',
    );
    expect(guildMember.setNickname).toHaveBeenCalledWith('Jane D.');
    expect(rolesFetch.mock.calls).toEqual([
      [SERVER_ROLES.ladies_lounge],
      [SERVER_ROLES.onboarding],
    ]);
    expect(guildMember.roles.add).toHaveBeenCalledTimes(1);
    expect(guildMember.roles.add).toHaveBeenCalledWith({
      id: SERVER_ROLES.ladies_lounge,
    });
    expect(guildMember.roles.remove).toHaveBeenCalledTimes(1);
    expect(guildMember.roles.remove).toHaveBeenCalledWith({
      id: SERVER_ROLES.onboarding,
    });
  });

  it('looks for no Reverify role: roles are fetched only by id', async () => {
    const { interaction, guildMember, rolesFetch } = fakeInteraction();

    await selfOnboardUser(meetupClient, interaction);

    for (const call of rolesFetch.mock.calls) {
      expect(call).toHaveLength(1);
      expect(typeof call[0]).toBe('string');
    }
    // No remove call, whatever its arguments, names the Reverify role.
    const names = (arg: unknown) =>
      arg === 'reverify-role' ||
      (typeof arg === 'object' &&
        arg !== null &&
        (arg as { id?: unknown }).id === 'reverify-role');
    for (const call of guildMember.roles.remove.mock.calls as unknown[][]) {
      expect(call.some(names), JSON.stringify(call)).toBe(false);
    }
  });

  it('still onboards when the link could not be saved', async () => {
    vi.mocked(recordMeetupLink).mockResolvedValueOnce(false);
    const { interaction, guildMember } = fakeInteraction();

    await selfOnboardUser(meetupClient, interaction);

    expect(guildMember.roles.remove).toHaveBeenCalledWith({
      id: SERVER_ROLES.onboarding,
    });
  });

  it('a link refused as a duplicate onboards nobody', async () => {
    vi.mocked(recordMeetupLink).mockRejectedValueOnce(
      new DuplicateMeetupAccountError('already linked'),
    );
    const { interaction, guildMember } = fakeInteraction();

    await expect(selfOnboardUser(meetupClient, interaction)).rejects.toThrow(
      DuplicateMeetupAccountError,
    );

    expect(guildMember.roles.add).not.toHaveBeenCalled();
    expect(guildMember.roles.remove).not.toHaveBeenCalled();
  });
});
