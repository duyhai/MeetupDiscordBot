import pg from 'pg';
import { Logger } from 'tslog';

import {
  ChangeSource,
  IdentityChange,
  IdentityChangeMetadata,
  IdentityChangeRecord,
  IdentityField,
  IdentitySnapshot,
} from './identityTypes.js';

const logger = new Logger({ name: 'PostgresIdentityRepository' });

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS member_identity (
  discord_user_id    TEXT PRIMARY KEY,
  username           TEXT,
  global_name        TEXT,
  nickname           TEXT,
  user_avatar_hash   TEXT,
  member_avatar_hash TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS member_identity_changes (
  id              BIGSERIAL PRIMARY KEY,
  discord_user_id TEXT NOT NULL,
  field           TEXT NOT NULL,
  old_value       TEXT,
  new_value       TEXT,
  old_thumb       BYTEA,
  new_thumb       BYTEA,
  detected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  source          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS member_identity_changes_detected_at_idx
  ON member_identity_changes (detected_at);
CREATE INDEX IF NOT EXISTS member_identity_changes_user_field_idx
  ON member_identity_changes (discord_user_id, field, detected_at DESC);
`;

interface SnapshotRow {
  discord_user_id: string;
  username: string | null;
  global_name: string | null;
  nickname: string | null;
  user_avatar_hash: string | null;
  member_avatar_hash: string | null;
}

interface MetadataRow {
  id: string;
  discord_user_id: string;
  field: IdentityField;
  old_value: string | null;
  new_value: string | null;
  detected_at: Date;
  source: ChangeSource;
}

interface ChangeRow extends MetadataRow {
  old_thumb: Buffer | null;
  new_thumb: Buffer | null;
}

function toSnapshot(row: SnapshotRow): IdentitySnapshot {
  return {
    discordUserId: row.discord_user_id,
    username: row.username,
    globalName: row.global_name,
    nickname: row.nickname,
    userAvatarHash: row.user_avatar_hash,
    memberAvatarHash: row.member_avatar_hash,
  };
}

function toChangeMetadata(row: MetadataRow): IdentityChangeMetadata {
  return {
    id: row.id,
    discordUserId: row.discord_user_id,
    field: row.field,
    oldValue: row.old_value,
    newValue: row.new_value,
    detectedAt: row.detected_at,
    source: row.source,
  };
}

function toChangeRecord(row: ChangeRow): IdentityChangeRecord {
  return {
    ...toChangeMetadata(row),
    oldThumb: row.old_thumb,
    newThumb: row.new_thumb,
  };
}

export class PostgresIdentityRepository {
  private pool: pg.Pool;

  private schemaEnsured: Promise<void> | undefined;

  private static singleton: PostgresIdentityRepository;

  private constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'PostgresIdentityRepository requires DATABASE_URL to be set',
      );
    }
    const isLocal =
      connectionString.includes('localhost') ||
      connectionString.includes('127.0.0.1');
    this.pool = new pg.Pool({
      connectionString,
      max: 3,
      // Heroku Postgres requires TLS but uses certs node rejects by default
      ssl: isLocal ? undefined : { rejectUnauthorized: false },
      allowExitOnIdle: true, // lets test processes exit cleanly instead of waiting on idle clients
    });
    // Heroku recycles idle connections; pg.Pool is an EventEmitter, so without
    // a listener the resulting 'error' event would crash the whole process --
    // taking onboarding and OAuth down with identity monitoring. Learned in
    // production on the member repository; the same pattern applies here.
    this.pool.on('error', (error) => {
      logger.error(`Postgres pool error: ${String(error)}`);
    });
  }

  static async instance(): Promise<PostgresIdentityRepository> {
    if (!PostgresIdentityRepository.singleton) {
      PostgresIdentityRepository.singleton = new PostgresIdentityRepository();
    }
    await PostgresIdentityRepository.singleton.ensureSchema();
    return PostgresIdentityRepository.singleton;
  }

  private async ensureSchema(): Promise<void> {
    if (this.schemaEnsured === undefined) {
      this.schemaEnsured = this.pool.query(CREATE_TABLE_SQL).then(() => {
        logger.info('member_identity schema ensured');
      });
    }
    try {
      await this.schemaEnsured;
    } catch (error) {
      // Never cache a rejection: a Postgres blip at boot would otherwise
      // poison the singleton for the life of the dyno, so the sweep, the
      // digest and the report all fail permanently until someone restarts.
      this.schemaEnsured = undefined; // retry on next call
      throw error;
    }
  }

  async getSnapshot(
    discordUserId: string,
  ): Promise<IdentitySnapshot | undefined> {
    const result = await this.pool.query<SnapshotRow>(
      'SELECT * FROM member_identity WHERE discord_user_id = $1',
      [discordUserId],
    );
    const row = result.rows[0];
    return row ? toSnapshot(row) : undefined;
  }

  async putSnapshot(snapshot: IdentitySnapshot): Promise<void> {
    await this.pool.query(
      `INSERT INTO member_identity (discord_user_id, username, global_name,
         nickname, user_avatar_hash, member_avatar_hash, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (discord_user_id) DO UPDATE SET
         username = EXCLUDED.username,
         global_name = EXCLUDED.global_name,
         nickname = EXCLUDED.nickname,
         user_avatar_hash = EXCLUDED.user_avatar_hash,
         member_avatar_hash = EXCLUDED.member_avatar_hash,
         updated_at = now()`,
      [
        snapshot.discordUserId,
        snapshot.username,
        snapshot.globalName,
        snapshot.nickname,
        snapshot.userAvatarHash,
        snapshot.memberAvatarHash,
      ],
    );
  }

  async recordChanges(
    changes: IdentityChange[],
    source: ChangeSource,
    thumbs: Map<string, { oldThumb: Buffer | null; newThumb: Buffer | null }>,
  ): Promise<void> {
    for (const change of changes) {
      const thumb = thumbs.get(`${change.discordUserId}:${change.field}`);
      // Sequential rather than Promise.all: these share one small pool and a
      // burst from the sweep would otherwise exhaust it.
      // eslint-disable-next-line no-await-in-loop
      await this.pool.query(
        `INSERT INTO member_identity_changes (discord_user_id, field,
           old_value, new_value, old_thumb, new_thumb, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          change.discordUserId,
          change.field,
          change.oldValue,
          change.newValue,
          thumb?.oldThumb ?? null,
          thumb?.newThumb ?? null,
          source,
        ],
      );
    }
  }

  /**
   * Metadata only -- no thumbnails. This feeds the text digest, which never
   * renders an image; `SELECT *` here would drag every BYTEA thumb from the
   * last 24h into memory on a dyno with an R14 history.
   */
  async listChangesSince(since: Date): Promise<IdentityChangeMetadata[]> {
    const result = await this.pool.query<MetadataRow>(
      `SELECT id, discord_user_id, field, old_value, new_value,
              detected_at, source
         FROM member_identity_changes
        WHERE detected_at >= $1 ORDER BY detected_at ASC`,
      [since],
    );
    return result.rows.map(toChangeMetadata);
  }

  async listChangesBetween(
    from: Date,
    to: Date,
  ): Promise<IdentityChangeRecord[]> {
    const result = await this.pool.query<ChangeRow>(
      `SELECT * FROM member_identity_changes
       WHERE detected_at >= $1 AND detected_at < $2
       ORDER BY detected_at ASC`,
      [from, to],
    );
    return result.rows.map(toChangeRecord);
  }

  async storageStats(): Promise<{ changeCount: number; totalBytes: number }> {
    const result = await this.pool.query<{ count: string; bytes: string }>(
      `SELECT (SELECT count(*) FROM member_identity_changes)::text AS count,
              (pg_total_relation_size('member_identity_changes')
               + pg_total_relation_size('member_identity'))::text AS bytes`,
    );
    return {
      changeCount: Number(result.rows[0].count),
      totalBytes: Number(result.rows[0].bytes),
    };
  }

  /**
   * Deletes changes older than the cutoff. Deliberately never scheduled: at
   * the measured sizes pruning saves nothing worth the risk of destroying
   * evidence, so removing history stays a deliberate act.
   */
  async pruneChangesBefore(cutoff: Date): Promise<number> {
    const result = await this.pool.query(
      'DELETE FROM member_identity_changes WHERE detected_at < $1',
      [cutoff],
    );
    return result.rowCount ?? 0;
  }
}
