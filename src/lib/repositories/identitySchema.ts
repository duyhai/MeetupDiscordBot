/**
 * The identity-monitoring schema, and the migration that brings an older
 * deployment of it up to date.
 *
 * ONE-WAY MIGRATION. An earlier version of this feature (PR #61) reached
 * production with `member_identity` keyed by `discord_user_id` alone and
 * `member_identity_changes` holding a `discord_user_id` column and no
 * platform/scope. The steps below reshape those live tables in place. Once
 * they have run, the pre-migration code can no longer read or write these
 * tables (its column and conflict target are gone), so rolling back the
 * deploy is NOT a rollback of the schema. Reverting would need a hand-written
 * reverse migration; nothing here provides one.
 *
 * Why migrate rather than recreate: `member_identity_changes` holds real
 * impersonation evidence -- rows, their ids, and before-image bytes that
 * cannot be fetched again because Discord purges superseded avatars. Every
 * row, id and thumbnail byte must survive. Ids in particular: the digest's
 * high-water mark keys on them.
 *
 * Safe to run on (a) an empty database, (b) the old production schema, and
 * (c) an already-migrated database. Every step is either naturally idempotent
 * (IF [NOT] EXISTS, `WHERE ... IS NULL`, SET NOT NULL) or guarded by a catalog
 * check.
 */
import pg from 'pg';

/**
 * The target schema. On a fresh database this creates everything; on a
 * migrated one every statement is a no-op.
 */
export const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS member_identity (
  scope_id            TEXT NOT NULL,
  discord_user_id     TEXT NOT NULL,
  username            TEXT,
  global_name         TEXT,
  nickname            TEXT,
  user_avatar_hash    TEXT,
  member_avatar_hash  TEXT,
  -- The 64px image behind each hash above, fetched once and kept. This is
  -- where a change's *before* picture comes from: Discord purges superseded
  -- avatars, so re-fetching the old hash at change time 404s. Nullable --
  -- thumbnails stay best-effort and a change is recorded without them.
  user_avatar_thumb   BYTEA,
  member_avatar_thumb BYTEA,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
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
CREATE TABLE IF NOT EXISTS meetup_identity (
  scope_id          TEXT NOT NULL,
  meetup_member_id  TEXT NOT NULL,
  name              TEXT,
  username          TEXT,
  photo_id          TEXT,
  -- The image behind photo_id. Meetup's baseline keeps an id, never the URL
  -- that served it, so a superseded photo is unreachable the moment it
  -- changes; storing the bytes here is the only source of a before-image.
  photo_thumb       BYTEA,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, meetup_member_id)
);
CREATE TABLE IF NOT EXISTS identity_digest_state (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

/**
 * Arbitrary but fixed. Every dyno must use the same key: during a Heroku
 * deploy the old and new dynos overlap, and two new-code processes (web
 * restart + the digest, or two web dynos) can both reach ensureSchema at
 * once. Without the lock both would race ALTERs on the same tables; with it
 * the second waits, then finds every step already done and no-ops.
 */
export const IDENTITY_SCHEMA_LOCK_KEY = '7350126104981';

/**
 * Runs BEFORE the target DDL, because the target's subject index names
 * columns (platform, scope_id, subject_id) that the old changes table does
 * not have yet -- `CREATE INDEX IF NOT EXISTS` would fail against it.
 *
 * Every statement tolerates the tables not existing at all (fresh database).
 */
const PRE_TARGET_STEPS: string[] = [
  // Old member_identity: add the scope column (backfilled below, after the
  // target DDL guarantees the table exists) and the two thumb columns. The
  // thumbs stay NULL; the sweeps heal them over the following days.
  `ALTER TABLE IF EXISTS member_identity
     ADD COLUMN IF NOT EXISTS scope_id TEXT,
     ADD COLUMN IF NOT EXISTS user_avatar_thumb BYTEA,
     ADD COLUMN IF NOT EXISTS member_avatar_thumb BYTEA`,

  // Old member_identity_changes: discord_user_id becomes the platform-neutral
  // subject_id. A RENAME, not add-copy-drop, so no row is rewritten for it.
  // Only when the old column is still there -- Postgres has no
  // RENAME COLUMN IF EXISTS. to_regclass() resolves through search_path, the
  // same way the unqualified table names everywhere else do.
  `DO $$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM pg_attribute
        WHERE attrelid = to_regclass('member_identity_changes')
          AND attname = 'discord_user_id'
          AND NOT attisdropped
     ) THEN
       ALTER TABLE member_identity_changes
         RENAME COLUMN discord_user_id TO subject_id;
     END IF;
   END $$`,

  `ALTER TABLE IF EXISTS member_identity_changes
     ADD COLUMN IF NOT EXISTS platform TEXT,
     ADD COLUMN IF NOT EXISTS scope_id TEXT`,

  // The old per-user index is superseded by the target's subject index
  // (created by the target DDL). Dropping it is safe: it holds no data.
  `DROP INDEX IF EXISTS member_identity_changes_user_field_idx`,
];

/**
 * Runs AFTER the target DDL, so every table exists. `$1` is the Discord
 * guild id: every pre-migration row came from the one guild this bot has
 * ever monitored, so it is the only correct scope for them.
 */
const POST_TARGET_STEPS: { sql: string; withScope: boolean }[] = [
  // Backfills touch only rows still NULL, so a re-run rewrites nothing.
  {
    sql: 'UPDATE member_identity SET scope_id = $1 WHERE scope_id IS NULL',
    withScope: true,
  },
  {
    sql: `UPDATE member_identity_changes SET platform = 'discord'
           WHERE platform IS NULL`,
    withScope: false,
  },
  {
    sql: `UPDATE member_identity_changes SET scope_id = $1
           WHERE scope_id IS NULL`,
    withScope: true,
  },
  // Now that nothing is NULL, enforce the target's constraints. SET NOT NULL
  // on an already-NOT-NULL column is a no-op.
  {
    sql: 'ALTER TABLE member_identity ALTER COLUMN scope_id SET NOT NULL',
    withScope: false,
  },
  {
    sql: `ALTER TABLE member_identity_changes
            ALTER COLUMN platform SET NOT NULL,
            ALTER COLUMN scope_id SET NOT NULL`,
    withScope: false,
  },
  // The target's column defaults. PR #61's DDL already declared both, so on
  // production these are expected no-ops -- but the new write paths rely on
  // them (recordChanges never supplies detected_at), and a table that lacked
  // one would reject every new change row. Cheap to guarantee here.
  {
    sql: `ALTER TABLE member_identity_changes
            ALTER COLUMN detected_at SET DEFAULT now()`,
    withScope: false,
  },
  {
    sql: `ALTER TABLE member_identity
            ALTER COLUMN updated_at SET DEFAULT now()`,
    withScope: false,
  },
  // Primary key swap: (discord_user_id) -> (scope_id, discord_user_id). The
  // new code's upsert is `ON CONFLICT (scope_id, discord_user_id)`, which
  // Postgres rejects outright unless a matching unique constraint exists.
  // Skipped when the current PK already includes scope_id (fresh or migrated
  // database). The old constraint's name is looked up rather than assumed.
  {
    sql: `DO $$
          DECLARE
            old_pk TEXT;
          BEGIN
            IF NOT EXISTS (
              SELECT 1
                FROM pg_constraint c
                JOIN pg_attribute a
                  ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
               WHERE c.conrelid = to_regclass('member_identity')
                 AND c.contype = 'p'
                 AND a.attname = 'scope_id'
            ) THEN
              SELECT conname INTO old_pk
                FROM pg_constraint
               WHERE conrelid = to_regclass('member_identity')
                 AND contype = 'p';
              IF old_pk IS NOT NULL THEN
                EXECUTE format('ALTER TABLE member_identity DROP CONSTRAINT %I',
                               old_pk);
              END IF;
              ALTER TABLE member_identity
                ADD CONSTRAINT member_identity_pkey
                PRIMARY KEY (scope_id, discord_user_id);
            END IF;
          END $$`,
    withScope: false,
  },
];

/**
 * Brings the identity tables to the target schema in ONE transaction,
 * serialized across processes by a transaction-scoped advisory lock (released
 * automatically at COMMIT/ROLLBACK, so a crashed dyno cannot leave it held).
 *
 * All or nothing: if any step fails, the whole migration rolls back and the
 * tables are left exactly as they were, and the caller retries on the next
 * ensureSchema call.
 */
export async function migrateIdentitySchema(
  client: pg.ClientBase,
  discordScopeId: string,
): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [
      IDENTITY_SCHEMA_LOCK_KEY,
    ]);
    for (const step of PRE_TARGET_STEPS) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(step);
    }
    await client.query(CREATE_TABLE_SQL);
    for (const step of POST_TARGET_STEPS) {
      // Parameterized, never interpolated: the scope only ever enters SQL as
      // a bound value.
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        step.sql,
        step.withScope ? [discordScopeId] : undefined,
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
