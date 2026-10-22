import dayjs from 'dayjs';
import pg from 'pg';
import { Logger } from 'tslog';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  isSuspensionActive,
  pacificToday,
} from '../../src/lib/helpers/suspensionList.js';
import { PostgresMemberRepository } from '../../src/lib/repositories/postgresMemberRepository.js';
import { suspensionHistory } from '../../src/lib/helpers/noShowReport.js';
import {
  ensureSuspensionSchema,
  PostgresSuspensionRepository,
  SCHEMA_SQL,
  SUSPENSION_SCHEMA_LOCK_KEY,
} from '../../src/lib/repositories/postgresSuspensionRepository.js';
import { DASHBOARD_LOCK_CLASS } from '../../src/lib/repositories/dashboardPool.js';
import { useIsolatedSchema } from './isolatedSchema.js';

// Mirrors tst/integration/postgresMemberRepository.test.ts conventions:
// requires DATABASE_URL against a real Postgres, skipped otherwise. Locally:
//   yarn test:integration:docker   (boots the Docker stack and wires the env)
const POSTGRES_AVAILABLE = Boolean(process.env.DATABASE_URL);

if (!POSTGRES_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    'Skipping PostgresSuspensionRepository integration tests: set DATABASE_URL to a reachable Postgres to run them.',
  );
}

(POSTGRES_AVAILABLE ? describe : describe.skip)(
  'PostgresSuspensionRepository',
  () => {
    let repo: PostgresSuspensionRepository;
    let schema: { drop(): Promise<void> };

    beforeAll(async () => {
      // Before the singleton exists, so its pool lands in the isolated schema.
      schema = await useIsolatedSchema('suspensions');
      repo = await PostgresSuspensionRepository.instance();
    });

    afterAll(async () => {
      await (repo as unknown as { pool: pg.Pool } | undefined)?.pool.end();
      await schema?.drop();
    });

    afterEach(async () => {
      await repo.deleteAllForTest();
    });

    const record = {
      memberId: 'm1',
      memberName: 'Alice',
      suspendedAt: new Date('2026-09-01T00:00:00Z'),
      durationDays: 30,
      notes: null,
    };

    it('inserts and counts by member', async () => {
      await repo.insert(record);
      // A different suspendedAt: repeat suspensions on different dates are
      // expected and must both be counted.
      await repo.insert({
        ...record,
        suspendedAt: new Date('2026-10-01T00:00:00Z'),
        durationDays: 60,
      });
      expect((await repo.listByMemberId('m1')).length).toBe(2);
      expect((await repo.listByMemberId('other')).length).toBe(0);
    });

    it('counts only suspensions dated before the given date', async () => {
      // A moderator back-records a September suspension for a member who
      // already has one in October. The October one is later, not prior, so
      // September must be computed as a first suspension: 30 days, not 60.
      await repo.insert({
        ...record,
        suspendedAt: new Date('2026-10-01T00:00:00Z'),
      });
      const september = new Date('2026-09-01T00:00:00Z');
      expect(await repo.countSuspensionsBefore('m1', september)).toBe(0);
      expect(
        await repo.countSuspensionsBefore(
          'm1',
          new Date('2026-11-01T00:00:00Z'),
        ),
      ).toBe(1);
      // Strictly before: a record on the date itself is not prior to itself.
      expect(
        await repo.countSuspensionsBefore(
          'm1',
          new Date('2026-10-01T00:00:00Z'),
        ),
      ).toBe(0);
    });

    it('insert skips an exact (member_id, suspended_at) duplicate', async () => {
      const first = await repo.insert(record);
      const second = await repo.insert({ ...record, durationDays: 60 });
      expect(first).toBeDefined();
      expect(second).toBeUndefined();
      expect((await repo.listByMemberId('m1')).length).toBe(1);
    });

    it('insert allows the same member on a different date (repeat suspension)', async () => {
      await repo.insert(record);
      const second = await repo.insert({
        ...record,
        suspendedAt: new Date('2026-10-01T00:00:00Z'),
        durationDays: 60,
      });
      expect(second).toBeDefined();
      expect((await repo.listByMemberId('m1')).length).toBe(2);
    });

    it('lists records for a member, newest first', async () => {
      await repo.insert(record);
      await repo.insert({
        ...record,
        suspendedAt: new Date('2026-10-01T00:00:00Z'),
        durationDays: 60,
      });
      const rows = await repo.listByMemberId('m1');
      expect(rows).toHaveLength(2);
      expect(rows[0].durationDays).toBe(60);
    });

    it('insertMany reports no ban where member_bans does not exist (a database the dashboard never ran on)', async () => {
      const { inserted, banned } = await repo.insertMany([record]);
      expect(inserted).toHaveLength(1);
      expect(banned).toEqual([]);
    });

    it('insertMany inserts all rows atomically', async () => {
      const { inserted: rows } = await repo.insertMany([
        record,
        { ...record, memberId: 'm2', memberName: 'Bob' },
      ]);
      expect(rows).toHaveLength(2);
      expect((await repo.listByMemberId('m2')).length).toBe(1);
    });

    it('insertMany skips exact duplicates and returns only the inserted rows', async () => {
      await repo.insert(record);
      const { inserted: rows } = await repo.insertMany([
        record, // exact duplicate of the pre-existing row: skipped
        { ...record, memberId: 'm2', memberName: 'Bob' },
        { ...record, memberId: 'm2', memberName: 'Bob' }, // duplicate within the batch
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0].memberId).toBe('m2');
      expect((await repo.listByMemberId('m1')).length).toBe(1);
      expect((await repo.listByMemberId('m2')).length).toBe(1);
    });

    it('listAll returns every record, newest suspension first', async () => {
      await repo.insert(record);
      await repo.insert({
        ...record,
        memberId: 'm2',
        suspendedAt: new Date('2026-10-01T00:00:00Z'),
      });
      const rows = await repo.listAll();
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.memberId)).toEqual(['m2', 'm1']);
    });
    it('listByMemberIds returns live records for the given members before the cutoff', async () => {
      const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
      await repo.insert({ ...record, suspendedAt: day('2026-09-01') });
      await repo.insert({ ...record, suspendedAt: day('2026-10-01') });
      const voided = await repo.insert({
        ...record,
        memberId: 'm2',
        suspendedAt: day('2026-09-15'),
      });
      await repo.void(voided.id, 'mod-1', 'wrong member');
      await repo.insert({
        ...record,
        memberId: 'm3',
        suspendedAt: day('2026-09-20'),
      });

      const beforeCutoff = await repo.listByMemberIds(
        ['m1', 'm2'],
        day('2026-10-01'),
      );
      expect(
        beforeCutoff.map((r) => [r.memberId, r.suspendedAt.toISOString()]),
      ).toEqual([['m1', '2026-09-01T00:00:00.000Z']]);

      const all = await repo.listByMemberIds(['m1', 'm2']);
      expect(all.map((r) => [r.memberId, r.suspendedAt.toISOString()])).toEqual(
        [
          ['m1', '2026-10-01T00:00:00.000Z'],
          ['m1', '2026-09-01T00:00:00.000Z'],
        ],
      );

      expect(await repo.listByMemberIds([])).toEqual([]);
    });

    it('listByIds returns voided records too, and runs no query for no ids', async () => {
      const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
      const live = await repo.insert({
        ...record,
        suspendedAt: day('2026-09-01'),
      });
      const gone = await repo.insert({
        ...record,
        memberId: 'm2',
        suspendedAt: day('2026-09-15'),
      });
      await repo.insert({ ...record, memberId: 'm3' });
      await repo.void(gone.id, '123456789012345678', 'wrong member');

      const rows = await repo.listByIds([gone.id, live.id, gone.id, -1, 0]);
      expect(rows.map((r) => r.id)).toEqual([live.id, gone.id]);
      expect(rows[0]).toMatchObject({
        memberId: 'm1',
        voidedAt: null,
        voidedBy: null,
        voidReason: null,
      });
      expect(rows[1]).toMatchObject({
        memberId: 'm2',
        voidedBy: '123456789012345678',
        voidReason: 'wrong member',
      });
      expect(rows[1].voidedAt).toBeInstanceOf(Date);
      expect(await repo.listByIds([999999])).toEqual([]);

      const pool = (repo as unknown as { pool: pg.Pool }).pool;
      const query = vi.spyOn(pool, 'query');
      try {
        expect(await repo.listByIds([])).toEqual([]);
        expect(await repo.listByIds([1.5, 2 ** 31])).toEqual([]);
        expect(query).not.toHaveBeenCalled();
      } finally {
        query.mockRestore();
      }
    });

    describe('void', () => {
      it('returns the voided record with who voided it and why', async () => {
        const inserted = await repo.insert(record);
        const voided = await repo.void(inserted.id, 'mod-1', 'wrong member');
        expect(voided).toEqual(
          expect.objectContaining({
            id: inserted.id,
            memberId: 'm1',
            durationDays: 30,
            voidedBy: 'mod-1',
            voidReason: 'wrong member',
          }),
        );
        expect(voided?.voidedAt).toBeInstanceOf(Date);
      });

      it('stops a voided row counting as a prior suspension', async () => {
        const inserted = await repo.insert(record);
        const later = new Date('2026-10-01T00:00:00Z');
        expect(await repo.countSuspensionsBefore('m1', later)).toBe(1);
        await repo.void(inserted.id, 'mod-1', 'wrong member');
        expect(await repo.countSuspensionsBefore('m1', later)).toBe(0);
      });

      it('drops a voided row out of both lists', async () => {
        const inserted = await repo.insert(record);
        await repo.insert({ ...record, memberId: 'm2' });
        await repo.void(inserted.id, 'mod-1', 'wrong member');
        expect(await repo.listByMemberId('m1')).toEqual([]);
        expect((await repo.listAll()).map((row) => row.memberId)).toEqual([
          'm2',
        ]);
      });

      it("leaves a voided row out of the No Show report's suspension history", async () => {
        // The report reads history only through listByMemberId: a voided
        // record must neither double the next penalty nor restart the
        // member's no-show count.
        await repo.insert({
          ...record,
          suspendedAt: new Date('2026-03-01T00:00:00Z'),
        });
        const wrong = await repo.insert(record);
        await repo.void(wrong.id, 'mod-1', 'recorded by mistake');

        expect(suspensionHistory(await repo.listByMemberId('m1'))).toEqual({
          priorCount: 1,
          lastSuspendedDay: '2026-03-01',
        });
      });

      it('lets the same member and date be recorded again after voiding', async () => {
        const inserted = await repo.insert(record);
        await repo.void(inserted.id, 'mod-1', 'wrong duration');
        const corrected = await repo.insert({ ...record, durationDays: 60 });
        expect(corrected).toBeDefined();
        expect(corrected?.id).not.toBe(inserted.id);
        const {
          inserted: [again],
        } = await repo.insertMany([{ ...record, memberId: 'm1' }]);
        // The corrected row is live again, so the pair is a duplicate once more.
        expect(again).toBeUndefined();
        expect(await repo.listByMemberId('m1')).toEqual([
          expect.objectContaining({ durationDays: 60 }),
        ]);
      });

      it('insertMany also records over a voided row', async () => {
        const inserted = await repo.insert(record);
        await repo.void(inserted.id, 'mod-1', 'wrong duration');
        const { inserted: rows } = await repo.insertMany([
          { ...record, durationDays: 60 },
        ]);
        expect(rows).toHaveLength(1);
      });

      it('returns undefined when voiding twice, or an unknown id', async () => {
        const inserted = await repo.insert(record);
        expect(await repo.void(inserted.id, 'mod-1', 'first')).toBeDefined();
        expect(await repo.void(inserted.id, 'mod-2', 'second')).toBeUndefined();
        expect(await repo.void(999999, 'mod-1', 'nope')).toBeUndefined();
      });
    });

    describe('listPage', () => {
      let members: PostgresMemberRepository;

      beforeAll(async () => {
        // Creates the members table, which belongs to the member repository.
        members = await PostgresMemberRepository.instance();
      });

      const at = (day: string) => new Date(`${day}T00:00:00Z`);
      const seed = async (
        memberId: string,
        day: string,
        durationDays: number,
        memberName: string | null = null,
      ) => {
        const row = await repo.insert({
          memberId,
          memberName,
          suspendedAt: at(day),
          durationDays,
          notes: `note ${memberId}`,
        });
        if (!row) {
          throw new Error('seed insert skipped');
        }
        return row;
      };
      const ids = (rows: { id: number }[]) =>
        rows.map((r) => r.id).sort((x, y) => x - y);
      const page = (
        state: 'active' | 'past' | 'voided',
        today: string,
        offset = 0,
        limit = 50,
      ) => repo.listPage({ state, today, offset, limit });

      it('active/past split matches /meetup_list_suspensions', async () => {
        await seed('1001', '2026-09-01', 30); // #a, last day 09-30
        await seed('1002', '2026-09-02', 30); // #b, last day 10-01
        await seed('1003', '2026-08-01', 30); // #c, last day 08-30
        await seed('1004', '2026-10-01', 60); // #d, last day 11-29
        const all = await repo.listAll();
        for (const now of [
          '2026-09-30T12:00:00Z',
          '2026-10-01T06:59:00Z', // still Sep 30 Pacific
          '2026-10-01T07:00:00Z', // Oct 1 Pacific
          '2026-10-02T07:00:00Z',
        ]) {
          const today = pacificToday(new Date(now));
          const command = all.filter((r) => isSuspensionActive(r, dayjs(now)));
          const commandPast = all.filter(
            (r) => !isSuspensionActive(r, dayjs(now)),
          );
          // eslint-disable-next-line no-await-in-loop -- one instant at a time
          expect(ids(await page('active', today)), now).toEqual(ids(command));
          // eslint-disable-next-line no-await-in-loop -- one instant at a time
          expect(ids(await page('past', today)), now).toEqual(ids(commandPast));
        }
      });

      it('parity holds across the 2026-11-01 DST change', async () => {
        await seed('1101', '2026-10-02', 30); // last day 10-31
        await seed('1102', '2026-10-03', 30); // last day 11-01
        await seed('1103', '2026-10-04', 30); // last day 11-02
        const all = await repo.listAll();
        for (const now of [
          '2026-11-01T06:59:00Z', // Oct 31 PDT
          '2026-11-01T07:00:00Z', // Nov 1 PDT
          '2026-11-01T08:00:00Z', // still Nov 1
          '2026-11-02T07:59:00Z', // Nov 1 11:59pm PST
          '2026-11-02T08:00:00Z', // Nov 2 PST
        ]) {
          const today = pacificToday(new Date(now));
          const command = all.filter((r) => isSuspensionActive(r, dayjs(now)));
          // eslint-disable-next-line no-await-in-loop -- one instant at a time
          expect(ids(await page('active', today)), now).toEqual(ids(command));
          // eslint-disable-next-line no-await-in-loop -- one instant at a time
          expect((await repo.countByState(today)).active, now).toBe(
            command.length,
          );
        }
      });

      it('a missing members table: no linked names, one warning without ids', async () => {
        await seed('8801', '2026-10-01', 30);
        const pool = (repo as unknown as { pool: pg.Pool }).pool;
        const realQuery = pool.query.bind(pool) as (
          ...args: unknown[]
        ) => Promise<unknown>;
        const missing = Object.assign(
          new Error('relation "members" does not exist'),
          { code: '42P01' },
        );
        function fakeQuery(text: unknown, ...rest: unknown[]) {
          if (typeof text === 'string' && text.includes('FROM members')) {
            return Promise.reject(missing);
          }
          return realQuery(text, ...rest);
        }
        const query = vi
          .spyOn(pool, 'query')
          // eslint-disable-next-line @typescript-eslint/no-misused-promises -- pool.query's callback overload
          .mockImplementation(fakeQuery);
        const warn = vi.spyOn(Logger.prototype, 'warn');
        try {
          const rows = await page('active', '2026-10-05');
          expect(rows.map((r) => r.memberId)).toEqual(['8801']);
          expect(rows[0]).toMatchObject({
            linkedName: null,
            linkedDiscordId: null,
          });
          expect(warn).toHaveBeenCalledTimes(1);
          const logged = JSON.stringify(warn.mock.calls[0]);
          expect(logged).toContain('members table missing');
          expect(logged).not.toContain('8801');
        } finally {
          warn.mockRestore();
          query.mockRestore();
        }
      });

      it('voided records appear only on the voided tab, newest void first, with reason and who voided', async () => {
        const live = await seed('2001', '2026-10-01', 30);
        const first = await seed('2002', '2026-10-01', 30);
        const second = await seed('2003', '2026-09-01', 30);
        await repo.void(first.id, '123456789012345678', 'wrong member');
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        });
        await repo.void(second.id, '223456789012345678', '<b>typo</b>');
        const today = '2026-10-05';
        expect(ids(await page('active', today))).toEqual([live.id]);
        expect(await page('past', today)).toEqual([]);
        const voided = await page('voided', today);
        expect(voided.map((r) => r.id)).toEqual([second.id, first.id]);
        expect(voided[0]).toMatchObject({
          voidedBy: '223456789012345678',
          voidReason: '<b>typo</b>',
        });
        expect(voided[0].voidedAt).toBeInstanceOf(Date);
        expect(voided[1].voidReason).toBe('wrong member');
        // The command never sees them either.
        expect(ids(await repo.listAll())).toEqual([live.id]);
      });

      it('countByState counts each tab', async () => {
        await seed('3001', '2026-09-01', 30);
        await seed('3002', '2026-10-01', 30);
        await seed('3003', '2026-10-02', 30);
        const v = await seed('3004', '2026-10-03', 30);
        await repo.void(v.id, '123456789012345678', 'dup');
        expect(await repo.countByState('2026-10-05')).toEqual({
          active: 2,
          past: 1,
          voided: 1,
        });
      });

      it('countByMonth counts live records by month', async () => {
        await seed('3101', '2026-07-31', 30);
        await seed('3102', '2026-08-01', 30);
        await seed('3103', '2026-08-31', 30);
        await seed('3104', '2026-10-01', 30);
        const v = await seed('3105', '2026-10-02', 30);
        await repo.void(v.id, '123456789012345678', 'dup');
        // From August 1 (UTC midnight, like suspended_at): July is left out,
        // the voided October record is excluded, and September has no row.
        expect(await repo.countByMonth(at('2026-08-01'))).toEqual([
          { month: '2026-08', count: 2 },
          { month: '2026-10', count: 1 },
        ]);
        expect(await repo.countByMonth(at('2026-11-01'))).toEqual([]);
      });

      it('countByMonth refuses an invalid date, and no query runs', async () => {
        const pool = (repo as unknown as { pool: pg.Pool }).pool;
        const query = vi.spyOn(pool, 'query');
        try {
          await expect(repo.countByMonth(new Date('nope'))).rejects.toThrow(
            RangeError,
          );
          await expect(
            repo.countByMonth('2026-01-01' as unknown as Date),
          ).rejects.toThrow(RangeError);
          expect(query).not.toHaveBeenCalled();
        } finally {
          query.mockRestore();
        }
      });

      it('orders like the command: newest suspended first', async () => {
        const older = await seed('4001', '2026-10-01', 90);
        const newest = await seed('4002', '2026-10-20', 30);
        const middle = await seed('4003', '2026-10-10', 30);
        const command = (await repo.listAll()).map((r) => r.id);
        const rows = (await page('active', '2026-10-21')).map((r) => r.id);
        expect(rows).toEqual([newest.id, middle.id, older.id]);
        expect(rows).toEqual(command);
      });

      it('linked members add name and Discord id', async () => {
        await members.upsert({
          discordUserId: '323456789012345678',
          meetupId: '5001',
          meetupName: 'Linked Lin',
          meetupMemberUrl: null,
          onboardMethod: 'manual',
          onboardedBy: null,
        });
        try {
          await seed('5001', '2026-10-01', 30);
          await seed('5002', '2026-10-01', 30, 'Stored Sam');
          const rows = await page('active', '2026-10-05');
          const linked = rows.find((r) => r.memberId === '5001');
          const unlinked = rows.find((r) => r.memberId === '5002');
          expect(linked).toMatchObject({
            memberName: null,
            linkedName: 'Linked Lin',
            linkedDiscordId: '323456789012345678',
            lastDay: '2026-10-30',
          });
          expect(unlinked).toMatchObject({
            memberName: 'Stored Sam',
            linkedName: null,
            linkedDiscordId: null,
          });
        } finally {
          await members.remove('323456789012345678');
        }
      });

      it('pages with offset and limit; limit capped at 50', async () => {
        await repo.insertMany(
          Array.from({ length: 55 }, (_, i) => ({
            memberId: String(6000 + i),
            memberName: null,
            suspendedAt: at('2026-10-01'),
            durationDays: 30,
            notes: null,
          })),
        );
        const today = '2026-10-05';
        expect(await page('active', today, 0, 500)).toHaveLength(50);
        const first = await page('active', today, 0, 10);
        const second = await page('active', today, 10, 10);
        expect(first).toHaveLength(10);
        expect(second).toHaveLength(10);
        expect(first.map((r) => r.id)).not.toContain(second[0].id);
        expect(await page('active', today, 50, 50)).toHaveLength(5);
        expect(await page('active', today, -5, 0)).toHaveLength(50);
      });

      it('refuses a bad state or today, and no query runs', async () => {
        const pool = (repo as unknown as { pool: pg.Pool }).pool;
        const query = vi.spyOn(pool, 'query');
        try {
          await expect(
            repo.listPage({
              state: 'active',
              today: "2026-10-01'; DROP",
              offset: 0,
              limit: 50,
            }),
          ).rejects.toThrow(RangeError);
          await expect(
            repo.listPage({
              state: 'everything' as 'active',
              today: '2026-10-01',
              offset: 0,
              limit: 50,
            }),
          ).rejects.toThrow(RangeError);
          await expect(repo.countByState('yesterday')).rejects.toThrow(
            RangeError,
          );
          expect(query).not.toHaveBeenCalled();
        } finally {
          query.mockRestore();
        }
      });
    });

    describe('schema ensure on boot', () => {
      const pool = () => (repo as unknown as { pool: pg.Pool }).pool;

      /**
       * The relation locks SCHEMA_SQL takes on an existing schema, read from
       * pg_locks inside the transaction (advisory lock, then the SQL), then
       * rolled back.
       */
      async function relationLocksDuringSchema(sql: string): Promise<string[]> {
        const client = await pool().connect();
        try {
          await client.query('BEGIN');
          await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
            DASHBOARD_LOCK_CLASS,
            SUSPENSION_SCHEMA_LOCK_KEY,
          ]);
          await client.query(sql);
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

      it('a second boot holds nothing stronger than AccessShareLock on suspension_records', async () => {
        await repo.insert(record);
        await ensureSuspensionSchema(pool());
        const locks = await relationLocksDuringSchema(SCHEMA_SQL);
        expect(locks.filter((l) => !l.endsWith(':AccessShareLock'))).toEqual(
          [],
        );
        // Not vacuous: the pre-guard statements take blocking locks even
        // when every column and index already exists.
        expect(
          await relationLocksDuringSchema(
            `ALTER TABLE suspension_records
               ADD COLUMN IF NOT EXISTS voided_at   TIMESTAMPTZ,
               ADD COLUMN IF NOT EXISTS voided_by   TEXT,
               ADD COLUMN IF NOT EXISTS void_reason TEXT`,
          ),
        ).toContain('suspension_records:AccessExclusiveLock');
        expect(
          await relationLocksDuringSchema(
            `CREATE INDEX IF NOT EXISTS suspension_records_member_id_idx
               ON suspension_records (member_id)`,
          ),
        ).toContain('suspension_records:ShareLock');
        expect((await repo.listByMemberId('m1')).length).toBe(1);
      });

      it('runs under the schema advisory lock, with a lock timeout', async () => {
        const holder = await pool().connect();
        try {
          await holder.query('BEGIN');
          await holder.query('SELECT pg_advisory_xact_lock($1, $2)', [
            DASHBOARD_LOCK_CLASS,
            SUSPENSION_SCHEMA_LOCK_KEY,
          ]);
          await expect(
            ensureSuspensionSchema(pool(), { lockTimeoutMs: 200 }),
          ).rejects.toThrow(/lock timeout/);
        } finally {
          await holder.query('ROLLBACK');
          holder.release();
        }
        await ensureSuspensionSchema(pool(), { lockTimeoutMs: 200 });
      });
    });

    describe('the guarded schema matches the unguarded one it replaced', () => {
      /** SCHEMA_SQL as it was before the boot guards (Task 5). */
      const UNGUARDED_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS suspension_records (
  id            SERIAL PRIMARY KEY,
  member_id     TEXT NOT NULL,
  member_name   TEXT,
  suspended_at  TIMESTAMPTZ NOT NULL,
  duration_days INTEGER NOT NULL,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE suspension_records
  ADD COLUMN IF NOT EXISTS voided_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by   TEXT,
  ADD COLUMN IF NOT EXISTS void_reason TEXT;
CREATE INDEX IF NOT EXISTS suspension_records_member_id_idx
  ON suspension_records (member_id);
DROP INDEX IF EXISTS suspension_records_member_suspended_at_idx;
CREATE UNIQUE INDEX IF NOT EXISTS suspension_records_live_member_suspended_at_idx
  ON suspension_records (member_id, suspended_at)
  WHERE voided_at IS NULL;
`;
      /** The part-3 table, before voiding existed. */
      const PART3_SQL = `
CREATE TABLE suspension_records (
  id            SERIAL PRIMARY KEY,
  member_id     TEXT NOT NULL,
  member_name   TEXT,
  suspended_at  TIMESTAMPTZ NOT NULL,
  duration_days INTEGER NOT NULL,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX suspension_records_member_suspended_at_idx
  ON suspension_records (member_id, suspended_at);
INSERT INTO suspension_records (member_id, suspended_at, duration_days)
  VALUES ('m1', '2026-09-01', 30);
`;

      /** Columns, indexes and constraints of suspension_records in a fresh schema built by `steps`. */
      async function shapeAfter(steps: string[]): Promise<unknown> {
        const name = `susp_shape_${Math.random().toString(36).slice(2, 10)}`;
        const client = new pg.Client({
          connectionString: process.env.DATABASE_URL,
        });
        await client.connect();
        try {
          await client.query(`CREATE SCHEMA ${name}`);
          await client.query(`SET search_path TO ${name}`);
          for (const step of steps) {
            // eslint-disable-next-line no-await-in-loop -- in order
            await client.query(step);
          }
          const columns = await client.query(
            `SELECT column_name, data_type, is_nullable, column_default, ordinal_position
               FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'suspension_records'
              ORDER BY ordinal_position`,
          );
          const indexes = await client.query<{
            indexname: string;
            indexdef: string;
          }>(
            `SELECT indexname, indexdef FROM pg_indexes
              WHERE schemaname = current_schema() AND tablename = 'suspension_records'
              ORDER BY indexname`,
          );
          const constraints = await client.query(
            `SELECT conname, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
               JOIN pg_class t ON t.oid = c.conrelid
              WHERE t.relname = 'suspension_records'
                AND t.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())
              ORDER BY conname`,
          );
          const rows = await client.query(
            'SELECT member_id, duration_days, voided_at FROM suspension_records ORDER BY id',
          );
          return {
            columns: columns.rows,
            // Schema-qualified in indexdef; strip the random name.
            indexes: indexes.rows.map((r) => ({
              ...r,
              indexdef: r.indexdef.replaceAll(`${name}.`, ''),
            })),
            constraints: constraints.rows,
            rows: rows.rows,
          };
        } finally {
          await client.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
          await client.end();
        }
      }

      it('on a fresh database', async () => {
        expect(await shapeAfter([SCHEMA_SQL, SCHEMA_SQL])).toEqual(
          await shapeAfter([UNGUARDED_SCHEMA_SQL]),
        );
      });

      it('upgrading a part-3 table that has rows', async () => {
        const guarded = await shapeAfter([PART3_SQL, SCHEMA_SQL, SCHEMA_SQL]);
        expect(guarded).toEqual(
          await shapeAfter([PART3_SQL, UNGUARDED_SCHEMA_SQL]),
        );
        expect((guarded as { rows: unknown[] }).rows).toEqual([
          { member_id: 'm1', duration_days: 30, voided_at: null },
        ]);
      });

      it('upgrading a table that already has the void columns but not the indexes', async () => {
        const partial = `${PART3_SQL}
ALTER TABLE suspension_records ADD COLUMN voided_at TIMESTAMPTZ,
  ADD COLUMN voided_by TEXT, ADD COLUMN void_reason TEXT;`;
        expect(await shapeAfter([partial, SCHEMA_SQL])).toEqual(
          await shapeAfter([partial, UNGUARDED_SCHEMA_SQL]),
        );
      });
    });

    describe('schema upgrade of a table created before voiding existed', () => {
      it('adds the void columns and makes the unique index partial, idempotently', async () => {
        const client = new pg.Client({
          connectionString: process.env.DATABASE_URL,
        });
        await client.connect();
        try {
          await client.query(
            'DROP SCHEMA IF EXISTS suspension_upgrade CASCADE',
          );
          await client.query('CREATE SCHEMA suspension_upgrade');
          await client.query('SET search_path TO suspension_upgrade');
          // The part-3 schema as first deployed to dev databases.
          await client.query(`
            CREATE TABLE suspension_records (
              id            SERIAL PRIMARY KEY,
              member_id     TEXT NOT NULL,
              member_name   TEXT,
              suspended_at  TIMESTAMPTZ NOT NULL,
              duration_days INTEGER NOT NULL,
              notes         TEXT,
              created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
            );
            CREATE UNIQUE INDEX suspension_records_member_suspended_at_idx
              ON suspension_records (member_id, suspended_at);
            INSERT INTO suspension_records (member_id, suspended_at, duration_days)
              VALUES ('m1', '2026-09-01', 30);
          `);

          await client.query(SCHEMA_SQL);
          await client.query(SCHEMA_SQL); // a second boot changes nothing

          await client.query(
            `UPDATE suspension_records
               SET voided_at = now(), voided_by = 'mod-1', void_reason = 'test'
             WHERE member_id = 'm1'`,
          );
          // Only succeeds if no full unique index remains on the pair.
          await client.query(
            `INSERT INTO suspension_records (member_id, suspended_at, duration_days)
               VALUES ('m1', '2026-09-01', 60)`,
          );
          await expect(
            client.query(
              `INSERT INTO suspension_records (member_id, suspended_at, duration_days)
                 VALUES ('m1', '2026-09-01', 90)`,
            ),
          ).rejects.toThrow(/duplicate key/);
        } finally {
          await client.query(
            'DROP SCHEMA IF EXISTS suspension_upgrade CASCADE',
          );
          await client.end();
        }
      });
    });
  },
);
