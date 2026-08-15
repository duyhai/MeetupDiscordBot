/* eslint-disable @typescript-eslint/unbound-method */
import { ButtonInteraction } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MeetupSyncAccountCommandsV2 } from '../../../src/buttonMenu/meetup/syncAccountV2.js';
import { disposeReplyStack } from '../../../src/lib/messageStack/registry.js';
import { ApplicationCache } from '../../../src/util/cache.js';
import { spinWait } from '../../../src/util/spinWait.js';

vi.mock('../../../src/util/cache.js', () => ({
  ApplicationCache: vi.fn(),
}));
vi.mock('../../../src/lib/client/oauth/state.js', () => ({
  createOAuthState: vi.fn().mockResolvedValue('masked-state'),
}));
vi.mock('../../../src/constants.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/constants.js')>();
  return {
    ...actual,
    generateOAuthUrl: vi.fn().mockReturnValue('https://example.test/oauth'),
  };
});
vi.mock('../../../src/util/spinWait.js', () => ({
  spinWait: vi.fn(),
}));

function makeInteraction(overrides: Record<string, unknown> = {}) {
  return {
    id: `interaction-${Math.random()}`,
    user: { id: 'user-1', username: 'testUser', toString: () => '<@user-1>' },
    guild: {},
    client: {},
    commandName: 'sync_meetup_account_v2',
    isChatInputCommand: () => false,
    isButton: () => true,
    customId: 'sync_meetup_account_v2',
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue({ id: 'm1' }),
    followUp: vi.fn().mockResolvedValue({ id: 'm2' }),
    deleteReply: vi.fn().mockResolvedValue(undefined),
    channel: { send: vi.fn().mockResolvedValue({ id: 'p1' }) },
    ...overrides,
  } as unknown as ButtonInteraction;
}

describe('MeetupSyncAccountCommandsV2 button handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not leave the stale connect-accounts prompt behind when an OAuth hop times out', async () => {
    // Reproduces MINOR 7's syncAccountV2 half: without wrapping both
    // spinWait calls in try/catch (removing progressId on throw), a timeout
    // left "Please connect your Discord and Meetup accounts" in the stack,
    // so discordCommandWrapper's catch would render the timeout error above
    // a still-live, now-useless OAuth button.
    const cache = {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn(),
      remove: vi.fn(),
    };
    vi.mocked(ApplicationCache).mockResolvedValue(cache as never);
    vi.mocked(spinWait).mockRejectedValue(
      new Error('Timeout waiting for Discord authentication. Please try again'),
    );

    const interaction = makeInteraction();
    const handler = new MeetupSyncAccountCommandsV2();
    await handler.meetupRequestApproveEventHandler(interaction);

    // discordCommandWrapper caught the throw and rendered the final error;
    // it must not also carry the stale "connect your accounts" content.
    expect(interaction.editReply).toHaveBeenCalled();
    const finalPayload = vi
      .mocked(interaction.editReply)
      .mock.calls.at(-1)?.[0] as { content: string };
    expect(finalPayload.content).toContain(
      'Timeout waiting for Discord authentication',
    );
    expect(finalPayload.content).not.toContain(
      'connect your Discord and Meetup',
    );

    disposeReplyStack(interaction);
  });
});
