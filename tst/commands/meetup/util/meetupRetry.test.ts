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

  it('points at the Link Meetup Account button, with no components of its own', async () => {
    const interaction = buttonInteraction();
    const commandFn = vi.fn();

    await withMeetupClient(interaction, commandFn);

    // The command body must not run without a token.
    expect(commandFn).not.toHaveBeenCalled();
    const reply = lastEditReply(interaction);
    expect(reply.content).toMatch(/link meetup account/i);
    // A retry button could only regenerate this same message with the
    // authorization link one click later, so the reply carries none.
    expect(reply.components ?? []).toHaveLength(0);
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
