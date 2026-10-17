import { Client } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import { GUILD_ID, SERVER_ROLES } from '../../../src/constants.js';
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

const OTHER_ROLE = '999';

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
    );
    expect(counts.linked).toBe(1);
    expect(counts.unlinked).toBe(2);
  });

  it('excludes onboarding from unlinked', () => {
    const counts = countLinkProgress(
      [member('1', [SERVER_ROLES.onboarding]), member('2')],
      [],
    );
    expect(counts).toMatchObject({ unlinked: 1, onboarding: 1 });
  });

  it('reverifyTagged is always 0: the Reverify role is gone', () => {
    const members = [member('1', [OTHER_ROLE]), member('2')];
    expect(countLinkProgress(members, []).reverifyTagged).toBe(0);
  });

  it('unlinked is a non-bot member with no Meetup id and no Onboarding role', () => {
    const members = [
      member('1'),
      member('2'),
      member('3', [SERVER_ROLES.onboarding]),
      member('4', [], true),
      member('5', [SERVER_ROLES.moderator]),
      member('6'),
    ];
    const rows = [row('1', 'm1'), row('2', null), row('4', 'm4')];
    expect(countLinkProgress(members, rows).unlinked).toBe(3);
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
      ['1', guildMember('1', [OTHER_ROLE])],
      ['2', guildMember('2', [])],
      ['3', guildMember('3', [], true)],
    ]);
    const gatewayFetch = vi.fn();
    const guild = {
      members: { list: vi.fn().mockResolvedValue(page), fetch: gatewayFetch },
      roles: { fetch: vi.fn() },
    };
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
    // No Reverify role lookup any more.
    expect(guild.roles.fetch).not.toHaveBeenCalled();
    expect(counts).toEqual({
      linked: 1,
      unlinked: 1,
      reverifyTagged: 0,
      onboarding: 0,
    });
  });
});
