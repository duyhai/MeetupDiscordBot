import { Guild, GuildMember } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import {
  fetchAllMembers,
  toMemberSummary,
} from '../../../src/lib/helpers/guildMembers.js';

describe('fetchAllMembers', () => {
  function fakeGuild(ids: string[][]) {
    // Pages keyed by the `after` cursor they were requested with.
    const calls: (string | undefined)[] = [];
    const list = vi.fn(async ({ after }: { after?: string; limit: number }) => {
      calls.push(after);
      const page = ids.shift() ?? [];
      return {
        size: page.length,
        values: () => page.map((id) => ({ id }) as GuildMember),
        keys: () => page.values(),
      };
    });
    return { guild: { members: { list } } as unknown as Guild, calls };
  }

  it('pages with REST until a short page, threading the highest id', async () => {
    // REST instead of guild.members.fetch(): the gateway request (opcode 8)
    // shares a tight budget, and a full-guild gateway fetch hit "Request
    // with opcode 8 was rate limited" in production (2026-10-05).
    const pageOne = Array.from({ length: 1000 }, (_, i) => String(1000 + i));
    const { guild, calls } = fakeGuild([pageOne, ['3001', '3002']]);

    const members = await fetchAllMembers(guild);

    expect(members).toHaveLength(1002);
    expect(members.at(-1)?.id).toBe('3002');
    expect(calls).toEqual([undefined, '1999']);
  });

  it('handles an exactly full last page with one empty follow-up', async () => {
    const full = Array.from({ length: 1000 }, (_, i) => String(5000 + i));
    const { guild, calls } = fakeGuild([full, []]);

    expect(await fetchAllMembers(guild)).toHaveLength(1000);
    expect(calls).toHaveLength(2);
  });
});

describe('toMemberSummary', () => {
  it('keeps the id, the bot flag and the role ids', () => {
    const member = {
      id: '7',
      user: { bot: true },
      roles: {
        cache: new Map([
          ['r1', {}],
          ['r2', {}],
        ]),
      },
    } as unknown as GuildMember;
    expect(toMemberSummary(member)).toEqual({
      id: '7',
      isBot: true,
      roleIds: ['r1', 'r2'],
    });
  });
});
