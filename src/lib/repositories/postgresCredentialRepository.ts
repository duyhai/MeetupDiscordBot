import pg from 'pg';
import { Logger } from 'tslog';

import { Tokens } from '../client/discord/types.js';

const logger = new Logger({ name: 'PostgresCredentialRepository' });

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
 * credential. Meetup rotates refresh tokens, so two processes refreshing at
 * once (identity sweep, report job, backfill dyno, dashboard renewal) means
 * the second writer persists a token Meetup has already invalidated. Every
 * process takes this lock before reading-to-refresh and holds it until the
 * successor is committed, so refreshes are strictly serialized.
 */
export const ORGANIZER_CREDENTIAL_LOCK = 7595882001;

export interface CredentialMeta {
  memberId: string | null;
  failingSince: Date | null;
}

/** The credential as read under the lock, plus writes that stay inside it. */
export interface LockedCredential {
  current: Tokens | undefined;
  meta: CredentialMeta;
  /** Upserts oauth_credentials for this key, in the locked transaction. */
  write(tokens: Tokens): Promise<void>;
  /** Upserts oauth_credential_meta.member_id; digits only (CHECK). */
  setMemberId(memberId: string): Promise<void>;
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

  private static singleton: PostgresCredentialRepository;

  private constructor() {
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
      // This credential is read once per sweep, not per request -- a single
      // connection is enough and keeps this repository from competing with
      // the member and identity repositories for essential-0's 20 slots.
      max: 1,
      // Heroku Postgres requires TLS but uses certs node rejects by default
      ssl: isLocal ? undefined : { rejectUnauthorized: false },
      allowExitOnIdle: true, // lets test processes exit cleanly instead of waiting on idle clients
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
  static createIsolatedForTest(): PostgresCredentialRepository {
    return new PostgresCredentialRepository();
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
    const result = await this.pool.query<CredentialRow>(
      'SELECT * FROM oauth_credentials WHERE key = $1',
      [key],
    );
    const row = result.rows[0];
    return row ? toTokens(row) : undefined;
  }

  /** Unlocked read of the credential's meta row (dashboard status). */
  async getMeta(key: string): Promise<CredentialMeta> {
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
   * `fn` must not call back into this repository: the pool holds a single
   * connection, and this transaction owns it until `fn` settles.
   */
  async withLockedCredential<T>(
    key: string,
    fn: (locked: LockedCredential) => Promise<T>,
  ): Promise<T> {
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
    const guarded = {
      query: ((...args: Parameters<pg.PoolClient['query']>) => {
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
    // Set when ROLLBACK itself fails: the connection is in an unknown state
    // (likely dead), so destroy it rather than hand it back to a pool whose
    // only slot every later sweep depends on.
    let broken = false;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [
        ORGANIZER_CREDENTIAL_LOCK,
      ]);
      const result = await fn(guarded);
      open = false;
      await client.query('COMMIT');
      return result;
    } catch (error) {
      open = false;
      await client.query('ROLLBACK').catch(() => {
        broken = true;
      });
      throw error;
    } finally {
      client.release(broken);
    }
  }

  /** Locked upsert: waits for any in-flight refresh to commit first. */
  async put(key: string, tokens: Tokens): Promise<void> {
    await this.withLockedCredential(key, (locked) => locked.write(tokens));
  }

  /** Locked delete of the credential row only; its meta row is kept. */
  async clear(key: string): Promise<void> {
    await this.inLockedTransaction(key, async (client) => {
      await client.query('DELETE FROM oauth_credentials WHERE key = $1', [key]);
    });
  }

  /**
   * Opens a failure episode: sets failing_since = now() only if it is null.
   * True iff this call started the episode (so exactly one caller alerts).
   */
  async markFailing(key: string): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.pool.query(
      `INSERT INTO oauth_credential_meta (key, failing_since) VALUES ($1, now())
       ON CONFLICT (key) DO UPDATE SET failing_since = now()
         WHERE oauth_credential_meta.failing_since IS NULL
       RETURNING key`,
      [key],
    );
    return result.rowCount === 1;
  }

  /** Closes a failure episode. True iff one was open. */
  async clearFailing(key: string): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.pool.query(
      `UPDATE oauth_credential_meta SET failing_since = NULL
        WHERE key = $1 AND failing_since IS NOT NULL`,
      [key],
    );
    return result.rowCount === 1;
  }
}
