import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ensureDashboardSchema } from '../../src/lib/repositories/dashboardPool.js';
import { PostgresRetentionRepository } from '../../src/lib/repositories/postgresRetentionRepository.js';
import { PostgresSnapshotRepository } from '../../src/lib/repositories/postgresSnapshotRepository.js';
import {
  CohortMonth,
  createRetentionLoader,
  headlines,
} from '../../src/lib/retention/retention.js';
import { SnapshotEvent } from '../../src/lib/snapshot/meetup.js';
import { useIsolatedSchema } from './isolatedSchema.js';

const POSTGRES_AVAILABLE = Boolean(process.env.DATABASE_URL);

if (!POSTGRES_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    'Skipping PostgresRetentionRepository integration tests: set DATABASE_URL to a reachable Postgres to run them.',
  );
}

const LISTED = new Date('2026-11-01T00:00:00Z');
const AS_OF = '2026-11-20';

/** Noon-ish Pacific on `day` (YYYY-MM-DD) plus `plus` days: the same Pacific date all year. */
const at = (day: string, plus = 0): Date =>
  new Date(Date.parse(`${day}T20:00:00Z`) + plus * 86_400_000);

interface Fixture {
  id: string;
  at: Date;
  /** Member ids who said yes. */
  yes?: string[];
  attended?: string[];
  waitlist?: string[];
  title?: string;
  status?: SnapshotEvent['status'];
  deleted?: boolean;
}

(POSTGRES_AVAILABLE ? describe : describe.skip)(
  'PostgresRetentionRepository',
  () => {
    let schema: { drop(): Promise<void> };
    let pool: pg.Pool;
    let snapshot: PostgresSnapshotRepository;
    let repo: PostgresRetentionRepository;

    beforeAll(async () => {
      schema = await useIsolatedSchema('retention');
      pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        max: 4,
      });
    });

    beforeEach(async () => {
      await pool.query(
        `DROP TABLE IF EXISTS meetup_host_names, meetup_event_rsvps, meetup_events,
           meetup_snapshot_runs CASCADE`,
      );
      await ensureDashboardSchema(pool);
      snapshot = new PostgresSnapshotRepository(pool);
      repo = new PostgresRetentionRepository(pool);
    });

    afterAll(async () => {
      await pool.end();
      await schema.drop();
    });

    async function seed(fixtures: Fixture[]): Promise<void> {
      await snapshot.upsertEvents(
        fixtures.map((f) => ({
          eventId: f.id,
          title: f.title ?? `Event ${f.id}`,
          dateTime: f.at,
          eventUrl: null,
          status: f.status ?? 'PAST',
          hostIds: [],
          yesCount: null,
          waitlistCount: null,
        })),
        LISTED,
      );
      for (const f of fixtures) {
        // eslint-disable-next-line no-await-in-loop
        await snapshot.replaceRsvps(
          f.id,
          [
            ...(f.yes ?? []).map((memberId) => ({
              memberId,
              status: 'YES' as const,
            })),
            ...(f.attended ?? []).map((memberId) => ({
              memberId,
              status: 'ATTENDED' as const,
            })),
            ...(f.waitlist ?? []).map((memberId) => ({
              memberId,
              status: 'WAITLIST' as const,
            })),
          ],
          LISTED,
        );
        if (f.deleted) {
          // eslint-disable-next-line no-await-in-loop
          await snapshot.markDeleted(f.id, LISTED);
        }
      }
    }

    const cohort = (rows: CohortMonth[], month: string) =>
      rows.find((r) => r.month === month);

    it('answers empty lists with nothing stored', async () => {
      expect(await repo.aggregates(AS_OF)).toEqual({
        cohorts: [],
        months: [],
        years: [],
      });
    });

    it("puts a member in the Pacific month of their first event, not the UTC one's", async () => {
      await seed([
        // 05:00 UTC on Feb 1 is 9 pm on Jan 31 in Seattle.
        { id: '1', at: new Date('2025-02-01T05:00:00Z'), yes: ['10'] },
        // 08:00 UTC on Feb 1 is midnight Pacific: February.
        { id: '2', at: new Date('2025-02-01T08:00:00Z'), yes: ['11'] },
        // Dec 31, 11 pm Pacific is Jan 1 UTC: the 2024 cohort year.
        { id: '3', at: new Date('2025-01-01T07:00:00Z'), yes: ['12'] },
      ]);
      const { cohorts, months, years } = await repo.aggregates(AS_OF);
      expect(cohorts.map((c) => [c.month, c.members])).toEqual([
        ['2024-12', 1],
        ['2025-01', 1],
        ['2025-02', 1],
      ]);
      expect(months.map((m) => [m.month, m.active, m.firstTimers])).toEqual([
        ['2024-12', 1, 1],
        ['2025-01', 1, 1],
        ['2025-02', 1, 1],
      ]);
      expect(years).toEqual([
        { cohort: 2024, year: 2024, members: 1 },
        { cohort: 2025, year: 2025, members: 2 },
      ]);
    });

    it('counts YES and ATTENDED at live past events only', async () => {
      await seed([
        { id: '1', at: at('2025-03-05'), yes: ['10'], attended: ['11'] },
        // None of these is an attended event.
        { id: '2', at: at('2025-03-06'), waitlist: ['10', '20'] },
        { id: '3', at: at('2025-03-07'), yes: ['10', '21'], deleted: true },
        {
          id: '4',
          at: at('2025-03-08'),
          yes: ['10', '22'],
          status: 'CANCELLED',
        },
        { id: '5', at: at('2025-03-09'), yes: ['10', '23'], status: 'ACTIVE' },
        {
          id: '6',
          at: at('2025-03-10'),
          yes: ['10', '24'],
          title: 'CANCELED: Hike',
        },
        {
          id: '7',
          at: at('2025-03-11'),
          yes: ['10', '25'],
          title: 'Picnic (Cancelled)',
        },
      ]);
      const { cohorts, months } = await repo.aggregates(AS_OF);
      expect(cohorts).toHaveLength(1);
      expect(cohorts[0]).toMatchObject({
        month: '2025-03',
        members: 2,
        reached2: 0,
        second90: 0,
      });
      expect(months).toEqual([{ month: '2025-03', active: 2, firstTimers: 2 }]);
    });

    it('counts an Open House as attended, as Wrapped does', async () => {
      await seed([
        { id: '1', at: at('2025-03-05'), yes: ['10'] },
        {
          id: '2',
          at: at('2025-03-12'),
          yes: ['10'],
          title: '[Open House] Board games',
        },
      ]);
      const { cohorts } = await repo.aggregates(AS_OF);
      expect(cohorts[0]).toMatchObject({ members: 1, reached2: 1 });
    });

    it('the 90-day window includes day 90 and not day 91', async () => {
      const first = '2025-01-10';
      await seed([
        { id: '1', at: at(first), yes: ['10', '11', '12', '13', '14'] },
        // 10: second on day 90, third on day 90 too (two events that day).
        { id: '2', at: at(first, 90), yes: ['10'] },
        {
          id: '3',
          at: new Date(at(first, 90).getTime() + 3_600_000),
          yes: ['10'],
        },
        // 11: second on day 91.
        { id: '4', at: at(first, 91), yes: ['11'] },
        // 12: second on day 1, third on day 91.
        { id: '5', at: at(first, 1), yes: ['12'] },
        { id: '6', at: at(first, 91), yes: ['12'] },
        // 13: a second event the same day as the first counts (day 0).
        {
          id: '7',
          at: new Date(at(first).getTime() + 3_600_000),
          yes: ['13'],
        },
        // 14: one event only.
      ]);
      const { cohorts } = await repo.aggregates(AS_OF);
      expect(cohort(cohorts, '2025-01')).toMatchObject({
        members: 5,
        second90: 3,
        third90: 1,
        reached2: 4,
        reached3: 2,
        reached4: 0,
      });
    });

    it('still coming a year on: an event on days 271 to 365 after the first', async () => {
      const first = '2024-02-01';
      await seed([
        { id: '1', at: at(first), yes: ['10', '11', '12', '13', '14'] },
        { id: '2', at: at(first, 270), yes: ['10'] },
        { id: '3', at: at(first, 271), yes: ['11'] },
        { id: '4', at: at(first, 365), yes: ['12'] },
        { id: '5', at: at(first, 366), yes: ['13'] },
        // Two events in the window are one member.
        { id: '6', at: at(first, 300), yes: ['11'] },
      ]);
      const { cohorts } = await repo.aggregates(AS_OF);
      expect(cohort(cohorts, '2024-02')).toMatchObject({
        members: 5,
        yearOn: 2,
      });
    });

    it('the ladder counts: how many reached each event, and the sixth and later pooled', async () => {
      // 10 attends eight events, 11 six, 12 two, 13 one; all first in 2025-04.
      const eight = Array.from({ length: 8 }, (_unused, i) => ({
        id: String(i + 1),
        at: at('2025-04-01', i * 7),
        yes: [
          '10',
          ...(i < 6 ? ['11'] : []),
          ...(i < 2 ? ['12'] : []),
          ...(i < 1 ? ['13'] : []),
        ],
      }));
      await seed(eight);
      const { cohorts } = await repo.aggregates(AS_OF);
      expect(cohorts).toHaveLength(1);
      expect(cohorts[0]).toEqual({
        month: '2025-04',
        members: 4,
        second90: 3,
        third90: 2,
        yearOn: 0,
        reached2: 3,
        reached3: 2,
        reached4: 2,
        reached5: 2,
        reached6: 2,
        // 10's 6th, 7th, 8th and 11's 6th; 10's 6th and 7th had a next.
        sixPlus: 4,
        sixPlusAgain: 2,
        recentThree: 0,
        recentUnderThree: 0,
      });
    });

    it('recent activity: an event in the 180 days to the as-of day, split by three events or fewer', async () => {
      await seed([
        { id: '1', at: at('2023-05-01'), yes: ['10', '11', '12', '13'] },
        { id: '2', at: at('2023-05-08'), yes: ['10', '13'] },
        // 10 has three events, the last 179 days before the as-of day.
        { id: '3', at: at(AS_OF, -179), yes: ['10'] },
        // 11 has two, the last one recent.
        { id: '4', at: at(AS_OF, -10), yes: ['11'] },
        // 12's only other event is exactly 180 days back: not recent.
        { id: '5', at: at(AS_OF, -180), yes: ['12'] },
        // 13 has three events, none recent.
        { id: '6', at: at('2023-06-01'), yes: ['13'] },
      ]);
      const { cohorts } = await repo.aggregates(AS_OF);
      expect(cohort(cohorts, '2023-05')).toMatchObject({
        members: 4,
        reached3: 2,
        recentThree: 1,
        recentUnderThree: 1,
      });
    });

    it('members per month are distinct, and new only in their first month', async () => {
      await seed([
        { id: '1', at: at('2025-06-03'), yes: ['10', '11'] },
        { id: '2', at: at('2025-06-20'), yes: ['10'] },
        { id: '3', at: at('2025-07-04'), yes: ['10', '12'] },
        { id: '4', at: at('2026-01-15'), yes: ['11'] },
      ]);
      const { months, years } = await repo.aggregates(AS_OF);
      expect(months).toEqual([
        { month: '2025-06', active: 2, firstTimers: 2 },
        { month: '2025-07', active: 2, firstTimers: 1 },
        { month: '2026-01', active: 1, firstTimers: 0 },
      ]);
      expect(years).toEqual([
        { cohort: 2025, year: 2025, members: 3 },
        { cohort: 2025, year: 2026, members: 1 },
      ]);
    });

    it('through the loader: a month that has not had its 90 days is not in the headline', async () => {
      // Snapshot finished 2026-11-20 Pacific. July's last day + 90 is Oct 29:
      // matured. August's is Nov 29: not yet.
      await seed([
        { id: '1', at: at('2026-07-10'), yes: ['10', '11'] },
        { id: '2', at: at('2026-07-12'), yes: ['10'] },
        { id: '3', at: at('2026-07-14'), yes: ['10'] },
        { id: '4', at: at('2026-08-10'), yes: ['20', '21', '22'] },
        { id: '5', at: at('2026-08-11'), yes: ['20', '21', '22'] },
        { id: '6', at: at('2026-08-12'), yes: ['20', '21', '22'] },
      ]);
      const finishedAt = new Date('2026-11-20T20:00:00Z');
      let reads = 0;
      const loader = createRetentionLoader({
        store: async () => ({
          aggregates: (asOf: string) => {
            reads += 1;
            return repo.aggregates(asOf);
          },
        }),
        snapshot: async () => ({
          hasFinishedFull: async () => true,
          lastFinishedRun: async () => ({
            id: 7,
            trigger: 'job',
            kind: 'full' as const,
            startedAt: finishedAt,
            finishedAt,
            listedAt: finishedAt,
            eventsListed: 6,
            eventsFetched: 6,
            rsvpsStored: 0,
            failed: 0,
            requests: 0,
            lastError: undefined,
          }),
        }),
        now: () => new Date('2027-01-01T00:00:00Z'),
      });
      const data = await loader.load();
      if (!data.ready) {
        throw new Error('not ready');
      }
      expect(data.asOf).toBe('2026-11-20');
      const { third90, second90 } = headlines(data);
      expect([third90.first, third90.last]).toEqual(['2025-08', '2026-07']);
      expect(third90.rate).toEqual({ count: 1, of: 2 });
      expect(second90.rate).toEqual({ count: 1, of: 2 });
      // The same run again: no second query.
      await loader.load();
      expect(reads).toBe(1);
    });
  },
);
