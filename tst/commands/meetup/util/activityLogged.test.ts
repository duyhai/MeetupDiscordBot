import { CommandInteraction } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  discordCommandWrapper,
  markActivityLogged,
} from '../../../../src/util/discord.js';
import * as discordLogger from '../../../../src/lib/helpers/discordLogger.js';

vi.mock('../../../../src/lib/helpers/discordLogger.js', () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
  logAlert: vi.fn().mockResolvedValue(undefined),
}));

function makeInteraction() {
  return {
    client: {},
    user: { id: 'u1', username: 'tester', toString: () => '<@u1>' },
    commandName: 'test_command',
    isChatInputCommand: () => true,
    reply: vi.fn().mockResolvedValue({ delete: vi.fn() }),
    editReply: vi.fn().mockResolvedValue(undefined),
  } as unknown as CommandInteraction;
}

describe('discordCommandWrapper activity log', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs a generic "used" entry for an ordinary success', async () => {
    await discordCommandWrapper(makeInteraction(), async () => {});

    expect(vi.mocked(discordLogger.logActivity)).toHaveBeenCalledTimes(1);
  });

  // A command that already posted its own, more specific entry (e.g. which
  // suspension was voided and why) shouldn't get a second, generic one.
  it('skips the generic entry when the command logged its own', async () => {
    const interaction = makeInteraction();
    let reachedEnd = false;

    await discordCommandWrapper(interaction, async () => {
      markActivityLogged(interaction);
      reachedEnd = true;
    });

    expect(reachedEnd).toBe(true);
    expect(vi.mocked(discordLogger.logAlert)).not.toHaveBeenCalled();
    expect(vi.mocked(discordLogger.logActivity)).not.toHaveBeenCalled();
  });

  it('does not leak the flag into the next command run', async () => {
    const first = makeInteraction();
    await discordCommandWrapper(first, async () => {
      markActivityLogged(first);
    });
    await discordCommandWrapper(makeInteraction(), async () => {});

    expect(vi.mocked(discordLogger.logActivity)).toHaveBeenCalledTimes(1);
  });
});
