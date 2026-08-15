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

  it('keeps the status banner instead of slicing it away when content embeds fill the limit', () => {
    // A stack already carrying 10 content embeds plus a status must not lose
    // the banner to Discord's 10-embed cap: content embeds are sliced to 9
    // first so the banner (pushed last) always survives the final slice.
    const payload = toDiscordPayload(
      {
        embeds: Array.from({ length: 10 }, () => ({}) as any),
        components: [],
        status: 'success',
      },
      '/test_command',
    );

    expect(payload.embeds).toHaveLength(10);
    const banner = payload.embeds.at(-1)?.toJSON();
    expect(banner.title).toBe('Finished');
    expect(banner.footer?.text).toBe('/test_command');
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

  it('propagates a null/non-object rejection instead of throwing inside errorCode', async () => {
    // errorCode reads `.code` off the rejection; a bare null/undefined
    // rejection (no `.code` property to read) must not itself throw a
    // TypeError -- it should fall through to the generic rethrow below.
    const interaction = makeInteraction({
      editReply: vi.fn().mockRejectedValue(null),
    });
    const { ephemeral } = createDiscordFlushers(interaction);

    await expect(
      ephemeral({ content: 'x', embeds: [], components: [] }),
    ).rejects.toBeNull();
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

  it('deletes the recreated followUp message via the webhook route (deleteReply(id)), when the stack empties', async () => {
    // Ephemeral messages can only be removed through the interaction
    // webhook's deleteMessage route; Message#delete() (the channel-message
    // route) is rejected by Discord for ephemeral messages. discord.js's
    // `deleteReply(id)` delegates to exactly that route. Deliberately omit
    // `delete` from the recreated handle so this test would fail (with a
    // TypeError) against the old `recreated.delete()` implementation.
    const deleteReply = vi.fn().mockResolvedValue(undefined);
    const interaction = makeInteraction({
      editReply: vi
        .fn()
        .mockResolvedValueOnce({ id: 'm1' })
        .mockRejectedValueOnce(new DiscordAPIErrorStub(10008)),
      followUp: vi.fn().mockResolvedValue({ id: 'm2' }),
      deleteReply,
    });
    const { ephemeral } = createDiscordFlushers(interaction);

    await ephemeral({ content: 'first', embeds: [], components: [] });
    await ephemeral({ content: 'first\nsecond', embeds: [], components: [] });
    await ephemeral(undefined);

    expect(deleteReply).toHaveBeenCalledTimes(1);
    expect(deleteReply).toHaveBeenCalledWith('m2');
  });
});

describe('public flusher', () => {
  it('publishes the first message with followUp (ephemeral: false), then edits it', async () => {
    // Public output must go through the webhook (interaction.followUp), not
    // channel.send: followUp works even where the bot lacks SEND_MESSAGES in
    // the channel and does not require interaction.channel to be resolved.
    // channel.send is deliberately left unset on this interaction so this
    // test would fail (TypeError on the null cast) against the old
    // `channel.send` implementation.
    const edit = vi.fn().mockResolvedValue(undefined);
    const interaction = makeInteraction({
      followUp: vi.fn().mockResolvedValue({ id: 'p1', edit }),
      channel: null,
    });
    const { public: publicFlusher } = createDiscordFlushers(interaction);

    await publicFlusher({ content: 'hello', embeds: [], components: [] });
    await publicFlusher({ content: 'hello again', embeds: [], components: [] });

    expect(vi.mocked(interaction.followUp)).toHaveBeenCalledTimes(1);
    const [args] = vi.mocked(interaction.followUp).mock.calls[0] as [
      { content: string; ephemeral: boolean },
    ];
    expect(args.content).toBe('hello');
    expect(args.ephemeral).toBe(false);
    expect(edit).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the stack empties and nothing was ever sent', async () => {
    const followUp = vi.fn().mockResolvedValue({ id: 'p1' });
    const interaction = makeInteraction({ followUp, channel: null });
    const { public: publicFlusher } = createDiscordFlushers(interaction);

    await publicFlusher(undefined);

    expect(followUp).not.toHaveBeenCalled();
  });
});
