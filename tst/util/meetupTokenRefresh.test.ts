/* eslint-disable @typescript-eslint/unbound-method */
import { CommandInteraction } from 'discord.js';
import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getUsableMeetupTokens } from '../../src/lib/helpers/meetupTokens.js';
import { waitForMeetupTokens } from '../../src/lib/helpers/oauthWait.js';
import { withMeetupClient } from '../../src/util/meetup.js';
import { applyNetworkBlock } from '../setup/blockNetwork.js';

const TOKEN_KEY = 'u1-meetup-tokens';
const HOUR_MS = 60 * 60 * 1000;
const THIRTY_DAYS_SEC = 30 * 24 * 60 * 60;

// Distinctive values, so a leak into a log line or a reply is unmistakable.
const SECRETS = {
  staleAccess: 'STALE-ACCESS-SECRET',
  storedRefresh: 'STORED-REFRESH-SECRET',
  newAccess: 'NEW-ACCESS-SECRET',
  rotatedRefresh: 'ROTATED-REFRESH-SECRET',
};

const fake = vi.hoisted(() => {
  const data = new Map<string, string>();
  const ttls = new Map<string, number | undefined>();
  const logged: string[] = [];
  const failure = { nextSet: false };
  return {
    data,
    ttls,
    logged,
    failure,
    cache: {
      get: (key: string) => Promise.resolve(data.get(key)),
      set: (key: string, value: string, ttlSec?: number) => {
        if (failure.nextSet) {
          failure.nextSet = false;
          return Promise.reject(new Error('redis is down'));
        }
        data.set(key, value);
        ttls.set(key, ttlSec);
        return Promise.resolve();
      },
      remove: (key: string) => {
        data.delete(key);
        return Promise.resolve();
      },
      exclusive_set: () => Promise.resolve(true),
      set_existing: () => Promise.resolve(false),
    },
  };
});

vi.mock('../../src/util/cache.js', () => ({
  ApplicationCache: () => Promise.resolve(fake.cache),
}));

// Every logger in the process writes here, so "tokens never reach the logs"
// is checked against everything that was logged, not one call site.
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

vi.mock('../../src/lib/helpers/discordLogger.js', () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
  logAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/lib/client/meetup/gqlClient.js', () => ({
  GqlMeetupClient: class {
    constructor(public accessToken: string) {}
  },
}));

// One look at the cache instead of a three-minute poll: `ready` if a token
// set is sitting at the key, `pending` otherwise. A stale set left behind
// after a failed refresh would come back `ready` and skip the prompt.
vi.mock('../../src/lib/helpers/oauthWait.js', () => ({
  waitForMeetupTokens: vi.fn(
    async (read: (key: string) => Promise<string | undefined>, key: string) => {
      const rawTokens = await read(key);
      return rawTokens ? { status: 'ready', rawTokens } : { status: 'pending' };
    },
  ),
}));

function slashInteraction() {
  return {
    client: {},
    commandName: 'where_have_we_met',
    user: { id: 'u1', username: 'tester', toString: () => '<@u1>' },
    editReply: vi.fn().mockResolvedValue(undefined),
    isButton: () => false,
  } as unknown as CommandInteraction;
}

function storeTokens(tokens: Record<string, unknown>) {
  fake.data.set(TOKEN_KEY, JSON.stringify(tokens));
}

const storeExpired = () =>
  storeTokens({
    accessToken: SECRETS.staleAccess,
    refreshToken: SECRETS.storedRefresh,
    expiresAt: Date.now() - HOUR_MS,
  });

const storedTokens = () =>
  JSON.parse(fake.data.get(TOKEN_KEY) ?? '{}') as {
    accessToken?: string;
    expiresAt?: number;
    refreshToken?: string;
  };

/** The access token each command body was handed, in call order. */
function accessTokensSeenBy(commandFn: ReturnType<typeof vi.fn>): string[] {
  return commandFn.mock.calls.map(
    ([client]) => (client as { accessToken: string }).accessToken,
  );
}

function replies(interaction: CommandInteraction): string {
  return JSON.stringify(vi.mocked(interaction.editReply).mock.calls);
}

const expectNoSecretsIn = (text: string) => {
  for (const secret of Object.values(SECRETS)) {
    expect(text).not.toContain(secret);
  }
};

const nockRefresh = () =>
  nock('https://secure.meetup.com').post(
    '/oauth2/access',
    (body: Record<string, string>) =>
      body.grant_type === 'refresh_token' &&
      body.refresh_token === SECRETS.storedRefresh,
  );

describe('withMeetupClient token reuse', () => {
  beforeEach(() => {
    fake.data.clear();
    fake.ttls.clear();
    fake.logged.length = 0;
    fake.failure.nextSet = false;
    vi.mocked(waitForMeetupTokens).mockClear();
    nock.disableNetConnect();
  });

  afterEach(() => {
    nock.cleanAll();
    applyNetworkBlock();
  });

  it('uses an unexpired access token as-is, without calling Meetup', async () => {
    storeTokens({
      accessToken: 'still-good',
      refreshToken: SECRETS.storedRefresh,
      expiresAt: Date.now() + HOUR_MS / 2,
    });
    const interaction = slashInteraction();
    const commandFn = vi.fn();

    // nock.disableNetConnect() turns any token request into a failure.
    await withMeetupClient(interaction, commandFn);

    expect(accessTokensSeenBy(commandFn)).toEqual(['still-good']);
    expect(storedTokens().accessToken).toBe('still-good');
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it('silently refreshes an expired access token', async () => {
    storeExpired();
    const refresh = nockRefresh().reply(200, {
      access_token: SECRETS.newAccess,
      refresh_token: SECRETS.storedRefresh,
      expires_in: 3600,
    });
    const interaction = slashInteraction();
    const commandFn = vi.fn();

    await withMeetupClient(interaction, commandFn);

    expect(refresh.isDone()).toBe(true);
    expect(accessTokensSeenBy(commandFn)).toEqual([SECRETS.newAccess]);
    // Silent: no connect prompt, no message of any kind.
    expect(interaction.editReply).not.toHaveBeenCalled();
    expect(storedTokens().accessToken).toBe(SECRETS.newAccess);
    expect(storedTokens().expiresAt).toBeGreaterThan(Date.now());
  });

  it('persists a rotated refresh token, and keeps it for 30 days from the refresh', async () => {
    storeExpired();
    nockRefresh().reply(200, {
      access_token: SECRETS.newAccess,
      refresh_token: SECRETS.rotatedRefresh,
      expires_in: 3600,
    });

    await withMeetupClient(slashInteraction(), vi.fn());

    expect(storedTokens().refreshToken).toBe(SECRETS.rotatedRefresh);
    // Every refresh restarts the full 30 days: retention slides with use.
    expect(fake.ttls.get(TOKEN_KEY)).toBe(THIRTY_DAYS_SEC);
  });

  it('keeps the existing refresh token when Meetup does not rotate it', async () => {
    storeExpired();
    nockRefresh().reply(200, {
      access_token: SECRETS.newAccess,
      expires_in: 3600,
    });

    await withMeetupClient(slashInteraction(), vi.fn());

    expect(storedTokens().accessToken).toBe(SECRETS.newAccess);
    expect(storedTokens().refreshToken).toBe(SECRETS.storedRefresh);
  });

  it('refreshes once when one member runs two commands at the same time', async () => {
    storeExpired();
    // A single interceptor: a second refresh request would find no match,
    // fail, and send that command to the connect prompt.
    const refresh = nockRefresh().delay(50).reply(200, {
      access_token: SECRETS.newAccess,
      refresh_token: SECRETS.rotatedRefresh,
      expires_in: 3600,
    });
    const first = slashInteraction();
    const second = slashInteraction();
    const commandFn = vi.fn();

    await Promise.all([
      withMeetupClient(first, commandFn),
      withMeetupClient(second, commandFn),
    ]);

    expect(refresh.isDone()).toBe(true);
    expect(accessTokensSeenBy(commandFn)).toEqual([
      SECRETS.newAccess,
      SECRETS.newAccess,
    ]);
    expect(first.editReply).not.toHaveBeenCalled();
    expect(second.editReply).not.toHaveBeenCalled();
    expect(storedTokens().refreshToken).toBe(SECRETS.rotatedRefresh);
  });

  it('falls back to the connect prompt when the refresh grant is dead', async () => {
    storeExpired();
    nockRefresh().reply(400, { error: 'invalid_grant' });
    const interaction = slashInteraction();
    const commandFn = vi.fn();

    await expect(
      withMeetupClient(interaction, commandFn),
    ).resolves.toBeUndefined();

    expect(commandFn).not.toHaveBeenCalled();
    expect(replies(interaction)).toContain(
      'Please connect your Meetup account',
    );
    // The dead set is gone, so the next authorization is what gets picked up.
    expect(fake.data.has(TOKEN_KEY)).toBe(false);
  });

  it.each([
    [
      'Meetup cannot be reached',
      () => nockRefresh().replyWithError('socket hang up'),
    ],
    ['Meetup answers 503', () => nockRefresh().reply(503, 'unavailable')],
    ['Meetup answers 429', () => nockRefresh().reply(429, 'slow down')],
    // A rotated or mistyped MEETUP_SECRET fails every member's refresh. It
    // says nothing about their grants, and must not cost anyone a connection.
    [
      'Meetup rejects our client credentials with 401',
      () => nockRefresh().reply(401, { error: 'invalid_client' }),
    ],
    [
      'Meetup rejects our client credentials with 400',
      () => nockRefresh().reply(400, { error: 'invalid_client' }),
    ],
    [
      'Meetup answers 400 without an OAuth error code',
      () => nockRefresh().reply(400, 'Bad Request'),
    ],
  ])(
    'shows the connect prompt but keeps the set when %s',
    async (_name, failRefresh) => {
      storeExpired();
      const before = fake.data.get(TOKEN_KEY);
      failRefresh();
      const interaction = slashInteraction();
      const commandFn = vi.fn();

      await expect(
        withMeetupClient(interaction, commandFn),
      ).resolves.toBeUndefined();

      // Nothing says the grant is dead, so the connection must survive for
      // the next attempt...
      expect(fake.data.get(TOKEN_KEY)).toBe(before);
      // ...without being mistaken for a fresh authorization in the meantime.
      expect(commandFn).not.toHaveBeenCalled();
      expect(replies(interaction)).toContain(
        'Please connect your Meetup account',
      );
    },
  );

  it('picks up a new authorization that lands while a kept set is waiting', async () => {
    storeExpired();
    nockRefresh().reply(503, 'unavailable');
    vi.mocked(waitForMeetupTokens).mockImplementationOnce(async (read, key) => {
      // The member finishes the OAuth hop: the callback replaces the set.
      storeTokens({
        accessToken: 'just-authorized',
        refreshToken: SECRETS.rotatedRefresh,
        expiresAt: Date.now() + HOUR_MS,
      });
      const rawTokens = await read(key);
      return rawTokens ? { status: 'ready', rawTokens } : { status: 'pending' };
    });
    const commandFn = vi.fn();

    await withMeetupClient(slashInteraction(), commandFn);

    expect(accessTokensSeenBy(commandFn)).toEqual(['just-authorized']);
  });

  it('runs the command on the refreshed token even when it cannot be stored', async () => {
    storeExpired();
    const before = fake.data.get(TOKEN_KEY);
    nockRefresh().reply(200, {
      access_token: SECRETS.newAccess,
      refresh_token: SECRETS.rotatedRefresh,
      expires_in: 3600,
    });
    fake.failure.nextSet = true;
    const interaction = slashInteraction();
    const commandFn = vi.fn();

    await withMeetupClient(interaction, commandFn);

    // The refresh worked; only the write did not. That is not a failed
    // refresh: the command runs, and nothing is deleted.
    expect(accessTokensSeenBy(commandFn)).toEqual([SECRETS.newAccess]);
    expect(interaction.editReply).not.toHaveBeenCalled();
    expect(fake.data.get(TOKEN_KEY)).toBe(before);
    expect(fake.logged.join('\n')).toMatch(/could not be stored/i);
    expect(fake.logged.join('\n')).not.toMatch(/could not refresh/i);
    expectNoSecretsIn(fake.logged.join('\n'));
  });

  it('does not delete a newer set stored while its own refresh was rejected', async () => {
    storeExpired();
    const newer = JSON.stringify({
      accessToken: 'from-the-other-dyno',
      refreshToken: SECRETS.rotatedRefresh,
      expiresAt: Date.now() + HOUR_MS,
    });
    // Deploy overlap: another process refreshed first, so this one's refresh
    // token is rejected -- after the winner has already stored its result.
    nockRefresh().reply(400, () => {
      fake.data.set(TOKEN_KEY, newer);
      return { error: 'invalid_grant' };
    });

    const interaction = slashInteraction();
    const commandFn = vi.fn();

    await withMeetupClient(interaction, commandFn);

    expect(fake.data.get(TOKEN_KEY)).toBe(newer);
    // And the member is not sent to the prompt while holding a good set.
    expect(accessTokensSeenBy(commandFn)).toEqual(['from-the-other-dyno']);
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it('uses a newer set stored while its own refresh was succeeding', async () => {
    storeExpired();
    const newer = JSON.stringify({
      accessToken: 'from-the-other-dyno',
      refreshToken: 'other-dyno-refresh',
      expiresAt: Date.now() + HOUR_MS,
    });
    nockRefresh().reply(200, () => {
      fake.data.set(TOKEN_KEY, newer);
      return {
        access_token: SECRETS.newAccess,
        refresh_token: SECRETS.rotatedRefresh,
        expires_in: 3600,
      };
    });
    const interaction = slashInteraction();
    const commandFn = vi.fn();

    await withMeetupClient(interaction, commandFn);

    // Whatever was stored last is the truth; it is neither overwritten nor
    // ignored.
    expect(fake.data.get(TOKEN_KEY)).toBe(newer);
    expect(accessTokensSeenBy(commandFn)).toEqual(['from-the-other-dyno']);
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it('picks up an authorization that lands while the connect prompt is being sent', async () => {
    storeExpired();
    nockRefresh().reply(503, 'unavailable');
    const interaction = slashInteraction();
    // The kept set must be noted BEFORE the prompt goes out: an authorization
    // finishing during that send is new, not the value to ignore.
    vi.mocked(interaction.editReply).mockImplementationOnce(() => {
      storeTokens({
        accessToken: 'just-authorized',
        refreshToken: 'fresh-grant',
        expiresAt: Date.now() + HOUR_MS,
      });
      return Promise.resolve(undefined as never);
    });
    const commandFn = vi.fn();

    await withMeetupClient(interaction, commandFn);

    expect(accessTokensSeenBy(commandFn)).toEqual(['just-authorized']);
  });

  it('does not write a connection back after it was forgotten mid-refresh', async () => {
    storeExpired();
    // A moderator runs /meetup_unlink while the refresh is in the air.
    nockRefresh().reply(200, () => {
      fake.data.delete(TOKEN_KEY);
      return {
        access_token: SECRETS.newAccess,
        refresh_token: SECRETS.rotatedRefresh,
        expires_in: 3600,
      };
    });
    const interaction = slashInteraction();
    const commandFn = vi.fn();

    await withMeetupClient(interaction, commandFn);

    expect(fake.data.has(TOKEN_KEY)).toBe(false);
    expect(commandFn).not.toHaveBeenCalled();
    expect(replies(interaction)).toContain(
      'Please connect your Meetup account',
    );
  });

  it('does not refresh again when a caller holding a stale read arrives after the refresh', async () => {
    storeExpired();
    const refresh = nockRefresh().reply(200, {
      access_token: SECRETS.newAccess,
      refresh_token: SECRETS.rotatedRefresh,
      expires_in: 3600,
    });
    // Caller B's first read is taken now (stale) but handed over only after
    // caller A has refreshed, stored, and left the in-flight map empty.
    const staleRead = fake.data.get(TOKEN_KEY);
    let releaseStaleRead: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      releaseStaleRead = resolve;
    });
    let firstRead = true;
    const cacheForB = {
      ...fake.cache,
      get: async (key: string) => {
        if (firstRead) {
          firstRead = false;
          await held;
          return staleRead;
        }
        return fake.cache.get(key);
      },
    };

    const callerB = getUsableMeetupTokens(cacheForB, 'u1');
    const tokensA = await getUsableMeetupTokens(fake.cache, 'u1');
    releaseStaleRead();
    const tokensB = await callerB;

    // A second request would find no interceptor and fail, leaving B empty.
    expect(refresh.isDone()).toBe(true);
    expect(tokensA?.accessToken).toBe(SECRETS.newAccess);
    expect(tokensB?.accessToken).toBe(SECRETS.newAccess);
    expect(storedTokens().refreshToken).toBe(SECRETS.rotatedRefresh);
  });

  it('falls back to the connect prompt when an expired set has no refresh token', async () => {
    storeTokens({
      accessToken: SECRETS.staleAccess,
      refreshToken: '',
      expiresAt: Date.now() - HOUR_MS,
    });
    const interaction = slashInteraction();
    const commandFn = vi.fn();

    await withMeetupClient(interaction, commandFn);

    expect(commandFn).not.toHaveBeenCalled();
    expect(replies(interaction)).toContain(
      'Please connect your Meetup account',
    );
  });

  it('never puts token values in logs or replies when a refresh succeeds', async () => {
    storeExpired();
    nockRefresh().reply(200, {
      access_token: SECRETS.newAccess,
      refresh_token: SECRETS.rotatedRefresh,
      expires_in: 3600,
    });
    const interaction = slashInteraction();
    const commandFn = vi.fn();

    await withMeetupClient(interaction, commandFn);

    // Guards against a vacuous pass: the refresh really happened.
    expect(accessTokensSeenBy(commandFn)).toEqual([SECRETS.newAccess]);
    expectNoSecretsIn(fake.logged.join('\n'));
    expectNoSecretsIn(replies(interaction));
  });

  it('never puts token values in logs or replies when a refresh fails', async () => {
    storeExpired();
    // A provider that echoes the request back in its error body.
    nockRefresh().reply(400, {
      error: 'invalid_grant',
      error_description: `refresh_token ${SECRETS.storedRefresh} is not valid`,
      access_token: SECRETS.staleAccess,
    });
    const interaction = slashInteraction();

    await withMeetupClient(interaction, vi.fn());

    // Guards against a vacuous pass: the failure was handled and reported.
    expect(replies(interaction)).toContain(
      'Please connect your Meetup account',
    );
    expect(fake.logged.join('\n')).toMatch(/refresh/i);
    expectNoSecretsIn(fake.logged.join('\n'));
    expectNoSecretsIn(replies(interaction));
  });
});
