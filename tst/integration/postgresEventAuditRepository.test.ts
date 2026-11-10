import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  EventObservation,
  NewEventChange,
} from '../../src/lib/eventAudit/types.js';
import {
  EVENT_AUDIT_RETENTION_DAYS,
  PostgresEventAuditRepository,
  RunWrite,
  ensureEventAuditSchema,
} from '../../src/lib/repositories/postgresEventAuditRepository.js';
import { useIsolatedSchema } from './isolatedSchema.js';

// Requires DATABASE_URL against a throwaway Postgres; skipped otherwise.
const POSTGRES_AVAILABLE = Boolean(process.env.DATABASE_URL);

const T0 = new Date('2026-11-10T17:00:00Z');
const T1 = new Date('2026-11-10T18:00:00Z');
const T2 = new Date('2026-11-10T19:00:00Z');
const HANA = { id: '4242', name: 'Hana' };
const KEN = { id: '5151', name: 'Ken' };
const URL_A = 'https://www.meetup.com/g/events/311000001/';

const obs = (overrides: Partial<EventObservation> = {}): EventObservation => ({
  eventId: '311000001',
  title: 'Board games',
  status: 'ACTIVE',
  startAt: new Date('2026-12-05T03:00:00Z'),
  duration: 'PT2H',
  eventUrl: URL_A,
  venueId: '27',
  photoId: null,
  hosts: [HANA],
  rsvpYes: 20,
  waitlist: 2,
  rsvpsClosed: false,
  lastEditedAt: null,
  ...overrides,
});

const change = (overrides: Partial<NewEventChange> = {}): NewEventChange => ({
  eventId: '311000001',
  kind: 'host_changed',
  oldValue: { hosts: [HANA] },
  newValue: { hosts: [KEN] },
  title: 'Board games',
  startAt: new Date('2026-12-05T03:00:00Z'),
  eventUrl: URL_A,
  hosts: [HANA, KEN],
  rsvpYes: 20,
  waitlist: 2,
  ...overrides,
});

const run = (overrides: Partial<RunWrite> = {}): RunWrite => ({
  startedAt: T1,
  finishedAt: new Date(T1.getTime() + 5000),
  requestedBy: 'job',
  listed: 2,
  confirmed: 0,
  observations: [obs(), obs({ eventId: '311000002', title: 'Hike' })],
  deletedEventIds: [],
  changes: [],
  ...overrides,
});

(POSTGRES_AVAILABLE ? describe : describe.skip)(
  'PostgresEventAuditRepository',
  () => {
    let schema: { drop(): Promise<void> };
    let pool: pg.Pool;
    let repo: PostgresEventAuditRepository;

    beforeAll(async () => {
      schema = await useIsolatedSchema('eventaudit');
      pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        max: 4,
      });
      await ensureEventAuditSchema(pool);
      // Twice: the schema is idempotent.
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

    it('starts empty', async () => {
      expect(await repo.hasAnyState()).toBe(false);
      expect(await repo.latestRun()).toBeUndefined();
      expect(await repo.liveStates()).toEqual([]);
    });

    it('a run writes snapshots, state and changes together; a later run moves the state on', async () => {
      const first = await repo.saveRun(run());
      expect(first.changes).toEqual([]);
      expect(await repo.hasAnyState()).toBe(true);
      const states = await repo.liveStates();
      expect(states.map((s) => s.eventId).sort()).toEqual([
        '311000001',
        '311000002',
      ]);
      expect(states[0].latest).toMatchObject({
        runId: first.runId,
        takenAt: T1,
        rsvpYes: 20,
      });
      expect(states[0].firstSeenAt).toEqual(T1);

      const second = await repo.saveRun(
        run({
          startedAt: T2,
          finishedAt: new Date(T2.getTime() + 5000),
          listed: 1,
          confirmed: 1,
          observations: [obs({ hosts: [KEN], rsvpYes: 18 })],
          deletedEventIds: ['311000002'],
          changes: [
            change(),
            change({
              eventId: '311000002',
              kind: 'deleted',
              newValue: null,
              hosts: [HANA],
            }),
          ],
        }),
      );
      expect(second.changes).toHaveLength(2);
      expect(second.changes[0]).toMatchObject({
        kind: 'host_changed',
        runId: second.runId,
        detectedAt: new Date(T2.getTime() + 5000),
        hosts: [HANA, KEN],
        alertedAt: null,
        actor: null,
      });
      const live = await repo.liveStates();
      expect(live).toHaveLength(1);
      expect(live[0]).toMatchObject({
        eventId: '311000001',
        firstSeenAt: T1,
        lastSeenAt: T2,
        latest: { rsvpYes: 18, hosts: [KEN] },
      });
      const history = await repo.eventHistory('311000002');
      expect(history?.state.deletedAt).toEqual(new Date(T2.getTime() + 5000));
      expect(await repo.latestRun()).toMatchObject({
        id: second.runId,
        requestedBy: 'job',
        listed: 1,
        confirmed: 1,
        changes: 2,
        outcome: 'saved',
      });
    });

    it('a failed run is recorded as failed and never counts as the latest saved run', async () => {
      await repo.saveRun(run());
      await repo.recordFailedRun(
        T2,
        new Date(T2.getTime() + 100),
        '123456789012345678',
      );
      const latest = await repo.latestRun();
      expect(latest).toMatchObject({
        outcome: 'failed',
        requestedBy: '123456789012345678',
      });
      expect(await repo.latestSavedRun()).toMatchObject({
        startedAt: T1,
        outcome: 'saved',
      });
    });

    it('unalerted lists only the asked kinds, oldest first, and markAlerted ends it', async () => {
      const { changes } = await repo.saveRun(
        run({
          changes: [
            change({
              kind: 'rsvp_drop',
              oldValue: { rsvpYes: 20 },
              newValue: { rsvpYes: 10 },
            }),
            change({ kind: 'deleted', newValue: null }),
            change(),
          ],
        }),
      );
      const pending = await repo.unalerted([
        'deleted',
        'cancelled',
        'host_changed',
      ]);
      expect(pending.map((c) => c.kind)).toEqual(['deleted', 'host_changed']);
      await repo.markAlerted([changes[1].id], T2);
      expect(
        (await repo.unalerted(['deleted', 'host_changed'])).map((c) => c.kind),
      ).toEqual(['host_changed']);
      expect(
        (await repo.eventHistory('311000001'))?.changes.find(
          (c) => c.kind === 'deleted',
        )?.alertedAt,
      ).toEqual(T2);
    });

    it('listChanges filters by kind, host, day range and cursor, newest first', async () => {
      const { changes } = await repo.saveRun(
        run({
          changes: [
            change({
              kind: 'title_changed',
              hosts: [HANA],
              startAt: new Date('2026-12-01T03:00:00Z'),
            }),
            change(), // hosts HANA + KEN
            change({
              eventId: '311000002',
              kind: 'deleted',
              newValue: null,
              hosts: [KEN],
            }),
          ],
        }),
      );
      const all = await repo.listChanges({});
      expect(all.map((c) => c.id)).toEqual([
        changes[2].id,
        changes[1].id,
        changes[0].id,
      ]);
      expect(
        (await repo.listChanges({ kind: 'deleted' })).map((c) => c.kind),
      ).toEqual(['deleted']);
      // Hana is only an old host on the host change, but hosts is the union.
      expect(
        (await repo.listChanges({ hostId: '4242' })).map((c) => c.kind),
      ).toEqual(['host_changed', 'title_changed']);
      expect(await repo.listChanges({ hostId: 'abc' })).toEqual([]);
      expect(
        (await repo.listChanges({ beforeId: changes[1].id })).map((c) => c.id),
      ).toEqual([changes[0].id]);
      expect(await repo.listChanges({ from: T2 })).toEqual([]);
      expect(await repo.listChanges({ from: T0, to: T2 })).toHaveLength(3);
      expect(await repo.listChanges({}, 2)).toHaveLength(2);
    });

    it('eventHistory has the snapshots and changes newest first; unknown or bad ids are undefined', async () => {
      await repo.saveRun(run());
      await repo.saveRun(
        run({
          startedAt: T2,
          finishedAt: T2,
          observations: [obs({ rsvpYes: 19 })],
          changes: [change()],
        }),
      );
      const history = await repo.eventHistory('311000001');
      expect(history?.snapshots.map((s) => s.rsvpYes)).toEqual([19, 20]);
      expect(history?.changes.map((c) => c.kind)).toEqual(['host_changed']);
      expect(history?.state.latest.rsvpYes).toBe(19);
      expect(await repo.eventHistory('999')).toBeUndefined();
      expect(await repo.eventHistory('abc')).toBeUndefined();
      expect((await repo.eventHistory('311000001', 1))?.snapshots).toHaveLength(
        1,
      );
    });

    it('recentChangesForHost finds changes where the member was a host, newest first', async () => {
      await repo.saveRun(
        run({
          changes: [
            change({ hosts: [HANA, KEN] }),
            change({
              eventId: '311000002',
              kind: 'deleted',
              newValue: null,
              hosts: [KEN],
            }),
          ],
        }),
      );
      expect(
        (await repo.recentChangesForHost('4242')).map((c) => c.kind),
      ).toEqual(['host_changed']);
      expect(
        (await repo.recentChangesForHost('5151')).map((c) => c.kind),
      ).toEqual(['deleted', 'host_changed']);
      expect(await repo.recentChangesForHost('5151', { since: T2 })).toEqual(
        [],
      );
      expect(
        await repo.recentChangesForHost('5151', { limit: 1 }),
      ).toHaveLength(1);
      expect(await repo.recentChangesForHost('9999')).toEqual([]);
      expect(await repo.recentChangesForHost('x')).toEqual([]);
    });

    it('the audit is append-only: only alerted_at may change, nothing fresh may be deleted', async () => {
      await repo.saveRun(run({ changes: [change()] }));
      await expect(
        pool.query("UPDATE event_changes SET title = 'x'"),
      ).rejects.toThrow(/append-only/);
      await expect(
        pool.query('UPDATE event_changes SET alerted_at = now()'),
      ).resolves.toBeDefined();
      await expect(pool.query('DELETE FROM event_changes')).rejects.toThrow(
        /append-only/,
      );
      await expect(pool.query('DELETE FROM event_snapshots')).rejects.toThrow(
        /append-only/,
      );
      await expect(
        pool.query("UPDATE event_snapshots SET title = 'x'"),
      ).rejects.toThrow(/append-only/);
    });

    it('prune removes what is older than the retention, keeping each live event latest snapshot', async () => {
      const old = new Date(
        T1.getTime() - (EVENT_AUDIT_RETENTION_DAYS + 1) * 86_400_000,
      );
      // An old run: two events, one change.
      await repo.saveRun(
        run({ startedAt: old, finishedAt: old, changes: [change()] }),
      );
      // A fresh run sees only event 1, so event 2's latest snapshot stays old.
      await repo.saveRun(run({ observations: [obs()], listed: 1 }));
      const counts = await repo.prune(T1);
      // Event 1's old snapshot (superseded) and event 2's old snapshot (its state goes with it).
      expect(counts).toEqual({ snapshots: 1, changes: 1, states: 1 });
      expect((await repo.liveStates()).map((s) => s.eventId)).toEqual([
        '311000001',
      ]);
      expect((await repo.eventHistory('311000001'))?.snapshots).toHaveLength(1);
      expect(await repo.eventHistory('311000002')).toBeUndefined();
      expect(await repo.prune(T1)).toEqual({
        snapshots: 0,
        changes: 0,
        states: 0,
      });
    });

    it('hosts that are not a list of {id, name} read back as no hosts', async () => {
      const { changes } = await repo.saveRun(run({ changes: [change()] }));
      await pool.query(
        'ALTER TABLE event_snapshots DISABLE TRIGGER USER; ALTER TABLE event_changes DISABLE TRIGGER USER',
      );
      await pool.query(`UPDATE event_snapshots SET hosts = '{}'::jsonb`);
      await pool.query(
        `UPDATE event_changes SET hosts = '[1, "x"]'::jsonb WHERE id = $1`,
        [changes[0].id],
      );
      await pool.query(
        'ALTER TABLE event_snapshots ENABLE TRIGGER USER; ALTER TABLE event_changes ENABLE TRIGGER USER',
      );
      expect((await repo.liveStates())[0].latest.hosts).toEqual([]);
      expect((await repo.listChanges({}))[0].hosts).toEqual([]);
    });
  },
);
