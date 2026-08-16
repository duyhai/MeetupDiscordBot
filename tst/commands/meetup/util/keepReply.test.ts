/* eslint-disable
  @typescript-eslint/unbound-method
*/
import { CommandInteraction } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  discordCommandWrapper,
  keepReplyVisible,
} from '../../../../src/util/discord.js';
import * as discordLogger from '../../../../src/lib/helpers/discordLogger.js';

vi.mock('../../../../src/lib/helpers/discordLogger.js', () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
  logAlert: vi.fn().mockResolvedValue(undefined),
}));

function makeInteraction() {
  const del = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    client: {},
    user: { id: 'u1', username: 'tester', toString: () => '<@u1>' },
    commandName: 'test_command',
    isChatInputCommand: () => true,
    isButton: () => false,
    reply: vi.fn().mockResolvedValue({ delete: del }),
    editReply: vi.fn().mockResolvedValue(undefined),
  } as unknown as CommandInteraction;
  return { interaction, del };
}

describe('discordCommandWrapper reply cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes the progress reply for an ordinary success', async () => {
    const { interaction, del } = makeInteraction();

    await discordCommandWrapper(interaction, async () => {});

    expect(del).toHaveBeenCalledTimes(1);
  });

  // A command that finishes by showing the member something -- "you still
  // need to authorize Discord, press the button again" -- must not have that
  // message deleted by the wrapper's cleanup. Before this, the retry guidance
  // was written with editReply and then erased a moment later, so the member
  // saw the reply vanish instead of telling them what to do.
  it('keeps the reply when the command marks it as the final word', async () => {
    const { interaction, del } = makeInteraction();
    let reachedEnd = false;

    await discordCommandWrapper(interaction, async () => {
      await interaction.editReply({ content: 'press the button again' });
      keepReplyVisible(interaction);
      reachedEnd = true;
    });

    // Guards against a vacuous pass: if keepReplyVisible blew up, the wrapper
    // would swallow it and `del` would be skipped for the wrong reason.
    expect(reachedEnd).toBe(true);
    expect(vi.mocked(discordLogger.logAlert)).not.toHaveBeenCalled();
    expect(vi.mocked(discordLogger.logActivity)).toHaveBeenCalledTimes(1);
    expect(del).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'press the button again',
    });
  });

  it('does not leak the keep flag into the next command run', async () => {
    const first = makeInteraction();
    let firstOk = false;
    await discordCommandWrapper(first.interaction, async () => {
      keepReplyVisible(first.interaction);
      firstOk = true;
    });
    expect(firstOk).toBe(true);
    expect(first.del).not.toHaveBeenCalled();

    const second = makeInteraction();
    await discordCommandWrapper(second.interaction, async () => {});
    expect(second.del).toHaveBeenCalledTimes(1);
  });
});
