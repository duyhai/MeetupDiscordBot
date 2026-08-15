/* eslint-disable @typescript-eslint/unbound-method */
import { CommandInteraction } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { replyStack } from '../../../src/lib/messageStack/registry.js';

vi.mock('../../../src/lib/helpers/discordLogger.js', () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
  logAlert: vi.fn().mockResolvedValue(undefined),
}));

function makeInteraction(id: string) {
  return {
    id,
    client: {},
    user: { id: 'u1', username: 'tester', toString: () => '<@u1>' },
    commandName: 'meetup_self_onboard',
    isChatInputCommand: () => true,
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue({ id: 'm1' }),
    followUp: vi.fn().mockResolvedValue({ id: 'm2' }),
    deleteReply: vi.fn().mockResolvedValue(undefined),
    channel: { send: vi.fn().mockResolvedValue({ id: 'p1' }) },
  } as unknown as CommandInteraction;
}

describe('onboarding output', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('collapses a multi-step flow into one ephemeral message', async () => {
    const interaction = makeInteraction('i-collapse');
    const stack = replyStack(interaction);

    stack.ephemeral.append({
      content: 'Linked your Meetup account.',
      status: 'pending',
    });
    stack.ephemeral.append({ content: 'Added your roles.', status: 'pending' });
    stack.ephemeral.append({ content: 'Done!', status: 'success' });
    await stack.flushAll();

    expect(vi.mocked(interaction.editReply)).toHaveBeenCalledTimes(1);
    const [payload] = vi.mocked(interaction.editReply).mock.calls[0] as [
      { content: string },
    ];
    expect(payload.content).toBe(
      'Linked your Meetup account.\nAdded your roles.\nDone!',
    );
  });

  it('keeps the public welcome message pingable in message content', async () => {
    const interaction = makeInteraction('i-welcome');
    const stack = replyStack(interaction);

    stack.publicSurface.append({ content: 'Welcome <@u1>!' });
    await stack.flushAll();

    const [payload] = vi.mocked(interaction.channel.send).mock.calls[0] as [
      { content: string; embeds: unknown[] },
    ];
    expect(payload.content).toBe('Welcome <@u1>!');
    expect(payload.embeds).toEqual([]);
  });
});
