import { Client } from 'discord.js';
import { ClientError } from 'graphql-request';
import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Configuration from '../../../src/configuration.js';
import { BASE_DISCORD_BOT_URL } from '../../../src/constants.js';
import { Tokens } from '../../../src/lib/client/discord/types.js';
import {
  MeetupTokenRefreshError,
  refreshMeetupToken,
} from '../../../src/lib/client/oauth/providers.js';
import { logAlert } from '../../../src/lib/helpers/discordLogger.js';
import {
  ORGANIZER_ACCOUNT_CHECK_TIMEOUT_MS,
  ORGANIZER_TOKEN_REUSE_MS,
  getOrganizerAccessToken,
  isMeetupUnauthorized,
  noteOrganizerCredentialRenewed,
  organizerFailureRemedy,
  resetOrganizerTokenStateForTest,
} from '../../../src/lib/helpers/organizerMeetupClient.js';
import { LockedCredential } from '../../../src/lib/repositories/postgresCredentialRepository.js';
import { ApplicationCredentialRepository } from '../../../src/util/credentialRepository.js';

const fake = vi.hoisted(() => ({
  logged: [] as string[],
  getSelfId: vi.fn(),
  /** Constructor arguments of every GqlMeetupClient, in order. */
  constructed: [] as unknown[][],
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

// The real MeetupTokenRefreshError: the seed gate tells rejections apart by it.
vi.mock(
  '../../../src/lib/client/oauth/providers.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../../../src/lib/client/oauth/providers.js')
    >()),
    refreshMeetupToken: vi.fn(),
  }),
);

vi.mock('../../../src/lib/helpers/discordLogger.js', () => ({
  logAlert: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../../src/lib/client/meetup/gqlClient.js', () => ({
  GqlMeetupClient: class {
    constructor(...args: unknown[]) {
      fake.constructed.push(args);
    }

    getSelfId = fake.getSelfId;
  },
}));

// A stand-in for the locked transaction: fn sees the stored state; a throw
// from fn is a rollback (nothing it did is kept), a return is a commit.
const db = {
  current: undefined as Tokens | undefined,
  memberId: null as string | null,
  failing: false,
  /** How many of the next COMMITs fail (the transaction's work is lost). */
  commitFails: 0,
  rolledBack: 0,
  /** Run one per locked call, in order, before fn: another process's work. */
  beforeLock: [] as Array<() => void>,
};

const locked = {
  write: vi.fn(async (tokens: Tokens) => {
    db.current = tokens;
  }),
  setMemberId: vi.fn(async (memberId: string) => {
    db.memberId = memberId;
  }),
  markFailing: vi.fn(async () => {
    const started = !db.failing;
    db.failing = true;
    return started;
  }),
  clearFailing: vi.fn(async () => {
    const wasOpen = db.failing;
    db.failing = false;
    return wasOpen;
  }),
  // A throw inside the savepoint undoes only the bookkeeping it did.
  savepoint: vi.fn(async <T>(_name: string, run: () => Promise<T>) => {
    const { memberId, failing } = db;
    try {
      return { ok: true as const, value: await run() };
    } catch (error: unknown) {
      Object.assign(db, { memberId, failing });
      return { ok: false as const, error };
    }
  }),
};

const credentials = {
  withLockedCredential: vi.fn(
    async <T>(
      _key: string,
      fn: (l: LockedCredential) => Promise<T>,
    ): Promise<T> => {
      db.beforeLock.shift()?.();
      const before = { ...db };
      let result: T;
      try {
        result = await fn({
          current: db.current,
          meta: { memberId: db.memberId, failingSince: null },
          ...(locked as unknown as Omit<LockedCredential, 'current' | 'meta'>),
        });
      } catch (error) {
        Object.assign(db, before);
        db.rolledBack += 1;
        throw error;
      }
      if (db.commitFails > 0) {
        Object.assign(db, before, { commitFails: db.commitFails - 1 });
        throw new Error('COMMIT failed: connection terminated');
      }
      return result;
    },
  ),
};

vi.mock('../../../src/util/credentialRepository.js', () => ({
  ApplicationCredentialRepository: vi.fn(async () => credentials),
  MEETUP_ORGANIZER_CREDENTIAL_KEY: 'meetup_organizer',
}));

const refresh = vi.mocked(refreshMeetupToken);
const alert = vi.mocked(logAlert);
const client = {} as Client;

const MINUTE = 60 * 1000;

/** Fixed text: no ids, no error. */
const SAVE_FAILED_ALERT = {
  title: 'Meetup organizer login could not be saved',
  description:
    'A renewed Meetup organizer login was obtained but could not be saved to the database. ' +
    'Identity monitoring uses it for this run; if the next daily sweep fails, renew it at ' +
    `${BASE_DISCORD_BOT_URL}/dashboard/organizer-login.`,
};

const stored = (expiresInMs: number, refreshToken = 'STORED-REFRESH') => ({
  accessToken: 'STORED-ACCESS',
  refreshToken,
  expiresAt: Date.now() + expiresInMs,
});

const fresh = (n = 1): Tokens => ({
  accessToken: `FRESH-ACCESS-${n}`,
  refreshToken: `FRESH-REFRESH-${n}`,
  expiresAt: Date.now() + 60 * MINUTE,
});

/** A refresh error whose message embeds a raw body, as the real one does. */
const refreshError = () =>
  new Error('Meetup token refresh failed: [400] RAW-BODY-SECRET');

/** Meetup's token endpoint answering `status`, optionally with an OAuth code. */
const rejection = (status: number, oauthError?: string) =>
  new MeetupTokenRefreshError(
    status,
    oauthError
      ? JSON.stringify({
          error: oauthError,
          error_description: 'RAW-BODY-SECRET',
        })
      : 'RAW-BODY-SECRET',
  );

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

beforeEach(() => {
  resetOrganizerTokenStateForTest();
  fake.logged.length = 0;
  Object.assign(db, {
    current: undefined,
    memberId: '468174923',
    failing: false,
    commitFails: 0,
    rolledBack: 0,
    beforeLock: [],
  });
  Configuration.meetup.organizerRefreshToken = 'SEED-REFRESH';
  Configuration.meetup.organizerMemberId = undefined;
  refresh.mockReset();
  alert.mockClear();
  fake.getSelfId.mockReset();
  fake.constructed.length = 0;
  // By default the token belongs to the recorded organizer account.
  fake.getSelfId.mockResolvedValue('468174923');
  vi.mocked(ApplicationCredentialRepository).mockImplementation(
    async () =>
      credentials as unknown as Awaited<
        ReturnType<typeof ApplicationCredentialRepository>
      >,
  );
  Object.values(locked).forEach((m) => m.mockClear());
  credentials.withLockedCredential.mockClear();
});

afterEach(() => {
  Configuration.meetup.organizerRefreshToken = undefined;
  Configuration.meetup.organizerMemberId = undefined;
});

describe('getOrganizerAccessToken', () => {
  it('reuses an access token with more than 5 minutes left', async () => {
    db.current = stored(ORGANIZER_TOKEN_REUSE_MS + MINUTE);

    await expect(getOrganizerAccessToken()).resolves.toBe('STORED-ACCESS');
    expect(refresh).not.toHaveBeenCalled();
    expect(locked.write).not.toHaveBeenCalled();
  });

  it('refreshes inside 5 minutes of expiry', async () => {
    db.current = stored(ORGANIZER_TOKEN_REUSE_MS - MINUTE);
    refresh.mockResolvedValueOnce(fresh());

    await expect(getOrganizerAccessToken()).resolves.toBe('FRESH-ACCESS-1');
    expect(refresh).toHaveBeenCalledWith('STORED-REFRESH');
    expect(db.current?.refreshToken).toBe('FRESH-REFRESH-1');
  });

  it('forceRefresh refreshes even when valid', async () => {
    db.current = stored(60 * MINUTE);
    refresh.mockResolvedValueOnce(fresh());

    await expect(getOrganizerAccessToken({ forceRefresh: true })).resolves.toBe(
      'FRESH-ACCESS-1',
    );
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('concurrent in-process callers share one refresh', async () => {
    db.current = stored(0);
    const pending = deferred<Tokens>();
    refresh.mockReturnValueOnce(pending.promise);

    const a = getOrganizerAccessToken();
    const b = getOrganizerAccessToken();
    pending.resolve(fresh());

    await expect(Promise.all([a, b])).resolves.toEqual([
      'FRESH-ACCESS-1',
      'FRESH-ACCESS-1',
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(credentials.withLockedCredential).toHaveBeenCalledTimes(1);
  });

  it('a forced call does not join an unforced one', async () => {
    db.current = stored(0);
    const first = deferred<Tokens>();
    refresh.mockReturnValueOnce(first.promise);
    refresh.mockResolvedValueOnce(fresh(2));

    const unforced = getOrganizerAccessToken();
    const forced = getOrganizerAccessToken({ forceRefresh: true });
    first.resolve(fresh(1));

    await expect(unforced).resolves.toBe('FRESH-ACCESS-1');
    await expect(forced).resolves.toBe('FRESH-ACCESS-2');
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('starts a new refresh once the shared one has settled', async () => {
    db.current = stored(0);
    refresh.mockResolvedValueOnce({ ...fresh(1), expiresAt: Date.now() });
    refresh.mockResolvedValueOnce(fresh(2));

    await getOrganizerAccessToken();
    await expect(getOrganizerAccessToken()).resolves.toBe('FRESH-ACCESS-2');
  });

  it('falls back to the config seed only when the stored refresh is rejected', async () => {
    db.current = stored(0);
    refresh.mockRejectedValueOnce(rejection(400, 'invalid_grant'));
    refresh.mockResolvedValueOnce(fresh());

    await expect(getOrganizerAccessToken()).resolves.toBe('FRESH-ACCESS-1');
    expect(refresh.mock.calls.map(([token]) => token)).toEqual([
      'STORED-REFRESH',
      'SEED-REFRESH',
    ]);

    // And never touches the seed when the stored one works.
    resetOrganizerTokenStateForTest();
    refresh.mockReset();
    db.current = stored(0, 'STORED-2');
    refresh.mockResolvedValueOnce(fresh(2));
    await getOrganizerAccessToken();
    expect(refresh.mock.calls.map(([token]) => token)).toEqual(['STORED-2']);
  });

  describe('the config seed is tried only after a definite rejection', () => {
    const triedTokens = () => refresh.mock.calls.map(([token]) => token);

    it('a timeout on the stored token never tries the seed', async () => {
      db.current = stored(0);
      refresh.mockRejectedValueOnce(
        new DOMException(
          'The operation was aborted due to timeout',
          'TimeoutError',
        ),
      );
      refresh.mockResolvedValue(fresh());

      await expect(
        getOrganizerAccessToken({ client }),
      ).resolves.toBeUndefined();
      expect(triedTokens()).toEqual(['STORED-REFRESH']);
      expect(db.current?.refreshToken).toBe('STORED-REFRESH');
      // A failure of this run like any other: the episode opens.
      expect(db.failing).toBe(true);
      expect(alert).toHaveBeenCalledTimes(1);
    });

    it('a network error on the stored token never tries the seed', async () => {
      db.current = stored(0);
      refresh.mockRejectedValueOnce(new TypeError('fetch failed'));
      refresh.mockResolvedValue(fresh());

      await expect(getOrganizerAccessToken()).resolves.toBeUndefined();
      expect(triedTokens()).toEqual(['STORED-REFRESH']);
    });

    it('a 5xx on the stored token never tries the seed', async () => {
      db.current = stored(0);
      refresh.mockRejectedValueOnce(rejection(503));
      refresh.mockResolvedValue(fresh());

      await expect(getOrganizerAccessToken()).resolves.toBeUndefined();
      expect(triedTokens()).toEqual(['STORED-REFRESH']);
    });

    it('a 429 on the stored token never tries the seed', async () => {
      db.current = stored(0);
      refresh.mockRejectedValueOnce(rejection(429));
      refresh.mockResolvedValue(fresh());

      await expect(getOrganizerAccessToken()).resolves.toBeUndefined();
      expect(triedTokens()).toEqual(['STORED-REFRESH']);
    });

    it('a 400 with no OAuth code never tries the seed', async () => {
      db.current = stored(0);
      refresh.mockRejectedValueOnce(rejection(400));
      refresh.mockResolvedValue(fresh());

      await expect(getOrganizerAccessToken()).resolves.toBeUndefined();
      expect(triedTokens()).toEqual(['STORED-REFRESH']);
    });

    it('an AbortError never tries the seed', async () => {
      db.current = stored(0);
      refresh.mockRejectedValueOnce(
        new DOMException('This operation was aborted', 'AbortError'),
      );
      refresh.mockResolvedValue(fresh());

      await expect(getOrganizerAccessToken()).resolves.toBeUndefined();
      expect(triedTokens()).toEqual(['STORED-REFRESH']);
    });

    it('invalid_client never tries the seed', async () => {
      db.current = stored(0);
      refresh.mockRejectedValueOnce(rejection(401, 'invalid_client'));
      refresh.mockResolvedValue(fresh());

      await expect(getOrganizerAccessToken()).resolves.toBeUndefined();
      expect(triedTokens()).toEqual(['STORED-REFRESH']);
    });

    it('invalid_grant on the stored token tries the seed', async () => {
      db.current = stored(0);
      refresh.mockRejectedValueOnce(rejection(400, 'invalid_grant'));
      refresh.mockResolvedValueOnce(fresh());

      await expect(getOrganizerAccessToken()).resolves.toBe('FRESH-ACCESS-1');
      expect(triedTokens()).toEqual(['STORED-REFRESH', 'SEED-REFRESH']);
      expect(db.current?.refreshToken).toBe('FRESH-REFRESH-1');
    });

    it('a bare 401 on the stored token tries the seed', async () => {
      db.current = stored(0);
      refresh.mockRejectedValueOnce(rejection(401));
      refresh.mockResolvedValueOnce(fresh());

      await expect(getOrganizerAccessToken()).resolves.toBe('FRESH-ACCESS-1');
      expect(triedTokens()).toEqual(['STORED-REFRESH', 'SEED-REFRESH']);
    });

    it('with no stored token the seed is used', async () => {
      refresh.mockResolvedValueOnce(fresh());

      await expect(getOrganizerAccessToken()).resolves.toBe('FRESH-ACCESS-1');
      expect(triedTokens()).toEqual(['SEED-REFRESH']);
      expect(db.current?.accessToken).toBe('FRESH-ACCESS-1');
    });

    it('never logs the raw refresh error body', async () => {
      db.current = stored(0);
      refresh.mockRejectedValue(rejection(400, 'invalid_grant'));

      await getOrganizerAccessToken();
      const logged = fake.logged.join('\n');
      expect(logged).toContain('HTTP 400 invalid_grant');
      expect(logged).not.toContain('RAW-BODY-SECRET');
    });
  });

  it('tries an identical stored token and seed only once', async () => {
    db.current = stored(0, 'SEED-REFRESH');
    refresh.mockRejectedValue(rejection(400, 'invalid_grant'));

    await expect(getOrganizerAccessToken()).resolves.toBeUndefined();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('persist failure keeps the fresh token for this run', async () => {
    db.current = stored(0);
    refresh.mockResolvedValueOnce(fresh());
    db.failing = true;
    // Both the write and its one retry fail.
    locked.write.mockRejectedValueOnce(new Error('write failed'));
    locked.write.mockRejectedValueOnce(new Error('write failed'));

    await expect(getOrganizerAccessToken({ client })).resolves.toBe(
      'FRESH-ACCESS-1',
    );
    // The token transaction returned rather than threw; only the retry,
    // whose write threw too, rolled back.
    expect(db.rolledBack).toBe(1);
    // Postgres aborted the transaction at the failed write, so the episode
    // is not touched: no recovery message, only the could-not-be-saved one.
    expect(locked.clearFailing).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(client, SAVE_FAILED_ALERT);
    expect(fake.logged.join('\n')).toMatch(/refreshed but could NOT be stored/);
    // Only the first candidate: a persist failure is not a refresh failure.
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(db.current?.refreshToken).toBe('STORED-REFRESH');
  });

  describe('a refreshed token survives a failed save', () => {
    it('a failed write after refresh is retried once with compare-and-set', async () => {
      db.current = stored(0);
      refresh.mockResolvedValueOnce(fresh(1));
      locked.write.mockRejectedValueOnce(new Error('write failed'));

      await expect(getOrganizerAccessToken({ client })).resolves.toBe(
        'FRESH-ACCESS-1',
      );
      expect(credentials.withLockedCredential).toHaveBeenCalledTimes(2);
      expect(locked.write).toHaveBeenCalledTimes(2);
      expect(db.current?.refreshToken).toBe('FRESH-REFRESH-1');
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(fake.logged.join('\n')).toMatch(/stored on the retry/);
    });

    it('the retry does not overwrite a token another process already advanced', async () => {
      db.current = stored(0);
      refresh.mockResolvedValueOnce(fresh(1));
      locked.write.mockRejectedValueOnce(new Error('write failed'));
      const advanced = { ...fresh(7), refreshToken: 'ADVANCED-ELSEWHERE' };
      db.beforeLock.push(
        () => undefined,
        () => {
          db.current = advanced;
        },
      );

      await expect(getOrganizerAccessToken({ client })).resolves.toBe(
        'FRESH-ACCESS-1',
      );
      expect(credentials.withLockedCredential).toHaveBeenCalledTimes(2);
      expect(locked.write).toHaveBeenCalledTimes(1); // only the failed one
      expect(db.current).toEqual(advanced);
      expect(fake.logged.join('\n')).toMatch(/already advanced/);
    });

    it('the retry does not overwrite a newer pair with the same refresh token', async () => {
      // e.g. Meetup did not rotate, and another process refreshed meanwhile:
      // same refresh token, newer access token. Its pair wins.
      db.current = stored(0);
      refresh.mockResolvedValueOnce(fresh(1));
      locked.write.mockRejectedValueOnce(new Error('write failed'));
      const newer = {
        accessToken: 'NEWER-ACCESS',
        refreshToken: 'STORED-REFRESH',
        expiresAt: Date.now() + 60 * MINUTE,
      };
      db.beforeLock.push(
        () => undefined,
        () => {
          db.current = newer;
        },
      );

      await expect(getOrganizerAccessToken({ client })).resolves.toBe(
        'FRESH-ACCESS-1',
      );
      expect(locked.write).toHaveBeenCalledTimes(1); // only the failed one
      expect(db.current).toEqual(newer);
      expect(fake.logged.join('\n')).toMatch(/already advanced/);
    });

    it('a failed COMMIT after refresh is retried once', async () => {
      db.current = stored(0);
      db.commitFails = 1;
      refresh.mockResolvedValueOnce(fresh(1));

      await expect(getOrganizerAccessToken({ client })).resolves.toBe(
        'FRESH-ACCESS-1',
      );
      expect(credentials.withLockedCredential).toHaveBeenCalledTimes(2);
      expect(db.current?.refreshToken).toBe('FRESH-REFRESH-1');
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('a retry after a seed refresh with nothing stored writes it', async () => {
      db.commitFails = 1;
      refresh.mockResolvedValueOnce(fresh(1));

      await expect(getOrganizerAccessToken()).resolves.toBe('FRESH-ACCESS-1');
      expect(db.current?.refreshToken).toBe('FRESH-REFRESH-1');
    });

    it('a failed retry is logged and the fresh token still returned', async () => {
      db.current = stored(0);
      db.commitFails = 2;
      refresh.mockResolvedValueOnce(fresh(1));

      await expect(getOrganizerAccessToken({ client })).resolves.toBe(
        'FRESH-ACCESS-1',
      );
      expect(credentials.withLockedCredential).toHaveBeenCalledTimes(2);
      expect(db.current?.refreshToken).toBe('STORED-REFRESH');
      expect(fake.logged.join('\n')).toMatch(/retry .*failed/i);
      expect(alert).toHaveBeenCalledTimes(1);
      expect(alert).toHaveBeenCalledWith(client, SAVE_FAILED_ALERT);
    });

    it('posts the could-not-be-saved alert when the retry write fails', async () => {
      db.current = stored(0);
      refresh.mockResolvedValueOnce(fresh(1));
      locked.write.mockRejectedValueOnce(new Error('write failed'));
      locked.write.mockRejectedValueOnce(new Error('write failed'));

      await expect(getOrganizerAccessToken({ client })).resolves.toBe(
        'FRESH-ACCESS-1',
      );
      expect(alert).toHaveBeenCalledTimes(1);
      expect(alert).toHaveBeenCalledWith(client, SAVE_FAILED_ALERT);
      // Not an episode: nothing is recorded, and every failure posts.
      expect(locked.markFailing).not.toHaveBeenCalled();
      expect(db.failing).toBe(false);

      resetOrganizerTokenStateForTest();
      refresh.mockResolvedValueOnce(fresh(2));
      locked.write.mockRejectedValueOnce(new Error('write failed'));
      locked.write.mockRejectedValueOnce(new Error('write failed'));
      await getOrganizerAccessToken({ client, forceRefresh: true });
      expect(alert).toHaveBeenCalledTimes(2);
    });

    it('no alert when the retry is skipped because another process advanced the pair', async () => {
      db.current = stored(0);
      refresh.mockResolvedValueOnce(fresh(1));
      locked.write.mockRejectedValueOnce(new Error('write failed'));
      db.beforeLock.push(
        () => undefined,
        () => {
          db.current = { ...fresh(7), refreshToken: 'ADVANCED-ELSEWHERE' };
        },
      );

      await expect(getOrganizerAccessToken({ client })).resolves.toBe(
        'FRESH-ACCESS-1',
      );
      expect(fake.logged.join('\n')).toMatch(/already advanced/);
      expect(alert).not.toHaveBeenCalled();
    });

    it('client-less: a failed retry logs only', async () => {
      db.current = stored(0);
      refresh.mockResolvedValueOnce(fresh(1));
      locked.write.mockRejectedValueOnce(new Error('write failed'));
      locked.write.mockRejectedValueOnce(new Error('write failed'));

      await expect(getOrganizerAccessToken()).resolves.toBe('FRESH-ACCESS-1');
      expect(alert).not.toHaveBeenCalled();
      expect(fake.logged.join('\n')).toMatch(/retry .*failed/i);
    });

    it('a bookkeeping failure does not lose the credential write', async () => {
      db.current = stored(0);
      db.failing = true;
      db.memberId = null;
      refresh.mockResolvedValueOnce(fresh(1));
      locked.clearFailing.mockRejectedValueOnce(new Error('meta write failed'));

      await expect(getOrganizerAccessToken({ client })).resolves.toBe(
        'FRESH-ACCESS-1',
      );
      // Written first; the bookkeeping ran after it, inside a savepoint.
      expect(locked.write.mock.invocationCallOrder[0]).toBeLessThan(
        locked.savepoint.mock.invocationCallOrder[0],
      );
      expect(db.current?.refreshToken).toBe('FRESH-REFRESH-1');
      expect(credentials.withLockedCredential).toHaveBeenCalledTimes(1);
      // The episode close was undone with its savepoint: no recovery post.
      expect(db.failing).toBe(true);
      expect(alert).not.toHaveBeenCalled();
    });
  });

  it('keeps the fresh token when the transaction fails to commit', async () => {
    db.current = stored(0);
    db.commitFails = 2; // the commit and its retry
    refresh.mockResolvedValueOnce(fresh());

    await expect(getOrganizerAccessToken({ client })).resolves.toBe(
      'FRESH-ACCESS-1',
    );
    expect(fake.logged.join('\n')).toMatch(/could NOT be stored/);
    // Episode state is unknown, so no episode post: only the one-off
    // could-not-be-saved alert for the failed retry.
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(client, SAVE_FAILED_ALERT);
  });

  it('returns undefined when the lock cannot be taken and nothing was refreshed', async () => {
    credentials.withLockedCredential.mockRejectedValueOnce(
      new Error('lock timeout'),
    );

    await expect(getOrganizerAccessToken({ client })).resolves.toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('returns undefined without DATABASE_URL', async () => {
    vi.mocked(ApplicationCredentialRepository).mockResolvedValueOnce(undefined);

    await expect(getOrganizerAccessToken({ client })).resolves.toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it('records the failure inside the locked transaction, which commits', async () => {
    db.current = stored(0);
    refresh.mockRejectedValue(refreshError());

    await expect(getOrganizerAccessToken({ client })).resolves.toBeUndefined();
    expect(locked.markFailing).toHaveBeenCalledTimes(1);
    expect(db.failing).toBe(true);
    expect(db.rolledBack).toBe(0);
    expect(fake.logged.join('\n')).toMatch(/No usable Meetup credential/);
  });

  it('alerts once per failure episode', async () => {
    db.current = stored(0);
    refresh.mockRejectedValue(refreshError());

    await getOrganizerAccessToken({ client });
    await getOrganizerAccessToken({ client });

    expect(locked.markFailing).toHaveBeenCalledTimes(2);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(client, {
      title: 'Meetup identity monitoring is not running',
      description: organizerFailureRemedy(),
    });
  });

  it('a 200 with no access token is an unusable credential: alert, no seed, nothing stored', async () => {
    db.current = stored(0);
    // The real refresh, against a token endpoint that answers 200 without
    // an access token.
    const actual = await vi.importActual<
      typeof import('../../../src/lib/client/oauth/providers.js')
    >('../../../src/lib/client/oauth/providers.js');
    refresh.mockImplementation(actual.refreshMeetupToken);
    nock('https://secure.meetup.com')
      .post('/oauth2/access')
      .reply(200, { refresh_token: 'ROTATED-REFRESH', expires_in: 3600 });

    try {
      await expect(
        getOrganizerAccessToken({ client }),
      ).resolves.toBeUndefined();
    } finally {
      nock.cleanAll();
    }

    expect(refresh.mock.calls.map(([token]) => token)).toEqual([
      'STORED-REFRESH',
    ]);
    expect(locked.write).not.toHaveBeenCalled();
    expect(db.current?.refreshToken).toBe('STORED-REFRESH');
    expect(db.current?.accessToken).toBe('STORED-ACCESS');
    expect(db.failing).toBe(true);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(client, {
      title: 'Meetup identity monitoring is not running',
      description: organizerFailureRemedy(),
    });
    expect(fake.logged.join('\n')).toMatch(/MeetupTokenResponseError/);
  });

  it('alerts when there is no credential at all', async () => {
    Configuration.meetup.organizerRefreshToken = undefined;

    await expect(getOrganizerAccessToken({ client })).resolves.toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it('posts one recovery message when it works again', async () => {
    db.current = stored(0);
    db.failing = true;
    refresh.mockResolvedValue(fresh());

    await getOrganizerAccessToken({ client });
    resetOrganizerTokenStateForTest();
    await getOrganizerAccessToken({ client, forceRefresh: true });

    expect(locked.clearFailing).toHaveBeenCalledTimes(2);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(client, {
      title: 'Meetup organizer login restored',
      description:
        'The shared Meetup organizer credential works again; Meetup identity monitoring resumes with the next sweep.',
    });
  });

  it('reusing a stored token does not close an open episode', async () => {
    // Only a successful refresh proves the grant works: a reused token may
    // be the very one Meetup just refused.
    db.current = stored(60 * MINUTE);
    db.failing = true;

    await expect(getOrganizerAccessToken({ client })).resolves.toBe(
      'STORED-ACCESS',
    );

    expect(locked.clearFailing).not.toHaveBeenCalled();
    expect(db.failing).toBe(true);
    expect(alert).not.toHaveBeenCalled();
  });

  it('a forced refresh reuses a token another process already rotated', async () => {
    db.current = stored(60 * MINUTE);

    await expect(
      getOrganizerAccessToken({
        forceRefresh: true,
        refusedAccessToken: 'OLD-ACCESS',
      }),
    ).resolves.toBe('STORED-ACCESS');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a forced refresh still refreshes when the stored token is the refused one', async () => {
    db.current = stored(60 * MINUTE);
    refresh.mockResolvedValueOnce(fresh());

    await expect(
      getOrganizerAccessToken({
        forceRefresh: true,
        refusedAccessToken: 'STORED-ACCESS',
      }),
    ).resolves.toBe('FRESH-ACCESS-1');
    expect(refresh).toHaveBeenCalledWith('STORED-REFRESH');
  });

  it('a forced refresh refreshes a rotated token inside the 5-minute window', async () => {
    db.current = stored(ORGANIZER_TOKEN_REUSE_MS - MINUTE);
    refresh.mockResolvedValueOnce(fresh());

    await expect(
      getOrganizerAccessToken({
        forceRefresh: true,
        refusedAccessToken: 'OLD-ACCESS',
      }),
    ).resolves.toBe('FRESH-ACCESS-1');
  });

  it('a failed forced refresh is not followed by a false recovery', async () => {
    // Grant revoked: the stored token is unexpired but Meetup refuses it.
    db.current = stored(60 * MINUTE);
    refresh.mockRejectedValue(refreshError());

    await expect(
      getOrganizerAccessToken({
        client,
        forceRefresh: true,
        refusedAccessToken: 'STORED-ACCESS',
      }),
    ).resolves.toBeUndefined();
    expect(alert).toHaveBeenCalledTimes(1); // the episode alert

    // The next sweeps reuse the still-unexpired, refused token.
    await getOrganizerAccessToken({ client });
    await getOrganizerAccessToken({ client });

    expect(db.failing).toBe(true);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][1].title).toBe(
      'Meetup identity monitoring is not running',
    );
  });

  it('logs instead of alerting without a client', async () => {
    db.current = stored(0);
    refresh.mockRejectedValue(refreshError());

    await getOrganizerAccessToken();
    await getOrganizerAccessToken();

    expect(alert).not.toHaveBeenCalled();
    const remedies = fake.logged.filter((line) =>
      line.includes(organizerFailureRemedy()),
    );
    expect(remedies).toHaveLength(2);
  });

  it("a client-less failure does not suppress the next sweep's alert", async () => {
    db.current = stored(0);
    refresh.mockRejectedValue(refreshError());

    // A script run (no Discord client) fails first: it logs the remedy but
    // leaves the episode alone.
    await expect(getOrganizerAccessToken()).resolves.toBeUndefined();
    expect(locked.markFailing).not.toHaveBeenCalled();
    expect(db.failing).toBe(false);
    expect(
      fake.logged.filter((line) => line.includes(organizerFailureRemedy())),
    ).toHaveLength(1);

    // So the sweep that follows still opens the episode and alerts.
    await expect(getOrganizerAccessToken({ client })).resolves.toBeUndefined();
    expect(db.failing).toBe(true);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][1].title).toBe(
      'Meetup identity monitoring is not running',
    );
  });

  it('a call with a client never joins a client-less one', async () => {
    db.current = stored(0);
    refresh.mockRejectedValue(refreshError());

    const script = getOrganizerAccessToken();
    const sweep = getOrganizerAccessToken({ client });
    await expect(Promise.all([script, sweep])).resolves.toEqual([
      undefined,
      undefined,
    ]);

    expect(credentials.withLockedCredential).toHaveBeenCalledTimes(2);
    expect(db.failing).toBe(true);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it('a client-less success does not consume the recovery post', async () => {
    db.current = stored(0);
    db.failing = true;
    refresh.mockResolvedValueOnce(fresh(1));

    await expect(getOrganizerAccessToken()).resolves.toBe('FRESH-ACCESS-1');
    expect(locked.clearFailing).not.toHaveBeenCalled();
    expect(db.failing).toBe(true);
    expect(db.current?.refreshToken).toBe('FRESH-REFRESH-1');

    // The next refresh with a client closes the episode and says so.
    db.current = { ...fresh(1), expiresAt: Date.now() };
    refresh.mockResolvedValueOnce(fresh(2));
    await expect(getOrganizerAccessToken({ client })).resolves.toBe(
      'FRESH-ACCESS-2',
    );
    expect(db.failing).toBe(false);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][1].title).toBe(
      'Meetup organizer login restored',
    );
  });

  it('a failed alert post is retried on the next run', async () => {
    db.current = stored(0);
    refresh.mockRejectedValue(refreshError());
    alert.mockResolvedValueOnce(false); // Discord refused the post

    await expect(getOrganizerAccessToken({ client })).resolves.toBeUndefined();
    expect(alert).toHaveBeenCalledTimes(1);
    // Re-opened: the episode is not left marked as alerted.
    expect(db.failing).toBe(false);
    expect(fake.logged.join('\n')).toMatch(/alert could not be posted/);

    await expect(getOrganizerAccessToken({ client })).resolves.toBeUndefined();
    expect(alert).toHaveBeenCalledTimes(2);
    expect(alert.mock.calls[1][1].title).toBe(
      'Meetup identity monitoring is not running',
    );
    expect(db.failing).toBe(true);

    // Posted now, so the episode stays open and quiet.
    await getOrganizerAccessToken({ client });
    expect(alert).toHaveBeenCalledTimes(2);
  });

  it('a failed recovery post is retried on the next refresh', async () => {
    db.current = stored(0);
    db.failing = true;
    refresh.mockResolvedValueOnce(fresh(1));
    alert.mockResolvedValueOnce(false);

    await expect(getOrganizerAccessToken({ client })).resolves.toBe(
      'FRESH-ACCESS-1',
    );
    expect(alert).toHaveBeenCalledTimes(1);
    expect(db.failing).toBe(true); // re-marked, so the post is owed still
    expect(fake.logged.join('\n')).toMatch(/recovery could not be posted/);

    db.current = { ...fresh(1), expiresAt: Date.now() };
    refresh.mockResolvedValueOnce(fresh(2));
    await getOrganizerAccessToken({ client });
    expect(alert).toHaveBeenCalledTimes(2);
    expect(alert.mock.calls[1][1].title).toBe(
      'Meetup organizer login restored',
    );
    expect(db.failing).toBe(false);
  });

  it('swallows a failure to record the episode', async () => {
    db.current = stored(0);
    refresh.mockRejectedValue(refreshError());
    locked.markFailing.mockRejectedValueOnce(new Error('meta write failed'));

    await expect(getOrganizerAccessToken({ client })).resolves.toBeUndefined();
    expect(alert).not.toHaveBeenCalled();
  });

  it('swallows a failure to post the alert', async () => {
    db.current = stored(0);
    refresh.mockRejectedValue(refreshError());
    alert.mockRejectedValueOnce(new Error('discord down'));

    await expect(getOrganizerAccessToken({ client })).resolves.toBeUndefined();
  });

  it('alert text links the renew page and never includes the error body', async () => {
    db.current = stored(0);
    refresh.mockRejectedValue(refreshError());

    await getOrganizerAccessToken({ client });

    expect(organizerFailureRemedy()).toContain(
      `${BASE_DISCORD_BOT_URL}/dashboard/organizer-login`,
    );
    expect(organizerFailureRemedy()).toBe(
      'Could not obtain a Meetup organizer token, so Meetup identity monitoring is paused. ' +
        `To fix: a Moderator or 1.5 Leadership Team member opens ${BASE_DISCORD_BOT_URL}/dashboard/organizer-login ` +
        'in a private window, signs in with Discord, then signs in to Meetup as the shared organizer account. ' +
        '(Fallback: /meetup_get_token sweep_credential:True and set MEETUP_ORGANIZER_REFRESH_TOKEN in Heroku.) ' +
        'Do not use a personal Meetup account.',
    );
    expect(JSON.stringify(alert.mock.calls)).not.toContain('RAW-BODY-SECRET');
  });

  it('records the member id when none is stored', async () => {
    db.current = stored(60 * MINUTE);
    db.memberId = null;
    fake.getSelfId.mockResolvedValueOnce('468174923');

    await expect(getOrganizerAccessToken()).resolves.toBe('STORED-ACCESS');
    expect(db.memberId).toBe('468174923');
    // Its own short locked call, after the token transaction committed.
    expect(credentials.withLockedCredential).toHaveBeenCalledTimes(2);
  });

  it('records the member id only when it matches MEETUP_ORGANIZER_MEMBER_ID', async () => {
    db.current = stored(60 * MINUTE);
    db.memberId = null;
    Configuration.meetup.organizerMemberId = '468174923';
    fake.getSelfId.mockResolvedValueOnce('468174923');

    await expect(getOrganizerAccessToken({ client })).resolves.toBe(
      'STORED-ACCESS',
    );
    expect(db.memberId).toBe('468174923');
    expect(alert).not.toHaveBeenCalled();
  });

  describe('the account of a refreshed token is checked before it is stored', () => {
    const OTHER = '999000111';
    const ORGANIZER = '468174923';
    const unchangedRow = () => ({
      accessToken: 'STORED-ACCESS',
      refreshToken: 'STORED-REFRESH',
    });
    const idsShown = () =>
      JSON.stringify(alert.mock.calls) + fake.logged.join('\n');

    it('a different account stores nothing', async () => {
      db.current = stored(0);
      refresh.mockResolvedValueOnce(fresh(1));
      fake.getSelfId.mockResolvedValue(OTHER);

      await expect(getOrganizerAccessToken()).resolves.toBeUndefined();

      // The TOKEN ROW is unchanged, not only the member id.
      expect(locked.write).not.toHaveBeenCalled();
      expect(db.current).toMatchObject(unchangedRow());
      expect(locked.setMemberId).not.toHaveBeenCalled();
      expect(db.memberId).toBe(ORGANIZER);
      // Client-less: logged, and the episode is left alone.
      expect(locked.markFailing).not.toHaveBeenCalled();
      expect(fake.logged.join('\n')).toMatch(/different account/);
      expect(idsShown()).not.toContain(OTHER);
      expect(idsShown()).not.toContain(ORGANIZER);
    });

    it('a wrong account after refresh is not used and opens the failure episode with the wrong-account alert', async () => {
      db.current = stored(0);
      refresh.mockResolvedValueOnce(fresh(1));
      fake.getSelfId.mockResolvedValue(OTHER);

      await expect(
        getOrganizerAccessToken({ client }),
      ).resolves.toBeUndefined();

      expect(locked.write).not.toHaveBeenCalled();
      expect(db.current).toMatchObject(unchangedRow());
      expect(db.failing).toBe(true);
      expect(alert).toHaveBeenCalledTimes(1);
      expect(alert).toHaveBeenCalledWith(client, {
        title: 'Meetup identity monitoring is not running',
        description:
          'The shared Meetup organizer credential now belongs to a different Meetup account than the one on record, ' +
          'so it was not saved or used. ' +
          `Renew it from ${BASE_DISCORD_BOT_URL}/dashboard/organizer-login while signed in to Meetup as the shared organizer account.`,
      });
      expect(idsShown()).not.toContain(OTHER);
      expect(idsShown()).not.toContain(ORGANIZER);

      // The episode is open and alerted: the next run stays quiet.
      refresh.mockResolvedValueOnce(fresh(2));
      await expect(
        getOrganizerAccessToken({ client }),
      ).resolves.toBeUndefined();
      expect(alert).toHaveBeenCalledTimes(1);
    });

    it('a seed of a different account stores nothing', async () => {
      db.current = stored(0);
      refresh.mockRejectedValueOnce(rejection(400, 'invalid_grant'));
      refresh.mockResolvedValueOnce(fresh(1));
      fake.getSelfId.mockResolvedValue(OTHER);

      await expect(
        getOrganizerAccessToken({ client }),
      ).resolves.toBeUndefined();
      expect(refresh.mock.calls.map(([token]) => token)).toEqual([
        'STORED-REFRESH',
        'SEED-REFRESH',
      ]);
      expect(locked.write).not.toHaveBeenCalled();
      expect(db.current).toMatchObject(unchangedRow());
      expect(alert.mock.calls[0][1].description).toMatch(
        /different Meetup account/,
      );
    });

    it('a seed checked against MEETUP_ORGANIZER_MEMBER_ID when nothing is recorded', async () => {
      db.memberId = null;
      Configuration.meetup.organizerMemberId = ORGANIZER;
      refresh.mockResolvedValueOnce(fresh(1));
      fake.getSelfId.mockResolvedValue(OTHER);

      await expect(getOrganizerAccessToken()).resolves.toBeUndefined();
      expect(db.current).toBeUndefined();
      expect(db.memberId).toBeNull();
    });

    it('a matching seed is stored and its member id recorded', async () => {
      db.memberId = null;
      Configuration.meetup.organizerMemberId = ORGANIZER;
      refresh.mockResolvedValueOnce(fresh(1));

      await expect(getOrganizerAccessToken()).resolves.toBe('FRESH-ACCESS-1');
      expect(db.current?.refreshToken).toBe('FRESH-REFRESH-1');
      expect(db.memberId).toBe(ORGANIZER);
      // Recorded inside the token transaction; the token is not looked up again.
      expect(credentials.withLockedCredential).toHaveBeenCalledTimes(1);
      expect(fake.getSelfId).toHaveBeenCalledTimes(1);
    });

    it('the account check after a refresh uses a short timeout', async () => {
      db.current = stored(0);
      refresh.mockResolvedValueOnce(fresh(1));

      await getOrganizerAccessToken();
      expect(ORGANIZER_ACCOUNT_CHECK_TIMEOUT_MS).toBe(10_000);
      expect(fake.constructed).toEqual([
        ['FRESH-ACCESS-1', { timeoutMs: ORGANIZER_ACCOUNT_CHECK_TIMEOUT_MS }],
      ]);
    });

    it('a lookup failure after refreshing the stored token still saves and uses it', async () => {
      // Same grant as the one on record: a lookup hiccup must not discard a
      // freshly rotated token.
      db.current = stored(0);
      refresh.mockResolvedValueOnce(fresh(1));
      fake.getSelfId.mockRejectedValue(new Error('meetup 503 RAW-BODY-SECRET'));

      await expect(getOrganizerAccessToken({ client })).resolves.toBe(
        'FRESH-ACCESS-1',
      );
      expect(db.current?.refreshToken).toBe('FRESH-REFRESH-1');
      expect(db.memberId).toBe(ORGANIZER);
      expect(alert).not.toHaveBeenCalled();
      const logged = fake.logged.join('\n');
      expect(logged).toMatch(/Could not confirm the account/);
      expect(logged).not.toContain('RAW-BODY-SECRET');
    });

    it('a lookup failure after a seed refresh stores nothing', async () => {
      db.current = stored(0);
      refresh.mockRejectedValueOnce(rejection(400, 'invalid_grant'));
      refresh.mockResolvedValueOnce(fresh(1));
      fake.getSelfId.mockRejectedValue(new Error('timeout'));

      await expect(
        getOrganizerAccessToken({ client }),
      ).resolves.toBeUndefined();
      expect(locked.write).not.toHaveBeenCalled();
      expect(db.current).toMatchObject(unchangedRow());
      expect(db.failing).toBe(true);
      expect(alert).toHaveBeenCalledTimes(1);
      expect(alert).toHaveBeenCalledWith(client, {
        title: 'Meetup identity monitoring is not running',
        description:
          'Could not confirm which Meetup account the refreshed Meetup organizer credential belongs to, ' +
          'so it was not saved or used, and Meetup identity monitoring was skipped this time. ' +
          'It retries on the next run; if this keeps happening, renew it ' +
          `from ${BASE_DISCORD_BOT_URL}/dashboard/organizer-login while signed in to Meetup as the shared organizer account.`,
      });
    });

    it('a lookup failure with no member id on record stores nothing', async () => {
      db.current = stored(0);
      db.memberId = null;
      Configuration.meetup.organizerMemberId = ORGANIZER;
      refresh.mockResolvedValueOnce(fresh(1));
      fake.getSelfId.mockRejectedValue(new Error('timeout'));

      await expect(getOrganizerAccessToken()).resolves.toBeUndefined();
      expect(locked.write).not.toHaveBeenCalled();
      expect(db.current).toMatchObject(unchangedRow());
      expect(db.memberId).toBeNull();
      // Client-less: logged only, the episode left alone.
      expect(locked.markFailing).not.toHaveBeenCalled();
      expect(fake.logged.join('\n')).toMatch(
        /could not confirm which Meetup account/i,
      );
    });

    it('bootstrap with no expected id stores as observed', async () => {
      db.current = stored(0);
      db.memberId = null;
      refresh.mockResolvedValueOnce(fresh(1));
      fake.getSelfId.mockResolvedValue(OTHER);

      await expect(getOrganizerAccessToken({ client })).resolves.toBe(
        'FRESH-ACCESS-1',
      );
      expect(db.current?.refreshToken).toBe('FRESH-REFRESH-1');
      expect(db.memberId).toBe(OTHER);
      expect(alert).not.toHaveBeenCalled();
    });

    it('bootstrap still stores when the lookup fails, recording nothing', async () => {
      db.current = stored(0);
      db.memberId = null;
      refresh.mockResolvedValueOnce(fresh(1));
      fake.getSelfId.mockRejectedValue(new Error('timeout'));

      await expect(getOrganizerAccessToken()).resolves.toBe('FRESH-ACCESS-1');
      expect(db.current?.refreshToken).toBe('FRESH-REFRESH-1');
      expect(db.memberId).toBeNull();
    });

    it('a stored token of the wrong account is not reused', async () => {
      db.current = stored(60 * MINUTE);
      fake.getSelfId.mockResolvedValue(OTHER);

      // Client-less: logged, not used, episode left alone.
      await expect(getOrganizerAccessToken()).resolves.toBeUndefined();
      expect(locked.markFailing).not.toHaveBeenCalled();
      expect(fake.logged.join('\n')).toMatch(/different account/);

      // With a client: the episode opens and its alert is posted once.
      await expect(
        getOrganizerAccessToken({ client }),
      ).resolves.toBeUndefined();
      await expect(
        getOrganizerAccessToken({ client }),
      ).resolves.toBeUndefined();
      expect(db.failing).toBe(true);
      expect(alert).toHaveBeenCalledTimes(1);
      expect(alert).toHaveBeenCalledWith(client, {
        title: 'Meetup identity monitoring is not running',
        description:
          'The stored Meetup organizer credential belongs to a different Meetup account than the one on record, ' +
          'so it is not used. ' +
          `Renew it from ${BASE_DISCORD_BOT_URL}/dashboard/organizer-login while signed in to Meetup as the shared organizer account.`,
      });
      // Memoised per token: one lookup for all three calls.
      expect(fake.getSelfId).toHaveBeenCalledTimes(1);
      expect(locked.write).not.toHaveBeenCalled();
      expect(idsShown()).not.toContain(OTHER);
      expect(idsShown()).not.toContain(ORGANIZER);
    });

    it('a failed wrong-account alert post is retried on the next run', async () => {
      db.current = stored(60 * MINUTE);
      fake.getSelfId.mockResolvedValue(OTHER);
      alert.mockResolvedValueOnce(false);

      await expect(
        getOrganizerAccessToken({ client }),
      ).resolves.toBeUndefined();
      expect(db.failing).toBe(false); // re-armed
      await expect(
        getOrganizerAccessToken({ client }),
      ).resolves.toBeUndefined();
      expect(alert).toHaveBeenCalledTimes(2);
      expect(db.failing).toBe(true);
    });

    it('a wrong account never closes an open episode', async () => {
      // Refresh path.
      db.current = stored(0);
      db.failing = true;
      refresh.mockResolvedValueOnce(fresh(1));
      fake.getSelfId.mockResolvedValue(OTHER);

      await expect(
        getOrganizerAccessToken({ client }),
      ).resolves.toBeUndefined();
      expect(locked.clearFailing).not.toHaveBeenCalled();
      expect(db.failing).toBe(true);

      // Reuse path.
      db.current = stored(60 * MINUTE);
      await expect(
        getOrganizerAccessToken({ client }),
      ).resolves.toBeUndefined();
      expect(locked.clearFailing).not.toHaveBeenCalled();
      expect(db.failing).toBe(true);

      // Neither a recovery nor a fresh alert: the episode was already open.
      expect(alert).not.toHaveBeenCalled();
    });
  });

  it('records as observed when no organizer id is configured', async () => {
    db.current = stored(60 * MINUTE);
    db.memberId = null;
    fake.getSelfId.mockResolvedValueOnce('999000111');

    await getOrganizerAccessToken({ client });

    expect(db.memberId).toBe('999000111');
    expect(alert).not.toHaveBeenCalled();
  });

  it('alerts when the credential store cannot be opened', async () => {
    class ConnectionError extends Error {
      name = 'ConnectionError';
    }
    vi.mocked(ApplicationCredentialRepository).mockRejectedValueOnce(
      new ConnectionError('connect ECONNREFUSED'),
    );

    await expect(getOrganizerAccessToken({ client })).resolves.toBeUndefined();
    expect(alert).toHaveBeenCalledWith(client, {
      title: 'Meetup organizer credential store unavailable',
      description:
        'Could not read the shared Meetup organizer credential from the database (it is unavailable or busy: ConnectionError), ' +
        'so Meetup identity monitoring was skipped this time. It retries on the next run.',
    });
    expect(fake.logged.join('\n')).toMatch(/ConnectionError/);
  });

  it('checks a mismatched stored token once, and alerts once a client is present', async () => {
    db.current = stored(60 * MINUTE);
    db.memberId = null;
    Configuration.meetup.organizerMemberId = '468174923';
    fake.getSelfId.mockResolvedValue('999000111');

    await expect(getOrganizerAccessToken()).resolves.toBeUndefined();
    await expect(getOrganizerAccessToken()).resolves.toBeUndefined();
    expect(fake.getSelfId).toHaveBeenCalledTimes(1);
    expect(alert).not.toHaveBeenCalled();

    await getOrganizerAccessToken({ client });
    await getOrganizerAccessToken({ client });
    expect(fake.getSelfId).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][1].title).toBe(
      'Meetup identity monitoring is not running',
    );
    expect(db.memberId).toBeNull();
  });

  it('alerts when the credential store is unavailable', async () => {
    class LockTimeoutError extends Error {
      name = 'LockTimeoutError';
    }
    const lockTimeout = new LockTimeoutError(
      'canceling statement due to lock timeout',
    );
    credentials.withLockedCredential
      .mockRejectedValueOnce(lockTimeout)
      .mockRejectedValueOnce(lockTimeout);

    await expect(getOrganizerAccessToken({ client })).resolves.toBeUndefined();
    await expect(getOrganizerAccessToken({ client })).resolves.toBeUndefined();

    expect(alert).toHaveBeenCalledTimes(2);
    expect(alert).toHaveBeenCalledWith(client, {
      title: 'Meetup organizer credential store unavailable',
      description:
        'Could not read the shared Meetup organizer credential from the database (it is unavailable or busy: LockTimeoutError), ' +
        'so Meetup identity monitoring was skipped this time. It retries on the next run.',
    });
    expect(fake.logged.join('\n')).toMatch(/LockTimeoutError/);
  });

  it('checks a reused token even when a member id is stored', async () => {
    db.current = stored(60 * MINUTE);
    fake.getSelfId.mockResolvedValue('999000111');

    // Checked without a client too: a script must not use it either.
    await expect(getOrganizerAccessToken()).resolves.toBeUndefined();
    expect(fake.getSelfId).toHaveBeenCalledTimes(1);
    expect(db.memberId).toBe('468174923'); // the recorded id is kept
    expect(locked.setMemberId).not.toHaveBeenCalled();
  });

  it('looks up each distinct access token once', async () => {
    db.current = stored(60 * MINUTE);

    await getOrganizerAccessToken({ client });
    await getOrganizerAccessToken({ client });
    expect(fake.getSelfId).toHaveBeenCalledTimes(1);

    refresh.mockResolvedValueOnce(fresh(1));
    await getOrganizerAccessToken({ client, forceRefresh: true });
    expect(fake.getSelfId).toHaveBeenCalledTimes(2);
  });

  it('a matching account still posts the recovery', async () => {
    db.current = stored(0);
    db.failing = true;
    refresh.mockResolvedValueOnce(fresh(1));

    await expect(getOrganizerAccessToken({ client })).resolves.toBe(
      'FRESH-ACCESS-1',
    );

    expect(fake.getSelfId).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][1].title).toBe(
      'Meetup organizer login restored',
    );
  });

  it('does not record a member id when the stored token changed during the lookup', async () => {
    db.current = stored(60 * MINUTE);
    db.memberId = null;
    // Another process replaces the credential while this one looks up the
    // old token's account: what was learned belongs to the old token.
    fake.getSelfId.mockImplementationOnce(async () => {
      db.current = { ...fresh(9), accessToken: 'REPLACED-ACCESS' };
      return '999000111';
    });

    await expect(getOrganizerAccessToken()).resolves.toBe('STORED-ACCESS');

    expect(locked.setMemberId).not.toHaveBeenCalled();
    expect(db.memberId).toBeNull();
  });

  it('never stores a member id that is not all digits', async () => {
    db.current = stored(60 * MINUTE);
    db.memberId = null;
    fake.getSelfId.mockResolvedValueOnce('abc');

    await getOrganizerAccessToken();

    expect(locked.setMemberId).not.toHaveBeenCalled();
  });

  it('member id lookup failure does not fail the token', async () => {
    db.current = stored(60 * MINUTE);
    db.memberId = null;
    fake.getSelfId.mockRejectedValueOnce(new Error('meetup down'));

    await expect(getOrganizerAccessToken()).resolves.toBe('STORED-ACCESS');

    fake.getSelfId.mockResolvedValueOnce('1');
    locked.setMemberId.mockRejectedValueOnce(new Error('write failed'));
    await expect(getOrganizerAccessToken()).resolves.toBe('STORED-ACCESS');
  });
});

describe('noteOrganizerCredentialRenewed', () => {
  it('re-arms the account check after a renewal', async () => {
    db.current = stored(60 * MINUTE);
    db.memberId = null;
    Configuration.meetup.organizerMemberId = '468174923';
    fake.getSelfId.mockResolvedValue('999000111');

    await expect(getOrganizerAccessToken({ client })).resolves.toBeUndefined();
    expect(alert).toHaveBeenCalledTimes(1);

    // Without a renewal the verdict stays: no new lookup, no new alert.
    await expect(getOrganizerAccessToken({ client })).resolves.toBeUndefined();
    expect(fake.getSelfId).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledTimes(1);

    // A renewal with the right account (the renew page closes the episode
    // and posts its own recovery): its token is checked, matches, and is used.
    noteOrganizerCredentialRenewed();
    db.failing = false;
    db.memberId = '468174923';
    db.current = { ...fresh(5), expiresAt: Date.now() + 60 * MINUTE };
    fake.getSelfId.mockResolvedValue('468174923');
    await expect(getOrganizerAccessToken({ client })).resolves.toBe(
      'FRESH-ACCESS-5',
    );
    expect(fake.getSelfId).toHaveBeenCalledTimes(2);
    expect(alert).toHaveBeenCalledTimes(1);

    // And a later mismatch is detected and alerted afresh.
    noteOrganizerCredentialRenewed();
    db.memberId = null;
    db.current = { ...fresh(6), expiresAt: Date.now() + 60 * MINUTE };
    fake.getSelfId.mockResolvedValue('999000111');
    await expect(getOrganizerAccessToken({ client })).resolves.toBeUndefined();
    expect(fake.getSelfId).toHaveBeenCalledTimes(3);
    expect(alert).toHaveBeenCalledTimes(2);
  });

  it('a later caller does not join a resolution started before the renewal', async () => {
    db.current = stored(0);
    const before = deferred<Tokens>();
    refresh.mockReturnValueOnce(before.promise);
    const stale = getOrganizerAccessToken();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());

    noteOrganizerCredentialRenewed();
    db.current = { ...fresh(9), expiresAt: Date.now() + 60 * MINUTE };
    await expect(getOrganizerAccessToken()).resolves.toBe('FRESH-ACCESS-9');

    before.resolve(fresh(1));
    await expect(stale).resolves.toBe('FRESH-ACCESS-1');
  });

  it('a mismatch found by a resolution that began before the renewal is ignored', async () => {
    db.current = stored(60 * MINUTE);
    db.memberId = null;
    Configuration.meetup.organizerMemberId = '468174923';
    const lookup = deferred<string>();
    fake.getSelfId.mockReturnValueOnce(lookup.promise);

    const stale = getOrganizerAccessToken({ client });
    await vi.waitFor(() => expect(fake.getSelfId).toHaveBeenCalled());
    noteOrganizerCredentialRenewed();
    db.memberId = '468174923';
    lookup.resolve('999000111');
    await stale;

    await getOrganizerAccessToken({ client });
    expect(alert).not.toHaveBeenCalled();
  });
});

describe('isMeetupUnauthorized', () => {
  const clientError = (status: number) =>
    new ClientError(
      { status, headers: new Headers(), body: '' },
      { query: '' },
    );

  it('is true for a graphql-request 401', () => {
    expect(isMeetupUnauthorized(clientError(401))).toBe(true);
  });

  it('is false for other statuses and other errors', () => {
    expect(isMeetupUnauthorized(clientError(500))).toBe(false);
    expect(isMeetupUnauthorized(new Error('401'))).toBe(false);
    expect(isMeetupUnauthorized(undefined)).toBe(false);
  });
});
