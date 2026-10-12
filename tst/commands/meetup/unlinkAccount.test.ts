/* eslint-disable @typescript-eslint/unbound-method */
import { CommandInteraction, User } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UnlinkAccountCommands } from '../../../src/commands/meetup/unlinkAccount.js';
import { InMemoryMemberRepository } from '../../../src/lib/repositories/inMemoryMemberRepository.js';
import * as memberRepository from '../../../src/util/memberRepository.js';

const TOKEN_KEY = 'discord-1-meetup-tokens';

const fake = vi.hoisted(() => {
  const data = new Map<string, string>();
  return {
    data,
    cache: {
      get: (key: string) => Promise.resolve(data.get(key)),
      remove: (key: string) => {
        data.delete(key);
        return Promise.resolve();
      },
    },
  };
});

vi.mock('../../../src/util/cache.js', () => ({
  ApplicationCache: () => Promise.resolve(fake.cache),
}));
vi.mock('../../../src/util/memberRepository.js', () => ({
  ApplicationMemberRepository: vi.fn(),
}));
vi.mock('../../../src/lib/helpers/discordLogger.js', () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
  logAlert: vi.fn().mockResolvedValue(undefined),
}));
// Run straight through: this test is about what unlinking removes, not about
// the command wrapper or the moderator gate.
vi.mock('../../../src/util/discord.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/util/discord.js')>();
  return {
    ...actual,
    discordCommandWrapper: vi.fn(async (_interaction, fn: () => unknown) => {
      await fn();
    }),
    requireModOrOrganizer: vi.fn().mockResolvedValue(undefined),
  };
});

const target = {
  id: 'discord-1',
  username: 'wrongAccount',
  toString: () => '<@discord-1>',
} as unknown as User;

function modInteraction() {
  return {
    client: {},
    user: { id: 'mod-1', username: 'mod', toString: () => '<@mod-1>' },
    followUp: vi.fn().mockResolvedValue(undefined),
  } as unknown as CommandInteraction;
}

const lastFollowUp = (interaction: CommandInteraction) => {
  const calls = vi.mocked(interaction.followUp).mock.calls;
  return (calls[calls.length - 1][0] as { content: string }).content;
};

describe('meetup_unlink', () => {
  let repo: InMemoryMemberRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    fake.data.clear();
    repo = new InMemoryMemberRepository();
    vi.mocked(memberRepository.ApplicationMemberRepository).mockResolvedValue(
      repo,
    );
    // A saved connection to the account the member should not have used.
    fake.data.set(TOKEN_KEY, JSON.stringify({ accessToken: 'wrong-account' }));
  });

  it('clears the saved Meetup connection along with the member record', async () => {
    await repo.upsert({
      discordUserId: 'discord-1',
      meetupId: 'meetup-wrong',
      meetupName: 'Wrong Account',
      meetupMemberUrl: 'https://www.meetup.com/members/1/',
      onboardMethod: 'self_onboard',
      onboardedBy: null,
    });
    const interaction = modInteraction();

    await new UnlinkAccountCommands().meetupUnlinkHandler(target, interaction);

    expect(await repo.findByDiscordId('discord-1')).toBeUndefined();
    // Left in place, the next Link Meetup Account press would silently reuse
    // it and link the same wrong account again.
    expect(fake.data.has(TOKEN_KEY)).toBe(false);
    expect(lastFollowUp(interaction)).toMatch(/connect/i);
  });

  it('clears the saved Meetup connection even when there is no member record', async () => {
    // A blocked duplicate link never gets a row, but the connection is saved.
    const interaction = modInteraction();

    await new UnlinkAccountCommands().meetupUnlinkHandler(target, interaction);

    expect(fake.data.has(TOKEN_KEY)).toBe(false);
    expect(lastFollowUp(interaction)).toMatch(/connect/i);
  });
});
