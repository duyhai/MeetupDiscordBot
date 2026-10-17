import { EventEmitter } from 'node:events';

import { Client, GuildMember } from 'discord.js';
import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GUILD_ID } from '../../../src/constants.js';
import {
  forgetConnectionOnLeave,
  registerMemberLeaveListener,
} from '../../../src/lib/helpers/memberLeave.js';
import { getUsableMeetupTokens } from '../../../src/lib/helpers/meetupTokens.js';

const HOUR_MS = 60 * 60 * 1000;

const fake = vi.hoisted(() => {
  const data = new Map<string, string>();
  const logged: string[] = [];
  const failure = { remove: undefined as Error | undefined };
  return {
    data,
    logged,
    failure,
    cache: {
      get: (key: string) => Promise.resolve(data.get(key)),
      set: (key: string, value: string) => {
        data.set(key, value);
        return Promise.resolve();
      },
      remove: (key: string) => {
        if (failure.remove) {
          return Promise.reject(failure.remove);
        }
        data.delete(key);
        return Promise.resolve();
      },
      exclusive_set: () => Promise.resolve(true),
      set_existing: () => Promise.resolve(false),
    },
  };
});

vi.mock('../../../src/util/cache.js', () => ({
  ApplicationCache: () => Promise.resolve(fake.cache),
}));

vi.mock('tslog', () => {
  const renderOne = (arg: unknown) => {
    if (arg instanceof Error) {
      return `${arg.message} ${arg.stack ?? ''}`;
    }
    return typeof arg === 'string' ? arg : JSON.stringify(arg);
  };
  const render = (args: unknown[]) => args.map(renderOne).join(' ');
  class Logger {
    debug = (...args: unknown[]) => fake.logged.push(render(args));

    info = (...args: unknown[]) => fake.logged.push(render(args));

    warn = (...args: unknown[]) => fake.logged.push(render(args));

    error = (...args: unknown[]) => fake.logged.push(render(args));
  }
  return { Logger };
});

function departing(
  id: string,
  { bot = false, guildId = GUILD_ID }: { bot?: boolean; guildId?: string } = {},
) {
  // What discord.js hands over for a member it had not cached: a partial
  // with only the guild and the user from the gateway payload.
  return {
    id,
    guild: { id: guildId },
    user: { id, bot },
    partial: true,
  } as unknown as GuildMember;
}

const saveConnection = (id: string, accessToken = `${id}-ACCESS-SECRET`) =>
  fake.data.set(
    `${id}-meetup-tokens`,
    JSON.stringify({
      accessToken,
      refreshToken: `${id}-REFRESH-SECRET`,
      expiresAt: Date.now() + HOUR_MS,
    }),
  );

describe('forgetting a Meetup connection when a member leaves', () => {
  beforeEach(() => {
    fake.data.clear();
    fake.logged.length = 0;
    fake.failure.remove = undefined;
    saveConnection('leaver');
    saveConnection('stayer');
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it("removes the leaving member's saved connection and nobody else's", async () => {
    await forgetConnectionOnLeave(departing('leaver'));

    expect(fake.data.has('leaver-meetup-tokens')).toBe(false);
    expect(fake.data.has('stayer-meetup-tokens')).toBe(true);
  });

  it('does nothing when a bot leaves', async () => {
    await forgetConnectionOnLeave(departing('leaver', { bot: true }));

    expect(fake.data.has('leaver-meetup-tokens')).toBe(true);
  });

  it('does nothing for a server other than ours', async () => {
    await forgetConnectionOnLeave(
      departing('leaver', { guildId: 'some-other-guild' }),
    );

    expect(fake.data.has('leaver-meetup-tokens')).toBe(true);
  });

  it('swallows a cache failure and logs it without token data', async () => {
    fake.failure.remove = new TypeError(
      `redis choked on ${fake.data.get('leaver-meetup-tokens') ?? ''}`,
    );

    await expect(
      forgetConnectionOnLeave(departing('leaver')),
    ).resolves.toBeUndefined();

    const logs = fake.logged.join('\n');
    expect(logs).toContain('leaver');
    expect(logs).toContain('TypeError');
    expect(logs).not.toContain('SECRET');
  });

  it('is wired to guildMemberRemove, which covers leave, kick and ban', async () => {
    const client = new EventEmitter();
    registerMemberLeaveListener(client as unknown as Client);

    client.emit('guildMemberRemove', departing('leaver'));

    await vi.waitFor(() => {
      expect(fake.data.has('leaver-meetup-tokens')).toBe(false);
    });
    expect(fake.data.has('stayer-meetup-tokens')).toBe(true);
  });

  it('leaves no connection behind when the member leaves mid-refresh', async () => {
    fake.data.set(
      'leaver-meetup-tokens',
      JSON.stringify({
        accessToken: 'expired',
        refreshToken: 'leaver-REFRESH-SECRET',
        expiresAt: Date.now() - HOUR_MS,
      }),
    );
    const refresh = nock('https://secure.meetup.com')
      .post('/oauth2/access')
      .delay(50)
      .reply(200, {
        access_token: 'refreshed',
        refresh_token: 'rotated',
        expires_in: 3600,
      });

    const inFlight = getUsableMeetupTokens(fake.cache, 'leaver');
    await forgetConnectionOnLeave(departing('leaver'));
    const tokens = await inFlight;

    // The refresh did complete; its result must not bring the set back.
    expect(refresh.isDone()).toBe(true);
    expect(tokens).toBeUndefined();
    expect(fake.data.has('leaver-meetup-tokens')).toBe(false);
  });
});
