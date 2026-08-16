/* eslint-disable @typescript-eslint/unbound-method */
import { ButtonInteraction, CommandInteraction, GuildMember } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SERVER_ROLES } from '../../../../src/constants.js';
import * as discordLogger from '../../../../src/lib/helpers/discordLogger.js';
import { DuplicateMeetupAccountError } from '../../../../src/lib/helpers/memberLink.js';
import {
  describeInteraction,
  discordCommandWrapper,
  hasAnyServerRole,
} from '../../../../src/util/discord.js';

vi.mock('../../../../src/lib/helpers/discordLogger.js', () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
  logAlert: vi.fn().mockResolvedValue(undefined),
}));

function makeInteraction(overrides: Record<string, unknown> = {}) {
  return {
    client: {},
    user: { id: 'user-1', username: 'testUser', toString: () => '<@user-1>' },
    commandName: 'test_command',
    isChatInputCommand: () => true,
    isButton: () => false,
    reply: vi
      .fn()
      .mockResolvedValue({ delete: vi.fn().mockResolvedValue(undefined) }),
    editReply: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as CommandInteraction;
}

describe('describeInteraction', () => {
  it('formats slash commands and buttons', () => {
    expect(describeInteraction(makeInteraction())).toBe('/test_command');
    const button = {
      isChatInputCommand: () => false,
      isButton: () => true,
      customId: 'sync_meetup_account',
    } as unknown as ButtonInteraction;
    expect(describeInteraction(button)).toBe('button:sync_meetup_account');
  });
});

describe('discordCommandWrapper logging hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('posts an activity entry on success', async () => {
    const interaction = makeInteraction();
    await discordCommandWrapper(interaction, async () => {});

    expect(vi.mocked(discordLogger.logActivity)).toHaveBeenCalledTimes(1);
    const [, entry] = vi.mocked(discordLogger.logActivity).mock.calls[0];
    expect(entry.title).toContain('/test_command');
    expect(vi.mocked(discordLogger.logAlert)).not.toHaveBeenCalled();
  });

  it('still logs success when the progress-reply delete fails', async () => {
    const interaction = makeInteraction({
      reply: vi.fn().mockResolvedValue({
        delete: vi.fn().mockRejectedValue(new Error('Unknown Message')),
      }),
    });
    await discordCommandWrapper(interaction, async () => {});

    expect(vi.mocked(discordLogger.logActivity)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(discordLogger.logAlert)).not.toHaveBeenCalled();
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it('skips the generic alert for duplicate-link blocks (already alerted)', async () => {
    const interaction = makeInteraction();
    await discordCommandWrapper(interaction, async () => {
      throw new DuplicateMeetupAccountError('already linked');
    });

    expect(vi.mocked(discordLogger.logAlert)).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    const [editArgs] = vi.mocked(interaction.editReply).mock.calls[0] as [
      { content: string },
    ];
    expect(editArgs.content).toContain('already linked');
  });

  it('posts an alert entry on error and still edits the reply', async () => {
    const interaction = makeInteraction();
    await discordCommandWrapper(interaction, async () => {
      throw new Error('boom');
    });

    expect(vi.mocked(discordLogger.logAlert)).toHaveBeenCalledTimes(1);
    const [, entry] = vi.mocked(discordLogger.logAlert).mock.calls[0];
    expect(entry.title).toContain('/test_command');
    expect(entry.description).toContain('boom');
    expect(interaction.editReply).toHaveBeenCalled();
  });
});

describe('hasAnyServerRole', () => {
  const memberWithRoles = (...roleIds: string[]) =>
    ({
      roles: { cache: new Map(roleIds.map((id) => [id, {}])) },
    }) as unknown as GuildMember;

  it('matches when the member has one of the roles', () => {
    const member = memberWithRoles(SERVER_ROLES.moderator);
    expect(hasAnyServerRole(member, ['moderator', 'organizer'])).toBe(true);
  });

  it('does not match when the member has none of the roles', () => {
    const member = memberWithRoles(SERVER_ROLES.bots);
    expect(hasAnyServerRole(member, ['moderator', 'organizer'])).toBe(false);
  });
});
