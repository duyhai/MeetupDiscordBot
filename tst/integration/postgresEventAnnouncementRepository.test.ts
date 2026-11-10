import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  PostgresEventAnnouncementRepository,
  ensureEventAnnouncementSchema,
} from '../../src/lib/repositories/postgresEventAnnouncementRepository.js';
import { useIsolatedSchema } from './isolatedSchema.js';

// Requires DATABASE_URL against a throwaway Postgres; skipped otherwise.
const POSTGRES_AVAILABLE = Boolean(process.env.DATABASE_URL);

const HOST = '12345';
const OTHER = '67890';
const EVENT = '311111111';

(POSTGRES_AVAILABLE ? describe : describe.skip)(
  'PostgresEventAnnouncementRepository',
  () => {
    let schema: { drop(): Promise<void> };
    let pool: pg.Pool;
    let repo: PostgresEventAnnouncementRepository;

    beforeAll(async () => {
      schema = await useIsolatedSchema('announce');
      pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        max: 4,
      });
      await ensureEventAnnouncementSchema(pool);
      // Twice: the schema is idempotent.
      await ensureEventAnnouncementSchema(pool);
    });

    beforeEach(async () => {
      await pool.query('TRUNCATE event_announcements');
      repo = new PostgresEventAnnouncementRepository(pool);
    });

    afterAll(async () => {
      await pool?.end();
      await schema?.drop();
    });

    it('the first claim wins; later ones see where it stands', async () => {
      await expect(repo.claim(EVENT, HOST)).resolves.toEqual({ claimed: true });
      const again = await repo.claim(EVENT, HOST);
      expect(again).toMatchObject({
        claimed: false,
        current: { status: 'sending', requestedBy: HOST },
      });
      await repo.finish(EVENT, 'sent');
      const done = await repo.claim(EVENT, OTHER);
      expect(done).toMatchObject({
        claimed: false,
        current: { status: 'sent', requestedBy: HOST },
      });
      expect((await repo.get(EVENT))?.completedAt).toBeInstanceOf(Date);
    });

    it('ten clicks at once: exactly one claims', async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, () => repo.claim(EVENT, HOST)),
      );
      expect(results.filter((r) => r.claimed)).toHaveLength(1);
    });

    it('a failed or unknown one can be claimed again, once at a time', async () => {
      await repo.claim(EVENT, HOST);
      await repo.finish(EVENT, 'failed', 'Meetup said no');
      expect((await repo.get(EVENT))?.failure).toBe('Meetup said no');
      const retries = await Promise.all([
        repo.claim(EVENT, OTHER),
        repo.claim(EVENT, OTHER),
      ]);
      expect(retries.filter((r) => r.claimed)).toHaveLength(1);
      expect(await repo.get(EVENT)).toMatchObject({
        status: 'sending',
        failure: null,
      });
      await repo.finish(EVENT, 'unknown', 'socket hang up');
      await expect(repo.claim(EVENT, OTHER)).resolves.toEqual({
        claimed: true,
      });
    });

    it('a "sending" row is claimed again only once it is 2 minutes old', async () => {
      await repo.claim(EVENT, HOST);
      expect(await repo.claim(EVENT, HOST)).toMatchObject({ claimed: false });
      await pool.query(
        `UPDATE event_announcements
            SET requested_at = now() - interval '3 minutes'`,
      );
      await expect(repo.claim(EVENT, HOST)).resolves.toEqual({
        claimed: true,
      });
    });

    it('a sent one is never claimed again', async () => {
      await repo.claim(EVENT, HOST);
      await repo.finish(EVENT, 'sent');
      await pool.query(
        `UPDATE event_announcements
            SET requested_at = now() - interval '1 day'`,
      );
      expect(await repo.claim(EVENT, OTHER)).toMatchObject({
        claimed: false,
        current: { status: 'sent' },
      });
    });

    it('finish changes only a sending row, and caps the failure text', async () => {
      await repo.claim(EVENT, HOST);
      await repo.finish(EVENT, 'sent');
      await repo.finish(EVENT, 'failed', 'late');
      expect((await repo.get(EVENT))?.status).toBe('sent');
      await repo.claim('2', HOST);
      await repo.finish('2', 'failed', 'x'.repeat(5000));
      expect((await repo.get('2'))?.failure).toHaveLength(1000);
    });

    it('forEvents reads several at once and skips bad ids', async () => {
      await repo.claim(EVENT, HOST);
      await repo.claim('2', HOST);
      const map = await repo.forEvents([EVENT, '2', '3', "1' OR '1"]);
      expect([...map.keys()].sort()).toEqual(['2', EVENT]);
      expect(await repo.forEvents([])).toEqual(new Map());
    });

    it('refuses a bad event or member id', async () => {
      await expect(repo.claim('abc', HOST)).rejects.toThrow(RangeError);
      await expect(repo.claim(EVENT, 'nobody')).rejects.toThrow();
    });
  },
);
