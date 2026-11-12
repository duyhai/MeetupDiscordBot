import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ensureDashboardSchema } from '../../src/lib/repositories/dashboardPool.js';
import { PostgresSnapshotRepository } from '../../src/lib/repositories/postgresSnapshotRepository.js';
import { SnapshotEvent } from '../../src/lib/snapshot/meetup.js';
import { useIsolatedSchema } from './isolatedSchema.js';

const POSTGRES_AVAILABLE = Boolean(process.env.DATABASE_URL);

if (!POSTGRES_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    'Skipping PostgresSnapshotRepository integration tests: set DATABASE_URL to a reachable Postgres to run them.',
  );
}

const NOW = new Date('2026-11-11T20:00:00Z');
const days = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60_000);

const event = (
  id: string,
  dateTime: Date,
  over: Partial<SnapshotEvent> = {},
): SnapshotEvent => ({
  eventId: id,
  title: `Event ${id}`,
  dateTime,
  eventUrl: `https://www.meetup.com/g/events/${id}/`,
  status: 'PAST',
  hostIds: ['111'],
  yesCount: 3,
  waitlistCount: 0,
  ...over,
});

(POSTGRES_AVAILABLE ? describe : describe.skip)(
  'PostgresSnapshotRepository',
  () => {
    let schema: { drop(): Promise<void> };
    let pool: pg.Pool;
    let repo: PostgresSnapshotRepository;

    beforeAll(async () => {
      schema = await useIsolatedSchema('snapshot');
      pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        max: 4,
      });
    });

    beforeEach(async () => {
      await pool.query(
        'DROP TABLE IF EXISTS meetup_event_rsvps, meetup_events, meetup_snapshot_runs, event_audit_state CASCADE',
      );
      await ensureDashboardSchema(pool);
      repo = new PostgresSnapshotRepository(pool);
    });

    afterAll(async () => {
      await pool.end();
      await schema.drop();
    });

    it('creates the schema idempotently', async () => {
      await ensureDashboardSchema(pool);
      await ensureDashboardSchema(pool);
      expect(await repo.totals()).toEqual({ events: 0, rsvps: 0 });
    });

    it('keeps one open run; full counts only once finished', async () => {
      const run = await repo.startRun('job', 'full');
      expect(run?.kind).toBe('full');
      expect(await repo.startRun('job', 'full')).toBeUndefined();
      expect(await repo.hasFinishedFull()).toBe(false);
      await repo.advance(run.id, {
        eventsFetched: 2,
        rsvpsStored: 7,
        failed: 1,
      });
      await repo.recordRequests(run.id, 5);
      await repo.recordError(run.id, 'TypeError');
      const done = await repo.finishRun(run.id);
      expect(done).toMatchObject({
        eventsFetched: 2,
        rsvpsStored: 7,
        failed: 1,
        requests: 5,
        lastError: 'TypeError',
      });
      expect(done?.finishedAt).toBeInstanceOf(Date);
      expect(await repo.finishRun(run.id)).toBeUndefined();
      expect(await repo.hasFinishedFull()).toBe(true);
      expect((await repo.lastFinishedRun())?.id).toBe(run.id);
      expect(await repo.openRun()).toBeUndefined();
    });

    it('upserts events in place and moves listed_at', async () => {
      await repo.upsertEvents([event('1', days(10))], days(1));
      await repo.upsertEvents(
        [
          event('1', days(10), {
            title: 'Renamed CANCELLED',
            hostIds: [],
            status: 'CANCELLED',
          }),
        ],
        NOW,
      );
      const { rows } = await pool.query(
        'SELECT title, status, host_ids, listed_at FROM meetup_events',
      );
      expect(rows).toEqual([
        {
          title: 'Renamed CANCELLED',
          status: 'CANCELLED',
          host_ids: [],
          listed_at: NOW,
        },
      ]);
    });

    it('replaces an event’s RSVPs in one go, last duplicate wins', async () => {
      await repo.upsertEvents([event('1', days(10))], NOW);
      await repo.replaceRsvps(
        '1',
        [
          { memberId: '10', status: 'YES' },
          { memberId: '11', status: 'WAITLIST' },
          { memberId: '12', status: 'YES' },
        ],
        days(2),
      );
      await repo.replaceRsvps(
        '1',
        [
          { memberId: '10', status: 'YES' },
          { memberId: '12', status: 'YES' },
          { memberId: '12', status: 'ATTENDED' },
        ],
        NOW,
      );
      const { rows } = await pool.query(
        'SELECT member_id, status FROM meetup_event_rsvps ORDER BY member_id',
      );
      expect(rows).toEqual([
        { member_id: '10', status: 'YES' },
        { member_id: '12', status: 'ATTENDED' },
      ]);
      const fetched = await pool.query<{ rsvps_fetched_at: Date }>(
        'SELECT rsvps_fetched_at FROM meetup_events',
      );
      expect(fetched.rows[0].rsvps_fetched_at).toEqual(NOW);
      expect(await repo.totals()).toEqual({ events: 1, rsvps: 2 });
    });

    it('selects the RSVP work set by the three rules, oldest first', async () => {
      const runStartedAt = days(0.5);
      await repo.upsertEvents(
        [
          event('901', days(100)),
          event('902', days(3)),
          event('903', days(4)),
          event('904', days(40)),
          event('905', days(20)),
          event('906', new Date(NOW.getTime() + 86_400_000), {
            status: 'ACTIVE',
          }),
          event('907', days(50)),
          event('908', days(60)),
        ],
        NOW,
      );
      await repo.replaceRsvps('902', [], days(1));
      await repo.replaceRsvps('903', [], days(0.1));
      await repo.replaceRsvps('904', [], days(30));
      await repo.replaceRsvps('905', [], days(25));
      await repo.markDeleted('907', NOW);
      const query = { runStartedAt, now: NOW, settleDays: 14 };
      // 908 failed during this run: it waits for the next one.
      await repo.recordRsvpFailure('908', 'TypeError', days(0.2));
      const work = await repo.eventsNeedingRsvps({ ...query, limit: 10 });
      expect(work.map((w) => w.eventId)).toEqual(['901', '905', '902']);
      expect(work[0].yesCount).toBe(3);
      expect(await repo.pendingRsvpCount(query)).toBe(3);
      expect(await repo.failingEventCount()).toBe(1);
      const nextRun = await repo.eventsNeedingRsvps({
        ...query,
        runStartedAt: NOW,
        limit: 10,
      });
      // 903 too: recent, and read before this later run started.
      expect(nextRun.map((w) => w.eventId)).toEqual([
        '901',
        '908',
        '905',
        '903',
        '902',
      ]);
      // A good read clears the failure.
      await repo.replaceRsvps('908', [], NOW);
      expect(await repo.failingEventCount()).toBe(0);
      const cleared = await pool.query<{
        rsvp_failures: number;
        rsvp_error: string | null;
        rsvp_failed_at: Date | null;
      }>(
        "SELECT rsvp_failures, rsvp_error, rsvp_failed_at FROM meetup_events WHERE event_id = '908'",
      );
      expect(cleared.rows[0]).toEqual({
        rsvp_failures: 0,
        rsvp_error: null,
        rsvp_failed_at: null,
      });
    });

    it('marks delisted rows but never ACTIVE ones, and counts PAST', async () => {
      await repo.upsertEvents(
        [
          event('801', days(10)),
          event('802', days(9), { status: 'CANCELLED' }),
          event('803', days(-3), { status: 'ACTIVE' }),
        ],
        days(2),
      );
      await repo.upsertEvents([event('804', days(8))], NOW);
      expect(await repo.pastEventCount()).toBe(2);
      expect(await repo.markDelisted(days(1), NOW)).toBe(2);
      expect(await repo.pastEventCount()).toBe(1);
      const { rows } = await pool.query<{ event_id: string }>(
        'SELECT event_id FROM meetup_events WHERE deleted_at IS NULL ORDER BY event_id',
      );
      expect(rows.map((r) => r.event_id)).toEqual(['803', '804']);
    });

    it('copies the event audit’s confirmed deletions, and is a no-op without its table', async () => {
      await repo.upsertEvents([event('5', days(1)), event('6', days(1))], NOW);
      expect(await repo.markAuditDeletions()).toBe(0);
      await pool.query(
        `CREATE TABLE event_audit_state (meetup_event_id TEXT PRIMARY KEY, deleted_at TIMESTAMPTZ)`,
      );
      await pool.query(
        `INSERT INTO event_audit_state VALUES ('5', $1), ('6', NULL)`,
        [days(0.2)],
      );
      expect(await repo.markAuditDeletions()).toBe(1);
      const { rows } = await pool.query(
        'SELECT event_id, deleted_at FROM meetup_events ORDER BY event_id',
      );
      expect(rows).toEqual([
        { event_id: '5', deleted_at: days(0.2) },
        { event_id: '6', deleted_at: null },
      ]);
    });

    it('two concurrent startRun calls open one run', async () => {
      const results = await Promise.all([
        repo.startRun('job', 'full'),
        repo.startRun('job', 'full'),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('reads a member’s events, hosted events and attendees for Wrapped', async () => {
      await repo.upsertEvents(
        [
          event('701', days(30), { hostIds: ['55'] }),
          event('702', days(20), { eventUrl: null, hostIds: ['55', '66'] }),
          event('703', days(10), { status: 'CANCELLED', hostIds: ['55'] }),
          event('704', days(-2), { status: 'ACTIVE', hostIds: ['55'] }),
          event('705', days(5), { hostIds: ['55'], yesCount: 9 }),
          event('706', days(4)),
        ],
        NOW,
      );
      await repo.markDeleted('706', NOW);
      await repo.replaceRsvps(
        '701',
        [
          { memberId: '55', status: 'YES' },
          { memberId: '77', status: 'ATTENDED' },
          { memberId: '88', status: 'WAITLIST' },
        ],
        NOW,
      );
      await repo.replaceRsvps(
        '702',
        [
          { memberId: '55', status: 'WAITLIST' },
          { memberId: '77', status: 'YES' },
        ],
        NOW,
      );
      await repo.replaceRsvps('706', [{ memberId: '55', status: 'YES' }], NOW);

      expect(await repo.memberEvents('55')).toEqual([
        {
          id: '701',
          title: 'Event 701',
          dateTime: days(30).toISOString(),
          eventUrl: 'https://www.meetup.com/g/events/701/',
        },
      ]);
      const hosted = await repo.hostedEvents('55');
      // Meetup's YES + ATTENDED total from the listing, as the token path
      // reads it (it counts RSVPs the organizer view hides).
      expect(hosted.map((h) => [h.id, h.attendance])).toEqual([
        ['701', 3],
        ['702', 3],
        ['705', 9],
      ]);
      // With no listed count, the stored YES/ATTENDED rows.
      await repo.upsertEvents(
        [event('701', days(30), { hostIds: ['55'], yesCount: null })],
        NOW,
      );
      expect((await repo.hostedEvents('55'))[0].attendance).toBe(2);
      expect(hosted[1].eventUrl).toMatch(/\/events\/702\/$/);
      expect(await repo.attendeesOf(['701', '702', '799'])).toEqual({
        '701': ['55', '77'],
        '702': ['77'],
        '799': [],
      });
      expect(await repo.isReady()).toBe(false);
      const run = await repo.startRun('job', 'full');
      await repo.finishRun(run.id);
      expect(await repo.isReady()).toBe(true);
      expect(await repo.updatedAt()).toBeInstanceOf(Date);
    });

    it('adds the rsvp_* columns to a table that predates them', async () => {
      await pool.query(
        'ALTER TABLE meetup_events DROP COLUMN rsvp_failures, DROP COLUMN rsvp_failed_at, DROP COLUMN rsvp_error',
      );
      await ensureDashboardSchema(pool);
      await ensureDashboardSchema(pool);
      const { rows } = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'meetup_events'
            AND column_name IN ('rsvp_error', 'rsvp_failed_at', 'rsvp_failures')
          ORDER BY column_name`,
      );
      expect(rows.map((r) => r.column_name)).toEqual([
        'rsvp_error',
        'rsvp_failed_at',
        'rsvp_failures',
      ]);
    });
  },
);
