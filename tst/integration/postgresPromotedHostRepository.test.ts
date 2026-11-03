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
          `INSERT INTO promoted_host_events (meetup_member_id, action, reason, actor_discord_id)
           VALUES ('12345', 'crown', 'r', $1)`,
          [LEAD],
        ),
      ).rejects.toThrow();
      await expect(
        pool.query(
          `INSERT INTO promoted_host_events (meetup_member_id, action, reason, actor_discord_id)
           VALUES ('12345', 'promote', 'r', 'nobody')`,
        ),
      ).rejects.toThrow();
    });
  },
);
