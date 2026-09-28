import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { PostgresSuspensionRepository } from '../../src/lib/repositories/postgresSuspensionRepository.js';

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

    beforeAll(async () => {
      repo = await PostgresSuspensionRepository.instance();
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

    it('insertMany inserts all rows atomically', async () => {
      const rows = await repo.insertMany([
        record,
        { ...record, memberId: 'm2', memberName: 'Bob' },
      ]);
      expect(rows).toHaveLength(2);
      expect((await repo.listByMemberId('m2')).length).toBe(1);
    });

    it('insertMany skips exact duplicates and returns only the inserted rows', async () => {
      await repo.insert(record);
      const rows = await repo.insertMany([
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
  },
);
