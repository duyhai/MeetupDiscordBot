import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GUILD_ID } from '../../src/constants.js';
import { migrateIdentitySchema } from '../../src/lib/repositories/identitySchema.js';
import { PostgresIdentityRepository } from '../../src/lib/repositories/postgresIdentityRepository.js';

// Migrates a copy of the schema PR #61 left in production, with live-shaped
// rows, and checks that every row, id and thumbnail byte survives.
//
// ISOLATION: everything here lives in a dedicated Postgres schema,
// `identity_migration_test`, dropped and recreated in beforeAll. The other
// integration suites share this database and use `public`, where the
// identity tables already exist in their TARGET shape -- running the old DDL
// there would break them (and they would break this). The repository under
// test is pointed at the dedicated schema through the connection string's
// `options=-c search_path=...`; vitest gives each test file its own module
// registry, so this file's PostgresIdentityRepository singleton is not the
// one the other suites use.
const POSTGRES_AVAILABLE = Boolean(process.env.DATABASE_URL);

if (!POSTGRES_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    'Skipping identity schema migration tests: set DATABASE_URL to a reachable Postgres to run them.',
  );
}

const TEST_SCHEMA = 'identity_migration_test';

// Production's pre-migration shape as read from the live database. The
// read-out listed no column defaults, so none are declared here -- the
// stricter case. (PR #61's DDL did declare DEFAULT now() on both timestamp
// columns; the migration guarantees those defaults either way.)
const OLD_SCHEMA_SQL = `
CREATE TABLE member_identity (
  discord_user_id    TEXT NOT NULL,
  username           TEXT,
  global_name        TEXT,
  nickname           TEXT,
  user_avatar_hash   TEXT,
  member_avatar_hash TEXT,
  updated_at         TIMESTAMPTZ NOT NULL,
  CONSTRAINT member_identity_pkey PRIMARY KEY (discord_user_id)
);
CREATE TABLE member_identity_changes (
  id              BIGSERIAL,
  discord_user_id TEXT NOT NULL,
  field           TEXT NOT NULL,
  old_value       TEXT,
  new_value       TEXT,
  old_thumb       BYTEA,
  new_thumb       BYTEA,
  detected_at     TIMESTAMPTZ NOT NULL,
  source          TEXT NOT NULL,
  CONSTRAINT member_identity_changes_pkey PRIMARY KEY (id)
);
CREATE INDEX member_identity_changes_detected_at_idx
  ON member_identity_changes (detected_at);
CREATE INDEX member_identity_changes_user_field_idx
  ON member_identity_changes (discord_user_id, field, detected_at DESC);
`;

/** House precedent: high bytes that a string coercion would corrupt. */
const OLD_THUMB = Buffer.from([0x52, 0x49, 0x46, 0x46, 0xff, 0x00, 0x89, 0xfe]);
const NEW_THUMB = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0xfd, 0xfc]);

interface ChangeRowSnapshot {
  id: string;
  subject_id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  old_thumb: Buffer | null;
  new_thumb: Buffer | null;
  detected_at: Date;
  source: string;
  platform: string;
  scope_id: string;
}

function withSearchPath(url: string, schema: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('options', `-c search_path=${schema}`);
  return parsed.toString();
}

describe.skipIf(!POSTGRES_AVAILABLE)('identity schema migration', () => {
  const originalUrl = process.env.DATABASE_URL;
  let admin: pg.Pool;
  let scoped: pg.Pool;
  let repo: PostgresIdentityRepository;
  const oldIds: string[] = [];

  async function readChanges(): Promise<ChangeRowSnapshot[]> {
    const result = await scoped.query<ChangeRowSnapshot>(
      `SELECT id::text AS id, subject_id, field, old_value, new_value,
              old_thumb, new_thumb, detected_at, source, platform, scope_id
         FROM member_identity_changes ORDER BY id`,
    );
    return result.rows;
  }

  async function indexNames(): Promise<string[]> {
    const result = await scoped.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = $1 AND tablename = 'member_identity_changes'
        ORDER BY indexname`,
      [TEST_SCHEMA],
    );
    return result.rows.map((row) => row.indexname);
  }

  async function primaryKeyColumns(): Promise<string[]> {
    const result = await scoped.query<{ attname: string }>(
      `SELECT a.attname
         FROM pg_constraint c
         CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a
           ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.conrelid = to_regclass('member_identity') AND c.contype = 'p'
        ORDER BY k.ord`,
    );
    return result.rows.map((row) => row.attname);
  }

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: originalUrl, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${TEST_SCHEMA}`);

    const scopedUrl = withSearchPath(originalUrl, TEST_SCHEMA);
    scoped = new pg.Pool({ connectionString: scopedUrl, max: 1 });
    await scoped.query(OLD_SCHEMA_SQL);

    await scoped.query(
      `INSERT INTO member_identity (discord_user_id, username, global_name,
         nickname, user_avatar_hash, member_avatar_hash, updated_at)
       VALUES ('u1', 'someone', 'Someone', 'Some One', 'aaa', NULL, now()),
              ('u2', 'other', NULL, NULL, NULL, 'mmm', now()),
              ('u3', 'third', 'Third', 'T', NULL, NULL, now())`,
    );
    const rows: [
      string,
      string,
      string | null,
      string | null,
      Buffer | null,
      Buffer | null,
      string,
    ][] = [
      ['u1', 'user_avatar', 'old-hash', 'aaa', OLD_THUMB, NEW_THUMB, 'event'],
      ['u1', 'nickname', 'Old Nick', 'Some One', null, null, 'event'],
      ['u2', 'member_avatar', null, 'mmm', null, NEW_THUMB, 'sweep'],
      ['u3', 'user_avatar', 'gone', null, OLD_THUMB, null, 'event'],
    ];
    for (const [
      user,
      field,
      oldValue,
      newValue,
      oldThumb,
      newThumb,
      source,
    ] of rows) {
      // eslint-disable-next-line no-await-in-loop
      const inserted = await scoped.query<{ id: string }>(
        `INSERT INTO member_identity_changes (discord_user_id, field,
           old_value, new_value, old_thumb, new_thumb, detected_at, source)
         VALUES ($1, $2, $3, $4, $5, $6, now() - interval '1 day', $7)
         RETURNING id::text AS id`,
        [user, field, oldValue, newValue, oldThumb, newThumb, source],
      );
      oldIds.push(inserted.rows[0].id);
    }
    // A gap in the id sequence, as production has from any rolled-back
    // insert: ids must be preserved, not renumbered.
    await scoped.query('DELETE FROM member_identity_changes WHERE id = $1', [
      oldIds[2],
    ]);
    oldIds.splice(2, 1);

    // The real entry point: the repository's lazy ensureSchema.
    process.env.DATABASE_URL = scopedUrl;
    repo = await PostgresIdentityRepository.instance();
  });

  afterAll(async () => {
    process.env.DATABASE_URL = originalUrl;
    await scoped?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin?.end();
  });

  it('preserves every change row, id and thumbnail byte', async () => {
    const changes = await readChanges();

    expect(changes.map((row) => row.id)).toEqual(oldIds);
    const avatar = changes.find((row) => row.id === oldIds[0]);
    expect(avatar?.subject_id).toBe('u1');
    expect(avatar?.old_value).toBe('old-hash');
    expect(avatar?.old_thumb?.equals(OLD_THUMB)).toBe(true);
    expect(avatar?.new_thumb?.equals(NEW_THUMB)).toBe(true);
    const removed = changes.find((row) => row.subject_id === 'u3');
    expect(removed?.old_thumb?.equals(OLD_THUMB)).toBe(true);
    expect(removed?.new_value).toBeNull();
    // Historical gateway-listener rows keep their source verbatim.
    expect(changes.filter((row) => row.source === 'event')).toHaveLength(3);
  });

  it('backfills platform and scope on every change row', async () => {
    const changes = await readChanges();
    expect(changes.every((row) => row.platform === 'discord')).toBe(true);
    expect(changes.every((row) => row.scope_id === GUILD_ID)).toBe(true);
  });

  it('scopes every baseline to the guild and keys it by (scope, user)', async () => {
    const result = await scoped.query<{ count: string; scoped: string }>(
      `SELECT count(*)::text AS count,
              count(*) FILTER (WHERE scope_id = $1)::text AS scoped
         FROM member_identity`,
      [GUILD_ID],
    );
    expect(result.rows[0]).toEqual({ count: '3', scoped: '3' });
    expect(await primaryKeyColumns()).toEqual(['scope_id', 'discord_user_id']);
  });

  it('replaces the old per-user index with the subject index', async () => {
    const names = await indexNames();
    expect(names).not.toContain('member_identity_changes_user_field_idx');
    expect(names).toContain('member_identity_changes_subject_idx');
    expect(names).toContain('member_identity_changes_detected_at_idx');
  });

  it('serves the migrated rows through the repository API', async () => {
    expect(await repo.getSnapshot(GUILD_ID, 'u1')).toEqual({
      scopeId: GUILD_ID,
      discordUserId: 'u1',
      username: 'someone',
      globalName: 'Someone',
      nickname: 'Some One',
      userAvatarHash: 'aaa',
      memberAvatarHash: null,
    });

    const window = await repo.listChangesBetween(
      new Date(Date.now() - 2 * 86_400_000),
      new Date(),
    );
    expect(window.map((row) => row.id)).toEqual(oldIds);
    expect(window[0].oldThumb?.equals(OLD_THUMB)).toBe(true);

    // The new upsert's conflict target now exists, and new rows continue the
    // old id sequence rather than colliding with it.
    await repo.putSnapshot({
      scopeId: GUILD_ID,
      discordUserId: 'u1',
      username: 'someone',
      globalName: 'Someone',
      nickname: 'Renamed',
      userAvatarHash: 'aaa',
      memberAvatarHash: null,
    });
    const updated = await repo.getSnapshot(GUILD_ID, 'u1');
    expect(updated?.nickname).toBe('Renamed');
    await repo.recordChanges(
      [
        {
          platform: 'discord',
          scopeId: GUILD_ID,
          subjectId: 'u1',
          field: 'nickname',
          oldValue: 'Some One',
          newValue: 'Renamed',
        },
      ],
      'sweep',
      new Map(),
    );
    const maxId = await scoped.query<{ max: string }>(
      'SELECT max(id)::text AS max FROM member_identity_changes',
    );
    expect(BigInt(maxId.rows[0].max)).toBeGreaterThan(
      BigInt(oldIds[oldIds.length - 1]),
    );
  });

  it('is a no-op when run again', async () => {
    const before = await readChanges();
    const baselinesBefore = await scoped.query(
      'SELECT * FROM member_identity ORDER BY discord_user_id',
    );

    const client = await scoped.connect();
    try {
      await migrateIdentitySchema(client, GUILD_ID);
      await migrateIdentitySchema(client, GUILD_ID);
    } finally {
      client.release();
    }

    const after = await readChanges();
    // Deep equality covers ids, values and the thumb Buffers byte for byte.
    expect(after).toEqual(before);
    const baselinesAfter = await scoped.query(
      'SELECT * FROM member_identity ORDER BY discord_user_id',
    );
    expect(baselinesAfter.rows).toEqual(baselinesBefore.rows);
    expect(await primaryKeyColumns()).toEqual(['scope_id', 'discord_user_id']);
  });
});

describe.skipIf(!POSTGRES_AVAILABLE)(
  'identity schema on an empty database',
  () => {
    const FRESH_SCHEMA = 'identity_migration_fresh_test';
    const url = process.env.DATABASE_URL;
    let admin: pg.Pool;
    let scoped: pg.Pool;

    beforeAll(async () => {
      admin = new pg.Pool({ connectionString: url, max: 1 });
      await admin.query(`DROP SCHEMA IF EXISTS ${FRESH_SCHEMA} CASCADE`);
      await admin.query(`CREATE SCHEMA ${FRESH_SCHEMA}`);
      scoped = new pg.Pool({
        connectionString: withSearchPath(url, FRESH_SCHEMA),
        max: 1,
      });
    });

    afterAll(async () => {
      await scoped?.end();
      await admin?.query(`DROP SCHEMA IF EXISTS ${FRESH_SCHEMA} CASCADE`);
      await admin?.end();
    });

    it('creates the target schema, and a second run changes nothing', async () => {
      const client = await scoped.connect();
      try {
        await migrateIdentitySchema(client, GUILD_ID);
        await migrateIdentitySchema(client, GUILD_ID);
      } finally {
        client.release();
      }
      const tables = await scoped.query<{ tablename: string }>(
        'SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename',
        [FRESH_SCHEMA],
      );
      expect(tables.rows.map((row) => row.tablename)).toEqual([
        'identity_digest_state',
        'meetup_identity',
        'member_identity',
        'member_identity_changes',
      ]);
      const columns = await scoped.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'member_identity_changes'
        ORDER BY ordinal_position`,
        [FRESH_SCHEMA],
      );
      expect(columns.rows.map((row) => row.column_name)).not.toContain(
        'discord_user_id',
      );
      expect(columns.rows.map((row) => row.column_name)).toContain(
        'subject_id',
      );
    });
  },
);
