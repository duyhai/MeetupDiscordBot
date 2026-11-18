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
        `DROP TABLE IF EXISTS host_medals, host_medal_months, meetup_host_names,
           meetup_event_rsvps, meetup_events, meetup_snapshot_runs CASCADE`,
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
      // Exactly one writer's set, never a mix.
      expect([[['333']], [['111', '222']]]).toContainEqual([
        stored.map((m) => m.memberId),
      ]);
      // A later award with different numbers keeps what is stored.
      await repo.award([
        {
          month: '2026-10',
          medals: [{ month: '2026-10', memberId: '444', place: 1, events: 1 }],
        },
        // A month with no hosted events: recorded as awarded, no medals.
        { month: '2026-09', medals: [] },
      ]);
      expect(await repo.medals()).toEqual(stored);
      expect(await repo.awardedMonths()).toEqual(
        new Set(['2026-09', '2026-10']),
      );
    });

    it('gives each event its Pacific day: late on a month’s last day and across both DST changes', async () => {
      await snapshot.upsertEvents(
        [
          // Oct 31, 23:30 PDT is Nov 1 06:30 UTC.
          event('1', { dateTime: new Date('2026-11-01T06:30:00Z') }),
          // Mar 8 2026, 01:30 PST (before the 2:00 spring-forward).
          event('2', { dateTime: new Date('2026-03-08T09:30:00Z') }),
          // Mar 8 2026, 23:30 PDT.
          event('3', { dateTime: new Date('2026-03-09T06:30:00Z') }),
          // Nov 1 2026, 01:30 PST, the repeated hour after fall-back.
          event('4', { dateTime: new Date('2026-11-01T09:30:00Z') }),
        ],
        new Date('2026-11-17T00:00:00Z'),
      );
      const days = Object.fromEntries(
        (await repo.hostedEvents()).map((e) => [e.id, e.day]),
      );
      expect(days).toEqual({
        '1': '2026-10-31',
        '2': '2026-03-08',
        '3': '2026-03-08',
        '4': '2026-11-01',
      });
    });

    it('lastCompleteListing: only the latest finished run, only if its listing was complete', async () => {
      expect(await snapshot.lastCompleteListing()).toBeUndefined();
      const good = await snapshot.startRun('job', 'full');
      const goodAt = new Date('2026-11-10T08:00:00Z');
      await snapshot.markListed(good.id, goodAt, 5);
      await snapshot.finishRun(good.id);
      expect(await snapshot.lastCompleteListing()).toEqual(goodAt);

      // A short listing, whose error a later good tick cleared.
      const short = await snapshot.startRun('job', 'incremental');
      await snapshot.markListed(
        short.id,
        new Date('2026-11-11T08:00:00Z'),
        2,
        true,
      );
      await snapshot.recordError(short.id, 'ShortListing');
      await snapshot.recordError(short.id, undefined);
      await snapshot.finishRun(short.id);
      expect(await snapshot.lastCompleteListing()).toBeUndefined();

      // A complete listing that still carries an error.
      const failed = await snapshot.startRun('job', 'incremental');
      await snapshot.markListed(failed.id, new Date('2026-11-12T08:00:00Z'), 5);
      await snapshot.recordError(failed.id, 'ClientError');
      await snapshot.finishRun(failed.id);
      expect(await snapshot.lastCompleteListing()).toBeUndefined();

      const next = await snapshot.startRun('job', 'incremental');
      const nextAt = new Date('2026-11-13T08:00:00Z');
      await snapshot.markListed(next.id, nextAt, 5);
      await snapshot.finishRun(next.id);
      expect(await snapshot.lastCompleteListing()).toEqual(nextAt);

      // An open run whose listing came back short holds awards back too.
      const open = await snapshot.startRun('job', 'incremental');
      await snapshot.markListed(
        open.id,
        new Date('2026-11-14T08:00:00Z'),
        2,
        true,
      );
      expect(await snapshot.lastCompleteListing()).toBeUndefined();
      await snapshot.finishRun(open.id);
      const last = await snapshot.startRun('job', 'incremental');
      await snapshot.markListed(last.id, new Date('2026-11-15T08:00:00Z'), 5);
      expect(await snapshot.lastCompleteListing()).toBeUndefined();
      await snapshot.finishRun(last.id);
      expect(await snapshot.lastCompleteListing()).toEqual(
        new Date('2026-11-15T08:00:00Z'),
      );
    });

    it('profileEvents matches Wrapped’s hostedEvents, except unknown attendance', async () => {
      const at = new Date('2026-11-17T00:00:00Z');
      await snapshot.upsertEvents(
        [
          event('1', { hostIds: ['111', '222'], yesCount: 9 }),
          // No listed count, RSVPs read: the stored rows.
          event('2', { hostIds: ['111'], yesCount: null }),
          // No listed count and never read: unknown.
          event('3', { hostIds: ['111'], yesCount: null }),
          event('4', { hostIds: ['222'] }),
        ],
        at,
      );
      await snapshot.replaceRsvps(
        '2',
        [
          { memberId: '501', status: 'YES' },
          { memberId: '502', status: 'ATTENDED' },
          { memberId: '503', status: 'WAITLIST' },
        ],
        at,
      );
      const wrapped = await snapshot.hostedEvents('111');
      const profile = await snapshot.profileEvents('111');
      expect(wrapped.map((e) => [e.id, e.attendance])).toEqual([
        ['1', 9],
        ['2', 2],
        ['3', 0],
      ]);
      expect(profile.map((e) => [e.id, e.attendance])).toEqual([
        ['1', 9],
        ['2', 2],
        ['3', undefined],
      ]);
      expect(profile.map(({ attendance: _a, ...rest }) => rest)).toEqual(
        wrapped.map(({ attendance: _a, ...rest }) => rest),
      );
    });
  },
);
