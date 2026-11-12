import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ensureDashboardSchema } from '../../src/lib/repositories/dashboardPool.js';
import { PostgresWrappedBackfillRepository } from '../../src/lib/repositories/postgresWrappedBackfillRepository.js';
import { useIsolatedSchema } from './isolatedSchema.js';

// Requires DATABASE_URL against a throwaway Postgres; skipped otherwise.
const POSTGRES_AVAILABLE = Boolean(process.env.DATABASE_URL);

if (!POSTGRES_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    'Skipping PostgresWrappedBackfillRepository integration tests: set DATABASE_URL to a reachable Postgres to run them.',
  );
}

const A = '100000000000000001';
const B = '100000000000000002';
const C = '100000000000000003';

const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

(POSTGRES_AVAILABLE ? describe : describe.skip)(
  'PostgresWrappedBackfillRepository',
  () => {
    let schema: { drop(): Promise<void> };
    let pool: pg.Pool;
    let repo: PostgresWrappedBackfillRepository;
    const another = () => new PostgresWrappedBackfillRepository(pool);

    beforeAll(async () => {
      schema = await useIsolatedSchema('wrapped_backfill');
      pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        max: 6,
      });
    });

    beforeEach(async () => {
      await pool.query(
        'DROP TABLE IF EXISTS wrapped_backfill_deferred, wrapped_backfill_runs',
      );
      await pool.query('DROP TABLE IF EXISTS wrapped_queue');
      await ensureDashboardSchema(pool);
      repo = another();
    });

    afterAll(async () => {
      await pool.end();
      await schema.drop();
    });

    it('the schema is idempotent on a second boot', async () => {
      await ensureDashboardSchema(pool);
      expect(await repo.openRun()).toBeUndefined();
      expect(await repo.queueLength()).toBe(0);
    });

    it('starts one run at a time; a second start while one is open is refused', async () => {
      const run = await repo.startRun('job', 12);
      expect(run).toMatchObject({
        trigger: 'job',
        membersTotal: 12,
        membersDone: 0,
        cursor: undefined,
        finishedAt: undefined,
      });
      expect(await another().startRun(A, 12)).toBeUndefined();
      expect((await repo.openRun())?.id).toBe(run?.id);
      const finished = await repo.finishRun(run.id);
      expect(finished?.finishedAt).toBeInstanceOf(Date);
      expect(await repo.openRun()).toBeUndefined();
      expect((await repo.lastFinishedRun())?.id).toBe(run?.id);
      expect(await repo.startRun(A, 13)).toMatchObject({ trigger: A });
    });

    it('advance is a compare-and-set and sums the deltas', async () => {
      const run = await repo.startRun('job', 3);
      expect(
        await repo.advanceRun(run.id, undefined, A, {
          done: 1,
          built: 2,
          skipped: 1,
          failed: 0,
        }),
      ).toBe(true);
      await repo.recordRequests(run.id, 40);
      // Another process that still thinks the cursor is unset loses.
      expect(
        await another().advanceRun(run.id, undefined, B, {
          done: 1,
          built: 0,
          skipped: 0,
          failed: 1,
        }),
      ).toBe(false);
      expect(
        await repo.advanceRun(run.id, A, B, {
          done: 1,
          built: 0,
          skipped: 0,
          failed: 1,
        }),
      ).toBe(true);
      await repo.recordRequests(run.id, 2);
      expect(await repo.openRun()).toMatchObject({
        cursor: B,
        membersDone: 2,
        built: 2,
        skipped: 1,
        failed: 1,
        requests: 42,
      });
    });

    it('defers members past the cursor (compare-and-set) and completes them with their deltas', async () => {
      const run = await repo.startRun('job', 3);
      const id = run.id;
      expect(await repo.deferMember(id, undefined, '11')).toBe(true);
      // Stale cursor: refused, nothing deferred.
      expect(await repo.deferMember(id, undefined, '12')).toBe(false);
      expect(
        await repo.advanceRun(id, '11', '12', {
          done: 1,
          built: 2,
          skipped: 0,
          failed: 0,
        }),
      ).toBe(true);
      expect(await repo.deferMember(id, '12', '13')).toBe(true);
      expect(await repo.deferredCount(id)).toBe(2);
      expect(await repo.nextDeferred(id, 5)).toEqual(['11', '13']);
      expect(
        await repo.completeDeferred(id, '11', {
          done: 1,
          built: 3,
          skipped: 0,
          failed: 1,
        }),
      ).toBe(true);
      // Already completed (another process): false, nothing added twice.
      expect(
        await repo.completeDeferred(id, '11', {
          done: 1,
          built: 3,
          skipped: 0,
          failed: 1,
        }),
      ).toBe(false);
      expect(await repo.nextDeferred(id, 5)).toEqual(['13']);
      const open = await repo.openRun();
      expect(open).toMatchObject({
        cursor: '13',
        membersDone: 2,
        built: 5,
        failed: 1,
      });
    });

    it('enqueue keeps the first year for a member', async () => {
      expect(
        await repo.enqueue({ discordUserId: A, meetupId: 'm1', year: 2026 }),
      ).toBe('queued');
      expect(
        await repo.enqueue({ discordUserId: A, meetupId: 'm1', year: 2025 }),
      ).toEqual({ already: 2026 });
      expect((await repo.position(A))?.row.year).toBe(2026);
    });

    it('positions by queued_at and counts the queue', async () => {
      await repo.enqueue({ discordUserId: A, meetupId: 'm1', year: 2026 });
      await pause(5);
      await repo.enqueue({ discordUserId: B, meetupId: 'm2', year: 2026 });
      await pause(5);
      await repo.enqueue({ discordUserId: C, meetupId: 'm3', year: 2024 });
      expect((await repo.position(A))?.position).toBe(1);
      expect((await repo.position(B))?.position).toBe(2);
      expect((await repo.position(C))?.position).toBe(3);
      expect(await repo.queueLength()).toBe(3);
      expect(await repo.position('100000000000000009')).toBeUndefined();
    });

    it('claimNext takes the oldest unclaimed, then nothing until the claim is stale', async () => {
      await repo.enqueue({ discordUserId: A, meetupId: 'm1', year: 2026 });
      await pause(5);
      await repo.enqueue({ discordUserId: B, meetupId: 'm2', year: 2026 });
      await pause(5);
      await repo.enqueue({ discordUserId: C, meetupId: 'm3', year: 2024 });
      const first = await repo.claimNext(2, 60_000);
      expect(first.map((r) => r.discordUserId)).toEqual([A, B]);
      expect(first[0]).toMatchObject({
        meetupId: 'm1',
        year: 2026,
        attempts: 0,
      });
      expect(
        (await repo.claimNext(2, 60_000)).map((r) => r.discordUserId),
      ).toEqual([C]);
      expect(await repo.claimNext(2, 60_000)).toEqual([]);
      await pause(5);
      // Claims older than the stale window are taken again (a crashed tick).
      expect((await repo.claimNext(2, 0)).map((r) => r.discordUserId)).toEqual([
        A,
        B,
      ]);
    });

    it('two claimers never get the same row', async () => {
      await repo.enqueue({ discordUserId: A, meetupId: 'm1', year: 2026 });
      await repo.enqueue({ discordUserId: B, meetupId: 'm2', year: 2026 });
      await repo.enqueue({ discordUserId: C, meetupId: 'm3', year: 2024 });
      const [x, y] = await Promise.all([
        another().claimNext(2, 60_000),
        another().claimNext(2, 60_000),
      ]);
      const ids = [...x, ...y].map((r) => r.discordUserId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(3);
    });

    it('release counts attempts and drops at the cap', async () => {
      await repo.enqueue({ discordUserId: A, meetupId: 'm1', year: 2026 });
      await repo.claimNext(1, 60_000);
      expect(await repo.release(A, 3)).toBe('released');
      expect((await repo.position(A))?.row.attempts).toBe(1);
      await repo.claimNext(1, 60_000);
      expect(await repo.release(A, 3)).toBe('released');
      await repo.claimNext(1, 60_000);
      expect(await repo.release(A, 3)).toBe('dropped');
      expect(await repo.position(A)).toBeUndefined();
      expect(await repo.queueLength()).toBe(0);
    });

    it('unclaim hands a claimed row back without an attempt', async () => {
      await repo.enqueue({ discordUserId: A, meetupId: 'm1', year: 2026 });
      await repo.claimNext(1, 60_000);
      expect(await repo.claimNext(1, 60_000)).toEqual([]);
      await repo.unclaim(A);
      const [row] = await repo.claimNext(1, 60_000);
      expect(row).toMatchObject({ discordUserId: A, attempts: 0 });
    });

    it('complete removes the row', async () => {
      await repo.enqueue({ discordUserId: A, meetupId: 'm1', year: 2026 });
      await repo.complete(A);
      expect(await repo.position(A)).toBeUndefined();
      await repo.complete(A); // no row: a no-op
    });
  },
);
