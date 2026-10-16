import { Client } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import { GUILD_ID, SERVER_ROLES } from '../../../src/constants.js';
import { collectUnlinkedMemberIds } from '../../../src/lib/helpers/unlinkedDigest.js';
import {
  collectLinkProgress,
  countLinkProgress,
  LinkProgressMember,
} from '../../../src/lib/reports/linkProgress.js';
import { MemberRecord } from '../../../src/lib/repositories/types.js';

const row = (
  discordUserId: string,
  meetupId: string | null,
): Pick<MemberRecord, 'discordUserId' | 'meetupId'> => ({
  discordUserId,
  meetupId,
});

const member = (
  id: string,
  roleIds: string[] = [],
  isBot = false,
): LinkProgressMember => ({ id, isBot, roleIds });

const REVERIFY = '999';

describe('countLinkProgress', () => {
  it('counts linked only among current non-bot members', () => {
    const counts = countLinkProgress(
      [member('1'), member('2'), member('3'), member('bot', [], true)],
      [
        row('1', 'm1'),
        row('gone', 'm9'), // left the server
        row('bot', 'm8'), // linked bot
        row('2', null), // mod-onboarded, no Meetup id
      ],
      undefined,
    );
    expect(counts.linked).toBe(1);
    expect(counts.unlinked).toBe(2);
  });

  it('excludes onboarding from unlinked', () => {
    const counts = countLinkProgress(
      [member('1', [SERVER_ROLES.onboarding]), member('2')],
      [],
      undefined,
    );
    expect(counts).toMatchObject({ unlinked: 1, onboarding: 1 });
  });

  it('counts Reverify-tagged', () => {
    const members = [
      member('1', [REVERIFY]),
      member('2', [REVERIFY]),
      member('3'),
    ];
    expect(countLinkProgress(members, [], REVERIFY).reverifyTagged).toBe(2);
    expect(countLinkProgress(members, [], undefined).reverifyTagged).toBe(0);
  });

  it('agrees with the unlinked digest', () => {
    const members = [
      member('1'),
      member('2'),
      member('3', [SERVER_ROLES.onboarding]),
      member('4', [], true),
      member('5', [SERVER_ROLES.moderator]),
      member('6'),
    ];
    const rows = [row('1', 'm1'), row('2', null), row('4', 'm4')];
    const digest = collectUnlinkedMemberIds(
      members.map((m) => ({
        id: m.id,
        isBot: m.isBot,
        hasOnboardingRole: m.roleIds.includes(SERVER_ROLES.onboarding),
      })),
      rows as MemberRecord[],
    );
    expect(countLinkProgress(members, rows, undefined).unlinked).toBe(
      digest.length,
    );
  });
});

describe('collectLinkProgress', () => {
  it('collects through REST paging, not the gateway', async () => {
    const guildMember = (id: string, roleIds: string[], bot = false) => ({
      id,
      user: { bot },
      roles: { cache: new Map(roleIds.map((r) => [r, {}])) },
      permissions: { has: () => false },
    });
    const page = new Map([
      ['1', guildMember('1', [REVERIFY])],
      ['2', guildMember('2', [])],
      ['3', guildMember('3', [], true)],
    ]);
    const gatewayFetch = vi.fn();
    const guild = {
      members: { list: vi.fn().mockResolvedValue(page), fetch: gatewayFetch },
      roles: {
        fetch: vi
          .fn()
          .mockResolvedValue(
            new Map([[REVERIFY, { id: REVERIFY, name: 'Reverify' }]]),
          ),
      },
    };
    // roles.fetch result needs Collection#find
    guild.roles.fetch.mockResolvedValue({
      find: (fn: (r: { name: string }) => boolean) =>
        [{ id: REVERIFY, name: 'Reverify' }].find(fn),
    });
    const guildsFetch = vi.fn().mockResolvedValue(guild);
    const client = { guilds: { fetch: guildsFetch } } as unknown as Client;

    const counts = await collectLinkProgress(client, {
      memberRepository: () =>
        Promise.resolve({
          listAll: () => Promise.resolve([row('1', 'm1')] as MemberRecord[]),
        }),
    });

    expect(guildsFetch).toHaveBeenCalledWith(GUILD_ID);
    expect(gatewayFetch).not.toHaveBeenCalled();
    expect(guild.members.list).toHaveBeenCalled();
    expect(counts).toEqual({
      linked: 1,
      unlinked: 1,
      reverifyTagged: 1,
      onboarding: 0,
    });
  });
});
