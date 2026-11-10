import pg from 'pg';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  DASHBOARD_LOCK_CLASS,
  SCHEMA_LOCK_KEY,
} from '../../src/lib/repositories/dashboardPool.js';
import {
  PROMOTED_HOST_SCHEMA_SQL,
  ensurePromotedHostSchema,
  PostgresPromotedHostRepository,
} from '../../src/lib/repositories/postgresPromotedHostRepository.js';
import { useIsolatedSchema } from './isolatedSchema.js';

// Requires DATABASE_URL against a throwaway Postgres; skipped otherwise.
const POSTGRES_AVAILABLE = Boolean(process.env.DATABASE_URL);

const LEAD = '223456789012345678';

(POSTGRES_AVAILABLE ? describe : describe.skip)(
  'PostgresPromotedHostRepository',
  () => {
    let schema: { drop(): Promise<void> };
    let pool: pg.Pool;
    let repo: PostgresPromotedHostRepository;

    beforeAll(async () => {
      schema = await useIsolatedSchema('promoted');
      pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        max: 2,
      });
      await ensurePromotedHostSchema(pool);
      // Twice: the schema is idempotent.
      await ensurePromotedHostSchema(pool);
    });

    beforeEach(async () => {
      await pool.query('TRUNCATE promoted_hosts, promoted_host_events');
      repo = new PostgresPromotedHostRepository(pool);
    });

    afterAll(async () => {
      await pool?.end();
      await schema?.drop();
    });

    const insert = (id: string, active: boolean) =>
      pool.query(
        `INSERT INTO promoted_hosts (meetup_member_id, active, reason, changed_by)
         VALUES ($1, $2, 'r', $3)`,
        [id, active, LEAD],
      );

    it('an empty table promotes no one', async () => {
      await expect(repo.isPromoted('12345')).resolves.toBe(false);
    });

    it('an active row is promoted and an inactive one is not', async () => {
      await insert('12345', true);
      await insert('67890', false);
      await expect(repo.isPromoted('12345')).resolves.toBe(true);
      await expect(repo.isPromoted('67890')).resolves.toBe(false);
    });

    it('a non-digit id is refused without a query', async () => {
      const spy = vi.spyOn(pool, 'query');
      await expect(repo.isPromoted("1' OR '1'='1")).resolves.toBe(false);
      await expect(repo.isPromoted('')).resolves.toBe(false);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('the history table refuses an unknown action and a bad actor id', async () => {
      await expect(
        pool.query(
          `INSERT INTO promoted_host_events (meetup_member_id, action, reason, actor_discord_id, version)
           VALUES ('12345', 'crown', 'r', $1, 1)`,
          [LEAD],
        ),
      ).rejects.toThrow();
      await expect(
        pool.query(
          `INSERT INTO promoted_host_events (meetup_member_id, action, reason, actor_discord_id, version)
           VALUES ('12345', 'promote', 'r', 'nobody', 1)`,
        ),
      ).rejects.toThrow();
    });

    it('the history is append-only and version is at least 1', async () => {
      await pool.query(
        `INSERT INTO promoted_host_events (meetup_member_id, action, reason, actor_discord_id, version)
         VALUES ('12345', 'promote', 'r', $1, 1)`,
        [LEAD],
      );
      await expect(
        pool.query("UPDATE promoted_host_events SET reason = 'x'"),
      ).rejects.toThrow(/append-only/);
      await expect(
        pool.query('DELETE FROM promoted_host_events'),
      ).rejects.toThrow(/append-only/);
      await expect(
        pool.query(
          `INSERT INTO promoted_hosts (meetup_member_id, active, reason, changed_by, version)
           VALUES ('1', true, 'r', $1, 0)`,
          [LEAD],
        ),
      ).rejects.toThrow();
    });

    describe('promote and demote', () => {
      const OTHER = '323456789012345678';

      it('a first promote inserts version 1 and records it', async () => {
        const result = await repo.change('promote', '12345', 0, LEAD, 'great');
        expect(result.code).toBe('changed');
        await expect(repo.isPromoted('12345')).resolves.toBe(true);
        const history = await repo.history('12345');
        expect(history).toMatchObject([
          {
            action: 'promote',
            reason: 'great',
            actorDiscordId: LEAD,
            version: 1,
          },
        ]);
      });

      it('demote, then promote again: versions go up, nothing is deleted', async () => {
        await repo.change('promote', '12345', 0, LEAD, 'one');
        const demoted = await repo.change('demote', '12345', 1, OTHER, 'two');
        expect(demoted).toMatchObject({
          code: 'changed',
          row: { active: false, version: 2, changedBy: OTHER, reason: 'two' },
        });
        await expect(repo.isPromoted('12345')).resolves.toBe(false);
        await repo.change('promote', '12345', 2, LEAD, 'three');
        expect(
          (await repo.history('12345')).map((e) => [e.action, e.version]),
        ).toEqual([
          ['promote', 3],
          ['demote', 2],
          ['promote', 1],
        ]);
        expect(await repo.list()).toHaveLength(1);
      });

      it('a version the leader did not see is stale and changes nothing', async () => {
        await repo.change('promote', '12345', 0, LEAD, 'one');
        await expect(
          repo.change('demote', '12345', 0, OTHER, 'late'),
        ).resolves.toEqual({ code: 'stale' });
        await expect(
          repo.change('promote', '67890', 3, OTHER, 'no row'),
        ).resolves.toEqual({ code: 'stale' });
        await expect(repo.isPromoted('12345')).resolves.toBe(true);
        expect(await repo.history('12345')).toHaveLength(1);
      });

      it('demoting someone never promoted is refused; promoting an active host is unchanged', async () => {
        await expect(
          repo.change('demote', '12345', 0, LEAD, 'why'),
        ).resolves.toEqual({ code: 'never-promoted' });
        await repo.change('promote', '12345', 0, LEAD, 'one');
        await expect(
          repo.change('promote', '12345', 1, LEAD, 'again'),
        ).resolves.toEqual({ code: 'unchanged' });
        expect(await repo.history('12345')).toHaveLength(1);
      });

      it('two leaders promoting at once: one change, one history row', async () => {
        const results = await Promise.all([
          repo.change('promote', '12345', 0, LEAD, 'a'),
          repo.change('promote', '12345', 0, OTHER, 'b'),
        ]);
        expect(results.map((r) => r.code).sort()).toEqual(['changed', 'stale']);
        expect(await repo.history('12345')).toHaveLength(1);
      });

      it('two leaders demoting at once: one change', async () => {
        await repo.change('promote', '12345', 0, LEAD, 'a');
        const results = await Promise.all([
          repo.change('demote', '12345', 1, LEAD, 'x'),
          repo.change('demote', '12345', 1, OTHER, 'y'),
        ]);
        expect(results.map((r) => r.code).sort()).toEqual(['changed', 'stale']);
        expect(await repo.history('12345')).toHaveLength(2);
      });

      it('refuses a bad member id and a reason the table refuses', async () => {
        await expect(
          repo.change('promote', "1' OR '1", 0, LEAD, 'r'),
        ).rejects.toThrow(RangeError);
        await expect(
          repo.change('promote', '12345', 0, LEAD, ''),
        ).rejects.toThrow();
        await expect(repo.get('12345')).resolves.toBeUndefined();
      });
    });

    it('a second boot holds nothing stronger than AccessShareLock', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
          DASHBOARD_LOCK_CLASS,
          SCHEMA_LOCK_KEY,
        ]);
        await client.query(PROMOTED_HOST_SCHEMA_SQL);
        const locks = await client.query<{ name: string; mode: string }>(
          `SELECT c.relname AS name, l.mode FROM pg_locks l
             JOIN pg_class c ON c.oid = l.relation
            WHERE l.pid = pg_backend_pid()
              AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())`,
        );
        expect(
          locks.rows
            .map((r) => `${r.name}:${r.mode}`)
            .filter((l) => !l.endsWith(':AccessShareLock')),
        ).toEqual([]);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    it('ensure waits on the schema advisory lock and fails with a lock timeout', async () => {
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock($1, $2)', [
          DASHBOARD_LOCK_CLASS,
          SCHEMA_LOCK_KEY,
        ]);
        await expect(
          ensurePromotedHostSchema(pool, { lockTimeoutMs: 200 }),
        ).rejects.toThrow(/lock timeout/);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
    });
  },
);
