/* eslint-disable @typescript-eslint/unbound-method */
import { CommandInteraction } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MeetupGetTokenCommands } from '../../../src/commands/meetup/getToken.js';
import { SERVER_ROLES } from '../../../src/constants.js';

const TOKENS = {
  accessToken: 'the-access-token',
  refreshToken: 'the-refresh-token',
  expiresAt: Date.now() + 3600 * 1000,
};

const cache = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('../../../src/util/cache.js', () => ({
  ApplicationCache: vi.fn(async () => cache),
}));

// Run straight through: this test is about the organizer gate inside the
// handler, not about the OAuth hand-off or the command wrapper's own
// behavior.
vi.mock('../../../src/util/meetup.js', () => ({
  withMeetupClient: vi.fn(async (_interaction, fn: (c: unknown) => unknown) => {
    await fn({});
  }),
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

function fakeInteraction(roleIds: string[]) {
  const member = {
    roles: { cache: { has: (id: string) => roleIds.includes(id) } },
  };
  return {
    guild: { members: { fetch: vi.fn().mockResolvedValue(member) } },
    user: { id: 'discord-1', username: 'tester' },
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
  } as unknown as CommandInteraction;
}

async function runCommand(roleIds: string[]) {
  cache.get.mockResolvedValue(JSON.stringify(TOKENS));
  const interaction = fakeInteraction(roleIds);
  await new MeetupGetTokenCommands().meetupGetTokenHandler(interaction);

  const [payload] = vi.mocked(interaction.followUp).mock.calls[0] as [
    { content: string },
  ];
  return payload.content;
}

describe('meetup_get_token refresh token gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes the refresh token for an organizer', async () => {
    const content = await runCommand([SERVER_ROLES.organizer]);

    expect(content).toContain('Refresh token');
    expect(content).toContain(TOKENS.refreshToken);
  });

  it('includes the refresh token for a moderator', async () => {
    const content = await runCommand([SERVER_ROLES.moderator]);

    expect(content).toContain(TOKENS.refreshToken);
  });

  // Guards the organizer gate itself: without it, every member who runs
  // this command -- not just organizers -- would receive the long-lived
  // credential behind the whole Meetup-side sweep.
  it('omits the refresh token for a non-organizer', async () => {
    const content = await runCommand([]);

    expect(content).not.toContain('Refresh token');
    expect(content).not.toContain(TOKENS.refreshToken);
    // The access token itself must still be delivered.
    expect(content).toContain(TOKENS.accessToken);
  });
});
