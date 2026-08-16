/* eslint-disable
  @typescript-eslint/unbound-method
*/
import {
  ButtonInteraction,
  CommandInteraction,
  MessageFlags,
  MessageFlagsBitField,
} from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { discordCommandWrapper } from '../../../../src/util/discord.js';

vi.mock('../../../../src/lib/helpers/discordLogger.js', () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
  logAlert: vi.fn().mockResolvedValue(undefined),
}));

function makeButton(ephemeral: boolean) {
  const del = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    client: {},
    user: { id: 'u1', username: 'tester', toString: () => '<@u1>' },
    customId: 'sync_meetup_account',
    isButton: () => true,
    isChatInputCommand: () => false,
    // The retry button lives on an ephemeral reply we sent; the Get Verified
    // button lives on a public message in the channel.
    // A real BitField, so the mock cannot drift from discord.js's shape.
    message: {
      flags: new MessageFlagsBitField(ephemeral ? MessageFlags.Ephemeral : 0),
    },
    reply: vi.fn().mockResolvedValue({ delete: del }),
    update: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    fetchReply: vi.fn().mockResolvedValue({ delete: del }),
  } as unknown as ButtonInteraction;
  return { interaction, del };
}

describe('discordCommandWrapper reply target', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Pressing the retry button should refresh the message it sits on, not
  // stack another ephemeral underneath it.
  it('updates in place when the button is on an ephemeral message', async () => {
    const { interaction } = makeButton(true);

    await discordCommandWrapper(interaction, async () => {});

    expect(interaction.update).toHaveBeenCalledTimes(1);
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  // The Get Verified button is attached to a PUBLIC channel message. update()
  // would rewrite that message for the whole server, so this branch must
  // stay a fresh ephemeral reply.
  it('replies fresh when the button is on a public message', async () => {
    const { interaction } = makeButton(false);

    await discordCommandWrapper(interaction, async () => {});

    expect(interaction.reply).toHaveBeenCalledTimes(1);
    expect(interaction.update).not.toHaveBeenCalled();
  });

  it('replies fresh for a slash command, which has no message to update', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      client: {},
      user: { id: 'u1', username: 'tester', toString: () => '<@u1>' },
      commandName: 'meetup_self_onboard',
      isButton: () => false,
      isChatInputCommand: () => true,
      reply: vi.fn().mockResolvedValue({ delete: del }),
      editReply: vi.fn().mockResolvedValue(undefined),
    } as unknown as CommandInteraction;

    await discordCommandWrapper(interaction, async () => {});

    expect(interaction.reply).toHaveBeenCalledTimes(1);
  });
});
