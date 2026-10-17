/* eslint-disable @typescript-eslint/unbound-method */
import { ButtonInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import { SERVER_ROLES } from '../../../src/constants.js';
import { addToChannel } from '../../../src/lib/helpers/channel.js';

/**
 * addToChannel hands out a per-user ViewChannel overwrite, which beats the
 * Onboarding role's channel denies. So it must refuse anyone who has not
 * finished verifying: in production (2026-10-12) a brand-new, unverified
 * member pressed the opt-in button and was let into a private channel.
 */

const CHANNEL_ID = 'private-channel';
// Any role that isn't Onboarding's.
const OTHER_ROLE_ID = 'other-role';

function fakeInteraction(roleIds: string[]) {
  const createOverwrite = vi.fn().mockResolvedValue(undefined);
  const fetchMember = vi.fn().mockResolvedValue({
    roles: { cache: new Map(roleIds.map((id) => [id, { id }])) },
  });
  const interaction = {
    user: { id: 'discord-1', username: 'tester' },
    guild: {
      members: { fetch: fetchMember },
      channels: {
        fetch: vi.fn().mockResolvedValue({
          name: 'private',
          permissionOverwrites: { create: createOverwrite },
          toString: () => `<#${CHANNEL_ID}>`,
        }),
      },
    },
    followUp: vi.fn().mockResolvedValue(undefined),
  } as unknown as ButtonInteraction;
  return { interaction, createOverwrite, fetchMember };
}

function lastReply(interaction: ButtonInteraction) {
  const calls = vi.mocked(interaction.followUp).mock.calls;
  return calls[calls.length - 1][0] as { content: string; ephemeral: boolean };
}

describe('addToChannel', () => {
  it('refuses a member who is still onboarding', async () => {
    const { interaction, createOverwrite } = fakeInteraction([
      SERVER_ROLES.onboarding,
    ]);

    await addToChannel(interaction, CHANNEL_ID);

    expect(createOverwrite).not.toHaveBeenCalled();
  });

  it('tells the onboarding member, privately, to link Meetup first', async () => {
    const { interaction } = fakeInteraction([SERVER_ROLES.onboarding]);

    await addToChannel(interaction, CHANNEL_ID);

    expect(interaction.followUp).toHaveBeenCalledTimes(1);
    const reply = lastReply(interaction);
    expect(reply.ephemeral).toBe(true);
    expect(reply.content).toMatch(/link.*Meetup account/i);
    expect(reply.content).not.toContain('You have been added');
  });

  it('adds a verified member', async () => {
    const { interaction, createOverwrite } = fakeInteraction([]);

    await addToChannel(interaction, CHANNEL_ID);

    expect(createOverwrite).toHaveBeenCalledWith('discord-1', {
      ViewChannel: true,
    });
    expect(lastReply(interaction).content).toContain('You have been added');
  });

  it('adds a verified member who holds other roles', async () => {
    const { interaction, createOverwrite } = fakeInteraction([OTHER_ROLE_ID]);

    await addToChannel(interaction, CHANNEL_ID);

    expect(createOverwrite).toHaveBeenCalledWith('discord-1', {
      ViewChannel: true,
    });
  });

  it('refuses a member in Onboarding whatever other roles they hold', async () => {
    const { interaction, createOverwrite } = fakeInteraction([
      OTHER_ROLE_ID,
      SERVER_ROLES.onboarding,
    ]);

    await addToChannel(interaction, CHANNEL_ID);

    expect(createOverwrite).not.toHaveBeenCalled();
  });

  it('checks roles fetched fresh, not whatever is cached', async () => {
    const { interaction, fetchMember } = fakeInteraction([]);

    await addToChannel(interaction, CHANNEL_ID);

    expect(fetchMember).toHaveBeenCalledWith({
      user: 'discord-1',
      force: true,
    });
  });

  it('adds nobody when the role check itself fails', async () => {
    const { interaction, createOverwrite, fetchMember } = fakeInteraction([]);
    fetchMember.mockRejectedValue(new Error('Discord is down'));

    await expect(addToChannel(interaction, CHANNEL_ID)).rejects.toThrow(
      'Discord is down',
    );
    expect(createOverwrite).not.toHaveBeenCalled();
  });
});
