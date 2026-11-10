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
  EventAuditDeps,
  runEventAuditTick,
} from '../../src/lib/eventAudit/job.js';
import { AuditMeetupReader } from '../../src/lib/eventAudit/meetup.js';
import { EventObservation } from '../../src/lib/eventAudit/types.js';
import { LogEntry } from '../../src/lib/helpers/discordLogger.js';
import { BUILD_LEASE_KEY } from '../../src/lib/reports/buildLease.js';
import {
  PostgresEventAuditRepository,
  ensureEventAuditSchema,
} from '../../src/lib/repositories/postgresEventAuditRepository.js';
import { FakeCache } from '../web/fakeCache.js';
import { useIsolatedSchema } from './isolatedSchema.js';

// Requires DATABASE_URL against a throwaway Postgres; skipped otherwise.
const POSTGRES_AVAILABLE = Boolean(process.env.DATABASE_URL);

const obs = (overrides: Partial<EventObservation> = {}): EventObservation => ({
  eventId: '311000001',
  title: 'Board games',
  status: 'ACTIVE',
  startAt: new Date('2026-12-06T03:00:00Z'),
  createdAt: new Date('2026-10-01T00:00:00Z'),
  duration: 'PT2H',
  eventUrl: 'https://www.meetup.com/g/events/311000001/',
  venueId: '27',
  photoId: null,
  hosts: [{ id: '4242', name: 'Hana' }],
  rsvpYes: 20,
  waitlist: 2,
  rsvpsClosed: false,
  lastEditedAt: null,
  ...overrides,
});

/**
 * The whole job on the real repository: the tick takes the build lease, the
 * run reads a fake Meetup, writes Postgres, alerts, and the hourly rule
 * holds the next tick back.
 */
(POSTGRES_AVAILABLE ? describe : describe.skip)(
  'event audit job end to end',
  () => {
    let schema: { drop(): Promise<void> };
    let pool: pg.Pool;
    let repo: PostgresEventAuditRepository;

    beforeAll(async () => {
      schema = await useIsolatedSchema('eventauditjob');
      pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        max: 4,
      });
      await ensureEventAuditSchema(pool);
    });

    beforeEach(async () => {
      await pool.query(
        'TRUNCATE event_changes, event_audit_state, event_snapshots, event_audit_runs',
      );
      repo = new PostgresEventAuditRepository(pool);
    });

    afterAll(async () => {
      await pool?.end();
      await schema?.drop();
    });

    function harness(
      listed: EventObservation[],
      byId: Record<string, EventObservation | null> = {},
    ) {
      const cache = new FakeCache();
      const alerts: LogEntry[] = [];
      let now = new Date('2026-11-10T20:00:00Z');
      const listEvents = vi.fn(async () => listed);
      const getEvent = vi.fn(async (id: string) => byId[id] ?? null);
      const reader: AuditMeetupReader = { listEvents, getEvent };
      const deps: EventAuditDeps = {
        now: () => now,
        cache: async () => cache,
        store: async () => repo,
        readMeetup: (fn) => fn(reader),
        alert: vi.fn(async (entry: LogEntry) => {
          alerts.push(entry);
          return true;
        }),
        newLeaseValue: () => 'lease',
      };
      return {
        deps,
        cache,
        alerts,
        listEvents,
        getEvent,
        advance: (minutes: number) => {
          now = new Date(now.getTime() + minutes * 60_000);
        },
      };
    }

    it('baseline tick, a quiet re-tick within the hour, then a deletion an hour later', async () => {
      const a = obs();
      const b = obs({ eventId: '311000002', title: 'Hike' });
      const h = harness([a, b]);
      await runEventAuditTick(h.deps);
      expect(h.listEvents).toHaveBeenCalledTimes(1);
      expect((await repo.liveStates()).map((s) => s.eventId)).toEqual([
        '311000001',
        '311000002',
      ]);
      expect(await repo.latestSavedRun()).toMatchObject({
        listed: 2,
        changes: 0,
        requestedBy: 'job',
      });
      expect(h.cache.values.has(BUILD_LEASE_KEY)).toBe(false);

      // Fifteen minutes on: not due, so Meetup is not read and the lease is not kept.
      h.advance(15);
      await runEventAuditTick(h.deps);
      expect(h.listEvents).toHaveBeenCalledTimes(1);
      expect(h.cache.values.has(BUILD_LEASE_KEY)).toBe(false);

      // An hour on: B is gone from the listing and Meetup says it does not exist.
      h.advance(45);
      const later = harness([a], { '311000002': null });
      // The same clock and cache; the same repository.
      const now = () => h.deps.now();
      const deps = { ...later.deps, now, cache: async () => h.cache };
      await runEventAuditTick(deps);
      expect(later.getEvent).toHaveBeenCalledWith('311000002');
      const history = await repo.eventHistory('311000002');
      expect(history?.state.deletedAt).toBeInstanceOf(Date);
      expect(history?.changes.map((c) => c.kind)).toEqual(['deleted']);
      expect(history?.changes[0].alertedAt).toBeInstanceOf(Date);
      expect(later.alerts.map((e) => e.title)).toEqual(['Event deleted: Hike']);
      expect(
        (await repo.listChanges({ kind: 'deleted' })).map((c) => c.rsvpYes),
      ).toEqual([20]);
    });

    it('a held build lease keeps the tick out', async () => {
      const h = harness([obs()]);
      await h.cache.set(BUILD_LEASE_KEY, 'a report build', 60);
      await runEventAuditTick(h.deps);
      expect(h.listEvents).not.toHaveBeenCalled();
      expect(await repo.latestRun()).toBeUndefined();
      expect(h.cache.values.get(BUILD_LEASE_KEY)).toBe('a report build');
    });
  },
);
