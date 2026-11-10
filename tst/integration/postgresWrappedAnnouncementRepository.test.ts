import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ensureDashboardSchema } from '../../src/lib/repositories/dashboardPool.js';
import { PostgresWrappedAnnouncementRepository } from '../../src/lib/repositories/postgresWrappedAnnouncementRepository.js';
import { useIsolatedSchema } from './isolatedSchema.js';

// Requires DATABASE_URL against a throwaway Postgres; skipped otherwise.
const POSTGRES_AVAILABLE = Boolean(process.env.DATABASE_URL);

if (!POSTGRES_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    'Skipping PostgresWrappedAnnouncementRepository integration tests: set DATABASE_URL to a reachable Postgres to run them.',
  );
}

const CHANNEL = '123456789012345678';
const MESSAGE = '987654321098765432';

const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

(POSTGRES_AVAILABLE ? describe : describe.skip)(
  'PostgresWrappedAnnouncementRepository',
  () => {
    let schema: { drop(): Promise<void> };
    let pool: pg.Pool;
    let repo: PostgresWrappedAnnouncementRepository;
    const another = () => new PostgresWrappedAnnouncementRepository(pool);

    beforeAll(async () => {
      schema = await useIsolatedSchema('wrapped_announce');
      pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        max: 6,
      });
    });

    beforeEach(async () => {
      await pool.query('DROP TABLE IF EXISTS wrapped_announcements');
      await ensureDashboardSchema(pool);
      repo = another();
    });

    afterAll(async () => {
      await pool.end();
      await schema.drop();
    });

    it('the schema is idempotent on a second boot', async () => {
      await ensureDashboardSchema(pool);
      expect(await repo.get(2026)).toBeUndefined();
    });

    it('claim is fresh once per year, for any instance (the job and the button)', async () => {
      expect(await repo.get(2026)).toBeUndefined();
      expect(await repo.claim(2026)).toBe('fresh');
      expect(await repo.claim(2026)).toBe(false);
      expect(await another().claim(2026)).toBe(false);
      expect((await repo.get(2026))?.postedAt).toBeUndefined();
      expect(await repo.claim(2027)).toBe('fresh');
    });

    it('a posted year is final: never reclaimed, with channel and message kept', async () => {
      expect(await repo.claim(2026)).toBe('fresh');
      expect(
        await repo.markPosted(2026, { channelId: CHANNEL, messageId: MESSAGE }),
      ).toBe(true);
      const row = await repo.get(2026);
      expect(row).toMatchObject({
        year: 2026,
        channelId: CHANNEL,
        messageId: MESSAGE,
      });
      expect(row?.postedAt).toBeInstanceOf(Date);
      await pause(20);
      expect(await repo.claim(2026, 0)).toBe(false);
      expect(await another().claim(2026, 0)).toBe(false);
      // A second markPosted (no claim held) changes nothing.
      expect(
        await repo.markPosted(2026, { channelId: CHANNEL, messageId: '1' }),
      ).toBe(false);
      expect((await repo.get(2026))?.messageId).toBe(MESSAGE);
    });

    it('a released claim (failed post) is retried at once by anyone', async () => {
      expect(await repo.claim(2026)).toBe('fresh');
      await repo.release(2026);
      expect(await another().claim(2026)).toBe('retry');
      // The releasing instance no longer holds it.
      expect(
        await repo.markPosted(2026, { channelId: CHANNEL, messageId: MESSAGE }),
      ).toBe(false);
    });

    it('a stale unposted claim (crash) is reclaimed after the reclaim window', async () => {
      expect(await repo.claim(2026)).toBe('fresh');
      const second = another();
      expect(await second.claim(2026, 60_000)).toBe(false);
      await pause(20);
      expect(await second.claim(2026, 10)).toBe('retry');
      // The old holder's markPosted misses: the claim moved on.
      expect(
        await repo.markPosted(2026, { channelId: CHANNEL, messageId: MESSAGE }),
      ).toBe(false);
      expect(
        await second.markPosted(2026, {
          channelId: CHANNEL,
          messageId: undefined,
        }),
      ).toBe(true);
      expect(await second.get(2026)).toMatchObject({
        channelId: CHANNEL,
        messageId: undefined,
      });
    });

    it('refuses a channel or message id that is not a snowflake', async () => {
      expect(await repo.claim(2026)).toBe('fresh');
      await expect(
        repo.markPosted(2026, { channelId: 'general', messageId: MESSAGE }),
      ).rejects.toThrow(/check constraint/i);
    });
  },
);
