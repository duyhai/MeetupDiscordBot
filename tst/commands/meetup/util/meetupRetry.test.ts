import { ButtonInteraction, CommandInteraction } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { withMeetupClient } from '../../../../src/util/meetup.js';

vi.mock('../../../../src/lib/helpers/discordLogger.js', () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
  logAlert: vi.fn().mockResolvedValue(undefined),
}));

const keepReplyVisible = vi.fn();
vi.mock('../../../../src/util/discord.js', async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal();
  return {
    ...actual,
    keepReplyVisible: (i: unknown): void => {
      keepReplyVisible(i);
    },
  };
});

// A wait short enough to expire during the test.
vi.mock('../../../../src/lib/helpers/oauthWait.js', () => ({
  waitForMeetupTokens: vi.fn().mockResolvedValue({ status: 'pending' }),
}));

function base() {
  return {
    client: {},
    user: { id: 'u1', username: 'tester', toString: () => '<@u1>' },
    editReply: vi.fn().mockResolvedValue(undefined),
  };
}

const buttonInteraction = () =>
  ({
    ...base(),
    customId: 'sync_meetup_account',
    isButton: () => true,
  }) as unknown as ButtonInteraction;

const slashInteraction = () =>
  ({
    ...base(),
    commandName: 'meetup_self_onboard',
    isButton: () => false,
  }) as unknown as CommandInteraction;

const lastEditReply = (interaction: { editReply: unknown }) => {
  const calls = (interaction.editReply as ReturnType<typeof vi.fn>).mock.calls;
  return calls[calls.length - 1][0] as {
    components?: {
      components: { data: { custom_id?: string; label?: string } }[];
    }[];
    content?: string;
  };
};

describe('withMeetupClient when the member has not finished authorizing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers a retry button that re-runs the button they pressed', async () => {
    const interaction = buttonInteraction();
    const commandFn = vi.fn();

    await withMeetupClient(interaction, commandFn);

    // The command body must not run without a token.
    expect(commandFn).not.toHaveBeenCalled();
    const reply = lastEditReply(interaction);
    expect(reply.content).toMatch(/try again/i);
    // Re-using the originating custom id means the retry re-enters the very
    // same handler, with no registry of retry actions to keep in sync.
    const button = reply.components?.[0].components[0].data;
    expect(button?.custom_id).toBe('sync_meetup_account');
    // The wrapper deletes the reply on success unless told otherwise.
    expect(keepReplyVisible).toHaveBeenCalledWith(interaction);
  });

  it('falls back to text for a slash command, which has no button to re-press', async () => {
    const interaction = slashInteraction();

    await withMeetupClient(interaction, vi.fn());

    const reply = lastEditReply(interaction);
    expect(reply.content).toMatch(/run the command again/i);
    expect(reply.components ?? []).toHaveLength(0);
    expect(keepReplyVisible).toHaveBeenCalledWith(interaction);
  });
});
