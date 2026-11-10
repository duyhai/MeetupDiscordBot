import { Client, DiscordAPIError, RESTJSONErrorCodes } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import { GUILD_ID } from '../../../src/constants.js';
import {
  discordUsername,
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
