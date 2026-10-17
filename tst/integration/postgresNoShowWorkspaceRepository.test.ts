import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Period } from '../../src/lib/reports/period.js';
import {
  DASHBOARD_LOCK_CLASS,
  SCHEMA_LOCK_KEY,
} from '../../src/lib/repositories/dashboardPool.js';
import {
  ensureWorkspaceSchema,
  PostgresNoShowWorkspaceRepository,
  WORKSPACE_SCHEMA_SQL,
} from '../../src/lib/repositories/postgresNoShowWorkspaceRepository.js';
import { SCHEMA_SQL as SUSPENSION_SCHEMA_SQL } from '../../src/lib/repositories/postgresSuspensionRepository.js';
import { SyncCase } from '../../src/lib/workspace/types.js';
import { useIsolatedSchema } from './isolatedSchema.js';

// Requires DATABASE_URL against a throwaway Postgres; skipped otherwise.
const POSTGRES_AVAILABLE = Boolean(process.env.DATABASE_URL);

if (!POSTGRES_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    'Skipping PostgresNoShowWorkspaceRepository integration tests: set DATABASE_URL to a reachable Postgres to run them.',
  );
}

const SEPTEMBER: Period = { year: 2026, month: 9 };
const OCTOBER: Period = { year: 2026, month: 10 };
const T1 = new Date('2026-10-01T16:00:00.000Z');
const T2 = new Date('2026-10-02T16:00:00.000Z');
const T3 = new Date('2026-10-03T16:00:00.000Z');
const MOD = '123456789012345678';

const WORKSPACE_TABLES = [
  'noshow_workspace_events',
  'noshow_workspace_months',
  'noshow_workspace_rows',
];

const warning = (memberId: string, memberName = `M${memberId}`): SyncCase => ({
  memberId,
  memberName,
  classification: 'warning',
});
const suspension = (
  memberId: string,
  memberName = `M${memberId}`,
): SyncCase => ({
  memberId,
  memberName,
  classification: 'suspension',
});

(POSTGRES_AVAILABLE ? describe : describe.skip)(
  'PostgresNoShowWorkspaceRepository',
  () => {
    let schema: { drop(): Promise<void> };
    let pool: pg.Pool;
    let repo: PostgresNoShowWorkspaceRepository;

    const count = async (table: string): Promise<number> =>
      (
        await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${table}`,
        )
      ).rows[0].n;

    const rowOf = async (period: Period, memberId: string) =>
      (
        await pool.query<{
          id: number;
          status: string;
          notes: string;
          version: number;
          classification: string;
          in_latest_snapshot: boolean;
          member_name: string;
        }>(
          `SELECT id, status, notes, version, classification, in_latest_snapshot, member_name
             FROM noshow_workspace_rows
            WHERE period = $1::date AND meetup_member_id = $2`,
          [
            `${period.year}-${String(period.month).padStart(2, '0')}-01`,
            memberId,
          ],
        )
      ).rows[0];

    const eventsOf = async (rowId: number) =>
      (
        await pool.query<{
          action: string;
          actor: string;
          old_status: string;
          new_status: string;
          note: string | null;
        }>(
          `SELECT action, actor, old_status, new_status, note
             FROM noshow_workspace_events WHERE row_id = $1 ORDER BY id`,
          [rowId],
        )
      ).rows;

    const sync = (
      cases: SyncCase[],
      builtAt = T1,
      snapshotId = 1,
      period = SEPTEMBER,
    ) =>
      repo.syncFromSnapshot({
        period,
        snapshotId,
        snapshotBuiltAt: builtAt,
        cases,
      });

    beforeAll(async () => {
      // Before any pool or singleton exists: the suspension repository's
      // pool must also land in the isolated schema.
      schema = await useIsolatedSchema('workspace');
      pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        max: 6,
      });
      await ensureWorkspaceSchema(pool);
    });

    beforeEach(async () => {
      await pool.query(
        `TRUNCATE noshow_workspace_events, noshow_workspace_rows,
           noshow_workspace_months, suspension_records RESTART IDENTITY CASCADE`,
      );
      repo = new PostgresNoShowWorkspaceRepository(pool);
    });

    afterAll(async () => {
      await pool?.end();
      await schema?.drop();
    });

    describe('schema', () => {
      it('creates the suspension table first on a fresh database', async () => {
        const tables = await pool.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables
            WHERE table_schema = current_schema() ORDER BY table_name`,
        );
        const names = tables.rows.map((r) => r.table_name);
        expect(names).toEqual(
          expect.arrayContaining(['suspension_records', ...WORKSPACE_TABLES]),
        );
      });

      /** Which workspace tables exist in current_schema() right now. */
      const workspaceTables = async (): Promise<string[]> =>
        (
          await pool.query<{ table_name: string }>(
            `SELECT table_name FROM information_schema.tables
              WHERE table_schema = current_schema() AND table_name LIKE 'noshow_workspace_%'
              ORDER BY table_name`,
          )
        ).rows.map((r) => r.table_name);

      const dropWorkspaceTables = () =>
        pool.query(
          'DROP TABLE noshow_workspace_events, noshow_workspace_rows, noshow_workspace_months',
        );

      it('ensures the suspension table before its own, which needs it', async () => {
        await dropWorkspaceTables();
        try {
          // The callback runs before the workspace transaction: none of its
          // tables exist yet, and suspension_records (the FK target) does.
          let sawBefore: string[] | undefined;
          await ensureWorkspaceSchema(pool, async () => {
            sawBefore = await workspaceTables();
            const target = await pool.query<{ r: string | null }>(
              `SELECT to_regclass(quote_ident(current_schema()) || '.suspension_records') AS r`,
            );
            expect(target.rows[0].r).not.toBeNull();
          });
          expect(sawBefore).toEqual([]);
          expect(await workspaceTables()).toEqual(WORKSPACE_TABLES);
        } finally {
          await ensureWorkspaceSchema(pool);
        }
      });

      it('a failing suspension ensure stops the workspace ensure', async () => {
        await dropWorkspaceTables();
        try {
          await expect(
            ensureWorkspaceSchema(pool, async () => {
              throw new Error('suspension schema failed');
            }),
          ).rejects.toThrow('suspension schema failed');
          // suspension_records exists here, so a workspace ensure that ran
          // anyway would have created its tables.
          expect(await workspaceTables()).toEqual([]);
        } finally {
          await ensureWorkspaceSchema(pool);
        }
      });

      it('schema is idempotent', async () => {
        await sync([warning('111')]);
        await ensureWorkspaceSchema(pool);
        await ensureWorkspaceSchema(pool);
        const triggers = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
            WHERE t.tgname = 'noshow_workspace_events_append_only'
              AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())`,
        );
        expect(triggers.rows[0].n).toBe(1);
        expect(await count('noshow_workspace_rows')).toBe(1);
        expect(await count('noshow_workspace_events')).toBe(1);
      });

      /**
       * The relation locks WORKSPACE_SCHEMA_SQL takes, read from pg_locks in
       * the same transaction (schema lock, then the SQL), then rolled back.
       */
      async function relationLocksDuringSchema(): Promise<string[]> {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
            DASHBOARD_LOCK_CLASS,
            SCHEMA_LOCK_KEY,
          ]);
          await client.query(WORKSPACE_SCHEMA_SQL);
          const locks = await client.query<{ name: string; mode: string }>(
            `SELECT c.relname AS name, l.mode FROM pg_locks l
               JOIN pg_class c ON c.oid = l.relation
              WHERE l.pid = pg_backend_pid()
                AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())
              ORDER BY 1, 2`,
          );
          return locks.rows.map((r) => `${r.name}:${r.mode}`);
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      }

      it('a boot on an existing schema takes no lock that blocks writes', async () => {
        // Rows, notes and suspensions get written while web dynos boot: a
        // later boot must only read the catalog.
        const locks = await relationLocksDuringSchema();
        expect(locks.filter((l) => !l.endsWith(':AccessShareLock'))).toEqual(
          [],
        );
        // Not vacuous: an unguarded CREATE INDEX IF NOT EXISTS on an index
        // that already exists still takes a ShareLock on its table.
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            'CREATE INDEX IF NOT EXISTS noshow_workspace_rows_member_idx ON noshow_workspace_rows (meetup_member_id)',
          );
          const unguarded = await client.query<{ mode: string }>(
            `SELECT l.mode FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
              WHERE l.pid = pg_backend_pid() AND c.relname = 'noshow_workspace_rows'
                AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())`,
          );
          expect(unguarded.rows.map((r) => r.mode)).toContain('ShareLock');
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      });

      it('a later boot updates the append-only function body', async () => {
        await pool.query(
          `CREATE OR REPLACE FUNCTION noshow_workspace_events_append_only() RETURNS trigger
             LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'stale body'; END $fn$`,
        );
        await ensureWorkspaceSchema(pool);
        await sync([warning('111')]);
        await expect(
          pool.query('DELETE FROM noshow_workspace_events'),
        ).rejects.toThrow('noshow_workspace_events is append-only');
      });

      it('guards match a mixed-case schema name exactly', async () => {
        // current_schema()::regnamespace re-parses the name as an
        // identifier, folding "WsMixed_..." to lower case: no such schema.
        const name = `WsMixed_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
        const url = new URL(process.env.DATABASE_URL ?? '');
        url.searchParams.delete('options');
        const mixed = new pg.Pool({
          connectionString: url.toString(),
          options: `-c search_path="${name}"`,
          max: 2,
        });
        try {
          await pool.query(`CREATE SCHEMA "${name}"`);
          const ensure = () =>
            ensureWorkspaceSchema(mixed, () =>
              mixed.query(SUSPENSION_SCHEMA_SQL),
            );
          await ensure();
          await ensure();
          const triggers = await mixed.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
              WHERE t.tgname = 'noshow_workspace_events_append_only'
                AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())`,
          );
          expect(triggers.rows[0].n).toBe(1);
        } finally {
          await mixed.end();
          await pool.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
        }
      });

      it('events are never updated or deleted', async () => {
        await sync([warning('111')]);
        await expect(
          pool.query(`UPDATE noshow_workspace_events SET note = 'x'`),
        ).rejects.toThrow(/append-only/);
        await expect(
          pool.query('DELETE FROM noshow_workspace_events'),
        ).rejects.toThrow(/append-only/);
        expect(await count('noshow_workspace_events')).toBe(1);
        const [event] = await eventsOf(1);
        expect(event.note).toBeNull();
      });

      it('rows refuse a non-digit member id, a bad status and suspended without a record', async () => {
        await sync([warning('111')]);
        await expect(
          pool.query(
            `INSERT INTO noshow_workspace_rows (period, meetup_member_id, classification)
             VALUES ('2026-09-01', '12a', 'warning')`,
          ),
        ).rejects.toThrow(/check constraint/);
        await expect(
          pool.query(
            `UPDATE noshow_workspace_rows SET status = 'banned' WHERE meetup_member_id = '111'`,
          ),
        ).rejects.toThrow(/check constraint/);
        await expect(
          pool.query(
            `UPDATE noshow_workspace_rows SET status = 'suspended' WHERE meetup_member_id = '111'`,
          ),
        ).rejects.toThrow(/check constraint/);
        await expect(
          pool.query(
            `UPDATE noshow_workspace_rows SET updated_by = 'someone' WHERE meetup_member_id = '111'`,
          ),
        ).rejects.toThrow(/check constraint/);
        await expect(
          pool.query(
            `INSERT INTO noshow_workspace_months (period, snapshot_id, snapshot_built_at)
             VALUES ('2026-09-02', 1, now())`,
          ),
        ).rejects.toThrow(/check constraint/);
        // A suspended row with a real record is allowed.
        const record = await pool.query<{ id: number }>(
          `INSERT INTO suspension_records (member_id, member_name, suspended_at, duration_days)
           VALUES ('111', 'M111', '2026-10-01T00:00:00Z', 30) RETURNING id`,
        );
        await pool.query(
          `UPDATE noshow_workspace_rows SET status = 'suspended', suspension_record_id = $1
            WHERE meetup_member_id = '111'`,
          [record.rows[0].id],
        );
        expect((await rowOf(SEPTEMBER, '111')).status).toBe('suspended');
      });
    });

    describe('sync', () => {
      it('sync creates one new row and one sync_created event per case', async () => {
        const outcome = await sync([warning('111', 'Ann'), suspension('222')]);
        expect(outcome).toEqual({
          status: 'synced',
          created: 2,
          reclassified: 0,
          dropped: 0,
          returned: 0,
        });
        const ann = await rowOf(SEPTEMBER, '111');
        expect(ann).toMatchObject({
          status: 'new',
          notes: '',
          version: 1,
          classification: 'warning',
          in_latest_snapshot: true,
          member_name: 'Ann',
        });
        expect(await eventsOf(ann.id)).toEqual([
          {
            action: 'sync_created',
            actor: 'sync',
            old_status: 'new',
            new_status: 'new',
            note: null,
          },
        ]);
        expect(await count('noshow_workspace_rows')).toBe(2);
        expect(await count('noshow_workspace_events')).toBe(2);
        const state = await repo.monthState(SEPTEMBER);
        expect(state).toMatchObject({
          period: SEPTEMBER,
          snapshotId: 1,
          snapshotBuiltAt: T1,
        });
        expect(state?.syncedAt).toBeInstanceOf(Date);
        expect(await repo.monthState(OCTOBER)).toBeUndefined();
      });

      it('sync is idempotent for the same snapshot', async () => {
        await sync([warning('111'), suspension('222')]);
        const again = await sync([warning('111'), suspension('222')]);
        expect(again.status).toBe('current');
        expect(await count('noshow_workspace_rows')).toBe(2);
        expect(await count('noshow_workspace_events')).toBe(2);
      });

      it('sync keeps edited rows', async () => {
        await sync([warning('111'), suspension('222')]);
        await pool.query(
          `UPDATE noshow_workspace_rows SET status = 'warning_sent', notes = 'sent by DM'
            WHERE meetup_member_id = '111'`,
        );
        const before = await rowOf(SEPTEMBER, '111');
        const outcome = await sync([warning('111'), suspension('222')], T2);
        expect(outcome).toEqual({
          status: 'synced',
          created: 0,
          reclassified: 0,
          dropped: 0,
          returned: 0,
        });
        const after = await rowOf(SEPTEMBER, '111');
        expect(after.status).toBe('warning_sent');
        expect(after.notes).toBe('sent by DM');
        expect(after.version).toBe(before.version);
        expect((await repo.monthState(SEPTEMBER))?.snapshotBuiltAt).toEqual(T2);
      });

      it('a renamed member is updated without an event or a version bump', async () => {
        await sync([warning('111', 'Ann')]);
        await sync([warning('111', 'Annie')], T2);
        const row = await rowOf(SEPTEMBER, '111');
        expect(row.member_name).toBe('Annie');
        expect(row.version).toBe(1);
        expect(await count('noshow_workspace_events')).toBe(1);
      });

      it('sync records a reclassification and bumps the version', async () => {
        await sync([warning('111')]);
        await pool.query(
          `UPDATE noshow_workspace_rows SET status = 'warning_copied' WHERE meetup_member_id = '111'`,
        );
        const outcome = await sync([suspension('111')], T2);
        expect(outcome.reclassified).toBe(1);
        const row = await rowOf(SEPTEMBER, '111');
        expect(row.classification).toBe('suspension');
        expect(row.version).toBe(2);
        expect(row.status).toBe('warning_copied');
        expect((await eventsOf(row.id)).slice(1)).toEqual([
          {
            action: 'sync_reclassified',
            actor: 'sync',
            old_status: 'warning_copied',
            new_status: 'warning_copied',
            note: 'warning → suspension',
          },
        ]);
      });

      it('marks rows missing from a rebuild and brings them back', async () => {
        await sync([warning('111'), warning('222')]);
        const dropped = await sync([warning('111')], T2);
        expect(dropped.dropped).toBe(1);
        let row = await rowOf(SEPTEMBER, '222');
        expect(row.in_latest_snapshot).toBe(false);
        expect(row.version).toBe(2);
        // A second rebuild without them does not drop them again.
        expect((await sync([warning('111')], T3, 2)).dropped).toBe(0);
        const returned = await sync(
          [warning('111'), warning('222')],
          new Date('2026-10-04T16:00:00Z'),
          3,
        );
        expect(returned.returned).toBe(1);
        row = await rowOf(SEPTEMBER, '222');
        expect(row.in_latest_snapshot).toBe(true);
        expect(row.version).toBe(3);
        expect((await eventsOf(row.id)).map((e) => e.action)).toEqual([
          'sync_created',
          'sync_dropped',
          'sync_returned',
        ]);
        expect(await repo.countRows(SEPTEMBER)).toEqual({
          total: 2,
          inLatest: 2,
        });
      });

      it('refuses to sync an older build over a newer one', async () => {
        await sync([warning('111')], T2, 2);
        const outcome = await sync([warning('111'), warning('222')], T1, 1);
        expect(outcome.status).toBe('older');
        expect(await count('noshow_workspace_rows')).toBe(1);
        expect(await count('noshow_workspace_events')).toBe(1);
        expect(await repo.monthState(SEPTEMBER)).toMatchObject({
          snapshotId: 2,
          snapshotBuiltAt: T2,
        });
      });

      it("the open month's in-place rebuild (same id, later built_at) syncs", async () => {
        await sync([warning('111')], T1, 7, OCTOBER);
        const outcome = await sync(
          [warning('111'), suspension('222')],
          T2,
          7,
          OCTOBER,
        );
        expect(outcome).toMatchObject({ status: 'synced', created: 1 });
        expect(await repo.countRows(OCTOBER)).toEqual({
          total: 2,
          inLatest: 2,
        });
        expect((await repo.monthState(OCTOBER))?.snapshotBuiltAt).toEqual(T2);
      });

      it('concurrent syncs of one month leave one row per member', async () => {
        const cases = [warning('111'), suspension('222'), warning('333')];
        const outcomes = await Promise.all([
          sync(cases, T1, 1),
          sync(cases, T2, 2),
        ]);
        expect(outcomes.map((o) => o.status).sort()).toEqual(
          expect.arrayContaining(['synced']),
        );
        expect(await count('noshow_workspace_rows')).toBe(3);
        expect(await count('noshow_workspace_events')).toBe(3);
        expect((await repo.monthState(SEPTEMBER))?.snapshotBuiltAt).toEqual(T2);
      });

      it('a failed sync writes nothing', async () => {
        await expect(
          sync([warning('111'), { ...warning('222'), memberId: 'x' }]),
        ).rejects.toThrow();
        expect(await count('noshow_workspace_months')).toBe(0);
        expect(await count('noshow_workspace_rows')).toBe(0);
        expect(await count('noshow_workspace_events')).toBe(0);
      });
    });

    describe('reads', () => {
      it('listRows orders suspension candidates first, in-report rows first, and pages at 50', async () => {
        const cases: SyncCase[] = [];
        for (let i = 0; i < 51; i += 1) {
          const id = String(1000 + i);
          const name = `w${String(i).padStart(2, '0')}`;
          cases.push(
            i % 10 === 0
              ? suspension(id, name.toUpperCase())
              : warning(id, name),
          );
        }
        cases.push(warning('9', 'aaa-dropped'));
        await sync(cases);
        await sync(cases.slice(0, 51), T2);
        const first = await repo.listRows(SEPTEMBER, { offset: 0, limit: 500 });
        expect(first).toHaveLength(50);
        // Suspensions (every tenth) first, by lower(name); then warnings.
        expect(first.slice(0, 6).map((r) => r.classification)).toEqual(
          Array(6).fill('suspension'),
        );
        expect(first.slice(0, 6).map((r) => r.memberName)).toEqual([
          'W00',
          'W10',
          'W20',
          'W30',
          'W40',
          'W50',
        ]);
        expect(first[6].memberName).toBe('w01');
        const second = await repo.listRows(SEPTEMBER, {
          offset: 50,
          limit: 50,
        });
        expect(second.map((r) => r.memberName)).toEqual(['w49', 'aaa-dropped']);
        expect(second[1].inLatestSnapshot).toBe(false);
        // Clamped: a junk limit and a negative offset still answer one page.
        expect(
          await repo.listRows(SEPTEMBER, { offset: -5, limit: Number.NaN }),
        ).toHaveLength(50);
        expect(
          await repo.listRows(SEPTEMBER, { offset: 0, limit: 0 }),
        ).toHaveLength(1);
        const row = first[0];
        expect(row).toMatchObject({
          period: SEPTEMBER,
          memberId: '1000',
          status: 'new',
          notes: '',
          suspensionRecordId: null,
          inLatestSnapshot: true,
          version: 1,
          updatedBy: 'sync',
        });
        expect(row.updatedAt).toBeInstanceOf(Date);
        expect(await repo.countRows(SEPTEMBER)).toEqual({
          total: 52,
          inLatest: 51,
        });
        expect(await repo.countRows(OCTOBER)).toEqual({
          total: 0,
          inLatest: 0,
        });
      });

      it('getRow reads one row of the month and refuses junk ids', async () => {
        await sync([warning('111', 'Ann')]);
        const id = (await rowOf(SEPTEMBER, '111')).id;
        expect((await repo.getRow(SEPTEMBER, id))?.memberName).toBe('Ann');
        expect(await repo.getRow(OCTOBER, id)).toBeUndefined();
        for (const junk of [
          0,
          -1,
          1.5,
          Number.NaN,
          2 ** 31,
          Number.MAX_SAFE_INTEGER + 2,
        ]) {
          // eslint-disable-next-line no-await-in-loop -- a handful of cases
          expect(await repo.getRow(SEPTEMBER, junk)).toBeUndefined();
        }
      });

      it('listRecentEvents returns each row newest first, capped per row', async () => {
        await sync([warning('111'), warning('222')]);
        const a = (await rowOf(SEPTEMBER, '111')).id;
        const b = (await rowOf(SEPTEMBER, '222')).id;
        for (let i = 0; i < 12; i += 1) {
          // eslint-disable-next-line no-await-in-loop -- ordered ids
          await pool.query(
            `INSERT INTO noshow_workspace_events (row_id, actor, action, old_status, new_status, note)
             VALUES ($1, $2, 'edit_notes', 'new', 'new', $3)`,
            [a, MOD, `n${i}`],
          );
        }
        const events = await repo.listRecentEvents([a, b]);
        expect(events.get(a)).toHaveLength(10);
        expect(events.get(a)?.[0]).toMatchObject({
          rowId: a,
          actor: MOD,
          action: 'edit_notes',
          oldStatus: 'new',
          newStatus: 'new',
          note: 'n11',
          suspensionRecordId: null,
        });
        expect(typeof events.get(a)?.[0].id).toBe('string');
        expect(events.get(a)?.[0].createdAt).toBeInstanceOf(Date);
        expect(events.get(b)?.map((e) => e.action)).toEqual(['sync_created']);
        expect(
          (await repo.listRecentEvents([a], 2)).get(a)?.map((e) => e.note),
        ).toEqual(['n11', 'n10']);
        expect((await repo.listRecentEvents([a], 99)).get(a)).toHaveLength(10);
        expect((await repo.listRecentEvents([])).size).toBe(0);
        await expect(
          repo.listRecentEvents(Array.from({ length: 51 }, (_, i) => i + 1)),
        ).rejects.toThrow(RangeError);
      });

      it('statusCounts counts only rows in the latest report', async () => {
        await sync([warning('111'), warning('222'), warning('333')]);
        await sync([warning('111'), warning('222')], T2);
        await pool.query(
          `UPDATE noshow_workspace_rows SET status = 'on_hold' WHERE meetup_member_id IN ('111', '333')`,
        );
        await sync([suspension('444')], T1, 5, OCTOBER);
        const counts = await repo.statusCounts([
          SEPTEMBER,
          OCTOBER,
          { year: 2026, month: 11 },
        ]);
        expect(counts.get('2026-09')).toEqual({ new: 1, on_hold: 1 });
        expect(counts.get('2026-10')).toEqual({ new: 1 });
        expect(counts.has('2026-11')).toBe(false);
        expect((await repo.statusCounts([])).size).toBe(0);
      });

      it('statusesByMember maps the month by member id', async () => {
        await sync([warning('111'), warning('222')]);
        await pool.query(
          `UPDATE noshow_workspace_rows SET status = 'skipped' WHERE meetup_member_id = '222'`,
        );
        expect(await repo.statusesByMember(SEPTEMBER)).toEqual(
          new Map([
            ['111', 'new'],
            ['222', 'skipped'],
          ]),
        );
        expect((await repo.statusesByMember(OCTOBER)).size).toBe(0);
      });

      it("statusesForMember lists the member's months, newest first; a non-digit id runs no query", async () => {
        await sync([warning('111')]);
        await sync([suspension('111')], T1, 5, OCTOBER);
        await pool.query(
          `UPDATE noshow_workspace_rows SET status = 'warning_sent'
            WHERE meetup_member_id = '111' AND period = '2026-09-01'`,
        );
        const statuses = await repo.statusesForMember('111');
        expect([...statuses.entries()]).toEqual([
          ['2026-10', 'new'],
          ['2026-09', 'warning_sent'],
        ]);
        // A pool that throws on any query proves nothing was asked.
        const refusing = new PostgresNoShowWorkspaceRepository({
          query: () => {
            throw new Error('no query expected');
          },
          connect: () => {
            throw new Error('no query expected');
          },
        } as unknown as pg.Pool);
        expect((await refusing.statusesForMember("1' OR '1'='1")).size).toBe(0);
        expect((await refusing.statusesForMember('')).size).toBe(0);
        expect(await refusing.getRow(SEPTEMBER, -1)).toBeUndefined();
        expect((await refusing.listRecentEvents([])).size).toBe(0);
      });

      it('listMonths lists synced months newest first', async () => {
        await sync([warning('111')]);
        await sync([warning('111')], T2, 9, OCTOBER);
        const months = await repo.listMonths();
        expect(months.map((m) => [m.period, m.snapshotId])).toEqual([
          [OCTOBER, 9],
          [SEPTEMBER, 1],
        ]);
      });

      it('instance() builds on the shared dashboard pool and ensures the schema', async () => {
        const shared = await PostgresNoShowWorkspaceRepository.instance();
        expect(await PostgresNoShowWorkspaceRepository.instance()).toBe(shared);
        expect(await shared.listMonths()).toEqual([]);
      });
    });
  },
);
