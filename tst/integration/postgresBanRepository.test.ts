import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { BanInsert } from '../../src/lib/bans/types.js';
import {
  DASHBOARD_LOCK_CLASS,
  MEMBER_LOCK_CLASS,
  SCHEMA_LOCK_KEY,
} from '../../src/lib/repositories/dashboardPool.js';
import {
  BAN_SCHEMA_SQL,
  ensureBanSchema,
  FILL_PHOTO_SQL,
  PostgresBanRepository,
  UPLOAD_PHOTO_SQL,
} from '../../src/lib/repositories/postgresBanRepository.js';
import { useIsolatedSchema } from './isolatedSchema.js';

// A non-UTC process: node-pg would parse a DATE at local midnight here, so
// banned_on must round-trip as a string (written $n::date, read to_char).
process.env.TZ = 'America/Los_Angeles';

// Requires DATABASE_URL against a throwaway Postgres; skipped otherwise.
const POSTGRES_AVAILABLE = Boolean(process.env.DATABASE_URL);

if (!POSTGRES_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    'Skipping PostgresBanRepository integration tests: set DATABASE_URL to a reachable Postgres to run them.',
  );
}

const MOD = '123456789012345678';
const LEAD = '223456789012345678';

const ban = (memberId: string, extra: Partial<BanInsert> = {}): BanInsert => ({
  memberId,
  memberName: `M${memberId}`,
  bannedOn: '2026-10-01',
  notes: '',
  recordedBy: MOD,
  ...extra,
});

const bytes = (fill: number, length = 64): Buffer => Buffer.alloc(length, fill);

/** Re-runs `check` every 20 ms until it is true; false after `timeoutMs`. */
async function pollUntil(
  check: () => Promise<boolean>,
  timeoutMs = 2000,
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

(POSTGRES_AVAILABLE ? describe : describe.skip)('PostgresBanRepository', () => {
  let schema: { drop(): Promise<void> };
  let pool: pg.Pool;
  let repo: PostgresBanRepository;

  const newPool = () =>
    new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

  const count = async (where = 'true'): Promise<number> =>
    (
      await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM member_bans WHERE ${where}`,
      )
    ).rows[0].n;

  beforeAll(async () => {
    schema = await useIsolatedSchema('bans');
    pool = newPool();
    await ensureBanSchema(pool);
  });

  beforeEach(async () => {
    repo = new PostgresBanRepository(pool);
    await repo.deleteAllForTest();
  });

  afterAll(async () => {
    await pool?.end();
    await schema?.drop();
  });

  describe('schema', () => {
    async function relationLocksDuringSchema(sql: string): Promise<string[]> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
          DASHBOARD_LOCK_CLASS,
          SCHEMA_LOCK_KEY,
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

    it('a second boot holds nothing stronger than AccessShareLock on member_bans', async () => {
      await repo.record(ban('1'));
      await ensureBanSchema(pool);
      const locks = await relationLocksDuringSchema(BAN_SCHEMA_SQL);
      expect(locks.filter((l) => !l.endsWith(':AccessShareLock'))).toEqual([]);
      // Not vacuous: the bare statement takes a write-blocking lock even
      // when the index already exists.
      expect(
        await relationLocksDuringSchema(
          `CREATE UNIQUE INDEX IF NOT EXISTS member_bans_active_member_idx
               ON member_bans (member_id) WHERE lifted_at IS NULL`,
        ),
      ).toContain('member_bans:ShareLock');
      expect(await count()).toBe(1);
    });

    it('ensureBanSchema waits on the schema advisory lock and fails with a lock timeout', async () => {
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock($1, $2)', [
          DASHBOARD_LOCK_CLASS,
          SCHEMA_LOCK_KEY,
        ]);
        await expect(
          ensureBanSchema(pool, { lockTimeoutMs: 200 }),
        ).rejects.toThrow(/lock timeout/);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
      await ensureBanSchema(pool, { lockTimeoutMs: 200 });
    });

    it(
      "CHECKs refuse a non-digit member id, a 21-digit id, '١٢٣', an upload photo without photo_updated_by, " +
        'a profile photo with one, a lift without a reason, a 153601-byte photo',
      async () => {
        const insert = (
          memberId: string,
          photo: Buffer | null = null,
          source: string | null = null,
          by: string | null = null,
        ) =>
          pool.query(
            `INSERT INTO member_bans
               (member_id, recorded_by, photo, photo_source, photo_updated_at, photo_updated_by)
             VALUES ($1, $2, $3, $4, CASE WHEN $3::bytea IS NULL THEN NULL ELSE now() END, $5)`,
            [memberId, MOD, photo, source, by],
          );
        const refused: unknown = expect.objectContaining({ code: '23514' });
        await expect(insert('12a4')).rejects.toEqual(refused);
        await expect(insert(' 123')).rejects.toEqual(refused);
        await expect(insert('1'.repeat(21))).rejects.toEqual(refused);
        await expect(insert('١٢٣')).rejects.toEqual(refused);
        await expect(insert('5', bytes(1), 'upload', null)).rejects.toEqual(
          refused,
        );
        await expect(insert('5', bytes(1), 'profile', MOD)).rejects.toEqual(
          refused,
        );
        await expect(
          insert('5', bytes(1, 153_601), 'profile', null),
        ).rejects.toEqual(refused);
        // The valid forms of the same statements go in.
        await insert('5', bytes(1, 153_600), 'profile', null);
        await expect(
          pool.query(
            `UPDATE member_bans SET lifted_at = now(), lifted_by = $1 WHERE member_id = '5'`,
            [LEAD],
          ),
        ).rejects.toEqual(refused);
        expect(await count()).toBe(1);
      },
    );
  });

  describe('record and import', () => {
    it('record refuses a second active ban; after lift the member can be banned again', async () => {
      const first = await repo.record(ban('42'));
      expect(first.ok).toBe(true);
      expect(await repo.record(ban('42'))).toEqual({
        ok: false,
        reason: 'already-banned',
      });
      if (!first.ok) throw new Error('unreachable');
      expect(first.ban).toMatchObject({
        memberId: '42',
        memberName: 'M42',
        bannedOn: '2026-10-01',
        recordedBy: MOD,
        hasPhoto: false,
        photoSource: null,
        liftedAt: null,
      });
      const lifted = await repo.lift(first.ban.id, LEAD, 'appeal granted');
      expect(lifted?.liftedBy).toBe(LEAD);
      expect(await repo.lift(first.ban.id, LEAD, 'again')).toBeUndefined();
      const again = await repo.record(ban('42'));
      expect(again.ok).toBe(true);
      expect(await count()).toBe(2);
      expect(await count('lifted_at IS NULL')).toBe(1);
    });

    it(
      'Review Focus 3: two concurrent importMany calls for overlapping members leave exactly one active ban per member, ' +
        'and the loser wrote no row',
      async () => {
        const poolA = newPool();
        const poolB = newPool();
        try {
          const a = new PostgresBanRepository(poolA);
          const b = new PostgresBanRepository(poolB);
          const results = await Promise.all([
            a.importMany([ban('10'), ban('11'), ban('12')]),
            b.importMany([ban('14'), ban('12'), ban('13')]),
          ]);
          const losers = results.filter((r) => !r.ok);
          const winners = results.filter((r) => r.ok);
          expect(losers).toHaveLength(1);
          expect(losers[0]).toMatchObject({
            ok: false,
            reason: 'already-banned',
          });
          expect(winners).toHaveLength(1);
          const winner = winners[0] as { ok: true; count: number };
          expect(await count()).toBe(winner.count);
          const perMember = await pool.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM member_bans
              WHERE lifted_at IS NULL GROUP BY member_id`,
          );
          expect(perMember.rows.every((r) => r.n === 1)).toBe(true);
        } finally {
          await poolA.end();
          await poolB.end();
        }
      },
    );

    it('D9: record waits on the member suspension lock applyAction takes', async () => {
      const holder = await pool.connect();
      let settled = false;
      try {
        await holder.query('BEGIN');
        await holder.query(
          `SELECT pg_advisory_xact_lock($1, hashtext('suspension:' || $2))`,
          [MEMBER_LOCK_CLASS, '42'],
        );
        const pending = repo.record(ban('42'));
        void pending.then(
          () => (settled = true),
          () => (settled = true),
        );
        const recordWaits = () =>
          pool
            .query<{ n: number }>(
              `SELECT count(*)::int AS n FROM pg_locks
                WHERE locktype = 'advisory' AND NOT granted
                  AND classid = $1::int::oid
                  AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
              [MEMBER_LOCK_CLASS],
            )
            .then((r) => r.rows[0].n === 1);
        expect(await pollUntil(recordWaits)).toBe(true);
        expect(settled).toBe(false);
        await holder.query('COMMIT');
        expect(await pending).toMatchObject({ ok: true });
      } finally {
        if (!settled) await holder.query('ROLLBACK').catch(() => {});
        holder.release();
      }
    });

    it('importMany rolls back every row when one collides', async () => {
      await repo.record(ban('30'));
      expect(await repo.importMany([ban('31'), ban('32'), ban('30')])).toEqual({
        ok: false,
        reason: 'already-banned',
        index: 2,
      });
      expect(await count()).toBe(1);
      expect(await repo.importMany([ban('31'), ban('32')])).toEqual({
        ok: true,
        count: 2,
      });
      expect(await count()).toBe(3);
    });

    it("banned_on round-trips '2026-02-28' and null in a non-UTC process", async () => {
      expect(new Date(2026, 1, 28).getTimezoneOffset()).not.toBe(0);
      const dated = await repo.record(ban('50', { bannedOn: '2026-02-28' }));
      const undated = await repo.record(ban('51', { bannedOn: null }));
      expect(dated.ok && dated.ban.bannedOn).toBe('2026-02-28');
      expect(undated.ok && undated.ban.bannedOn).toBeNull();
      const page = await repo.listPage({
        state: 'active',
        offset: 0,
        limit: 50,
      });
      expect(
        Object.fromEntries(page.map((r) => [r.memberId, r.bannedOn])),
      ).toEqual({ '50': '2026-02-28', '51': null });
    });
  });

  describe('photos', () => {
    const DAY = '2026-10-22';
    const recorded = async (memberId: string) => {
      const outcome = await repo.record(ban(memberId));
      if (!outcome.ok) throw new Error('not recorded');
      return outcome.ban;
    };

    it('Review Focus 4: a fill racing an upload never replaces the uploaded photo', async () => {
      const target = await recorded('60');
      const upload = bytes(0xaa);
      const uploader = await pool.connect();
      try {
        await uploader.query('BEGIN');
        await uploader.query(UPLOAD_PHOTO_SQL, [target.id, upload, LEAD]);
        const fill = repo.fillProfilePhoto(target.id, bytes(0xbb));
        // The fill reaches the row lock before the upload commits.
        const fillWaits = () =>
          pool
            .query<{ n: number }>(
              `SELECT count(*)::int AS n FROM pg_stat_activity
                WHERE wait_event_type = 'Lock'
                  AND datname = current_database() AND pid <> pg_backend_pid()
                  AND query LIKE '%photo_source = ''profile''%'`,
            )
            .then((r) => r.rows[0].n === 1);
        expect(await pollUntil(fillWaits)).toBe(true);
        await uploader.query('COMMIT');
        expect(await fill).toBe(false);
      } finally {
        uploader.release();
      }
      expect(await repo.getPhoto(target.id)).toEqual(upload);
      const [row] = await repo.listPage({
        state: 'active',
        offset: 0,
        limit: 50,
      });
      expect(row).toMatchObject({
        hasPhoto: true,
        photoSource: 'upload',
        photoUpdatedBy: LEAD,
      });
      expect(FILL_PHOTO_SQL).toMatch(/photo IS NULL/);
    });

    it('fill sets profile source and null updater, and never touches a lifted or already-filled ban', async () => {
      const open = await recorded('70');
      const toLift = await recorded('71');
      await repo.lift(toLift.id, LEAD, 'lifted');
      expect(await repo.listPhotoFillCandidates(10, DAY)).toEqual([
        { id: open.id, memberId: '70' },
      ]);
      expect(await repo.fillProfilePhoto(open.id, bytes(1))).toBe(true);
      expect(await repo.fillProfilePhoto(open.id, bytes(2))).toBe(false);
      expect(await repo.fillProfilePhoto(toLift.id, bytes(3))).toBe(false);
      expect(await repo.getPhoto(open.id)).toEqual(bytes(1));
      expect(await repo.getPhoto(toLift.id)).toBeUndefined();
      const [row] = await repo.listPage({
        state: 'active',
        offset: 0,
        limit: 50,
      });
      expect(row).toMatchObject({
        hasPhoto: true,
        photoSource: 'profile',
        photoUpdatedBy: null,
      });
      expect(row.photoUpdatedAt).toBeInstanceOf(Date);
      expect(await repo.listPhotoFillCandidates(10, DAY)).toEqual([]);
    });

    it('setUploadedPhoto replaces a profile photo and reports replaced: true; refuses a lifted ban', async () => {
      const target = await recorded('80');
      const first = await repo.setUploadedPhoto(target.id, bytes(5), LEAD);
      expect(first?.replaced).toBe(false);
      expect(first?.ban).toMatchObject({
        hasPhoto: true,
        photoSource: 'upload',
        photoUpdatedBy: LEAD,
      });
      await pool.query(
        `UPDATE member_bans SET photo_source = 'profile', photo_updated_by = NULL WHERE id = $1`,
        [target.id],
      );
      const second = await repo.setUploadedPhoto(target.id, bytes(6), MOD);
      expect(second?.replaced).toBe(true);
      expect(second?.ban.photoSource).toBe('upload');
      expect(await repo.getPhoto(target.id)).toEqual(bytes(6));
      await repo.lift(target.id, LEAD, 'lifted');
      expect(
        await repo.setUploadedPhoto(target.id, bytes(7), LEAD),
      ).toBeUndefined();
      expect(await repo.getPhoto(target.id)).toEqual(bytes(6));
      expect(
        await repo.setUploadedPhoto(999_999, bytes(7), LEAD),
      ).toBeUndefined();
    });

    it('Review Focus 4: a re-ban starts with the latest lifted photo; the lifted row keeps its own', async () => {
      const older = await recorded('90');
      await repo.setUploadedPhoto(older.id, bytes(0x11), LEAD);
      await repo.lift(older.id, LEAD, 'first lift');
      const middle = await recorded('90');
      expect(middle.hasPhoto).toBe(true);
      await repo.setUploadedPhoto(middle.id, bytes(0x22), MOD);
      await repo.lift(middle.id, LEAD, 'second lift');
      // A lifted ban without a photo is newer but is skipped.
      const bare = await recorded('90');
      await pool.query(
        `UPDATE member_bans SET photo = NULL, photo_source = NULL,
             photo_updated_at = NULL, photo_updated_by = NULL WHERE id = $1`,
        [bare.id],
      );
      await repo.lift(bare.id, LEAD, 'third lift');
      const imported = await repo.importMany([ban('90'), ban('91')]);
      expect(imported).toEqual({ ok: true, count: 2 });
      const [active91, active90] = await repo.listPage({
        state: 'active',
        offset: 0,
        limit: 50,
      });
      expect(active91).toMatchObject({ memberId: '91', hasPhoto: false });
      expect(active90).toMatchObject({
        memberId: '90',
        hasPhoto: true,
        photoSource: 'upload',
        photoUpdatedBy: MOD,
      });
      expect(await repo.getPhoto(active90.id)).toEqual(bytes(0x22));
      expect(await repo.getPhoto(older.id)).toEqual(bytes(0x11));
      expect(await repo.getPhoto(middle.id)).toEqual(bytes(0x22));
      // The sweep leaves the carried photo alone.
      expect(await repo.fillProfilePhoto(active90.id, bytes(0x33))).toBe(false);
      expect(
        (await repo.listPhotoFillCandidates(10, DAY)).map((c) => c.memberId),
      ).toEqual(['91']);
    });

    it('fill candidates: stable order within a day, rotating daily, so sourceless bans cannot block the rest', async () => {
      expect(
        await repo.importMany(
          Array.from({ length: 60 }, (_, i) => ban(String(1000 + i))),
        ),
      ).toEqual({ ok: true, count: 60 });
      const all = (
        await pool.query<{ id: number }>(
          'SELECT id FROM member_bans ORDER BY id',
        )
      ).rows.map((r) => r.id);
      expect(all).toHaveLength(60);
      const fiftieth = all[49];
      const ids = async (day: string) =>
        (await repo.listPhotoFillCandidates(50, day)).map((c) => c.id);
      const first = await ids('2026-10-22');
      expect(first).toHaveLength(50);
      expect(await ids('2026-10-22')).toEqual(first);
      const second = await ids('2026-10-23');
      expect(second).toHaveLength(50);
      expect(second).not.toEqual(first);
      expect(second.some((id) => id > fiftieth)).toBe(true);
      // Over two days, more than one day's worth is reached.
      expect(new Set([...first, ...second]).size).toBeGreaterThan(50);
    });

    it('listPhotoFillCandidates refuses a malformed day before any query', async () => {
      for (const day of ['', '2026-1-22', "2026-10-22' OR 1=1", '22/10/2026']) {
        // eslint-disable-next-line no-await-in-loop -- each must refuse
        await expect(
          repo.listPhotoFillCandidates(10, day),
        ).rejects.toBeInstanceOf(RangeError);
      }
    });

    it('lift keeps the photo; listPage(lifted) shows who, when, why and hasPhoto', async () => {
      const target = await recorded('100');
      await repo.fillProfilePhoto(target.id, bytes(9));
      const lifted = await repo.lift(target.id, LEAD, 'served');
      expect(lifted).toMatchObject({
        liftedBy: LEAD,
        liftReason: 'served',
        hasPhoto: true,
      });
      const page = await repo.listPage({
        state: 'lifted',
        offset: 0,
        limit: 50,
      });
      expect(page).toHaveLength(1);
      expect(page[0]).toMatchObject({
        id: target.id,
        liftedBy: LEAD,
        liftReason: 'served',
        hasPhoto: true,
        photoSource: 'profile',
      });
      expect(page[0].liftedAt).toBeInstanceOf(Date);
      expect(await repo.getPhoto(target.id)).toEqual(bytes(9));
      expect(await repo.countByState()).toEqual({ active: 0, lifted: 1 });
      expect(
        await repo.listPage({ state: 'active', offset: 0, limit: 50 }),
      ).toEqual([]);
    });

    it('getPhoto returns the bytes for one id and undefined for a ban without a photo', async () => {
      const withPhoto = await recorded('110');
      const without = await recorded('111');
      await repo.fillProfilePhoto(withPhoto.id, bytes(4, 1000));
      expect(await repo.getPhoto(withPhoto.id)).toEqual(bytes(4, 1000));
      expect(await repo.getPhoto(without.id)).toBeUndefined();
      expect(await repo.getPhoto(999_999)).toBeUndefined();
    });
  });

  describe('reads', () => {
    it('activeMemberIds refuses more than 1000 distinct valid ids before any query', async () => {
      const ids = Array.from({ length: 1001 }, (_, i) => String(i + 1));
      await expect(repo.activeMemberIds(ids)).rejects.toBeInstanceOf(
        RangeError,
      );
      // Duplicates and invalid ids do not count toward the cap.
      const thousand = [...ids.slice(0, 1000), '1', '12a4', ' 7'];
      expect(await repo.activeMemberIds(thousand)).toEqual(new Set());
    });

    it('activeMemberIds returns only active bans among valid ids; countByState and paging', async () => {
      await repo.importMany([ban('200'), ban('201'), ban('202')]);
      const [, , first] = await repo.listPage({
        state: 'active',
        offset: 0,
        limit: 50,
      });
      await repo.lift(first.id, LEAD, 'lifted');
      expect(
        await repo.activeMemberIds(['200', '201', '201', '202', '12a4', '9']),
      ).toEqual(new Set(['201', '202']));
      expect(await repo.countByState()).toEqual({ active: 2, lifted: 1 });
      const paged = await repo.listPage({
        state: 'active',
        offset: 1,
        limit: 1,
      });
      expect(paged.map((r) => r.memberId)).toEqual(['201']);
    });
  });
});
