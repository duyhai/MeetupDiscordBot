import { Client } from 'discord.js';
import { ClientError } from 'graphql-request';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Configuration from '../../../src/configuration.js';
import { BASE_DISCORD_BOT_URL } from '../../../src/constants.js';
import { Tokens } from '../../../src/lib/client/discord/types.js';
import { refreshMeetupToken } from '../../../src/lib/client/oauth/providers.js';
import { logAlert } from '../../../src/lib/helpers/discordLogger.js';
import {
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

vi.mock('../../../src/lib/client/oauth/providers.js', () => ({
  refreshMeetupToken: vi.fn(),
}));

vi.mock('../../../src/lib/helpers/discordLogger.js', () => ({
  logAlert: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../../src/lib/client/meetup/gqlClient.js', () => ({
  GqlMeetupClient: class {
    getSelfId = fake.getSelfId;
  },
}));

// A stand-in for the locked transaction: fn sees the stored state; a throw
// from fn is a rollback (nothing it did is kept), a return is a commit.
const db = {
  current: undefined as Tokens | undefined,
  memberId: null as string | null,
  failing: false,
  commitFails: false,
  rolledBack: 0,
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
};

const credentials = {
  withLockedCredential: vi.fn(
    async <T>(
      _key: string,
      fn: (l: LockedCredential) => Promise<T>,
    ): Promise<T> => {
      const before = { ...db };
      let result: T;
      try {
        result = await fn({
          current: db.current,
          meta: { memberId: db.memberId, failingSince: null },
          ...locked,
        });
      } catch (error) {
        Object.assign(db, before);
        db.rolledBack += 1;
        throw error;
      }
      if (db.commitFails) {
        Object.assign(db, before);
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
    commitFails: false,
    rolledBack: 0,
  });
  Configuration.meetup.organizerRefreshToken = 'SEED-REFRESH';
  Configuration.meetup.organizerMemberId = undefined;
  refresh.mockReset();
  alert.mockClear();
  fake.getSelfId.mockReset();
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

  it('falls back to the config seed only when the stored refresh fails', async () => {
    db.current = stored(0);
    refresh.mockRejectedValueOnce(refreshError());
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

  it('tries an identical stored token and seed only once', async () => {
    db.current = stored(0, 'SEED-REFRESH');
    refresh.mockRejectedValue(refreshError());

    await expect(getOrganizerAccessToken()).resolves.toBeUndefined();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('uses the seed when nothing is stored yet', async () => {
    refresh.mockResolvedValueOnce(fresh());

    await expect(getOrganizerAccessToken()).resolves.toBe('FRESH-ACCESS-1');
    expect(refresh).toHaveBeenCalledWith('SEED-REFRESH');
    expect(db.current?.accessToken).toBe('FRESH-ACCESS-1');
  });

  it('persist failure keeps the fresh token for this run', async () => {
    db.current = stored(0);
    refresh.mockResolvedValueOnce(fresh());
    db.failing = true;
    locked.write.mockRejectedValueOnce(new Error('write failed'));

    await expect(getOrganizerAccessToken({ client })).resolves.toBe(
      'FRESH-ACCESS-1',
    );
    expect(db.rolledBack).toBe(0); // fn returned rather than threw
    // Postgres aborted the transaction at the failed write, so the episode
    // was not durably closed: no recovery message.
    expect(alert).not.toHaveBeenCalled();
    expect(fake.logged.join('\n')).toMatch(/refreshed but could NOT be stored/);
    // Only the first candidate: a persist failure is not a refresh failure.
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps the fresh token when the transaction fails to commit', async () => {
    db.current = stored(0);
    db.commitFails = true;
    refresh.mockResolvedValueOnce(fresh());

    await expect(getOrganizerAccessToken({ client })).resolves.toBe(
      'FRESH-ACCESS-1',
    );
    expect(fake.logged.join('\n')).toMatch(/could NOT be stored/);
    expect(alert).not.toHaveBeenCalled();
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

  it('a different account stores nothing and alerts once', async () => {
    db.current = stored(60 * MINUTE);
    db.memberId = null;
    Configuration.meetup.organizerMemberId = '468174923';
    fake.getSelfId.mockResolvedValue('999000111');

    await expect(getOrganizerAccessToken({ client })).resolves.toBe(
      'STORED-ACCESS',
    );
    await expect(getOrganizerAccessToken({ client })).resolves.toBe(
      'STORED-ACCESS',
    );

    expect(locked.setMemberId).not.toHaveBeenCalled();
    expect(db.memberId).toBeNull();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(client, {
      title: 'Meetup organizer credential belongs to a different account',
      description:
        'The stored Meetup organizer credential is not the shared organizer account (the one on record, or MEETUP_ORGANIZER_MEMBER_ID). ' +
        `Renew it at ${BASE_DISCORD_BOT_URL}/dashboard/organizer-login while signed in to Meetup as the shared organizer account.`,
    });
    const shown = JSON.stringify(alert.mock.calls) + fake.logged.join('\n');
    expect(shown).not.toContain('999000111');
    expect(JSON.stringify(alert.mock.calls)).not.toContain('468174923');
    expect(fake.logged.join('\n')).not.toContain('468174923');
    expect(
      fake.logged.filter((line) => line.includes('different account')),
    ).not.toHaveLength(0);
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
        'Could not read the shared Meetup organizer credential from the database (ConnectionError), ' +
        'so Meetup identity monitoring was skipped this time. It retries on the next run.',
    });
    expect(fake.logged.join('\n')).toMatch(/ConnectionError/);
  });

  it('checks a mismatched member id once, and alerts once a client is present', async () => {
    db.current = stored(60 * MINUTE);
    db.memberId = null;
    Configuration.meetup.organizerMemberId = '468174923';
    fake.getSelfId.mockResolvedValue('999000111');

    await getOrganizerAccessToken();
    await getOrganizerAccessToken();
    expect(fake.getSelfId).toHaveBeenCalledTimes(1);
    expect(alert).not.toHaveBeenCalled();

    await getOrganizerAccessToken({ client });
    await getOrganizerAccessToken({ client });
    expect(fake.getSelfId).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][1].title).toBe(
      'Meetup organizer credential belongs to a different account',
    );
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
        'Could not read the shared Meetup organizer credential from the database (LockTimeoutError), ' +
        'so Meetup identity monitoring was skipped this time. It retries on the next run.',
    });
    expect(fake.logged.join('\n')).toMatch(/LockTimeoutError/);
  });

  it('checks the account even when a member id is stored', async () => {
    db.current = stored(60 * MINUTE);
    fake.getSelfId.mockResolvedValue('999000111');

    // Without a client nothing could be alerted, so no lookup is spent.
    await getOrganizerAccessToken();
    expect(fake.getSelfId).not.toHaveBeenCalled();

    await expect(getOrganizerAccessToken({ client })).resolves.toBe(
      'STORED-ACCESS',
    );
    expect(fake.getSelfId).toHaveBeenCalledTimes(1);
    expect(db.memberId).toBe('468174923'); // the recorded id is kept
    expect(locked.setMemberId).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][1].title).toBe(
      'Meetup organizer credential belongs to a different account',
    );
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

  it('a mismatched account after a refresh posts the wrong-account alert and no recovery', async () => {
    // e.g. MEETUP_ORGANIZER_REFRESH_TOKEN was seeded from a personal account
    // while an episode was open.
    db.current = stored(0);
    db.failing = true;
    refresh.mockResolvedValueOnce(fresh(1));
    fake.getSelfId.mockResolvedValue('999000111');

    await expect(getOrganizerAccessToken({ client })).resolves.toBe(
      'FRESH-ACCESS-1',
    );

    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][1].title).toBe(
      'Meetup organizer credential belongs to a different account',
    );
    const shown = JSON.stringify(alert.mock.calls) + fake.logged.join('\n');
    expect(shown).not.toContain('999000111');
    expect(shown).not.toContain('468174923');
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
  it('re-arms the wrong-account check and alert after a renewal', async () => {
    db.current = stored(60 * MINUTE);
    db.memberId = null;
    Configuration.meetup.organizerMemberId = '468174923';
    fake.getSelfId.mockResolvedValue('999000111');

    await getOrganizerAccessToken({ client });
    expect(alert).toHaveBeenCalledTimes(1);

    // Without a renewal the check and the alert stay spent for this process.
    await getOrganizerAccessToken({ client });
    expect(fake.getSelfId).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledTimes(1);

    noteOrganizerCredentialRenewed();

    // A renewal with the right account: its new token is checked, matches,
    // and no stale wrong-account alert follows.
    db.memberId = '468174923';
    db.current = { ...fresh(5), expiresAt: Date.now() + 60 * MINUTE };
    fake.getSelfId.mockResolvedValue('468174923');
    await getOrganizerAccessToken({ client });
    expect(fake.getSelfId).toHaveBeenCalledTimes(2);
    expect(alert).toHaveBeenCalledTimes(1);

    // And a later mismatch is detected and alerted afresh.
    noteOrganizerCredentialRenewed();
    db.memberId = null;
    db.current = { ...fresh(6), expiresAt: Date.now() + 60 * MINUTE };
    fake.getSelfId.mockResolvedValue('999000111');
    await getOrganizerAccessToken({ client });
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
