import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Period } from '../../src/lib/reports/period.js';
import {
  HallOfFamePayload,
  NoShowPayload,
} from '../../src/lib/reports/types.js';
import { ensureDashboardSchema } from '../../src/lib/repositories/dashboardPool.js';
import {
  PostgresReportSnapshotRepository,
  SnapshotWrite,
} from '../../src/lib/repositories/postgresReportSnapshotRepository.js';

// Requires DATABASE_URL against a throwaway Postgres; skipped otherwise.
const POSTGRES_AVAILABLE = Boolean(process.env.DATABASE_URL);

if (!POSTGRES_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    'Skipping PostgresReportSnapshotRepository integration tests: set DATABASE_URL to a reachable Postgres to run them.',
  );
}

const SEPTEMBER: Period = { year: 2026, month: 9 };

function hallOfFame(events: number, period = '2026-09'): HallOfFamePayload {
  return {
    version: 1,
    reportType: 'hall_of_fame',
    period,
    asOf: '2026-10-01T07:00:00.000Z',
    summary: { events, hosts: 1, newHosts: 0 },
    totalEvents: events,
    hosts: [
      {
        host: {
          id: '111',
          name: 'Ann',
          memberUrl: 'https://www.meetup.com/members/111/',
        },
        isNew: false,
        events: [],
      },
    ],
  };
}

function noShow(noShows: number): NoShowPayload {
  return {
    version: 1,
    reportType: 'no_show',
    period: '2026-09',
    asOf: '2026-10-01T07:00:00.000Z',
    summary: {
      noShows,
      members: noShows,
      warnings: 0,
      suspensionCandidates: 0,
      cleared: 0,
      departed: 0,
    },
    attendance: { pastEventsWithRsvps: 4, eventsWithNoShow: 1, noShows },
    cases: [],
    cleared: [],
    departed: [],
  };
}

function write(overrides: Partial<SnapshotWrite> = {}): SnapshotWrite {
  return {
    reportType: 'hall_of_fame',
    period: SEPTEMBER,
    builtAt: new Date('2026-10-01T08:00:00.000Z'),
    builtBy: 'job',
    sourceComplete: true,
    payload: hallOfFame(3),
    mode: 'update-open',
    ...overrides,
  };
}

function testPool(max: number, options?: string): pg.Pool {
  return new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max,
    options,
  });
}

(POSTGRES_AVAILABLE ? describe : describe.skip)(
  'PostgresReportSnapshotRepository',
  () => {
    let pool: pg.Pool;
    let repo: PostgresReportSnapshotRepository;

    async function rows() {
      const result = await pool.query<{
        id: number;
        report_type: string;
        superseded_by: number | null;
      }>(
        'SELECT id, report_type, superseded_by FROM report_snapshots ORDER BY id',
      );
      return result.rows;
    }

    beforeAll(async () => {
      pool = testPool(6);
      await ensureDashboardSchema(pool);
      repo = new PostgresReportSnapshotRepository(pool);
    });

    beforeEach(async () => {
      await pool.query('TRUNCATE report_snapshots RESTART IDENTITY');
    });

    afterAll(async () => {
      await pool.end();
    });

    it('save then getCurrent', async () => {
      const builtAt = new Date('2026-10-01T08:15:30.123Z');
      const saved = await repo.save(write({ builtAt }));
      expect(saved).toEqual({
        id: 1,
        reportType: 'hall_of_fame',
        period: SEPTEMBER,
        builtAt,
        builtBy: 'job',
        sourceComplete: true,
        summary: { events: 3, hosts: 1, newHosts: 0 },
      });
      const current = await repo.getCurrent('hall_of_fame', SEPTEMBER);
      expect(current.payload).toEqual(hallOfFame(3));
      expect(current.period).toEqual({ year: 2026, month: 9 });
      expect(current.builtAt).toEqual(builtAt);
      expect(current.builtBy).toBe('job');
      const meta = await repo.getCurrentMeta('hall_of_fame', SEPTEMBER);
      expect(meta).toEqual(saved);
      expect(meta).not.toHaveProperty('payload');
      expect(
        await repo.getCurrent('hall_of_fame', { year: 2026, month: 8 }),
      ).toBeUndefined();
      expect(await repo.getCurrentMeta('no_show', SEPTEMBER)).toBeUndefined();
    });

    it('stores a source_complete of false as given', async () => {
      await repo.save(
        write({
          reportType: 'no_show',
          payload: noShow(2),
          sourceComplete: false,
        }),
      );
      const meta = await repo.getCurrentMeta('no_show', SEPTEMBER);
      expect(meta.sourceComplete).toBe(false);
    });

    it('current month updates in place', async () => {
      const first = await repo.save(write());
      const laterAt = new Date('2026-10-02T08:00:00.000Z');
      const second = await repo.save(
        write({
          payload: hallOfFame(5),
          builtAt: laterAt,
          builtBy: '1234567890',
        }),
      );
      expect(second.id).toBe(first.id);
      expect(await rows()).toHaveLength(1);
      const current = await repo.getCurrent('hall_of_fame', SEPTEMBER);
      expect(current.payload).toEqual(hallOfFame(5));
      expect(current.builtAt).toEqual(laterAt);
      expect(current.builtBy).toBe('1234567890');
    });

    it('finished-month rebuild supersedes and keeps history', async () => {
      await repo.save(write({ payload: hallOfFame(1) }));
      await repo.save(write({ payload: hallOfFame(2), mode: 'supersede' }));
      const third = await repo.save(
        write({
          payload: hallOfFame(3),
          mode: 'supersede',
          builtBy: 'backfill',
        }),
      );
      expect(third.id).toBe(3);
      expect(await rows()).toHaveLength(3);
      const history = await repo.listHistory('hall_of_fame', SEPTEMBER);
      expect(history.map((h) => [h.id, h.supersededBy])).toEqual([
        [1, 2],
        [2, 3],
        [3, null],
      ]);
      expect(history.map((h) => h.summary)).toEqual([
        hallOfFame(1).summary,
        hallOfFame(2).summary,
        hallOfFame(3).summary,
      ]);
      expect(history[0]).not.toHaveProperty('payload');
      const current = await repo.getCurrent('hall_of_fame', SEPTEMBER);
      expect(current.id).toBe(3);
      expect(current.payload).toEqual(hallOfFame(3));
      expect(current.builtBy).toBe('backfill');
    });

    it('concurrent saves leave exactly one current row', async () => {
      await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          repo.save(write({ payload: hallOfFame(i), mode: 'supersede' })),
        ),
      );
      const all = await rows();
      expect(all).toHaveLength(6);
      expect(all.filter((r) => r.superseded_by === null)).toHaveLength(1);
      const ids = new Set(all.map((r) => r.id));
      for (const r of all) {
        if (r.superseded_by !== null) {
          expect(ids.has(r.superseded_by)).toBe(true);
        }
      }
      // The history is one chain: every row is superseded by a distinct row.
      const targets = all
        .map((r) => r.superseded_by)
        .filter((id) => id !== null);
      expect(new Set(targets).size).toBe(5);

      await pool.query('TRUNCATE report_snapshots RESTART IDENTITY');
      await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          repo.save(write({ payload: hallOfFame(i), mode: 'update-open' })),
        ),
      );
      expect(await rows()).toHaveLength(1);
    });

    it('a failed supersede leaves the previous row current', async () => {
      const previous = await repo.save(write());
      await expect(
        repo.save(write({ mode: 'supersede', sourceComplete: null })),
      ).rejects.toThrow(/null value in column "source_complete"/);
      const all = await rows();
      expect(all).toEqual([
        { id: previous.id, report_type: 'hall_of_fame', superseded_by: null },
      ]);
      expect((await repo.getCurrentMeta('hall_of_fame', SEPTEMBER)).id).toBe(
        previous.id,
      );
      // The pool's connections are still usable after the rollback.
      const next = await repo.save(write({ mode: 'supersede' }));
      expect(next.id).toBeGreaterThan(previous.id);
    });

    it('schema is idempotent', async () => {
      await repo.save(write());
      await Promise.all([
        ensureDashboardSchema(pool),
        ensureDashboardSchema(pool),
        ensureDashboardSchema(pool),
      ]);
      await ensureDashboardSchema(pool);
      expect(await rows()).toHaveLength(1);
    });

    it('first-time schema creation from concurrent sessions succeeds', async () => {
      // A fresh Postgres schema per round, so every round is a true first
      // creation racing on pg_type/pg_class; without the advisory lock this
      // fails with a unique violation or "already exists".
      for (let round = 0; round < 5; round += 1) {
        const schema = `dash_schema_${randomUUID().replaceAll('-', '')}`;
        // eslint-disable-next-line no-await-in-loop
        await pool.query(`CREATE SCHEMA ${schema}`);
        const scoped = testPool(8, `-c search_path=${schema}`);
        try {
          // eslint-disable-next-line no-await-in-loop
          await Promise.all(
            Array.from({ length: 8 }, () => ensureDashboardSchema(scoped)),
          );
          // eslint-disable-next-line no-await-in-loop
          const tables = await pool.query<{ table_name: string }>(
            `SELECT table_name FROM information_schema.tables
             WHERE table_schema = $1 ORDER BY table_name`,
            [schema],
          );
          expect(tables.rows.map((t) => t.table_name)).toEqual([
            'dashboard_notices',
            'link_progress_daily',
            'report_snapshots',
          ]);
        } finally {
          // eslint-disable-next-line no-await-in-loop
          await scoped.end();
          // eslint-disable-next-line no-await-in-loop
          await pool.query(`DROP SCHEMA ${schema} CASCADE`);
        }
      }
    });

    it('the schema rejects a period that is not the first of a month and an unknown built_by', async () => {
      const insert = `INSERT INTO report_snapshots
        (report_type, period, built_at, built_by, source_complete, payload)
        VALUES ('hall_of_fame', $1::date, now(), $2, true, '{}'::jsonb)`;
      await expect(pool.query(insert, ['2026-09-02', 'job'])).rejects.toThrow(
        /check constraint/,
      );
      await expect(
        pool.query(insert, ['2026-09-01', 'someone']),
      ).rejects.toThrow(/check constraint/);
      await expect(repo.save(write({ builtBy: 'someone' }))).rejects.toThrow(
        RangeError,
      );
      await expect(repo.save(write({ builtBy: '' }))).rejects.toThrow(
        RangeError,
      );
      expect(await rows()).toHaveLength(0);
    });

    it('listSummaries pages without payloads', async () => {
      await repo.save(
        write({
          period: { year: 2026, month: 7 },
          payload: hallOfFame(7, '2026-07'),
        }),
      );
      await repo.save(
        write({
          period: { year: 2026, month: 8 },
          payload: hallOfFame(8, '2026-08'),
        }),
      );
      await repo.save(write({ payload: hallOfFame(90) }));
      await repo.save(write({ payload: hallOfFame(9), mode: 'supersede' }));

      const firstPage = await repo.listSummaries('hall_of_fame', { limit: 2 });
      expect(firstPage.map((s) => s.period)).toEqual([
        { year: 2026, month: 9 },
        { year: 2026, month: 8 },
      ]);
      expect(firstPage.map((s) => s.summary)).toEqual([
        hallOfFame(9).summary,
        hallOfFame(8).summary,
      ]);
      for (const s of firstPage) {
        expect(s).not.toHaveProperty('payload');
      }
      const nextPage = await repo.listSummaries('hall_of_fame', {
        before: { year: 2026, month: 8 },
      });
      expect(nextPage.map((s) => s.period)).toEqual([{ year: 2026, month: 7 }]);

      const all = await repo.listSummaries('hall_of_fame');
      expect(all).toHaveLength(3);
      expect(all.map((s) => s.id)).not.toContain(3);
      expect(await repo.listSummaries('no_show')).toEqual([]);
      // Out-of-range limits are clamped to 1..50.
      expect(
        await repo.listSummaries('hall_of_fame', { limit: 0 }),
      ).toHaveLength(1);
      expect(
        await repo.listSummaries('hall_of_fame', { limit: 500 }),
      ).toHaveLength(3);
    });

    it('snapshots of the two report types do not interfere', async () => {
      const hof = await repo.save(write());
      await repo.save(write({ reportType: 'no_show', payload: noShow(2) }));
      await repo.save(
        write({ reportType: 'no_show', payload: noShow(3), mode: 'supersede' }),
      );
      const current = await repo.getCurrentMeta('hall_of_fame', SEPTEMBER);
      expect(current).toEqual(hof);
      expect(await repo.listHistory('hall_of_fame', SEPTEMBER)).toHaveLength(1);
      expect(await repo.listHistory('no_show', SEPTEMBER)).toHaveLength(2);
      expect((await repo.getCurrent('no_show', SEPTEMBER)).payload).toEqual(
        noShow(3),
      );
    });
  },
);
