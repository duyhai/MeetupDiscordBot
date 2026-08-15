/* eslint-disable @typescript-eslint/unbound-method */
import { ButtonInteraction, CommandInteraction, GuildMember } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SERVER_ROLES } from '../../../../src/constants.js';
import * as discordLogger from '../../../../src/lib/helpers/discordLogger.js';
import { DuplicateMeetupAccountError } from '../../../../src/lib/helpers/memberLink.js';
import {
  registrySize,
  replyStack,
} from '../../../../src/lib/messageStack/registry.js';
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
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue({ id: 'm1' }),
    followUp: vi.fn().mockResolvedValue({ id: 'm2' }),
    deleteReply: vi.fn().mockResolvedValue(undefined),
    channel: { send: vi.fn().mockResolvedValue({ id: 'p1' }) },
    id: `interaction-${Math.random()}`,
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

describe('discordCommandWrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defers, runs the command, and flushes one message', async () => {
    const interaction = makeInteraction();
    await discordCommandWrapper(interaction, async () => {
      replyStack(interaction).ephemeral.append({
        content: 'result',
        status: 'success',
      });
    });

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(vi.mocked(interaction.editReply)).toHaveBeenCalledTimes(1);
    const [payload] = vi.mocked(interaction.editReply).mock.calls[0] as [
      { content: string },
    ];
    expect(payload.content).toBe('result');
  });

  it('posts an activity entry on success', async () => {
    const interaction = makeInteraction();
    await discordCommandWrapper(interaction, async () => {});

    expect(vi.mocked(discordLogger.logActivity)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(discordLogger.logAlert)).not.toHaveBeenCalled();
  });

  it('renders the error in the stack and alerts', async () => {
    const interaction = makeInteraction();
    await discordCommandWrapper(interaction, async () => {
      throw new Error('boom');
    });

    expect(vi.mocked(discordLogger.logAlert)).toHaveBeenCalledTimes(1);
    const [payload] = vi.mocked(interaction.editReply).mock.calls[0] as [
      { content: string },
    ];
    expect(payload.content).toContain('boom');
  });

  it('renders a non-Error throw in the stack and alerts', async () => {
    const interaction = makeInteraction();
    await discordCommandWrapper(interaction, async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'plain string failure';
    });

    expect(vi.mocked(discordLogger.logAlert)).toHaveBeenCalledTimes(1);
    const [payload] = vi.mocked(interaction.editReply).mock.calls[0] as [
      { content: string; embeds: { toJSON: () => { title?: string } }[] },
    ];
    expect(payload.content).toContain('plain string failure');
    expect(payload.embeds.at(-1)?.toJSON().title).toBe('Error');
  });

  it('skips the generic alert for duplicate-link blocks (already alerted)', async () => {
    const interaction = makeInteraction();
    await discordCommandWrapper(interaction, async () => {
      throw new DuplicateMeetupAccountError('already linked');
    });

    expect(vi.mocked(discordLogger.logAlert)).not.toHaveBeenCalled();
  });

  it('leaves no message when the flow produced no output', async () => {
    const interaction = makeInteraction();
    await discordCommandWrapper(interaction, async () => {});

    expect(interaction.deleteReply).toHaveBeenCalledTimes(1);
    expect(vi.mocked(interaction.editReply)).not.toHaveBeenCalled();
  });

  it('still surfaces an error if something throws after commandFn resolves', async () => {
    // The pending "Working on it…" entry (workingId) must still exist when
    // any later step in the try block throws, so the catch block's
    // stack.ephemeral.update(workingId, ...) actually replaces it with the
    // error instead of being a no-op against an already-removed entry. This
    // guards the ordering fix: workingId is now removed only after
    // logActivity settles, not before it.
    vi.mocked(discordLogger.logActivity).mockRejectedValueOnce(
      new Error('log channel unreachable'),
    );
    const interaction = makeInteraction();
    await discordCommandWrapper(interaction, async () => {});

    const [payload] = vi.mocked(interaction.editReply).mock.calls[0] as [
      { content: string },
    ];
    expect(payload.content).toContain('log channel unreachable');
  });

  it('disposes the manager so the registry does not grow', async () => {
    const interaction = makeInteraction();
    await discordCommandWrapper(interaction, async () => {
      replyStack(interaction).ephemeral.append({ content: 'x' });
    });

    // RULING A: the brief's original assertion called replyStack(interaction)
    // again here, which lazily recreates a manager and makes registrySize()
    // 1 -- an assertion that can never pass. Assert disposal directly instead.
    expect(registrySize()).toBe(0);
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
