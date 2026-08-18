import pg from 'pg';
import { Logger } from 'tslog';

import {
  ChangeSource,
  IdentityChange,
  IdentityChangeMetadata,
  IdentityChangeRecord,
  IdentityField,
  IdentityPlatform,
  IdentitySnapshot,
} from './identityTypes.js';

const logger = new Logger({ name: 'PostgresIdentityRepository' });

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS member_identity (
  scope_id           TEXT NOT NULL,
  discord_user_id    TEXT NOT NULL,
  username           TEXT,
  global_name        TEXT,
  nickname           TEXT,
  user_avatar_hash   TEXT,
  member_avatar_hash TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, discord_user_id)
);
CREATE TABLE IF NOT EXISTS member_identity_changes (
  id           BIGSERIAL PRIMARY KEY,
  platform     TEXT NOT NULL,
  scope_id     TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  field        TEXT NOT NULL,
  old_value    TEXT,
  new_value    TEXT,
  old_thumb    BYTEA,
  new_thumb    BYTEA,
  detected_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  source       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS member_identity_changes_detected_at_idx
  ON member_identity_changes (detected_at);
CREATE INDEX IF NOT EXISTS member_identity_changes_subject_idx
  ON member_identity_changes (platform, scope_id, subject_id, detected_at DESC);
`;

interface SnapshotRow {
  scope_id: string;
  discord_user_id: string;
  username: string | null;
  global_name: string | null;
  nickname: string | null;
  user_avatar_hash: string | null;
  member_avatar_hash: string | null;
}

interface MetadataRow {
  id: string;
  platform: IdentityPlatform;
  scope_id: string;
  subject_id: string;
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
    scopeId: row.scope_id,
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
    platform: row.platform,
    scopeId: row.scope_id,
    subjectId: row.subject_id,
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
      // The member repository already takes 5 of essential-0's 20
      // connections, and a deploy briefly doubles both across overlapping
      // dynos; the backfill script also opens its own pool on top of
      // whatever's running. 2 leaves enough headroom for all of that at once.
      max: 2,
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
    scopeId: string,
    discordUserId: string,
  ): Promise<IdentitySnapshot | undefined> {
    const result = await this.pool.query<SnapshotRow>(
      'SELECT * FROM member_identity WHERE scope_id = $1 AND discord_user_id = $2',
      [scopeId, discordUserId],
    );
    const row = result.rows[0];
    return row ? toSnapshot(row) : undefined;
  }

  async putSnapshot(snapshot: IdentitySnapshot): Promise<void> {
    await this.pool.query(
      `INSERT INTO member_identity (scope_id, discord_user_id, username,
         global_name, nickname, user_avatar_hash, member_avatar_hash, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (scope_id, discord_user_id) DO UPDATE SET
         username = EXCLUDED.username,
         global_name = EXCLUDED.global_name,
         nickname = EXCLUDED.nickname,
         user_avatar_hash = EXCLUDED.user_avatar_hash,
         member_avatar_hash = EXCLUDED.member_avatar_hash,
         updated_at = now()`,
      [
        snapshot.scopeId,
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
      const thumb = thumbs.get(
        `${change.platform}:${change.scopeId}:${change.subjectId}:${change.field}`,
      );
      // Sequential rather than Promise.all: these share one small pool and a
      // burst from the sweep would otherwise exhaust it.
      // eslint-disable-next-line no-await-in-loop
      await this.pool.query(
        `INSERT INTO member_identity_changes (platform, scope_id, subject_id,
           field, old_value, new_value, old_thumb, new_thumb, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          change.platform,
          change.scopeId,
          change.subjectId,
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
  async listChangesMetadataBetween(
    from: Date,
    to: Date,
  ): Promise<IdentityChangeMetadata[]> {
    const result = await this.pool.query<MetadataRow>(
      `SELECT id, platform, scope_id, subject_id, field, old_value, new_value,
              detected_at, source
         FROM member_identity_changes
        WHERE detected_at >= $1 AND detected_at < $2
        ORDER BY detected_at ASC`,
      [from, to],
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

  /**
   * Row count and total thumbnail bytes for a range, without transferring a
   * single thumbnail. The report command uses this to refuse an oversized
   * window BEFORE the rows -- and their base64 expansion, and the assembled
   * document, and writeFileSync's copy -- are all resident on a 512 MB dyno.
   */
  async measureChangesBetween(
    from: Date,
    to: Date,
  ): Promise<{ changeCount: number; thumbBytes: number }> {
    const result = await this.pool.query<{ bytes: string; count: string }>(
      `SELECT count(*)::text AS count,
              coalesce(sum(coalesce(octet_length(old_thumb), 0)
                         + coalesce(octet_length(new_thumb), 0)), 0)::text
                AS bytes
         FROM member_identity_changes
        WHERE detected_at >= $1 AND detected_at < $2`,
      [from, to],
    );
    return {
      changeCount: Number(result.rows[0].count),
      thumbBytes: Number(result.rows[0].bytes),
    };
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

  /**
   * Erases one member's identity history and baseline. Deliberately never
   * called automatically -- like pruneChangesBefore, using it is a considered
   * act, because this data is impersonation evidence.
   */
  async deleteMemberIdentity(
    platform: IdentityPlatform,
    scopeId: string,
    subjectId: string,
  ): Promise<number> {
    const changes = await this.pool.query(
      `DELETE FROM member_identity_changes
       WHERE platform = $1 AND scope_id = $2 AND subject_id = $3`,
      [platform, scopeId, subjectId],
    );
    if (platform === 'discord') {
      await this.pool.query(
        'DELETE FROM member_identity WHERE scope_id = $1 AND discord_user_id = $2',
        [scopeId, subjectId],
      );
    }
    return changes.rowCount ?? 0;
  }
}
