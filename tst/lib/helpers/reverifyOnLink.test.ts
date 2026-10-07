import { ButtonInteraction, Guild } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GqlMeetupClient } from '../../../src/lib/client/meetup/gqlClient.js';
import {
  DuplicateMeetupAccountError,
  recordMeetupLink,
} from '../../../src/lib/helpers/memberLink.js';
import { selfOnboardUser } from '../../../src/lib/helpers/onboardUser.js';
import { removeReverifyRole } from '../../../src/lib/helpers/reverify.js';

vi.mock('../../../src/lib/helpers/memberLink.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../src/lib/helpers/memberLink.js')
  >()),
  recordMeetupLink: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../../src/lib/helpers/reverify.js', () => ({
  removeReverifyRole: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/lib/helpers/identityMonitor.js', () => ({
  updateBaselineSilently: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/lib/helpers/identitySuppression.js', () => ({
  suppressIdentityWrites: vi.fn(),
  releaseIdentityWriteSuppression: vi.fn(),
}));

const USER_ID = 'discord-7';

function fakeInteraction() {
  const guildMember = {
    id: USER_ID,
    nickname: null,
    permissions: { has: vi.fn().mockReturnValue(false) },
    setNickname: vi.fn().mockResolvedValue(undefined),
    roles: {
      add: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
  };
  const guild = {
    members: { fetch: vi.fn().mockResolvedValue(guildMember) },
    roles: { fetch: vi.fn().mockResolvedValue({ id: 'role-1' }) },
  } as unknown as Guild;
  return {
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

describe('linking during the Reverify migration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('removes the Reverify role once the link is recorded', async () => {
    const interaction = fakeInteraction();

    await selfOnboardUser(meetupClient, interaction);

    expect(removeReverifyRole).toHaveBeenCalledWith(interaction.guild, USER_ID);
  });

  it('keeps the role when the link could not be saved', async () => {
    vi.mocked(recordMeetupLink).mockResolvedValueOnce(false);

    await selfOnboardUser(meetupClient, fakeInteraction());

    expect(removeReverifyRole).not.toHaveBeenCalled();
  });

  it('keeps the role when the link is refused as a duplicate', async () => {
    vi.mocked(recordMeetupLink).mockRejectedValueOnce(
      new DuplicateMeetupAccountError('already linked'),
    );

    await expect(
      selfOnboardUser(meetupClient, fakeInteraction()),
    ).rejects.toThrow(DuplicateMeetupAccountError);

    expect(removeReverifyRole).not.toHaveBeenCalled();
  });
});
