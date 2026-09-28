import {
  ButtonInteraction,
  CommandInteraction,
  Guild,
  GuildMember,
} from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { onboardUserCommon } from '../../../src/lib/helpers/onboardUser.js';
import { updateBaselineSilently } from '../../../src/lib/helpers/identityMonitor.js';
import {
  releaseIdentityWriteSuppression,
  suppressIdentityWrites,
} from '../../../src/lib/helpers/identitySuppression.js';

vi.mock('../../../src/lib/helpers/identityMonitor.js', () => ({
  updateBaselineSilently: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/lib/helpers/identitySuppression.js', () => ({
  suppressIdentityWrites: vi.fn(),
  releaseIdentityWriteSuppression: vi.fn(),
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

/**
 * Call-site guard for the onboarding/gateway race. The suppression helper is
 * unit-tested in isolation, but the whole point is WHEN onboarding calls it:
 * Discord dispatches GUILD_MEMBER_UPDATE concurrently with setNickname's HTTP
 * response, so a flag set after the write is already too late.
 */
describe('onboardUserCommon identity-write suppression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('suppresses before setNickname and releases after the baseline write', async () => {
    const guildMember = fakeGuildMember();
    const guild = fakeGuild(guildMember);

    await onboardUserCommon(fakeInteraction(guild), USER_ID, 'MALE');

    expect(suppressIdentityWrites).toHaveBeenCalledWith(USER_ID);
    expect(releaseIdentityWriteSuppression).toHaveBeenCalledWith(USER_ID);

    const order = (fn: unknown) =>
      vi.mocked(fn as () => void).mock.invocationCallOrder[0];
    // Ordering is the entire fix; asserting only that both ran would pass on
    // the racy arrangement this replaced.
    expect(order(suppressIdentityWrites)).toBeLessThan(
      // eslint-disable-next-line @typescript-eslint/unbound-method
      order(guildMember.setNickname),
    );
    expect(order(updateBaselineSilently)).toBeLessThan(
      order(releaseIdentityWriteSuppression),
    );
  });

  it('releases the suppression even when setNickname fails', async () => {
    const guildMember = fakeGuildMember();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const { setNickname } = guildMember;
    vi.mocked(setNickname).mockRejectedValueOnce(
      new Error('missing permissions'),
    );
    const guild = fakeGuild(guildMember);

    // A left-behind entry would blind the digest to this member's real
    // changes until the hard TTL expires.
    await expect(
      onboardUserCommon(fakeInteraction(guild), USER_ID, 'MALE'),
    ).rejects.toThrow('missing permissions');
    expect(releaseIdentityWriteSuppression).toHaveBeenCalledWith(USER_ID);
  });
});
