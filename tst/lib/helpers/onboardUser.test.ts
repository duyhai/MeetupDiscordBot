import {
  ButtonInteraction,
  CommandInteraction,
  Guild,
  GuildMember,
} from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { onboardUserCommon } from '../../../src/lib/helpers/onboardUser.js';
import { updateBaselineSilently } from '../../../src/lib/helpers/identityMonitor.js';

vi.mock('../../../src/lib/helpers/identityMonitor.js', () => ({
  updateBaselineSilently: vi.fn().mockResolvedValue(undefined),
}));

const USER_ID = 'discord-user-1';

function fakeGuildMember() {
  return {
    id: USER_ID,
    nickname: null,
    permissions: { has: vi.fn().mockReturnValue(false) },
    setNickname: vi.fn().mockResolvedValue(undefined),
    roles: {
      add: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as GuildMember;
}

function fakeGuild(guildMember: GuildMember) {
  return {
    members: {
      fetch: vi.fn().mockResolvedValue(guildMember),
    },
    roles: {
      fetch: vi.fn().mockResolvedValue({ id: 'role-1' }),
    },
  } as unknown as Guild;
}

function fakeInteraction(guild: Guild) {
  return {
    guild,
    client: {
      users: {
        fetch: vi.fn().mockResolvedValue({
          id: USER_ID,
          tag: 'TestUser#0001',
          username: 'testuser',
        }),
      },
    },
  } as unknown as CommandInteraction | ButtonInteraction;
}

describe('onboardUserCommon', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('completes onboarding even when the identity baseline write fails', async () => {
    vi.mocked(updateBaselineSilently).mockRejectedValueOnce(
      new Error('identity repo down'),
    );

    const guildMember = fakeGuildMember();
    const guild = fakeGuild(guildMember);
    const interaction = fakeInteraction(guild);

    // A monitoring-only failure must not propagate out of onboarding: the
    // member still needs their gender role and the onboarding role removed.
    await expect(
      onboardUserCommon(interaction, USER_ID, 'MALE'),
    ).resolves.not.toThrow();

    // Role assignment (after the baseline write) still ran.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(guildMember.roles.add).toHaveBeenCalledWith({ id: 'role-1' });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(guildMember.roles.remove).toHaveBeenCalledWith({ id: 'role-1' });
  });
});
