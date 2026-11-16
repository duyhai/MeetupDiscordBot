import {
  Client,
  DiscordAPIError,
  RESTJSONErrorCodes,
  Status,
} from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import { GUILD_ID } from '../../../src/constants.js';
import {
  cachedDisplayNames,
  discordUsername,
  displayName,
  displayNames,
  ensureServerMember,
  isServerMember,
} from '../../../src/web/host/serverJoin.js';

const USER = '123456789012345678';

const unknownMember = () =>
  new DiscordAPIError(
    { code: RESTJSONErrorCodes.UnknownMember, message: 'Unknown Member' },
    RESTJSONErrorCodes.UnknownMember,
    404,
    'GET',
    '/guilds/x/members/y',
    {},
  );

function fakeClient(options: {
  member?: { pending?: boolean };
  fetchError?: unknown;
  added?: { pending?: boolean } | null;
}) {
  const fetch = vi.fn();
  if (options.fetchError) {
    fetch.mockRejectedValueOnce(options.fetchError);
  }
  if (options.member) {
    fetch.mockResolvedValue(options.member);
  }
  const add = vi.fn().mockResolvedValue(options.added ?? null);
  const guildsFetch = vi.fn().mockResolvedValue({ members: { fetch, add } });
  const client = { guilds: { fetch: guildsFetch } } as unknown as Client;
  return { client, fetch, add, guildsFetch };
}

describe('ensureServerMember', () => {
  it('leaves a member as they are', async () => {
    const member = { pending: false };
    const { client, add, guildsFetch } = fakeClient({ member });
    expect(await ensureServerMember(() => client, USER, 'oauth')).toEqual({
      joined: false,
      pending: false,
      member,
    });
    expect(guildsFetch).toHaveBeenCalledWith(GUILD_ID);
    expect(add).not.toHaveBeenCalled();
  });

  it('adds a non-member with their own OAuth token, and reports screening', async () => {
    const added = { pending: true };
    const { client, add } = fakeClient({
      fetchError: unknownMember(),
      added,
    });
    expect(await ensureServerMember(() => client, USER, 'oauth')).toEqual({
      joined: true,
      pending: true,
      member: added,
    });
    expect(add).toHaveBeenCalledWith(USER, {
      accessToken: 'oauth',
      fetchWhenExisting: false,
    });
  });

  it('an add that finds them already in (204) is not a join', async () => {
    const member = { pending: false };
    const { client, fetch } = fakeClient({
      fetchError: unknownMember(),
      added: null,
    });
    fetch.mockResolvedValue(member);
    expect(await ensureServerMember(() => client, USER, 'oauth')).toEqual({
      joined: false,
      pending: false,
      member,
    });
  });

  it('any other Discord failure, or no client, is thrown', async () => {
    const { client, add } = fakeClient({
      fetchError: new Error('discord down'),
    });
    await expect(
      ensureServerMember(() => client, USER, 'oauth'),
    ).rejects.toThrow('discord down');
    expect(add).not.toHaveBeenCalled();
    await expect(
      ensureServerMember(() => undefined, USER, 'oauth'),
    ).rejects.toThrow('not ready');
  });
});

describe('isServerMember', () => {
  it('a member is in; Unknown Member is out; anything else is thrown', async () => {
    const member = fakeClient({ member: { pending: false } });
    expect(await isServerMember(() => member.client, USER)).toBe(true);
    const gone = fakeClient({ fetchError: unknownMember() });
    expect(await isServerMember(() => gone.client, USER)).toBe(false);
    const down = fakeClient({ fetchError: new Error('discord down') });
    await expect(isServerMember(() => down.client, USER)).rejects.toThrow(
      'discord down',
    );
    await expect(isServerMember(() => undefined, USER)).rejects.toThrow(
      'not ready',
    );
  });
});

describe('Unknown User', () => {
  const unknownUser = () =>
    new DiscordAPIError(
      { code: RESTJSONErrorCodes.UnknownUser, message: 'Unknown User' },
      RESTJSONErrorCodes.UnknownUser,
      404,
      'GET',
      '/guilds/x/members/y',
      {},
    );

  it('reads as not a member, for both the check and the join', async () => {
    const check = fakeClient({ fetchError: unknownUser() });
    expect(await isServerMember(() => check.client, USER)).toBe(false);
    const join = fakeClient({
      fetchError: unknownUser(),
      added: { pending: false },
    });
    expect(
      (await ensureServerMember(() => join.client, USER, 'oauth')).joined,
    ).toBe(true);
    expect(join.add).toHaveBeenCalled();
  });
});

describe('discordUsername', () => {
  const withUsers = (fetch: () => Promise<{ username: string }>) =>
    ({ users: { fetch: vi.fn(fetch) } }) as unknown as Client;

  it('names the account, or nothing if Discord does not know it or the bot is not ready', async () => {
    const known = withUsers(async () => ({ username: 'dee.linked' }));
    expect(await discordUsername(() => known, USER)).toBe('dee.linked');
    const unknown = withUsers(async () => {
      throw new Error('Unknown User');
    });
    expect(await discordUsername(() => unknown, USER)).toBeUndefined();
    expect(await discordUsername(() => undefined, USER)).toBeUndefined();
  });

  it('gives up after its timeout rather than wait on a slow Discord', async () => {
    const slow = withUsers(
      async () =>
        new Promise(() => {
          // never answers
        }),
    );
    const started = Date.now();
    expect(await discordUsername(() => slow, USER, 20)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('displayName', () => {
  const withGuild = (
    cached: { displayName: string } | undefined,
    fetch: (id: string) => Promise<{ displayName: string }>,
  ) => {
    const membersFetch = vi.fn(fetch);
    const client = {
      guilds: {
        fetch: vi.fn().mockResolvedValue({
          members: {
            cache: new Map(cached ? [[USER, cached]] : []),
            fetch: membersFetch,
          },
        }),
      },
    } as unknown as Client;
    return { client, membersFetch };
  };

  it('reads the server nickname from the guild member cache without a fetch', async () => {
    const { client, membersFetch } = withGuild({ displayName: 'Dee ✨' }, () =>
      Promise.reject(new Error('should not fetch')),
    );
    expect(await displayName(() => client, USER)).toBe('Dee ✨');
    expect(membersFetch).not.toHaveBeenCalled();
  });

  it('fetches a member who is not cached', async () => {
    const { client, membersFetch } = withGuild(undefined, async () => ({
      displayName: 'Dee',
    }));
    expect(await displayName(() => client, USER)).toBe('Dee');
    expect(membersFetch).toHaveBeenCalledWith(USER);
  });

  it('is nothing for someone not on the server, a slow Discord, or no bot', async () => {
    const gone = withGuild(undefined, () => Promise.reject(unknownMember()));
    expect(await displayName(() => gone.client, USER)).toBeUndefined();
    const slow = withGuild(
      undefined,
      () =>
        new Promise(() => {
          // never answers
        }),
    );
    expect(await displayName(() => slow.client, USER, 20)).toBeUndefined();
    expect(await displayName(() => undefined, USER)).toBeUndefined();
  });
});

describe('displayNames', () => {
  const ids = (n: number) =>
    Array.from({ length: n }, (_, i) => `30000000000000000${String(i)}`);
  const withGuild = (
    cached: Record<string, string>,
    fetch: (
      options: string | { user: string[]; time: number },
    ) => Promise<unknown>,
    shardStatus: Status | 'no shard' = Status.Ready,
  ) => {
    const membersFetch = vi.fn(fetch);
    const client = {
      guilds: {
        fetch: vi.fn().mockResolvedValue({
          shard:
            shardStatus === 'no shard' ? undefined : { status: shardStatus },
          members: {
            cache: new Map(
              Object.entries(cached).map(([id, name]) => [
                id,
                { displayName: name },
              ]),
            ),
            fetch: membersFetch,
          },
        }),
      },
    } as unknown as Client;
    return { client, membersFetch };
  };
  const batch = (options: { user: string[] }, skip: string[] = []) =>
    new Map(
      options.user
        .filter((id) => !skip.includes(id))
        .map((id) => [id, { id, displayName: `Pal ${id.slice(-1)}` }]),
    );
  const rest = async (options: unknown) => {
    if (typeof options !== 'string') {
      throw new Error('no gateway here');
    }
    if (options.endsWith('9')) {
      throw unknownMember();
    }
    return { displayName: `Pal ${options.slice(-1)}` };
  };

  it('many misses on a Ready shard: the cache, then one batched request; whoever it lacks is not on the server', async () => {
    const all = ids(8);
    const { client, membersFetch } = withGuild(
      { [all[0]]: 'Cached' },
      async (options) => batch(options as { user: string[] }, [all[7]]),
    );
    const names = await displayNames(() => client, all);
    expect(membersFetch).toHaveBeenCalledTimes(1);
    expect(membersFetch).toHaveBeenCalledWith({
      user: all.slice(1),
      time: expect.any(Number) as number,
    });
    expect(names[all[0]]).toBe('Cached');
    expect(names[all[1]]).toBe('Pal 1');
    expect(names[all[7]]).toBeNull();
  });

  it('a shard that is not Ready (reconnecting) never gets the gateway request: REST instead', async () => {
    const statuses = [
      Status.Reconnecting,
      Status.Connecting,
      'no shard',
    ] as const;
    const runs = await Promise.all(
      statuses.map(async (status) => {
        const { client, membersFetch } = withGuild({}, rest, status);
        const names = await displayNames(() => client, ids(8));
        return { names, calls: membersFetch.mock.calls.map(([o]) => o) };
      }),
    );
    runs.forEach(({ names, calls }) => {
      expect(Object.keys(names)).toHaveLength(8);
      expect(calls.every((o) => typeof o === 'string')).toBe(true);
    });
  });

  it('a few misses are read one by one over REST; Unknown Member is "not on the server"', async () => {
    const few = [...ids(2), '300000000000000009'];
    const { client, membersFetch } = withGuild({}, rest);
    expect(await displayNames(() => client, few)).toEqual({
      [few[0]]: 'Pal 0',
      [few[1]]: 'Pal 1',
      [few[2]]: null,
    });
    expect(membersFetch.mock.calls.map(([o]) => o)).toEqual(few);
  });

  it('a failed batch (a gateway rate limit) falls back to reading one by one', async () => {
    const all = ids(7);
    const { client, membersFetch } = withGuild({}, async (options) => {
      if (typeof options !== 'string') {
        throw new Error('Request with opcode 8 was rate limited');
      }
      return { displayName: `Pal ${options.slice(-1)}` };
    });
    const names = await displayNames(() => client, all);
    expect(Object.keys(names)).toHaveLength(7);
    // One batch, then each id once.
    expect(membersFetch).toHaveBeenCalledTimes(8);
  });

  it('stays within its budget: a Discord that never answers leaves them unanswered, not absent', async () => {
    // The gateway request rejects at its `time`, as discord.js does; REST
    // reads never answer.
    const { client } = withGuild({}, (options) => {
      if (typeof options === 'string') {
        return new Promise(() => undefined);
      }
      return new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error('GuildMembersTimeout'));
        }, options.time);
      });
    });
    const started = Date.now();
    const names = await displayNames(() => client, ids(8), 200);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(names).toEqual({});
  });

  it('no bot or no ids: no names, no calls', async () => {
    expect(await displayNames(() => undefined, ids(8))).toEqual({});
    const { client, membersFetch } = withGuild({}, async () => new Map());
    expect(await displayNames(() => client, [])).toEqual({});
    expect(membersFetch).not.toHaveBeenCalled();
  });
});

describe('cachedDisplayNames', () => {
  it('reads only the bot’s memory: no request, unknown ids left out', () => {
    const client = {
      guilds: {
        cache: new Map([
          [
            GUILD_ID,
            { members: { cache: new Map([['a', { displayName: 'Ann' }]]) } },
          ],
        ]),
      },
    } as unknown as Client;
    expect(cachedDisplayNames(() => client, ['a', 'b'])).toEqual({ a: 'Ann' });
    expect(cachedDisplayNames(() => undefined, ['a'])).toEqual({});
  });
});
