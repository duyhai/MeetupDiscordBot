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
      await pool.query('TRUNCATE event_announcements, event_recreations');
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

    it('hold schedules a send; a held row is neither claimed nor held again', async () => {
      const due = new Date(Date.now() + 60 * 60 * 1000);
      await expect(repo.hold(EVENT, HOST, due)).resolves.toEqual({
        held: true,
      });
      expect(await repo.get(EVENT)).toMatchObject({
        status: 'held',
        dueAt: due,
      });
      expect(await repo.claim(EVENT, HOST)).toMatchObject({
        claimed: false,
        current: { status: 'held' },
      });
      expect(await repo.hold(EVENT, OTHER, due)).toMatchObject({
        held: false,
        current: { status: 'held', requestedBy: HOST },
      });
    });

    it('a cancelled hold can be requested again; a sent one cannot be cancelled', async () => {
      const due = new Date(Date.now() + 60 * 60 * 1000);
      await repo.hold(EVENT, HOST, due);
      expect(await repo.cancelHeld(EVENT)).toBe(true);
      expect(await repo.get(EVENT)).toMatchObject({ status: 'cancelled' });
      expect(await repo.cancelHeld(EVENT)).toBe(false);
      await expect(repo.claim(EVENT, HOST)).resolves.toEqual({ claimed: true });
      expect((await repo.get(EVENT))?.dueAt).toBeNull();
      await repo.finish(EVENT, 'sent');
      expect(await repo.cancelHeld(EVENT)).toBe(false);
    });

    it('the tick finds due holds and claims each once, never one not yet due or cancelled', async () => {
      const now = new Date();
      const past = new Date(now.getTime() - 60 * 1000);
      const future = new Date(now.getTime() + 60 * 60 * 1000);
      await repo.hold(EVENT, HOST, past);
      await repo.hold('2', HOST, future);
      await repo.hold('3', HOST, past);
      await repo.cancelHeld('3');
      expect((await repo.due(now)).map((a) => a.meetupEventId)).toEqual([
        EVENT,
      ]);
      const claims = await Promise.all([
        repo.claimHeld(EVENT, now),
        repo.claimHeld(EVENT, now),
      ]);
      // One per tick by default; more on request.
      expect(await repo.due(now, 5)).toHaveLength(0);
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(await repo.claimHeld('2', now)).toBe(false);
      expect(await repo.claimHeld('3', now)).toBe(false);
      expect(await repo.get(EVENT)).toMatchObject({ status: 'sending' });
      await repo.finish(EVENT, 'sent');
      expect(await repo.due(now)).toEqual([]);
    });

    it('otherTimes lists when others go or went out, not this one or old ones', async () => {
      const soon = new Date(Date.now() + 10 * 60 * 1000);
      await repo.hold(EVENT, HOST, soon);
      await repo.hold('2', HOST, soon);
      await repo.claim('3', HOST);
      await repo.finish('3', 'sent');
      await repo.claim('4', HOST);
      await repo.finish('4', 'failed', 'no');
      await repo.claim('5', HOST);
      await repo.finish('5', 'sent');
      await pool.query(
        `UPDATE event_announcements SET completed_at = now() - interval '2 hours'
          WHERE meetup_event_id = '5'`,
      );
      const since = new Date(Date.now() - 60 * 60 * 1000);
      const times = await repo.otherTimes(EVENT, since);
      expect(times).toHaveLength(2);
      expect(times.map((t) => t.getTime())).toContain(soon.getTime());
    });

    it('a recreation is claimed once, filled, and read back; a released claim can be taken again', async () => {
      const claims = await Promise.all([
        repo.claimRecreation(EVENT, HOST),
        repo.claimRecreation(EVENT, OTHER),
      ]);
      expect(claims.sort()).toEqual(['claimed', 'pending']);
      expect(await repo.recreationOf(EVENT)).toMatchObject({
        oldEventId: EVENT,
        newEventId: null,
      });
      await repo.fillRecreation(EVENT, '2');
      expect(await repo.recreationOf(EVENT)).toMatchObject({ newEventId: '2' });
      // Filled: done, never released.
      expect(await repo.claimRecreation(EVENT, OTHER)).toBe('done');
      await repo.releaseRecreation(EVENT, HOST);
      await repo.releaseRecreation(EVENT, OTHER);
      expect(await repo.recreationOf(EVENT)).toMatchObject({ newEventId: '2' });
      // Only its own maker releases an unfilled claim.
      expect(await repo.claimRecreation('3', HOST)).toBe('claimed');
      await repo.releaseRecreation('3', OTHER);
      expect(await repo.recreationOf('3')).toMatchObject({ requestedBy: HOST });
      await repo.releaseRecreation('3', HOST);
      expect(await repo.recreationOf('3')).toBeUndefined();
      expect(await repo.claimRecreation('3', HOST)).toBe('claimed');
      // A claim that never got its copy goes stale; it is never taken over.
      expect(await repo.claimRecreation('3', OTHER)).toBe('pending');
      await pool.query(
        `UPDATE event_recreations SET created_at = now() - interval '11 minutes'
          WHERE old_event_id = '3'`,
      );
      expect(await repo.claimRecreation('3', OTHER)).toBe('stale');
      expect(await repo.recreationOf('3')).toMatchObject({
        requestedBy: HOST,
        newEventId: null,
      });
      expect(await repo.recreationOf('9')).toBeUndefined();
      await expect(repo.claimRecreation('x', HOST)).rejects.toThrow(RangeError);
    });

    it('unclaim puts a tick’s sending row back on hold, not a click’s', async () => {
      const due = new Date(Date.now() - 60_000);
      await repo.hold(EVENT, HOST, due);
      expect(await repo.claimHeld(EVENT, new Date())).toBe(true);
      await repo.unclaim(EVENT);
      expect(await repo.get(EVENT)).toMatchObject({
        status: 'held',
        dueAt: due,
      });
      await repo.claim('2', HOST);
      await repo.unclaim('2');
      expect((await repo.get('2'))?.status).toBe('sending');
    });

    it('recentSends counts real sends only: sent at completed_at and sending, never held', async () => {
      const since = new Date(Date.now() - 60 * 60_000);
      // Held and an hour overdue: not a send.
      await repo.hold(EVENT, HOST, new Date(Date.now() - 30 * 60_000));
      expect(await repo.recentSends(since)).toEqual([]);
      await repo.claim('2', HOST);
      expect(await repo.recentSends(since)).toHaveLength(1);
      await repo.finish('2', 'sent');
      expect(await repo.recentSends(since)).toHaveLength(1);
      await repo.claim('3', HOST);
      await repo.finish('3', 'failed', 'no');
      expect(await repo.recentSends(since)).toHaveLength(1);
      expect(await repo.recentSends(new Date(Date.now() + 60_000))).toEqual([]);
    });

    it('otherTimes uses when a sent one actually went out, not when it was due', async () => {
      const due = new Date(Date.now() - 2 * 60 * 60_000);
      await repo.hold('2', HOST, due);
      await repo.claimHeld('2', new Date());
      await repo.finish('2', 'sent');
      const since = new Date(Date.now() - 60 * 60_000);
      const times = await repo.otherTimes(EVENT, since);
      expect(times).toHaveLength(1);
      expect(times[0].getTime()).toBeGreaterThan(since.getTime());
    });

    it('a table made before the hold column gains it and the new statuses', async () => {
      await pool.query('DROP TABLE event_announcements');
      await pool.query(`
        CREATE TABLE event_announcements (
          meetup_event_id TEXT PRIMARY KEY CHECK (meetup_event_id ~ '^[0-9]{1,20}$'),
          requested_by TEXT NOT NULL CHECK (requested_by ~ '^[1-9][0-9]{0,19}$'),
          status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed', 'unknown')),
          failure TEXT,
          requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          completed_at TIMESTAMPTZ
        )`);
      await ensureEventAnnouncementSchema(pool);
      await expect(
        repo.hold(EVENT, HOST, new Date(Date.now() + 60_000)),
      ).resolves.toEqual({ held: true });
    });

    it('refuses a bad event or member id', async () => {
      await expect(repo.claim('abc', HOST)).rejects.toThrow(RangeError);
      await expect(repo.claim(EVENT, 'nobody')).rejects.toThrow();
    });
  },
);
