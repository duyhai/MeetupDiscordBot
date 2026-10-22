import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  formatRecordSummary,
  recordCsvRows,
} from '../../src/lib/helpers/recordSuspensions.js';
import { parseSuspensionCsv } from '../../src/lib/helpers/suspensionCsv.js';
import { ensureBanSchema } from '../../src/lib/repositories/postgresBanRepository.js';
import { PostgresSuspensionRepository } from '../../src/lib/repositories/postgresSuspensionRepository.js';
import { MEMBER_LOCK_CLASS } from '../../src/lib/repositories/dashboardPool.js';
import { useIsolatedSchema } from './isolatedSchema.js';

// M5 (Hai, 2026-10-22, "yes to both" via the lead): /meetup_record_suspension
// refuses a member with an active ban, under the member lock.
const POSTGRES_AVAILABLE = Boolean(process.env.DATABASE_URL);

const MOD = '123456789012345678';

const at = (day: string) => new Date(`${day}T00:00:00Z`);
const row = (memberId: string, day = '2026-10-01') => ({
  memberId,
  memberName: null,
  suspendedAt: at(day),
  durationDays: 30,
  notes: null,
});

/** Re-runs `check` every 20 ms until it is true; false after `timeoutMs`. */
async function pollUntil(
  check: () => Promise<boolean>,
  timeoutMs = 5000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

(POSTGRES_AVAILABLE ? describe : describe.skip)(
  'the suspension import and active bans',
  () => {
    let schema: { drop(): Promise<void> };
    let pool: pg.Pool;
    let repo: PostgresSuspensionRepository;

    const banSql = `INSERT INTO member_bans (member_id, recorded_by) VALUES ($1, $2)`;
    const liftedBanSql = `INSERT INTO member_bans (member_id, recorded_by, lifted_at, lifted_by, lift_reason)
      VALUES ($1, $2, now(), $2, 'lifted')`;
    const suspensionsOf = async (memberId: string): Promise<number> =>
      (
        await pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM suspension_records WHERE member_id = $1',
          [memberId],
        )
      ).rows[0].n;

    beforeAll(async () => {
      // Before the singleton exists, so its pool lands in the isolated schema.
      schema = await useIsolatedSchema('suspension_bans');
      pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        max: 4,
      });
      await ensureBanSchema(pool);
      repo = await PostgresSuspensionRepository.instance();
    });

    beforeEach(async () => {
      await repo.deleteAllForTest();
      await pool.query('DELETE FROM member_bans');
    });

    afterAll(async () => {
      await (repo as unknown as { pool: pg.Pool } | undefined)?.pool.end();
      await pool?.end();
      await schema?.drop();
    });

    it('an active ban refuses the row; a lifted ban does not; the rest of the batch is inserted', async () => {
      await pool.query(banSql, ['500', MOD]);
      await pool.query(liftedBanSql, ['600', MOD]);
      const { inserted, banned } = await repo.insertMany([
        row('500'),
        row('600'),
        row('700'),
        row('500', '2026-10-08'),
      ]);
      expect(banned).toEqual(['500']);
      expect(inserted.map((r) => r.memberId)).toEqual(['600', '700']);
      expect(await suspensionsOf('500')).toBe(0);
      expect(await suspensionsOf('600')).toBe(1);
    });

    it('the historical import (CSV, recordCsvRows, summary) reports the banned member instead of dropping it', async () => {
      await pool.query(banSql, ['500', MOD]);
      const csv = [
        'member_id,member_name,duration_days,suspended_at,notes',
        '100,Ann,30,2025-03-01,',
        '500,Banned Person,30,2025-04-01,no-show',
        '200,,60,2025-05-01,',
      ].join('\n');
      const outcome = await recordCsvRows(
        repo,
        parseSuspensionCsv(csv),
        new Map([['100', 'Ann']]),
      );
      expect(outcome.recorded.map((r) => r.memberId)).toEqual(['100', '200']);
      expect(outcome.banned).toEqual([
        expect.objectContaining({ memberId: '500', rowNumber: 3 }),
      ]);
      const summary = formatRecordSummary(outcome);
      expect(summary.result).toContain('1 refused: member is banned');
      expect(summary.body).toContain('- member 500 is banned [row 3]');
      expect(summary.body).not.toContain('Banned Person');
      expect(await suspensionsOf('500')).toBe(0);
      expect(await suspensionsOf('100')).toBe(1);
      expect(await suspensionsOf('200')).toBe(1);
    });

    it('waits on the member lock, then sees a ban committed by the lock holder', async () => {
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(
          "SELECT pg_advisory_xact_lock($1, hashtext('suspension:' || $2))",
          [MEMBER_LOCK_CLASS, '800'],
        );
        const importing = repo.insertMany([row('900'), row('800')]);
        let settled = false;
        void importing.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        const waiting = await pollUntil(
          async () =>
            (
              await pool.query<{ n: number }>(
                // Member 800's key only: two-int advisory keys show as
                // classid and objid (objsubid 2).
                `SELECT count(*)::int AS n FROM pg_locks l
                   JOIN pg_stat_activity a ON a.pid = l.pid
                  WHERE l.locktype = 'advisory' AND NOT l.granted
                    AND a.datname = current_database() AND l.pid <> pg_backend_pid()
                    AND l.classid = $1::int::oid
                    AND l.objid = hashtext('suspension:' || $2)::oid
                    AND l.objsubid = 2`,
                [MEMBER_LOCK_CLASS, '800'],
              )
            ).rows[0].n > 0,
        );
        expect(waiting).toBe(true);
        expect(settled).toBe(false);
        // As a ban recorded under the same lock (D9) would.
        await holder.query(banSql, ['800', MOD]);
        await holder.query('COMMIT');
        const { inserted, banned } = await importing;
        expect(banned).toEqual(['800']);
        expect(inserted.map((r) => r.memberId)).toEqual(['900']);
        expect(await suspensionsOf('800')).toBe(0);
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
    });
  },
);
