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
import { recordCsvRows } from '../../src/lib/helpers/recordSuspensions.js';
import {
  PostgresSuspensionRepository,
  SCHEMA_SQL as SUSPENSION_SCHEMA_SQL,
} from '../../src/lib/repositories/postgresSuspensionRepository.js';
import {
  ActionOutcome,
  ActionRequest,
  SyncCase,
  WorkspaceAction,
} from '../../src/lib/workspace/types.js';
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

    describe('actions', () => {
      const MOD_B = '223456789012345678';
      const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
      const sleep = (ms: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        });

      /** A row's live state, by id. */
      const stateOf = async (rowId: number) =>
        (
          await pool.query<{
            status: string;
            version: number;
            notes: string;
            suspension_record_id: number | null;
            updated_by: string | null;
          }>(
            `SELECT status, version, notes, suspension_record_id, updated_by
               FROM noshow_workspace_rows WHERE id = $1`,
            [rowId],
          )
        ).rows[0];

      const records = async () =>
        (
          await pool.query<{
            id: number;
            member_id: string;
            member_name: string | null;
            suspended_at: Date;
            duration_days: number;
            notes: string | null;
            voided_at: Date | null;
            voided_by: string | null;
            void_reason: string | null;
          }>('SELECT * FROM suspension_records ORDER BY id')
        ).rows;

      const insertRecord = async (memberId: string, iso: string) =>
        (
          await pool.query<{ id: number }>(
            `INSERT INTO suspension_records (member_id, member_name, suspended_at, duration_days)
             VALUES ($1, $2, $3, 30) RETURNING id`,
            [memberId, `M${memberId}`, day(iso)],
          )
        ).rows[0].id;

      /** Points a row at a record directly, as an earlier action would have. */
      const linkDirectly = (rowId: number, recordId: number) =>
        pool.query(
          `UPDATE noshow_workspace_rows SET status = 'suspended', suspension_record_id = $2 WHERE id = $1`,
          [rowId, recordId],
        );

      /** Applies `action` at the row's current version (unless one is given). */
      async function act(
        rowId: number,
        action: WorkspaceAction,
        extra: Partial<ActionRequest> = {},
        on: PostgresNoShowWorkspaceRepository = repo,
      ): Promise<ActionOutcome> {
        const version = extra.expectedVersion ?? (await stateOf(rowId)).version;
        const period = extra.period ?? SEPTEMBER;
        return on.applyAction({
          period,
          rowId,
          expectedVersion: version,
          actor: MOD,
          action,
          note: '',
          ...extra,
        });
      }

      const okOf = (outcome: ActionOutcome) => {
        if (outcome.ok === false) {
          throw new Error(`expected ok, got ${outcome.reason}`);
        }
        return outcome;
      };

      const seedSuspension = async (memberId = '222', period = SEPTEMBER) => {
        await sync([suspension(memberId)], T1, period.month, period);
        return (await rowOf(period, memberId)).id;
      };
      const seedWarning = async (memberId = '111') => {
        await sync([warning(memberId)]);
        return (await rowOf(SEPTEMBER, memberId)).id;
      };

      it('refuses a stale version and writes nothing', async () => {
        const id = await seedWarning();
        const first = await act(id, 'hold', {
          expectedVersion: 1,
          note: 'away',
        });
        const second = await act(id, 'hold', {
          expectedVersion: 1,
          note: 'again',
        });
        expect(first.ok).toBe(true);
        expect(second).toEqual({ ok: false, reason: 'stale' });
        expect((await stateOf(id)).version).toBe(2);
        expect(
          (await eventsOf(id)).filter((e) => e.action === 'hold'),
        ).toHaveLength(1);
      });

      it('an unknown row, or a row of another month, is not-found', async () => {
        const id = await seedWarning();
        expect(
          await act(id + 99, 'hold', { note: 'x', expectedVersion: 1 }),
        ).toEqual({
          ok: false,
          reason: 'not-found',
        });
        expect(await act(id, 'hold', { note: 'x', period: OCTOBER })).toEqual({
          ok: false,
          reason: 'not-found',
        });
        expect((await stateOf(id)).version).toBe(1);
      });

      it('two moderators with the same version: exactly one wins', async () => {
        const id = await seedWarning();
        const outcomes = await Promise.all([
          act(id, 'hold', { expectedVersion: 1, note: 'a' }),
          act(id, 'skip', { expectedVersion: 1, note: 'b', actor: MOD_B }),
        ]);
        expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
        expect(outcomes.filter((o) => !o.ok)).toEqual([
          { ok: false, reason: 'stale' },
        ]);
        expect((await stateOf(id)).version).toBe(2);
        expect(await eventsOf(id)).toHaveLength(2);
      });

      it('rolls back the suspension when the workspace update fails', async () => {
        const id = await seedSuspension();
        await pool.query(`
          CREATE FUNCTION test_refuse_suspended() RETURNS trigger LANGUAGE plpgsql
            AS $fn$ BEGIN RAISE EXCEPTION 'refused for the test'; END $fn$;
          CREATE TRIGGER test_refuse_suspended BEFORE UPDATE ON noshow_workspace_rows
            FOR EACH ROW WHEN (NEW.status = 'suspended') EXECUTE FUNCTION test_refuse_suspended();
        `);
        try {
          await expect(
            act(id, 'record_suspension', { suspendedOn: day('2026-10-03') }),
          ).rejects.toThrow('refused for the test');
        } finally {
          await pool.query(`
            DROP TRIGGER test_refuse_suspended ON noshow_workspace_rows;
            DROP FUNCTION test_refuse_suspended();
          `);
        }
        expect(await count('suspension_records')).toBe(0);
        expect(await stateOf(id)).toMatchObject({ version: 1, status: 'new' });
        expect(await eventsOf(id)).toHaveLength(1);
      });

      it('record suspension writes the same row /meetup_record_suspension would', async () => {
        await sync([
          suspension('501', 'Same Name'),
          suspension('502', 'Same Name'),
        ]);
        const a = (await rowOf(SEPTEMBER, '501')).id;
        await insertRecord('501', '2026-03-01');
        await insertRecord('502', '2026-03-01');
        okOf(await act(a, 'edit_notes', { note: '  no-show twice \r\n' }));
        const outcome = okOf(
          await act(a, 'record_suspension', { suspendedOn: day('2026-10-03') }),
        );
        const suspensions = await PostgresSuspensionRepository.instance();
        const csv = await recordCsvRows(
          suspensions,
          [
            {
              memberId: '502',
              memberName: 'Same Name',
              durationDays: 60,
              suspendedAt: day('2026-10-03'),
              notes: 'no-show twice',
              rowNumber: 2,
            },
          ],
          new Map([['502', 'Same Name']]),
        );
        expect(csv.recorded).toHaveLength(1);
        expect(csv.durationMismatches).toEqual([]);
        const rows = await pool.query<Record<string, unknown> & { id: number }>(
          `SELECT * FROM suspension_records WHERE member_id IN ('501', '502')
             AND suspended_at = '2026-10-03T00:00:00Z' ORDER BY member_id`,
        );
        const strip = ({
          id: _id,
          member_id: _m,
          created_at: _c,
          ...rest
        }: Record<string, unknown>) => rest;
        expect(rows.rows).toHaveLength(2);
        expect(strip(rows.rows[0])).toEqual(strip(rows.rows[1]));
        expect(rows.rows[0]).toMatchObject({
          member_name: 'Same Name',
          duration_days: 60,
          notes: 'no-show twice',
        });
        expect(outcome.suspension).toMatchObject({
          id: rows.rows[0].id,
          durationDays: 60,
          voidedAt: null,
        });
        expect(outcome.linkedExisting).toBe(false);
        expect(outcome.row).toMatchObject({
          status: 'suspended',
          suspensionRecordId: rows.rows[0].id,
          updatedBy: MOD,
        });
      });

      it('duration follows 30 × 2^prior as of the chosen date', async () => {
        const id = await seedSuspension();
        const other = await seedSuspension('222', OCTOBER);
        await insertRecord('222', '2026-03-01');
        // Later than the chosen date, and already backing the October row.
        await linkDirectly(other, await insertRecord('222', '2026-11-01'));
        const outcome = okOf(
          await act(id, 'record_suspension', {
            suspendedOn: day('2026-09-10'),
          }),
        );
        expect(outcome.suspension?.durationDays).toBe(60);
      });

      it('the suspension date is stored as UTC midnight of the chosen day', async () => {
        const id = await seedSuspension();
        okOf(
          await act(id, 'record_suspension', {
            suspendedOn: day('2026-10-03'),
          }),
        );
        const [rec] = await records();
        expect(rec.suspended_at.toISOString()).toBe('2026-10-03T00:00:00.000Z');
        expect(rec.duration_days).toBe(30);
        expect(rec.notes).toBeNull();
      });

      it('refuses a date before the month started', async () => {
        const id = await seedSuspension();
        for (const suspendedOn of [
          day('2026-08-31'),
          new Date(new Date('2026-09-01T00:00:00.000Z').getTime() - 1),
          new Date('nope'),
          undefined,
        ]) {
          expect(
            // eslint-disable-next-line no-await-in-loop -- one case at a time
            await act(id, 'record_suspension', {
              suspendedOn,
            }),
          ).toEqual({ ok: false, reason: 'bad-date' });
        }
        expect(await count('suspension_records')).toBe(0);
        expect(await stateOf(id)).toMatchObject({ version: 1, status: 'new' });
        expect(await eventsOf(id)).toHaveLength(1);
      });

      it('refuses when a live suspension after the period start exists and offers to link it', async () => {
        const id = await seedSuspension();
        const existing = await insertRecord('222', '2026-09-20');
        expect(
          await act(id, 'record_suspension', {
            suspendedOn: day('2026-10-03'),
          }),
        ).toEqual({
          ok: false,
          reason: 'already-suspended',
          existing: { id: existing, suspendedAt: day('2026-09-20') },
        });
        expect(await count('suspension_records')).toBe(1);
        expect((await stateOf(id)).version).toBe(1);
      });

      it('a suspension dated the 1st of the month counts as in the month', async () => {
        const id = await seedSuspension();
        const existing = await insertRecord('222', '2026-09-01');
        const outcome = await act(id, 'record_suspension', {
          suspendedOn: day('2026-09-10'),
        });
        expect(outcome).toMatchObject({
          ok: false,
          reason: 'already-suspended',
          existing: { id: existing },
        });
      });

      it('a voided suspension or one already linked to another row is not offered', async () => {
        const id = await seedSuspension();
        const october = await seedSuspension('222', OCTOBER);
        const voided = await insertRecord('222', '2026-09-15');
        await pool.query(
          `UPDATE suspension_records SET voided_at = now(), voided_by = $2, void_reason = 'x' WHERE id = $1`,
          [voided, MOD_B],
        );
        await linkDirectly(october, await insertRecord('222', '2026-10-02'));
        const outcome = okOf(
          await act(id, 'record_suspension', {
            suspendedOn: day('2026-09-20'),
          }),
        );
        expect(outcome.linkedExisting).toBe(false);
        expect(await count('suspension_records')).toBe(3);
        expect(outcome.suspension?.durationDays).toBe(30);
      });

      it('link_suspension links without inserting', async () => {
        const id = await seedSuspension();
        const existing = await insertRecord('222', '2026-09-20');
        const outcome = okOf(
          await act(id, 'link_suspension', { linkRecordId: existing }),
        );
        expect(outcome.linkedExisting).toBe(true);
        expect(outcome.suspension?.id).toBe(existing);
        expect(outcome.row).toMatchObject({
          status: 'suspended',
          suspensionRecordId: existing,
        });
        expect(outcome.event).toMatchObject({
          action: 'link_suspension',
          oldStatus: 'new',
          newStatus: 'suspended',
          suspensionRecordId: existing,
          actor: MOD,
        });
        expect(await count('suspension_records')).toBe(1);
      });

      it('link_suspension refuses a record of another member, before the month, voided, or linked', async () => {
        const id = await seedSuspension();
        const october = await seedSuspension('222', OCTOBER);
        const otherMember = await insertRecord('999', '2026-09-20');
        const beforeMonth = await insertRecord('222', '2026-08-31');
        const voided = await insertRecord('222', '2026-09-15');
        await pool.query(
          `UPDATE suspension_records SET voided_at = now(), voided_by = $2, void_reason = 'x' WHERE id = $1`,
          [voided, MOD_B],
        );
        const linked = await insertRecord('222', '2026-10-02');
        await linkDirectly(october, linked);
        for (const linkRecordId of [
          otherMember,
          beforeMonth,
          voided,
          linked,
          999999,
          0,
          -1,
          1.5,
          undefined,
        ]) {
          // eslint-disable-next-line no-await-in-loop -- one case at a time
          expect(await act(id, 'link_suspension', { linkRecordId })).toEqual({
            ok: false,
            reason: 'record-unavailable',
          });
        }
        expect(await stateOf(id)).toMatchObject({ version: 1, status: 'new' });
      });

      it('same-date ON CONFLICT links the existing row', async () => {
        const id = await seedSuspension();
        let inserted: number | undefined;
        const racing = new PostgresNoShowWorkspaceRepository(pool, {
          beforeSuspensionInsertForTest: async () => {
            // Another session records the same member and date, and commits.
            inserted = await insertRecord('222', '2026-10-03');
          },
        });
        const outcome = okOf(
          await act(
            id,
            'record_suspension',
            { suspendedOn: day('2026-10-03') },
            racing,
          ),
        );
        expect(outcome.linkedExisting).toBe(true);
        expect(outcome.suspension?.id).toBe(inserted);
        expect(await count('suspension_records')).toBe(1);
        expect((await stateOf(id)).suspension_record_id).toBe(inserted);
      });

      it('void voids the linked record with the reason and who', async () => {
        const id = await seedSuspension();
        const recorded = okOf(
          await act(id, 'record_suspension', {
            suspendedOn: day('2026-10-03'),
          }),
        );
        const outcome = okOf(
          await act(id, 'void', { note: '  wrong member  ', actor: MOD_B }),
        );
        expect(outcome.alreadyVoided).toBe(false);
        expect(outcome.previousStatus).toBe('suspended');
        expect(outcome.row.status).toBe('voided');
        expect(outcome.suspension).toMatchObject({
          id: recorded.suspension?.id,
          voidedBy: MOD_B,
          voidReason: 'wrong member',
        });
        const [rec] = await records();
        expect(rec).toMatchObject({
          voided_by: MOD_B,
          void_reason: 'wrong member',
        });
        expect(rec.voided_at).toBeInstanceOf(Date);
        expect(outcome.event).toMatchObject({
          action: 'void',
          note: 'wrong member',
          actor: MOD_B,
        });
      });

      it('void after /meetup_void_suspension voided it outside marks the row voided', async () => {
        const id = await seedSuspension();
        const recorded = okOf(
          await act(id, 'record_suspension', {
            suspendedOn: day('2026-10-03'),
          }),
        );
        const suspensions = await PostgresSuspensionRepository.instance();
        await suspensions.void(
          recorded.suspension?.id ?? 0,
          MOD_B,
          'via the command',
        );
        const outcome = okOf(await act(id, 'void', { note: 'dup' }));
        expect(outcome.alreadyVoided).toBe(true);
        expect(outcome.row.status).toBe('voided');
        const [rec] = await records();
        expect(rec).toMatchObject({
          voided_by: MOD_B,
          void_reason: 'via the command',
        });
        expect(outcome.suspension).toMatchObject({ voidedBy: MOD_B });
      });

      it('record_suspension again after a void links a fresh record', async () => {
        const id = await seedSuspension();
        const first = okOf(
          await act(id, 'record_suspension', {
            suspendedOn: day('2026-10-03'),
          }),
        );
        okOf(await act(id, 'void', { note: 'wrong date' }));
        const again = okOf(
          await act(id, 'record_suspension', {
            suspendedOn: day('2026-10-03'),
          }),
        );
        expect(again.suspension?.id).not.toBe(first.suspension?.id);
        expect(again.linkedExisting).toBe(false);
        expect(again.previousStatus).toBe('voided');
        expect((await stateOf(id)).suspension_record_id).toBe(
          again.suspension?.id,
        );
        expect(await count('suspension_records')).toBe(2);
      });

      it('every action writes exactly one event row', async () => {
        const id = await seedWarning();
        okOf(await act(id, 'hold', { note: 'travelling' }));
        okOf(await act(id, 'reopen'));
        okOf(await act(id, 'copy_warning'));
        okOf(await act(id, 'mark_sent', { actor: MOD_B }));
        const last = okOf(await act(id, 'edit_notes', { note: 'sent by DM' }));
        expect((await eventsOf(id)).slice(1)).toEqual([
          {
            action: 'hold',
            actor: MOD,
            old_status: 'new',
            new_status: 'on_hold',
            note: 'travelling',
          },
          {
            action: 'reopen',
            actor: MOD,
            old_status: 'on_hold',
            new_status: 'new',
            note: null,
          },
          {
            action: 'copy_warning',
            actor: MOD,
            old_status: 'new',
            new_status: 'warning_copied',
            note: null,
          },
          {
            action: 'mark_sent',
            actor: MOD_B,
            old_status: 'warning_copied',
            new_status: 'warning_sent',
            note: null,
          },
          {
            action: 'edit_notes',
            actor: MOD,
            old_status: 'warning_sent',
            new_status: 'warning_sent',
            note: 'sent by DM',
          },
        ]);
        expect(last.row).toMatchObject({
          status: 'warning_sent',
          notes: 'sent by DM',
          version: 6,
          updatedBy: MOD,
        });
        expect(await stateOf(id)).toMatchObject({
          version: 6,
          notes: 'sent by DM',
        });
      });

      it('reopen restores the status before the hold', async () => {
        const id = await seedWarning();
        okOf(await act(id, 'mark_sent'));
        okOf(await act(id, 'hold', { note: 'check' }));
        const outcome = okOf(await act(id, 'reopen'));
        expect(outcome.row.status).toBe('warning_sent');
        expect(outcome.previousStatus).toBe('on_hold');
      });

      /**
       * The member lock serialises suspension writes across that member's
       * rows. A record linked to another row is not "already suspended"
       * (UNLINKED_LIVE), so September and October can each record one; what
       * the lock guarantees is that the second sees the first: its check and
       * its prior count run after the first commits.
       */
      it('two rows of one member recording at once are serialised: the later one counts the earlier', async () => {
        for (let run = 0; run < 5; run += 1) {
          // eslint-disable-next-line no-await-in-loop -- one race per run, each from a clean slate
          await pool.query(
            `TRUNCATE noshow_workspace_events, noshow_workspace_rows,
               noshow_workspace_months, suspension_records RESTART IDENTITY CASCADE`,
          );
          // eslint-disable-next-line no-await-in-loop -- as above
          const sep = await seedSuspension('222', SEPTEMBER);
          // eslint-disable-next-line no-await-in-loop -- as above
          const oct = await seedSuspension('222', OCTOBER);
          // September pauses before its insert, holding the lock; October
          // starts inside that pause.
          const slow = new PostgresNoShowWorkspaceRepository(pool, {
            beforeSuspensionInsertForTest: () => sleep(150),
          });
          // eslint-disable-next-line no-await-in-loop -- as above
          const [first, second] = await Promise.all([
            act(
              sep,
              'record_suspension',
              { suspendedOn: day('2026-10-05') },
              slow,
            ),
            sleep(40).then(() =>
              act(oct, 'record_suspension', {
                suspendedOn: day('2026-10-06'),
                period: OCTOBER,
              }),
            ),
          ]);
          expect(okOf(first).suspension?.durationDays, `run ${run}`).toBe(30);
          // Without the lock October counts no prior and records 30 days.
          expect(okOf(second).suspension?.durationDays, `run ${run}`).toBe(60);
          // eslint-disable-next-line no-await-in-loop -- as above
          expect(await count('suspension_records'), `run ${run}`).toBe(2);
        }
      });

      it('two rows of one member recording the same date: exactly one record', async () => {
        const sep = await seedSuspension('222', SEPTEMBER);
        const oct = await seedSuspension('222', OCTOBER);
        const outcomes = await Promise.all([
          act(sep, 'record_suspension', { suspendedOn: day('2026-10-05') }),
          act(oct, 'record_suspension', {
            suspendedOn: day('2026-10-05'),
            period: OCTOBER,
          }),
        ]);
        expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
        expect(outcomes.filter((o) => !o.ok)).toEqual([
          { ok: false, reason: 'record-unavailable' },
        ]);
        expect(await count('suspension_records')).toBe(1);
      });

      it('a refused action leaves the version unchanged', async () => {
        const id = await seedWarning();
        expect(await act(id, 'void', { note: 'x' })).toEqual({
          ok: false,
          reason: 'not-allowed',
        });
        expect(await act(id, 'hold', { note: '   ' })).toEqual({
          ok: false,
          reason: 'note-required',
        });
        expect(
          await act(id, 'record_suspension', {
            suspendedOn: day('2026-10-03'),
          }),
        ).toEqual({ ok: false, reason: 'wrong-classification' });
        expect(await stateOf(id)).toMatchObject({ version: 1, status: 'new' });
        expect(await eventsOf(id)).toHaveLength(1);
      });
    });
  },
);
