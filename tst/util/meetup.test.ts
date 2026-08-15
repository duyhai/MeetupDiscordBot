/* eslint-disable @typescript-eslint/unbound-method */
import { ButtonInteraction } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  disposeReplyStack,
  replyStack,
} from '../../src/lib/messageStack/registry.js';
import { ApplicationCache } from '../../src/util/cache.js';
import { withMeetupClient } from '../../src/util/meetup.js';
import { spinWait } from '../../src/util/spinWait.js';

vi.mock('../../src/util/cache.js', () => ({
  ApplicationCache: vi.fn(),
}));
vi.mock('../../src/lib/client/oauth/state.js', () => ({
  createOAuthState: vi.fn().mockResolvedValue('masked-state'),
}));
vi.mock('../../src/util/spinWait.js', () => ({
  spinWait: vi.fn(),
}));

function makeInteraction(overrides: Record<string, unknown> = {}) {
  return {
    id: `interaction-${Math.random()}`,
    user: { id: 'user-1', username: 'testUser' },
    commandName: 'test_command',
    isChatInputCommand: () => true,
    editReply: vi.fn().mockResolvedValue({ id: 'm1' }),
    followUp: vi.fn().mockResolvedValue({ id: 'm2' }),
    deleteReply: vi.fn().mockResolvedValue(undefined),
    channel: { send: vi.fn().mockResolvedValue({ id: 'p1' }) },
    ...overrides,
  } as unknown as ButtonInteraction;
}

describe('withMeetupClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not leave the stale OAuth prompt behind when spinWait times out', async () => {
    // Reproduces MINOR 7: without the try/finally around spinWait, a timeout
    // here left the "Please connect your Meetup account" entry in the
    // ephemeral stack forever, so it would render above whatever error
    // message the caller (discordCommandWrapper) later shows.
    const cache = {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn(),
      remove: vi.fn(),
    };
    vi.mocked(ApplicationCache).mockResolvedValue(cache as never);
    vi.mocked(spinWait).mockRejectedValue(
      new Error('Timeout waiting for Meetup authentication. Please try again'),
    );

    const interaction = makeInteraction();

    await expect(withMeetupClient(interaction, async () => {})).rejects.toThrow(
      'Timeout waiting for Meetup authentication',
    );

    await replyStack(interaction).flushAll();
    disposeReplyStack(interaction);

    // The stack ended up empty: the stale prompt was removed, so flushing
    // deletes the (never-sent) reply rather than publishing "Please connect".
    expect(interaction.deleteReply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it('runs commandFn with a client built from cached tokens without prompting', async () => {
    const cache = {
      get: vi
        .fn()
        .mockResolvedValue(JSON.stringify({ accessToken: 'token-123' })),
      set: vi.fn(),
      remove: vi.fn(),
    };
    vi.mocked(ApplicationCache).mockResolvedValue(cache as never);

    const interaction = makeInteraction();
    const commandFn = vi.fn().mockResolvedValue(undefined);
    await withMeetupClient(interaction, commandFn);

    expect(commandFn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spinWait)).not.toHaveBeenCalled();
    disposeReplyStack(interaction);
  });
});
