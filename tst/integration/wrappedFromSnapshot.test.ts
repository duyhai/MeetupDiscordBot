/* eslint-disable @typescript-eslint/no-unsafe-assignment -- expect.objectContaining() matchers */
import crypto from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RedisCache } from '../../src/lib/cache/redisCache.js';
import { ensureDashboardSchema } from '../../src/lib/repositories/dashboardPool.js';
import { InMemoryMemberRepository } from '../../src/lib/repositories/inMemoryMemberRepository.js';
import { PostgresSnapshotRepository } from '../../src/lib/repositories/postgresSnapshotRepository.js';
import { PostgresWrappedBackfillRepository } from '../../src/lib/repositories/postgresWrappedBackfillRepository.js';
import { PostgresWrappedEntryRepository } from '../../src/lib/repositories/postgresWrappedEntryRepository.js';
import { snapshotWrapped } from '../../src/lib/snapshot/wrapped.js';
import {
  BackfillDeps,
  runBackfillTick,
} from '../../src/lib/wrapped/backfill.js';
import { wrappedCacheKey } from '../../src/lib/wrapped/cache.js';
import { readEntry } from '../../src/lib/wrapped/store.js';
import { useIsolatedSchema } from './isolatedSchema.js';

// Real Postgres (the snapshot, the runs, the entries) and Redis: a tick over
// a seeded snapshot writes exactly the entry the page and the command read,
// with no Meetup call at all.
const AVAILABLE = Boolean(
  process.env.DATABASE_URL && process.env.REDISCLOUD_URL,
);

if (!AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    'Skipping Wrapped-from-snapshot integration tests: set DATABASE_URL and REDISCLOUD_URL to run them.',
  );
}

const suffix = String(Date.now()).slice(-9);
const USER = `2${suffix}0001`.padEnd(18, '0');
const FRIEND = `2${suffix}0002`.padEnd(18, '0');
const ME = `7${suffix}`;
const PAL = `8${suffix}`;
const GHOST = `9${suffix}`; // unlinked: must never reach an entry
const THIS_YEAR = new Date().getUTCFullYear();

(AVAILABLE ? describe : describe.skip)(
  'Wrapped from the group snapshot (integration)',
  () => {
    let schema: { drop(): Promise<void> };
    let redis: RedisCache;
    let snapshot: PostgresSnapshotRepository;
    let entries: PostgresWrappedEntryRepository;
    let deps: BackfillDeps;
    const meetupCalls = vi.fn();

    beforeAll(async () => {
      schema = await useIsolatedSchema('wrapped_from_snapshot');
      const store = await PostgresWrappedBackfillRepository.instance();
      const pool = (store as unknown as { pool: import('pg').Pool }).pool;
      await ensureDashboardSchema(pool);
      snapshot = new PostgresSnapshotRepository(pool);
      entries = await PostgresWrappedEntryRepository.instance();
      redis = await RedisCache.instance();

      const at = (y: number, m: number) =>
        new Date(Date.UTC(y, m, 10, 3, 0, 0));
      const listed = new Date();
      await snapshot.upsertEvents(
        [
          [`${suffix}1`, at(THIS_YEAR - 1, 2), 'Board game night', [ME]],
          [`${suffix}2`, at(THIS_YEAR, 3), 'Hot pot dinner', []],
          [`${suffix}3`, at(THIS_YEAR, 5), 'Board games again', [ME]],
        ].map(([eventId, dateTime, title, hostIds]) => ({
          eventId: eventId as string,
          title: title as string,
          dateTime: dateTime as Date,
          eventUrl: null,
          status: 'PAST' as const,
          hostIds: hostIds as string[],
          yesCount: 3,
          waitlistCount: 0,
        })),
        listed,
      );
      for (const id of [`${suffix}1`, `${suffix}2`, `${suffix}3`]) {
        // eslint-disable-next-line no-await-in-loop -- test setup
        await snapshot.replaceRsvps(
          id,
          [
            { memberId: ME, status: 'ATTENDED' },
            { memberId: PAL, status: 'YES' },
            { memberId: GHOST, status: 'YES' },
          ],
          listed,
        );
      }
      const run = await snapshot.startRun('job', 'full');
      await snapshot.finishRun(run.id);

      const repo = new InMemoryMemberRepository();
      for (const [discordUserId, meetupId] of [
        [USER, ME],
        [FRIEND, PAL],
      ]) {
        // eslint-disable-next-line no-await-in-loop -- test setup
        await repo.upsert({
          discordUserId,
          meetupId,
          meetupName: null,
          meetupMemberUrl: null,
          onboardMethod: 'self_onboard',
          onboardedBy: null,
        });
      }
      const noMeetup = () => {
        meetupCalls();
        throw new Error('no Meetup call expected');
      };
      deps = {
        now: () => new Date(),
        cache: async () => redis,
        store: async () => store,
        entries: async () => entries,
        members: async () => repo,
        memberToken: async () => undefined,
        memberClient: noMeetup,
        withOrganizer: async () => noMeetup(),
        isPresent: async () => true,
        canStart: async () => true,
        alert: vi.fn(async () => true),
        newLeaseValue: () => crypto.randomUUID(),
        groupId: '7595882',
        snapshot: async () => snapshotWrapped(snapshot),
      };
    });

    afterAll(async () => {
      await Promise.all(
        [USER, FRIEND].flatMap((id) =>
          [THIS_YEAR - 1, THIS_YEAR].map((year) =>
            redis.remove(wrappedCacheKey(id, year)),
          ),
        ),
      );
      await schema.drop();
    });

    it('a tick builds every year of every member from the snapshot, with no Meetup call', async () => {
      const outcome = await runBackfillTick(deps);
      expect(outcome).toMatchObject({ kind: 'ran', calls: 0, failed: 0 });
      expect(meetupCalls).not.toHaveBeenCalled();

      const now = new Date();
      const tiers = { cache: redis, entries };
      const mine = await readEntry(tiers, USER, THIS_YEAR, ME, now);
      expect(mine?.stats).toMatchObject({
        attendedThisYear: 2,
        hosting: expect.objectContaining({ thisYear: 1, allTime: 2 }),
      });
      expect(mine?.companions.named).toEqual([
        expect.objectContaining({ discordUserId: FRIEND, sharedCount: 2 }),
      ]);
      expect(mine?.companions.otherCount).toBe(1);
      const lastYear = await readEntry(tiers, USER, THIS_YEAR - 1, ME, now);
      expect(lastYear?.stats.attendedThisYear).toBe(1);
      for (const entry of [mine, lastYear]) {
        expect(JSON.stringify(entry)).not.toContain(GHOST);
        expect(JSON.stringify(entry)).not.toContain(`"${PAL}"`);
      }
    });
  },
);
