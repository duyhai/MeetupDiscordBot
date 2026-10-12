/* eslint-disable @typescript-eslint/unbound-method */
import { CommandInteraction } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MeetupGetTokenCommands } from '../../../src/commands/meetup/getToken.js';
import { SERVER_ROLES } from '../../../src/constants.js';

const TOKENS = vi.hoisted(() => ({
  accessToken: 'the-access-token',
  refreshToken: 'the-refresh-token',
  expiresAt: Date.now() + 3600 * 1000,
}));

const cache = vi.hoisted(() => ({
  get: vi.fn(),
  remove: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/util/cache.js', () => ({
  ApplicationCache: vi.fn(async () => cache),
}));

// Run straight through: this test is about the organizer gate inside the
// handler, not about the OAuth hand-off or the command wrapper's own
// behavior.
vi.mock('../../../src/util/meetup.js', () => ({
  withMeetupClient: vi.fn(
    async (_interaction, fn: (c: unknown, tokens: unknown) => unknown) => {
      // The set withMeetupClient resolved, which is what the command shows.
      await fn({}, TOKENS);
    },
  ),
}));
vi.mock('../../../src/util/discord.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/util/discord.js')>();
  return {
    ...actual,
    discordCommandWrapper: vi.fn(async (_interaction, fn: () => unknown) => {
      await fn();
    }),
  };
});

function fakeInteraction(
  roleIds: string[],
  {
    admin = false,
    inGuild = true,
  }: { admin?: boolean; inGuild?: boolean } = {},
) {
  const member = {
    roles: { cache: { has: (id: string) => roleIds.includes(id) } },
    permissions: { has: () => admin },
  };
  return {
    // Null in a DM -- discord.js types this as nullable and it genuinely is.
    guild: inGuild
      ? { members: { fetch: vi.fn().mockResolvedValue(member) } }
      : null,
    user: { id: 'discord-1', username: 'tester' },
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
  } as unknown as CommandInteraction;
}

interface RunOptions {
  admin?: boolean;
  inGuild?: boolean;
  sweepCredential?: boolean;
}

async function runCommand(roleIds: string[], options: RunOptions = {}) {
  // What sits in the cache is deliberately NOT what was resolved: after a
  // failed write the stored pair is stale, and showing it would hand out a
  // dead access token.
  cache.get.mockResolvedValue(
    JSON.stringify({ ...TOKENS, accessToken: 'stale-stored-access' }),
  );
  const interaction = fakeInteraction(roleIds, options);
  await new MeetupGetTokenCommands().meetupGetTokenHandler(
    options.sweepCredential,
    interaction,
  );

  const [payload] = vi.mocked(interaction.followUp).mock.calls[0] as [
    { content: string },
  ];
  return payload.content;
}

const forSweep = { sweepCredential: true };

describe('meetup_get_token', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the access token that was resolved, not a re-read of the cache', async () => {
    const content = await runCommand([]);

    expect(content).toContain(TOKENS.accessToken);
    expect(content).not.toContain('stale-stored-access');
  });

  // The routine call: a mod pulling an access token for a notebook must not
  // be shown a standing credential, or lose their connection, every time.
  it.each([
    ['an organizer', [SERVER_ROLES.organizer], {}],
    ['a moderator', [SERVER_ROLES.moderator], {}],
    ['an admin', [], { admin: true }],
  ])(
    'shows %s only the access token and keeps their connection by default',
    async (_who, roleIds, options) => {
      const content = await runCommand(roleIds, options);

      expect(content).toContain(TOKENS.accessToken);
      expect(content).not.toContain('Refresh token');
      expect(content).not.toContain(TOKENS.refreshToken);
      expect(cache.remove).not.toHaveBeenCalled();
    },
  );
});

describe('meetup_get_token sweep_credential', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes the refresh token for an organizer', async () => {
    const content = await runCommand([SERVER_ROLES.organizer], forSweep);

    expect(content).toContain('Refresh token');
    expect(content).toContain(TOKENS.refreshToken);
  });

  it('includes the refresh token for a moderator', async () => {
    const content = await runCommand([SERVER_ROLES.moderator], forSweep);

    expect(content).toContain(TOKENS.refreshToken);
  });

  it('includes the refresh token for an admin without the organizer role', async () => {
    const content = await runCommand([], { admin: true, ...forSweep });

    // The server owner holds Administrator without necessarily holding the
    // organizer role, and is the person most likely to be setting
    // MEETUP_ORGANIZER_REFRESH_TOKEN in Heroku. requireModOrOrganizer already
    // treats admin as sufficient; this gate was the odd one out.
    expect(content).toContain(TOKENS.refreshToken);
  });

  // Guards the organizer gate itself: without it, every member who passes
  // the option -- not just organizers -- would receive the long-lived
  // credential behind the whole Meetup-side sweep.
  it('omits the refresh token for a non-organizer, and keeps their connection', async () => {
    const content = await runCommand([], forSweep);

    expect(content).not.toContain('Refresh token');
    expect(content).not.toContain(TOKENS.refreshToken);
    // The access token itself must still be delivered.
    expect(content).toContain(TOKENS.accessToken);
    expect(cache.remove).not.toHaveBeenCalled();
  });

  it('hands the connection over once the refresh token has been shown', async () => {
    const content = await runCommand([SERVER_ROLES.organizer], forSweep);

    // The refresh token is about to become the sweep's credential. If this
    // member's own commands kept refreshing the same grant, a rotation on
    // either side would invalidate the other.
    expect(cache.remove).toHaveBeenCalledWith('discord-1-meetup-tokens');
    expect(content).toMatch(/connect again/i);
  });

  it('keeps the connection when the reply could not be delivered', async () => {
    const interaction = fakeInteraction([SERVER_ROLES.organizer]);
    vi.mocked(interaction.followUp).mockRejectedValue(
      new Error('Unknown interaction'),
    );

    await expect(
      new MeetupGetTokenCommands().meetupGetTokenHandler(true, interaction),
    ).rejects.toThrow('Unknown interaction');

    // Nobody saw the refresh token, so nothing was handed over.
    expect(cache.remove).not.toHaveBeenCalled();
  });

  it('still delivers the access token when invoked from a DM', async () => {
    const content = await runCommand([SERVER_ROLES.organizer], {
      inGuild: false,
      ...forSweep,
    });

    // interaction.guild is null in a DM -- a natural place to run a command
    // that hands back a secret. Dereferencing it threw a TypeError that
    // surfaced as a generic "command failed".
    expect(content).toContain(TOKENS.accessToken);
  });

  it('withholds the refresh token in a DM, and keeps the connection', async () => {
    const content = await runCommand([SERVER_ROLES.organizer], {
      inGuild: false,
      ...forSweep,
    });

    // No guild means no role information. An unverifiable caller is not an
    // organizer, so the long-lived credential stays behind the gate.
    expect(content).not.toContain(TOKENS.refreshToken);
    expect(cache.remove).not.toHaveBeenCalled();
  });
});
