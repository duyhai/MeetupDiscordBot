import crypto from 'crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ORGANIZER_CREDENTIAL_LOCK,
  PostgresCredentialRepository,
} from '../../src/lib/repositories/postgresCredentialRepository.js';
import { Tokens } from '../../src/lib/client/discord/types.js';

// Exercises the upsert conflict target and TIMESTAMPTZ handling against a
// real Postgres -- a mock would paper over both. Requires DATABASE_URL;
// skipped otherwise, matching the identity repository suite.
// Locally: yarn test:integration:docker
const POSTGRES_AVAILABLE = Boolean(process.env.DATABASE_URL);

if (!POSTGRES_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    'Skipping PostgresCredentialRepository integration tests: set DATABASE_URL to a reachable Postgres to run them.',
  );
}

const freshTokens = (): Tokens => ({
  accessToken: `access-${crypto.randomUUID()}`,
  refreshToken: `refresh-${crypto.randomUUID()}`,
  expiresAt: Date.now() + 3600 * 1000,
});

const tokensWithRefresh = (refreshToken: string): Tokens => ({
  ...freshTokens(),
  refreshToken,
});

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

interface Gate {
  promise: Promise<void>;
  open: () => void;
}

const gate = (): Gate => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

// pg_locks splits a bigint advisory key into classid (high 32 bits) and objid
// (low 32 bits); objsubid = 1 marks the single-bigint form.
const LOCK_CLASSID = Math.floor(ORGANIZER_CREDENTIAL_LOCK / 2 ** 32);
const LOCK_OBJID = ORGANIZER_CREDENTIAL_LOCK % 2 ** 32;

describe.skipIf(!POSTGRES_AVAILABLE)('PostgresCredentialRepository', () => {
  let repo: PostgresCredentialRepository;
  // A third connection outside either repository's pool: observes pg_locks and
  // table contents while both repositories' single connections are busy.
  let observer: pg.Client;

  beforeAll(async () => {
    repo = await PostgresCredentialRepository.instance();
    observer = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await observer.connect();
  });

  // Every isolated instance owns a pool; end them all so no connection
  // outlives the suite.
  const isolatedRepos: PostgresCredentialRepository[] = [];
  const isolated = (
    options?: Parameters<
      typeof PostgresCredentialRepository.createIsolatedForTest
    >[0],
  ): PostgresCredentialRepository => {
    const instance =
      PostgresCredentialRepository.createIsolatedForTest(options);
    isolatedRepos.push(instance);
    return instance;
  };

  afterAll(async () => {
    await Promise.allSettled(isolatedRepos.map((instance) => instance.end()));
    await observer?.end();
  });

  /** pid of the session currently holding the organizer lock. */
  const lockHolderPid = async (): Promise<number> => {
    const { rows } = await observer.query<{ pid: number }>(
      `SELECT pid FROM pg_locks
        WHERE locktype = 'advisory' AND granted
          AND classid = $1 AND objid = $2 AND objsubid = 1`,
      [LOCK_CLASSID, LOCK_OBJID],
    );
    if (rows.length !== 1) {
      throw new Error(`expected one lock holder, found ${rows.length}`);
    }
    return rows[0].pid;
  };

  /**
   * Resolves once some session is blocked waiting for the organizer lock, so
   * the race tests prove "waiting" from Postgres itself instead of guessing
   * with sleeps. Rejects after `timeoutMs` (i.e. nobody ever waited).
   */
  const waitForLockWaiter = async (timeoutMs = 5000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      const { rows } = await observer.query<{ waiting: number }>(
        `SELECT count(*)::int AS waiting FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted
            AND classid = $1 AND objid = $2 AND objsubid = 1`,
        [LOCK_CLASSID, LOCK_OBJID],
      );
      if (rows[0].waiting > 0) {
        return;
      }
      // eslint-disable-next-line no-await-in-loop
      await delay(20);
    }
    throw new Error('no session ever waited for the organizer credential lock');
  };

  const storedRefreshToken = async (
    key: string,
  ): Promise<string | undefined> => {
    const { rows } = await observer.query<{ refresh_token: string }>(
      'SELECT refresh_token FROM oauth_credentials WHERE key = $1',
      [key],
    );
    return rows[0]?.refresh_token;
  };

  it('round-trips a token set', async () => {
    const key = `key-${crypto.randomUUID()}`;
    const tokens = freshTokens();

    await repo.put(key, tokens);
    const stored = await repo.get(key);

    expect(stored?.accessToken).toBe(tokens.accessToken);
    expect(stored?.refreshToken).toBe(tokens.refreshToken);
    // expiresAt round-trips through a TIMESTAMPTZ column, which only holds
    // millisecond precision -- matching the input's own precision here.
    expect(stored?.expiresAt).toBe(tokens.expiresAt);
  });

  it('overwrites rather than duplicates on repeated put', async () => {
    const key = `key-${crypto.randomUUID()}`;
    await repo.put(key, freshTokens());
    const updated = freshTokens();
    await repo.put(key, updated);

    const stored = await repo.get(key);
    expect(stored?.accessToken).toBe(updated.accessToken);
    expect(stored?.refreshToken).toBe(updated.refreshToken);
  });

  it('returns undefined for an absent key', async () => {
    expect(await repo.get(`missing-${crypto.randomUUID()}`)).toBeUndefined();
  });

  it('clear removes the stored credential', async () => {
    const key = `key-${crypto.randomUUID()}`;
    await repo.put(key, freshTokens());

    await repo.clear(key);

    expect(await repo.get(key)).toBeUndefined();
  });

  it('creates the meta table idempotently', async () => {
    // Two fresh instances each run the schema DDL against an existing schema.
    const first = isolated();
    const second = isolated();
    const key = `key-${crypto.randomUUID()}`;
    expect(await first.getMeta(key)).toEqual({
      memberId: null,
      failingSince: null,
    });
    expect(await second.getMeta(key)).toEqual({
      memberId: null,
      failingSince: null,
    });

    const { rows } = await observer.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'oauth_credential_meta' ORDER BY column_name`,
    );
    expect(rows.map((row) => row.column_name)).toEqual([
      'failing_since',
      'key',
      'member_id',
    ]);
  });

  /**
   * Holds the organizer lock from a separate repository instance (its own
   * session) until `release` is called, writing `refreshToken` just before
   * committing. Resolves `inside` once the lock is held.
   */
  const holdLock = (
    holder: PostgresCredentialRepository,
    key: string,
    refreshToken: string,
    order: string[],
  ) => {
    const inside = gate();
    const releaseGate = gate();
    const done = holder.withLockedCredential(key, async (locked) => {
      inside.open();
      await releaseGate.promise;
      await locked.write(tokensWithRefresh(refreshToken));
      order.push(`holder wrote ${refreshToken}`);
    });
    return { inside: inside.promise, release: releaseGate.open, done };
  };

  it('put and clear go through the lock', async () => {
    const holder = isolated();
    const key = `key-${crypto.randomUUID()}`;
    const order: string[] = [];

    // put: blocked while another session holds the lock, runs after it commits
    const first = holdLock(holder, key, 'from-holder', order);
    const putting = (async () => {
      await first.inside;
      await repo.put(key, tokensWithRefresh('from-put'));
      order.push('put done');
    })();
    try {
      await first.inside;
      await waitForLockWaiter();
      expect(order).toEqual([]);
      expect(await storedRefreshToken(key)).toBeUndefined();
    } finally {
      // Always let the holder commit, so a failure here never leaves the
      // lock held and wedges every later test.
      first.release();
      await Promise.allSettled([first.done, putting]);
    }
    await Promise.all([first.done, putting]);
    expect(order).toEqual(['holder wrote from-holder', 'put done']);
    // put ran second, so its value is the one that survives
    expect(await storedRefreshToken(key)).toBe('from-put');

    // clear: likewise, and it deletes only after the holder's write commits
    const second = holdLock(holder, key, 'rewritten', order);
    const clearing = (async () => {
      await second.inside;
      await repo.clear(key);
      order.push('clear done');
    })();
    try {
      await second.inside;
      await waitForLockWaiter();
      expect(await storedRefreshToken(key)).toBe('from-put');
    } finally {
      second.release();
      await Promise.allSettled([second.done, clearing]);
    }
    await Promise.all([second.done, clearing]);
    expect(order.slice(2)).toEqual(['holder wrote rewritten', 'clear done']);
    expect(await storedRefreshToken(key)).toBeUndefined();
  });

  it('serializes two independent repository instances racing to refresh', async () => {
    const other = isolated();
    const key = `key-${crypto.randomUUID()}`;
    await repo.put(key, tokensWithRefresh('r0'));

    const seen: Record<string, string | undefined> = {};
    const events: string[] = [];

    // Each "refresh" reads the current refresh token, spends 300 ms talking to
    // a pretend Meetup, and writes a successor derived from what it read --
    // exactly the shape that kills a rotating credential when two interleave.
    const refresh =
      (name: string, entered?: Gate, proceed?: Promise<void>) =>
      async (locked: {
        current: Tokens | undefined;
        write: (tokens: Tokens) => Promise<void>;
      }): Promise<void> => {
        seen[name] = locked.current?.refreshToken;
        events.push(`${name} read`);
        entered?.open();
        await proceed;
        await delay(300);
        await locked.write(
          tokensWithRefresh(`${locked.current?.refreshToken}>${name}`),
        );
        events.push(`${name} wrote`);
      };

    const firstEntered = gate();
    const letFirstFinish = gate();
    const first = other.withLockedCredential(
      key,
      refresh('A', firstEntered, letFirstFinish.promise),
    );
    await firstEntered.promise;

    const second = repo.withLockedCredential(key, refresh('B'));
    try {
      // Postgres itself reports B blocked on the lock while A is mid-refresh.
      await waitForLockWaiter();
      expect(events).toEqual(['A read']);
    } finally {
      letFirstFinish.open();
      await Promise.allSettled([first, second]);
    }
    await Promise.all([first, second]);

    expect(events).toEqual(['A read', 'A wrote', 'B read', 'B wrote']);
    expect(seen).toEqual({ A: 'r0', B: 'r0>A' });
    expect((await repo.get(key))?.refreshToken).toBe('r0>A>B');
  });

  it('rolls back when fn throws', async () => {
    const key = `key-${crypto.randomUUID()}`;
    await expect(
      repo.withLockedCredential(key, async (locked) => {
        await locked.write(freshTokens());
        await locked.setMemberId('12345');
        throw new Error('refresh blew up');
      }),
    ).rejects.toThrow('refresh blew up');

    expect(await repo.get(key)).toBeUndefined();
    expect(await repo.getMeta(key)).toEqual({
      memberId: null,
      failingSince: null,
    });
    // and the lock was released: the next locked call proceeds
    await repo.put(key, freshTokens());
    expect(await repo.get(key)).toBeDefined();
  });

  it('hands fn the current credential and meta read under the lock', async () => {
    const key = `key-${crypto.randomUUID()}`;
    const tokens = freshTokens();
    await repo.put(key, tokens);
    await repo.withLockedCredential(key, (locked) =>
      locked.setMemberId('12345'),
    );
    await repo.markFailing(key);

    const observed = await repo.withLockedCredential(key, async (locked) => ({
      current: locked.current,
      meta: locked.meta,
    }));
    expect(observed.current?.refreshToken).toBe(tokens.refreshToken);
    expect(observed.meta.memberId).toBe('12345');
    expect(observed.meta.failingSince).toBeInstanceOf(Date);
    expect(await repo.getMeta(key)).toEqual(observed.meta);
  });

  it('refuses writes after the locked transaction has ended', async () => {
    const key = `key-${crypto.randomUUID()}`;
    const leaked = await repo.withLockedCredential(
      key,
      async (locked) => locked,
    );
    await expect(leaked.write(freshTokens())).rejects.toThrow(/ended/);
    expect(await repo.get(key)).toBeUndefined();
  });

  it('markFailing starts an episode once, clearFailing ends it once', async () => {
    const key = `key-${crypto.randomUUID()}`;
    await repo.put(key, freshTokens());

    expect(await repo.markFailing(key)).toBe(true);
    const started = (await repo.getMeta(key)).failingSince;
    expect(started).toBeInstanceOf(Date);
    expect(await repo.markFailing(key)).toBe(false);
    // the episode start is not pushed forward by repeated failures
    expect((await repo.getMeta(key)).failingSince).toEqual(started);

    expect(await repo.clearFailing(key)).toBe(true);
    expect((await repo.getMeta(key)).failingSince).toBeNull();
    expect(await repo.clearFailing(key)).toBe(false);
  });

  it('markFailing works with no credential row', async () => {
    const key = `key-${crypto.randomUUID()}`;
    expect(await repo.markFailing(key)).toBe(true);
    expect(await repo.get(key)).toBeUndefined();
    expect((await repo.getMeta(key)).failingSince).toBeInstanceOf(Date);
  });

  it('clear keeps the meta row', async () => {
    const key = `key-${crypto.randomUUID()}`;
    await repo.put(key, freshTokens());
    await repo.withLockedCredential(key, (locked) =>
      locked.setMemberId('12345'),
    );
    await repo.clear(key);
    expect(await repo.get(key)).toBeUndefined();
    expect((await repo.getMeta(key)).memberId).toBe('12345');
  });

  it('setMemberId rejects non-digits', async () => {
    const key = `key-${crypto.randomUUID()}`;
    await expect(
      repo.withLockedCredential(key, (locked) => locked.setMemberId('12a45')),
    ).rejects.toThrow(/check constraint/);
    expect((await repo.getMeta(key)).memberId).toBeNull();

    await repo.withLockedCredential(key, (locked) =>
      locked.setMemberId('468174923'),
    );
    expect((await repo.getMeta(key)).memberId).toBe('468174923');
  });

  it('survives the backend being terminated mid-transaction', async () => {
    const holder = isolated();
    const key = `key-${crypto.randomUUID()}`;
    const order: string[] = [];
    const held = holdLock(holder, key, 'never-stored', order);
    const outcome = held.done.then(
      () => 'resolved',
      (error: unknown) => `rejected: ${String(error)}`,
    );
    try {
      await held.inside;
      const pid = await lockHolderPid();
      await observer.query('SELECT pg_terminate_backend($1)', [pid]);
      // Let the dead socket surface as a client 'error' event while the
      // client is still checked out -- the case that used to crash the dyno.
      await delay(200);
    } finally {
      held.release();
    }
    expect(await outcome).toMatch(
      /^rejected: Error: Credential transaction lost its database connection: /,
    );
    expect(order).toEqual([]);
    expect(await storedRefreshToken(key)).toBeUndefined();

    // The broken connection was destroyed, not recycled: the same one-slot
    // pool hands out a fresh connection and the next write succeeds.
    await holder.put(key, tokensWithRefresh('after-terminate'));
    expect(await storedRefreshToken(key)).toBe('after-terminate');
  });

  it('re-entering the repository inside the lock fails fast', async () => {
    const key = `key-${crypto.randomUUID()}`;
    const started = Date.now();
    await expect(
      repo.withLockedCredential(key, async (locked) => {
        await locked.write(freshTokens());
        // With a one-connection pool this used to wait forever.
        await repo.getMeta(key);
      }),
    ).rejects.toThrow(
      'credential repository re-entered inside withLockedCredential',
    );
    expect(Date.now() - started).toBeLessThan(2000);
    // rolled back: the write inside never landed
    expect(await repo.get(key)).toBeUndefined();

    // every public entry point is guarded, not just getMeta
    const reentries = await repo.withLockedCredential(key, async () =>
      Promise.allSettled([
        repo.get(key),
        repo.getMeta(key),
        repo.put(key, freshTokens()),
        repo.clear(key),
        repo.markFailing(key),
        repo.clearFailing(key),
        repo.withLockedCredential(key, async () => undefined),
      ]),
    );
    expect(reentries.map((result) => result.status)).toEqual(
      Array(7).fill('rejected'),
    );
  });

  it('a waiter gives up after lock_timeout', async () => {
    const holder = isolated();
    const impatient = isolated({ lockTimeoutMs: 200 });
    const key = `key-${crypto.randomUUID()}`;
    const order: string[] = [];
    const held = holdLock(holder, key, 'from-holder', order);
    try {
      await held.inside;
      const started = Date.now();
      await expect(
        impatient.put(key, tokensWithRefresh('from-impatient')),
      ).rejects.toThrow(/lock timeout/);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      held.release();
      await Promise.allSettled([held.done]);
    }
    await held.done;
    expect(await storedRefreshToken(key)).toBe('from-holder');
    // the impatient instance's pool is still usable afterwards
    await impatient.put(key, tokensWithRefresh('later'));
    expect(await storedRefreshToken(key)).toBe('later');
  });

  it('locked markFailing/clearFailing start and end an episode exactly once', async () => {
    const key = `key-${crypto.randomUUID()}`;
    const results = await repo.withLockedCredential(key, async (locked) => [
      await locked.markFailing(),
      await locked.markFailing(),
    ]);
    expect(results).toEqual([true, false]);
    expect((await repo.getMeta(key)).failingSince).toBeInstanceOf(Date);

    const cleared = await repo.withLockedCredential(key, async (locked) => [
      await locked.clearFailing(),
      await locked.clearFailing(),
    ]);
    expect(cleared).toEqual([true, false]);
    expect((await repo.getMeta(key)).failingSince).toBeNull();
  });

  it('a rollback undoes a locked markFailing', async () => {
    const key = `key-${crypto.randomUUID()}`;
    await expect(
      repo.withLockedCredential(key, async (locked) => {
        expect(await locked.markFailing()).toBe(true);
        throw new Error('refresh blew up');
      }),
    ).rejects.toThrow('refresh blew up');
    expect((await repo.getMeta(key)).failingSince).toBeNull();
    // and the episode can still be started afterwards
    expect(await repo.markFailing(key)).toBe(true);
  });

  it('work started inside the lock can use the repository after the transaction ends', async () => {
    const key = `key-${crypto.randomUUID()}`;
    let later!: Promise<unknown>;
    const committed = gate();
    await repo.withLockedCredential(key, async (locked) => {
      await locked.setMemberId('12345');
      // Fire-and-forget work spawned inside fn, running only after commit.
      later = new Promise((resolve, reject) => {
        setTimeout(() => {
          committed.promise.then(() => repo.getMeta(key)).then(resolve, reject);
        }, 0);
      });
    });
    committed.open();
    await expect(later).resolves.toEqual({
      memberId: '12345',
      failingSince: null,
    });

    // Ungated: the timer may fire while COMMIT is still in flight. It must
    // wait for the connection, not be refused as re-entry.
    let racing!: Promise<unknown>;
    await repo.withLockedCredential(key, async () => {
      racing = new Promise((resolve, reject) => {
        setTimeout(() => {
          repo.getMeta(key).then(resolve, reject);
        }, 0);
      });
    });
    await expect(racing).resolves.toMatchObject({ memberId: '12345' });
  });
});
