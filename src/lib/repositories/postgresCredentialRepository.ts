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
`;

interface CredentialRow {
  key: string;
  access_token: string;
  refresh_token: string;
  expires_at: Date;
}

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

  async get(key: string): Promise<Tokens | undefined> {
    const result = await this.pool.query<CredentialRow>(
      'SELECT * FROM oauth_credentials WHERE key = $1',
      [key],
    );
    const row = result.rows[0];
    return row ? toTokens(row) : undefined;
  }

  async put(key: string, tokens: Tokens): Promise<void> {
    await this.pool.query(
      `INSERT INTO oauth_credentials (key, access_token, refresh_token, expires_at, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (key) DO UPDATE SET
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         expires_at = EXCLUDED.expires_at,
         updated_at = now()`,
      [
        key,
        tokens.accessToken,
        tokens.refreshToken,
        new Date(tokens.expiresAt ?? Date.now()),
      ],
    );
  }

  async clear(key: string): Promise<void> {
    await this.pool.query('DELETE FROM oauth_credentials WHERE key = $1', [
      key,
    ]);
  }
}
