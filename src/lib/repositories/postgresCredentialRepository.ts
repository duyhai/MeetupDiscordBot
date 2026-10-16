import { AsyncLocalStorage } from 'node:async_hooks';

import pg from 'pg';
import { Logger } from 'tslog';

import { Tokens } from '../client/discord/types.js';

const logger = new Logger({ name: 'PostgresCredentialRepository' });

// A waiter gives up after this long rather than queueing forever behind a
// stuck holder. A healthy holder can take about 30 s worst case (stored
// refresh 10 s + seed refresh 10 s + account check 10 s), so this sits above
// that and below the 45 s idle-in-transaction kill.
const LOCK_TIMEOUT_MS = 40_000;
// Postgres kills a holder that goes quiet mid-transaction this long, which
// releases the lock even if the process holding it is wedged.
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 45_000;
// Backstop for pool.connect(): never wait forever for the single connection.
// In-process waiters queue here behind a holder that may take ~30 s.
const CONNECTION_TIMEOUT_MS = 40_000;

// Marks code running inside a locked transaction. With a one-connection
// pool, calling back into the repository from there would wait forever for
// the connection the transaction itself holds, so it fails fast instead.
// The store is a mutable token cleared when the transaction ends: async work
// spawned inside fn (timers, fire-and-forget chains) inherits the context,
// and must be free to use the repository once the lock is released.
const insideLock = new AsyncLocalStorage<{ active: boolean }>();

function assertNotReentered(): void {
  if (insideLock.getStore()?.active === true) {
    throw new Error(
      'credential repository re-entered inside withLockedCredential',
    );
  }
}

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS oauth_credentials (
  key           TEXT PRIMARY KEY,
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Side table, not columns: failure state must be recordable when no
-- credential row exists yet (oauth_credentials' tokens are NOT NULL).
CREATE TABLE IF NOT EXISTS oauth_credential_meta (
  key           TEXT PRIMARY KEY,
  member_id     TEXT CHECK (member_id ~ '^[0-9]{1,20}$'),
  failing_since TIMESTAMPTZ
);
`;

/**
 * Transaction-scoped advisory lock key guarding every write of the organizer
 * credential. Meetup may rotate refresh tokens (not documented; assume it
 * does), and then two processes refreshing at once (identity sweep, report
 * job, backfill dyno, dashboard renewal) means the second writer persists a
 * token Meetup has already invalidated. Every
 * process takes this lock before reading-to-refresh and holds it until the
 * successor is committed, so refreshes are strictly serialized.
 */
export const ORGANIZER_CREDENTIAL_LOCK = 7595882001;

export interface CredentialMeta {
  memberId: string | null;
  failingSince: Date | null;
}

/**
 * What a savepoint-scoped block came to: `value` when `ok`, else `error`
 * (never re-thrown). A plain shape: this project does not compile with
 * strictNullChecks, so a discriminated union would not narrow.
 */
export interface SavepointResult<T> {
  ok: boolean;
  value?: T;
  error?: unknown;
}

const SAVEPOINT_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** The credential as read under the lock, plus writes that stay inside it. */
export interface LockedCredential {
  current: Tokens | undefined;
  meta: CredentialMeta;
  /** Upserts oauth_credentials for this key, in the locked transaction. */
  write(tokens: Tokens): Promise<void>;
  /** Upserts oauth_credential_meta.member_id; digits only (CHECK). */
  setMemberId(memberId: string): Promise<void>;
  /** Locked markFailing: true iff this call started the episode. */
  markFailing(): Promise<boolean>;
  /** Locked clearFailing: true iff an episode was open. */
  clearFailing(): Promise<boolean>;
  /**
   * Runs `fn` inside SAVEPOINT `name` on the locked transaction: RELEASE on
   * success, ROLLBACK TO SAVEPOINT on a throw. A statement error inside `fn`
   * then undoes only `fn`'s own work instead of aborting the transaction, so
   * bookkeeping cannot cost the credential write. Never re-throws `fn`'s
   * error; rejects only for a `name` that is not a plain identifier.
   */
  savepoint<T>(name: string, fn: () => Promise<T>): Promise<SavepointResult<T>>;
}

export interface CredentialRepositoryOptions {
  /** Test-only override of the lock wait bound. */
  lockTimeoutMs?: number;
  /** Test-only: the pool's application_name, to find its backend in pg_stat_activity. */
  applicationName?: string;
}

interface CredentialRow {
  key: string;
  access_token: string;
  refresh_token: string;
  expires_at: Date;
}

interface MetaRow {
  member_id: string | null;
  failing_since: Date | null;
}

function toMeta(row: MetaRow | undefined): CredentialMeta {
  return {
    memberId: row?.member_id ?? null,
    failingSince: row?.failing_since ?? null,
  };
}

const UPSERT_CREDENTIAL_SQL = `INSERT INTO oauth_credentials (key, access_token, refresh_token, expires_at, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (key) DO UPDATE SET
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         expires_at = EXCLUDED.expires_at,
         updated_at = now()`;

const MARK_FAILING_SQL = `INSERT INTO oauth_credential_meta (key, failing_since) VALUES ($1, now())
       ON CONFLICT (key) DO UPDATE SET failing_since = now()
         WHERE oauth_credential_meta.failing_since IS NULL
       RETURNING key`;

const CLEAR_FAILING_SQL = `UPDATE oauth_credential_meta SET failing_since = NULL
        WHERE key = $1 AND failing_since IS NOT NULL`;

function toTokens(row: CredentialRow): Tokens {
  return {
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    expiresAt: row.expires_at.getTime(),
  };
}

export class PostgresCredentialRepository {
  private pool: pg.Pool;

  private schemaEnsured: Promise<void> | undefined;

  private readonly lockTimeoutMs: number;

  private static singleton: PostgresCredentialRepository;

  private constructor(options: CredentialRepositoryOptions = {}) {
    this.lockTimeoutMs = options.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'PostgresCredentialRepository requires DATABASE_URL to be set',
      );
    }
    const isLocal =
      connectionString.includes('localhost') ||
      connectionString.includes('127.0.0.1');
    this.pool = new pg.Pool({
      connectionString,
      application_name: options.applicationName,
      // This credential is read once per sweep, not per request -- a single
      // connection is enough and keeps this repository from competing with
      // the member and identity repositories for essential-0's 20 slots.
      max: 1,
      // Heroku Postgres requires TLS but uses certs node rejects by default
      ssl: isLocal ? undefined : { rejectUnauthorized: false },
      allowExitOnIdle: true, // lets test processes exit cleanly instead of waiting on idle clients
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    });
    // Heroku recycles idle connections; pg.Pool is an EventEmitter, so without
    // a listener the resulting 'error' event would crash the whole process --
    // taking onboarding and OAuth down with it. Learned in production on the
    // member repository; the same pattern applies here.
    this.pool.on('error', (error) => {
      logger.error(`Postgres pool error: ${String(error)}`);
    });
  }

  /**
   * Test-only: a second instance with its own pool (and so its own session),
   * standing in for another process racing the singleton for the lock.
   */
  static createIsolatedForTest(
    options?: CredentialRepositoryOptions,
  ): PostgresCredentialRepository {
    return new PostgresCredentialRepository(options);
  }

  /** Closes this instance's pool (test cleanup for isolated instances). */
  async end(): Promise<void> {
    await this.pool.end();
  }

  static async instance(): Promise<PostgresCredentialRepository> {
    if (!PostgresCredentialRepository.singleton) {
      PostgresCredentialRepository.singleton =
        new PostgresCredentialRepository();
    }
    await PostgresCredentialRepository.singleton.ensureSchema();
    return PostgresCredentialRepository.singleton;
  }

  private async ensureSchema(): Promise<void> {
    if (this.schemaEnsured === undefined) {
      this.schemaEnsured = this.pool.query(CREATE_TABLE_SQL).then(() => {
        logger.info('oauth_credentials schema ensured');
      });
    }
    try {
      // Two processes running this DDL at once on a fresh database can hit
      // Postgres's pg_type unique-key race on CREATE TABLE IF NOT EXISTS;
      // the loser's call rejects, and the retry on its next call finds the
      // tables already there.
      await this.schemaEnsured;
    } catch (error) {
      // Never cache a rejection: a Postgres blip at boot would otherwise
      // poison the singleton for the life of the dyno, so every sweep fails
      // permanently until someone restarts.
      this.schemaEnsured = undefined; // retry on next call
      throw error;
    }
  }

  /** Unlocked read. Never use it to decide whether to refresh. */
  async get(key: string): Promise<Tokens | undefined> {
    assertNotReentered();
    const result = await this.pool.query<CredentialRow>(
      'SELECT * FROM oauth_credentials WHERE key = $1',
      [key],
    );
    const row = result.rows[0];
    return row ? toTokens(row) : undefined;
  }

  /** Unlocked read of the credential's meta row (dashboard status). */
  async getMeta(key: string): Promise<CredentialMeta> {
    assertNotReentered();
    await this.ensureSchema();
    const result = await this.pool.query<MetaRow>(
      'SELECT member_id, failing_since FROM oauth_credential_meta WHERE key = $1',
      [key],
    );
    return toMeta(result.rows[0]);
  }

  /**
   * BEGIN; take the organizer advisory lock; read the credential and its meta;
   * run `fn`; COMMIT (ROLLBACK if `fn` throws). The lock is released with the
   * transaction, so a crashed process can never leave it held.
   *
   * Every key shares the one organizer lock, so all locked calls serialize.
   *
   * `fn` must not call back into this repository: the pool holds a single
   * connection, and this transaction owns it until `fn` settles. Doing so
   * rejects immediately instead of deadlocking.
   */
  async withLockedCredential<T>(
    key: string,
    fn: (locked: LockedCredential) => Promise<T>,
  ): Promise<T> {
    assertNotReentered();
    return this.inLockedTransaction(key, async (client) => {
      const credential = (
        await client.query<CredentialRow>(
          'SELECT * FROM oauth_credentials WHERE key = $1',
          [key],
        )
      ).rows[0];
      const meta = (
        await client.query<MetaRow>(
          'SELECT member_id, failing_since FROM oauth_credential_meta WHERE key = $1',
          [key],
        )
      ).rows[0];
      return fn({
        current: credential ? toTokens(credential) : undefined,
        meta: toMeta(meta),
        write: async (tokens) => {
          await client.query(UPSERT_CREDENTIAL_SQL, [
            key,
            tokens.accessToken,
            tokens.refreshToken,
            new Date(tokens.expiresAt ?? Date.now()),
          ]);
        },
        setMemberId: async (memberId) => {
          await client.query(
            `INSERT INTO oauth_credential_meta (key, member_id) VALUES ($1, $2)
             ON CONFLICT (key) DO UPDATE SET member_id = EXCLUDED.member_id`,
            [key, memberId],
          );
        },
        markFailing: async () =>
          (await client.query(MARK_FAILING_SQL, [key])).rowCount === 1,
        clearFailing: async () =>
          (await client.query(CLEAR_FAILING_SQL, [key])).rowCount === 1,
        savepoint: async <S>(
          name: string,
          run: () => Promise<S>,
        ): Promise<SavepointResult<S>> => {
          // Interpolated (SAVEPOINT takes no parameters), so it must be a
          // plain identifier.
          if (!SAVEPOINT_NAME.test(name)) {
            throw new Error(`Invalid savepoint name: ${JSON.stringify(name)}`);
          }
          try {
            await client.query(`SAVEPOINT ${name}`);
          } catch (error: unknown) {
            return { ok: false, error };
          }
          try {
            const value = await run();
            await client.query(`RELEASE SAVEPOINT ${name}`);
            return { ok: true, value };
          } catch (error: unknown) {
            // If this fails too the transaction stays aborted, and COMMIT
            // reports it as the rollback it is.
            await client
              .query(`ROLLBACK TO SAVEPOINT ${name}`)
              .catch(() => undefined);
            return { ok: false, error };
          }
        },
      });
    });
  }

  /**
   * Runs `fn` inside one transaction holding the organizer lock, on the
   * pool's own client. Everything in `fn` must use that client: a
   * `this.pool.query` would wait forever for the pool's only connection.
   * The client handed to `fn` refuses queries once the transaction ends, so a
   * write leaked past `fn` can never land outside the lock.
   */
  private async inLockedTransaction<T>(
    key: string,
    fn: (client: Pick<pg.PoolClient, 'query'>) => Promise<T>,
  ): Promise<T> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    let open = true;
    // Set when the connection is known bad (backend died, or ROLLBACK
    // failed): destroy it rather than hand it back to a pool whose only slot
    // every later sweep depends on.
    let broken = false;
    let connectionError: Error | undefined;
    // pg-pool drops its idle 'error' listener while a client is checked out,
    // so a backend dying mid-transaction (terminated, idle timeout, network)
    // would emit an unhandled 'error' and crash the process. Handle it here.
    const onError = (error: Error): void => {
      logger.error(
        `Postgres connection lost inside the credential lock: ${error.name}`,
      );
      connectionError = error;
      broken = true;
      open = false;
    };
    client.on('error', onError);
    const lockToken = { active: true };
    const guarded = {
      query: ((...args: Parameters<pg.PoolClient['query']>) => {
        if (connectionError) {
          return Promise.reject(
            new Error(
              `Credential transaction lost its database connection: ${connectionError.name}`,
            ),
          );
        }
        if (!open) {
          return Promise.reject(
            new Error(
              `Locked credential transaction for ${key} has ended; write inside withLockedCredential`,
            ),
          );
        }
        return (client.query as (...a: unknown[]) => unknown)(...args);
      }) as pg.PoolClient['query'],
    };
    try {
      // READ COMMITTED explicitly: every statement after the lock sees a
      // fresh snapshot, so the read below includes the previous holder's
      // committed write.
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query(
        `SELECT set_config('lock_timeout', $1, true),
                set_config('idle_in_transaction_session_timeout', $2, true)`,
        [`${this.lockTimeoutMs}ms`, `${IDLE_IN_TRANSACTION_TIMEOUT_MS}ms`],
      );
      await client.query('SELECT pg_advisory_xact_lock($1)', [
        ORGANIZER_CREDENTIAL_LOCK,
      ]);
      // Deactivate as soon as fn settles, not after COMMIT: work fn spawned
      // may run while COMMIT is in flight, and should simply wait for the
      // connection rather than be refused as re-entry.
      const result = await insideLock
        .run(lockToken, () => fn(guarded))
        .finally(() => {
          lockToken.active = false;
        });
      open = false;
      // A statement error inside fn aborts the transaction even when fn
      // catches it, and COMMIT then answers ROLLBACK without raising. Report
      // that as the failure it is, not as a successful write.
      const commit = await client.query('COMMIT');
      if (commit.command === 'ROLLBACK') {
        throw new Error(
          'Credential transaction was rolled back by the database',
        );
      }
      return result;
    } catch (error) {
      open = false;
      if (!broken) {
        await client.query('ROLLBACK').catch(() => {
          broken = true;
        });
      }
      throw error;
    } finally {
      lockToken.active = false;
      client.removeListener('error', onError);
      client.release(broken);
    }
  }

  /** Locked upsert: waits for any in-flight refresh to commit first. */
  async put(key: string, tokens: Tokens): Promise<void> {
    assertNotReentered();
    await this.withLockedCredential(key, (locked) => locked.write(tokens));
  }

  /** Locked delete of the credential row only; its meta row is kept. */
  async clear(key: string): Promise<void> {
    assertNotReentered();
    await this.inLockedTransaction(key, async (client) => {
      await client.query('DELETE FROM oauth_credentials WHERE key = $1', [key]);
    });
  }

  /**
   * Opens a failure episode: sets failing_since = now() only if it is null.
   * True iff this call started the episode (so exactly one caller alerts).
   */
  async markFailing(key: string): Promise<boolean> {
    assertNotReentered();
    await this.ensureSchema();
    const result = await this.pool.query(MARK_FAILING_SQL, [key]);
    return result.rowCount === 1;
  }

  /** Closes a failure episode. True iff one was open. */
  async clearFailing(key: string): Promise<boolean> {
    assertNotReentered();
    await this.ensureSchema();
    const result = await this.pool.query(CLEAR_FAILING_SQL, [key]);
    return result.rowCount === 1;
  }
}
