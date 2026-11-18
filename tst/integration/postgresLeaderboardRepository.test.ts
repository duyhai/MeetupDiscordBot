import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ensureDashboardSchema } from '../../src/lib/repositories/dashboardPool.js';
import { PostgresLeaderboardRepository } from '../../src/lib/repositories/postgresLeaderboardRepository.js';
import { PostgresSnapshotRepository } from '../../src/lib/repositories/postgresSnapshotRepository.js';
import { SnapshotEvent } from '../../src/lib/snapshot/meetup.js';
import { useIsolatedSchema } from './isolatedSchema.js';

const POSTGRES_AVAILABLE = Boolean(process.env.DATABASE_URL);

if (!POSTGRES_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    'Skipping PostgresLeaderboardRepository integration tests: set DATABASE_URL to a reachable Postgres to run them.',
  );
}

const event = (
  id: string,
  over: Partial<SnapshotEvent> = {},
): SnapshotEvent => ({
  eventId: id,
  title: `Event ${id}`,
  dateTime: new Date('2026-10-10T02:00:00Z'),
  eventUrl: null,
  status: 'PAST',
  hostIds: ['111'],
  yesCount: 3,
  waitlistCount: 0,
  ...over,
});

(POSTGRES_AVAILABLE ? describe : describe.skip)(
  'PostgresLeaderboardRepository',
  () => {
    let schema: { drop(): Promise<void> };
    let pool: pg.Pool;
    let snapshot: PostgresSnapshotRepository;
    let repo: PostgresLeaderboardRepository;

    beforeAll(async () => {
      schema = await useIsolatedSchema('leaderboard');
      pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        max: 4,
      });
    });

    beforeEach(async () => {
      await pool.query(
        'DROP TABLE IF EXISTS host_medals, host_medal_months, meetup_host_names, meetup_event_rsvps, meetup_events CASCADE',
      );
      await ensureDashboardSchema(pool);
      snapshot = new PostgresSnapshotRepository(pool);
      repo = new PostgresLeaderboardRepository(pool);
    });

    afterAll(async () => {
      await pool.end();
      await schema.drop();
    });

    it('reads live past hosted events only, and the latest host names', async () => {
      const first = new Date('2026-11-01T00:00:00Z');
      await snapshot.upsertEvents(
        [
          event('1', {
            hostIds: ['111', '222'],
            hostNames: { '111': 'Ann', '222': 'Bo' },
          }),
          event('2', { status: 'ACTIVE' }),
          event('3', { hostIds: [] }),
          event('4'),
        ],
        first,
      );
      await snapshot.markDeleted('4', first);
      // A later listing renames a host; an older one never overwrites it.
      await snapshot.upsertEvents(
        [event('1', { hostIds: ['111'], hostNames: { '111': 'Annie' } })],
        new Date('2026-11-02T00:00:00Z'),
      );
      await snapshot.upsertEvents(
        [event('5', { hostNames: { '111': 'Old Ann' } })],
        new Date('2026-10-01T00:00:00Z'),
      );
      const events = await repo.hostedEvents();
      expect(events.map((e) => [e.id, e.hostIds])).toEqual([
        ['1', ['111']],
        ['5', ['111']],
      ]);
      expect(await repo.hostNames()).toEqual(
        new Map([
          ['111', 'Annie'],
          ['222', 'Bo'],
        ]),
      );
    });

    it('awards a month once, even when two processes race', async () => {
      const medals = [
        { month: '2026-10', memberId: '111', place: 1 as const, events: 4 },
        { month: '2026-10', memberId: '222', place: 1 as const, events: 4 },
      ];
      await Promise.all([
        repo.award([{ month: '2026-10', medals }]),
        repo.award([
          {
            month: '2026-10',
            medals: [
              { month: '2026-10', memberId: '333', place: 1, events: 9 },
            ],
          },
        ]),
      ]);
      const stored = await repo.medals();
      expect(stored).toHaveLength(stored[0].memberId === '333' ? 1 : 2);
      // A later award with different numbers keeps what is stored.
      await repo.award([
        {
          month: '2026-10',
          medals: [{ month: '2026-10', memberId: '444', place: 1, events: 1 }],
        },
        { month: '2026-09', medals: [] },
      ]);
      expect(await repo.medals()).toEqual(stored);
      expect(await repo.awardedMonths()).toEqual(
        new Set(['2026-09', '2026-10']),
      );
    });
  },
);
