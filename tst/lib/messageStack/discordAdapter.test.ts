/* eslint-disable
  @typescript-eslint/no-explicit-any,
  @typescript-eslint/no-unsafe-assignment,
  @typescript-eslint/no-unsafe-return,
  @typescript-eslint/unbound-method
*/
import { CommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import { EMBED_COLORS } from '../../../src/constants.js';
import {
  createDiscordFlushers,
  toDiscordPayload,
} from '../../../src/lib/messageStack/discordAdapter.js';

class DiscordAPIErrorStub extends Error {
  constructor(public code: number) {
    super(`stub discord error ${code}`);
  }
}

function makeInteraction(overrides: Record<string, unknown> = {}) {
  return {
    commandName: 'test_command',
    isChatInputCommand: () => true,
    editReply: vi.fn().mockResolvedValue({ id: 'm1' }),
    followUp: vi.fn().mockResolvedValue({ id: 'm2' }),
    deleteReply: vi.fn().mockResolvedValue(undefined),
    channel: { send: vi.fn().mockResolvedValue({ id: 'p1' }) },
    ...overrides,
  } as unknown as CommandInteraction;
}

describe('toDiscordPayload', () => {
  it('appends a status banner carrying colour, label and action', () => {
    const payload = toDiscordPayload(
      { content: 'hi', embeds: [], components: [], status: 'pending' },
      '/test_command',
    );

    expect(payload.content).toBe('hi');
    expect(payload.embeds).toHaveLength(1);
    const banner = payload.embeds[0].toJSON();
    expect(banner.color).toBe(EMBED_COLORS.pending);
    expect(banner.title).toBe('In progress');
    expect(banner.footer?.text).toBe('/test_command');
  });

  it('adds no banner when no entry declared a status', () => {
    const payload = toDiscordPayload(
      { content: 'plain', embeds: [], components: [] },
      '/test_command',
    );

    expect(payload.embeds).toHaveLength(0);
  });

  it('clamps content, embeds and component rows to Discord limits', () => {
    const payload = toDiscordPayload(
      {
        content: 'x'.repeat(2500),
        embeds: Array.from({ length: 12 }, () => ({}) as any),
        components: Array.from({ length: 7 }, () => ({}) as any),
        status: 'success',
      },
      '/test_command',
    );

    expect(payload.content?.length).toBe(2000);
    expect(payload.content?.endsWith('…')).toBe(true);
    expect(payload.embeds).toHaveLength(10);
    expect(payload.components).toHaveLength(5);
  });

  it('sends an empty string rather than undefined so content can be cleared', () => {
    const payload = toDiscordPayload(
      { embeds: [], components: [], status: 'success' },
      '/test_command',
    );

    expect(payload.content).toBe('');
  });
});

describe('ephemeral flusher', () => {
  it('edits the deferred reply on first publish', async () => {
    const interaction = makeInteraction();
    const { ephemeral } = createDiscordFlushers(interaction);

    await ephemeral({ content: 'first', embeds: [], components: [] });

    expect(vi.mocked(interaction.editReply)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(interaction.followUp)).not.toHaveBeenCalled();
  });

  it('recreates the message with the whole stack after a dismissal', async () => {
    const interaction = makeInteraction({
      editReply: vi
        .fn()
        .mockResolvedValueOnce({ id: 'm1' })
        .mockRejectedValueOnce(new DiscordAPIErrorStub(10008)),
    });
    const { ephemeral } = createDiscordFlushers(interaction);

    await ephemeral({ content: 'first', embeds: [], components: [] });
    await ephemeral({ content: 'first\nsecond', embeds: [], components: [] });

    expect(vi.mocked(interaction.followUp)).toHaveBeenCalledTimes(1);
    const [args] = vi.mocked(interaction.followUp).mock.calls[0] as [
      { content: string; ephemeral: boolean },
    ];
    expect(args.content).toBe('first\nsecond');
    expect(args.ephemeral).toBe(true);
  });

  it('gives up quietly when the interaction token is dead', async () => {
    const interaction = makeInteraction({
      editReply: vi.fn().mockRejectedValue(new DiscordAPIErrorStub(50027)),
    });
    const { ephemeral } = createDiscordFlushers(interaction);

    await expect(
      ephemeral({ content: 'doomed', embeds: [], components: [] }),
    ).resolves.toBeUndefined();
    expect(vi.mocked(interaction.followUp)).not.toHaveBeenCalled();
  });

  // RULING 2: a later task defers the reply before any output exists, so an
  // undefined stack must always try to clear it -- otherwise an unresolved
  // deferred reply would sit showing "thinking..." forever. This differs
  // from the public flusher, which only deletes when it actually sent
  // something.
  it('always attempts to clear the deferred reply, even if never published', async () => {
    const interaction = makeInteraction();
    const { ephemeral } = createDiscordFlushers(interaction);

    await ephemeral(undefined);
    expect(vi.mocked(interaction.deleteReply)).toHaveBeenCalledTimes(1);

    await ephemeral({ content: 'here', embeds: [], components: [] });
    await ephemeral(undefined);
    expect(vi.mocked(interaction.deleteReply)).toHaveBeenCalledTimes(2);
  });

  it('deletes the recreated followUp message after a dismissal, when the stack empties', async () => {
    const deleteRecreated = vi.fn().mockResolvedValue(undefined);
    const interaction = makeInteraction({
      editReply: vi
        .fn()
        .mockResolvedValueOnce({ id: 'm1' })
        .mockRejectedValueOnce(new DiscordAPIErrorStub(10008)),
      followUp: vi
        .fn()
        .mockResolvedValue({ id: 'm2', delete: deleteRecreated }),
    });
    const { ephemeral } = createDiscordFlushers(interaction);

    await ephemeral({ content: 'first', embeds: [], components: [] });
    await ephemeral({ content: 'first\nsecond', embeds: [], components: [] });
    await ephemeral(undefined);

    expect(deleteRecreated).toHaveBeenCalledTimes(1);
    expect(vi.mocked(interaction.deleteReply)).not.toHaveBeenCalled();
  });
});

describe('public flusher', () => {
  it('sends to the channel then edits that message', async () => {
    const edit = vi.fn().mockResolvedValue(undefined);
    const interaction = makeInteraction({
      channel: { send: vi.fn().mockResolvedValue({ id: 'p1', edit }) },
    });
    const { public: publicFlusher } = createDiscordFlushers(interaction);

    await publicFlusher({ content: 'hello', embeds: [], components: [] });
    await publicFlusher({ content: 'hello again', embeds: [], components: [] });

    expect(vi.mocked(interaction.channel.send)).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the stack empties and nothing was ever sent', async () => {
    const send = vi.fn().mockResolvedValue({ id: 'p1' });
    const interaction = makeInteraction({ channel: { send } });
    const { public: publicFlusher } = createDiscordFlushers(interaction);

    await publicFlusher(undefined);

    expect(send).not.toHaveBeenCalled();
  });
});
