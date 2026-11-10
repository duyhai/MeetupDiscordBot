import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { MEMBER_LOCK_CLASS } from '../../src/lib/repositories/dashboardPool.js';
import {
  ensureEventRequestSchema,
  NewEventRequest,
  PostgresEventRequestRepository,
} from '../../src/lib/repositories/postgresEventRequestRepository.js';
import { useIsolatedSchema } from './isolatedSchema.js';

// Requires DATABASE_URL against a throwaway Postgres; skipped otherwise.
const POSTGRES_AVAILABLE = Boolean(process.env.DATABASE_URL);

const LEAD = '223456789012345678';
const HOST = '4242';

const request = (over: Partial<NewEventRequest> = {}): NewEventRequest => ({
  meetupMemberId: HOST,
  discordUserId: '123456789012345678',
  hostName: 'Hana',
  tier: 'regular',
  kind: 'fresh',
  sourceEventId: null,
  title: 'Board game night',
  description: 'Bring a game.',
  startLocal: '2026-12-05T19:00',
  duration: 'PT2H',
  rsvpLimit: 12,
  guestLimit: 1,
  featuredPhotoId: 503707686,
  venueId: null,
  howToFindUs: null,
  ...over,
});

(POSTGRES_AVAILABLE ? describe : describe.skip)(
  'PostgresEventRequestRepository',
  () => {
    let schema: { drop(): Promise<void> };
    let pool: pg.Pool;
    let repo: PostgresEventRequestRepository;

    beforeAll(async () => {
      schema = await useIsolatedSchema('eventreq');
      pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        max: 4,
      });
      await ensureEventRequestSchema(pool);
      // Twice: the schema is idempotent.
      await ensureEventRequestSchema(pool);
    });

    beforeEach(async () => {
      await pool.query(
        'TRUNCATE event_request_events, event_requests RESTART IDENTITY',
      );
      repo = new PostgresEventRequestRepository(pool);
    });

    afterAll(async () => {
      await pool?.end();
      await schema?.drop();
    });

    const historyOf = async (id: string) =>
      (
        await pool.query<{ action: string; actor: string; version: number }>(
          'SELECT action, actor, version FROM event_request_events WHERE request_id = $1 ORDER BY id',
          [id],
        )
      ).rows;

    it('creates and reads back every field', async () => {
      const created = await repo.create(
        request({
          kind: 'copy',
          sourceEventId: '311111111',
          venueId: '27000001',
          howToFindUs: 'By the fountain',
        }),
      );
      expect(created).toMatchObject({
        status: 'pending',
        version: 1,
        kind: 'copy',
        sourceEventId: '311111111',
        featuredPhotoId: 503707686,
        venueId: '27000001',
        howToFindUs: 'By the fountain',
        meetupEventId: null,
      });
      expect(await repo.get(created.id)).toEqual(created);
      expect(await historyOf(created.id)).toEqual([
        { action: 'submit', actor: HOST, version: 1 },
      ]);
    });

    it('with maxPending, the count waits for a submit holding the host lock', async () => {
      // One request waiting, cap 2. Another submit holds the host's lock and
      // has inserted the second without committing yet: without the lock,
      // create would not see that row and would insert a third.
      const first = await repo.create(request({ submitToken: 'a'.repeat(16) }));
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
          MEMBER_LOCK_CLASS,
          `event-request:${HOST}`,
        ]);
        await holder.query(
          `INSERT INTO event_requests
             (meetup_member_id, discord_user_id, host_name, tier, kind,
              source_event_id, title, description, start_local, duration,
              rsvp_limit, guest_limit, featured_photo_id, venue_id,
              how_to_find_us, submit_token)
           SELECT meetup_member_id, discord_user_id, host_name, tier, kind,
                  source_event_id, title, description, start_local, duration,
                  rsvp_limit, guest_limit, featured_photo_id, venue_id,
                  how_to_find_us, $2
             FROM event_requests WHERE id = $1`,
          [first?.id, 'b'.repeat(16)],
        );
        let settled = false;
        const third = repo
          .create(request({ submitToken: 'c'.repeat(16) }), { maxPending: 2 })
          .finally(() => {
            settled = true;
          });
        await new Promise((resolve) => {
          setTimeout(resolve, 300);
        });
        expect(settled).toBe(false);
        await holder.query('COMMIT');
        await expect(third).resolves.toBe('full');
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM event_requests WHERE status = 'pending'`,
      );
      expect(Number(rows[0].n)).toBe(2);
    });

    it('ten submits at once with cap 2: exactly two are made', async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          repo.create(request({ submitToken: `${'t'.repeat(15)}${i}` }), {
            maxPending: 2,
          }),
        ),
      );
      expect(
        results.filter((r) => r !== 'full' && r !== undefined),
      ).toHaveLength(2);
    });

    it('at the cap, the same form sent again goes to its request, not "full"', async () => {
      const token = 'd'.repeat(16);
      await repo.create(request({ submitToken: token }), { maxPending: 1 });
      await expect(
        repo.create(request({ submitToken: token }), { maxPending: 1 }),
      ).resolves.toBeUndefined();
    });

    it('get refuses an id that cannot be a request id', async () => {
      expect(await repo.get('1; DROP TABLE x')).toBeUndefined();
      expect(await repo.get('0')).toBeUndefined();
      expect(await repo.get('999')).toBeUndefined();
    });

    it('two concurrent publishes at the same version: exactly one wins', async () => {
      const { id } = await repo.create(request());
      const results = await Promise.all([
        repo.startPublishing(id, 1, LEAD, ['pending']),
        repo.startPublishing(id, 1, '323456789012345678', ['pending']),
      ]);
      const winners = results.filter((r) => r !== undefined);
      expect(winners).toHaveLength(1);
      expect(winners[0]).toMatchObject({ status: 'publishing', version: 2 });
      expect(winners[0]?.decidedAt).toBeInstanceOf(Date);
    });

    it('refuses a stale version or a status outside from', async () => {
      const { id } = await repo.create(request());
      expect(await repo.startPublishing(id, 2, LEAD, ['pending'])).toBe(
        undefined,
      );
      expect(await repo.startPublishing(id, 1, LEAD, ['failed'])).toBe(
        undefined,
      );
      expect((await repo.get(id))?.status).toBe('pending');
    });

    it('a publishing row is retried only once it is stuck', async () => {
      const { id } = await repo.create(request());
      const started = await repo.startPublishing(id, 1, LEAD, ['pending']);
      expect(started?.version).toBe(2);
      const past = new Date(Date.now() - 60_000);
      expect(
        await repo.startPublishing(id, 2, LEAD, ['failed', 'publishing'], past),
      ).toBeUndefined();
      const future = new Date(Date.now() + 60_000);
      expect(
        await repo.startPublishing(
          id,
          2,
          LEAD,
          ['failed', 'publishing'],
          future,
        ),
      ).toMatchObject({ status: 'publishing', version: 3 });
      // Without stuckBefore, 'publishing' in from admits nothing.
      expect(
        await repo.startPublishing(id, 3, LEAD, ['failed', 'publishing']),
      ).toBeUndefined();
    });

    it('records the created event only while publishing, then finishes', async () => {
      const { id } = await repo.create(request());
      const url = 'https://www.meetup.com/g/events/317000001/';
      expect(await repo.recordCreated(id, 1, '317000001', url)).toBe(false);
      expect((await repo.get(id))?.meetupEventId).toBeNull();
      await repo.startPublishing(id, 1, LEAD, ['pending']);
      expect(await repo.recordCreated(id, 2, '317000001', url)).toBe(true);
      // Only once: a second event is never recorded over the first.
      expect(await repo.recordCreated(id, 3, '317000002', url)).toBe(false);
      const done = await repo.finish(id, 3, { status: 'published' });
      expect(done).toMatchObject({
        status: 'published',
        meetupEventId: '317000001',
        version: 4,
      });
      // A second finish changes nothing.
      expect(
        await repo.finish(id, 4, { status: 'failed', failure: 'late' }),
      ).toBeUndefined();
      expect(await historyOf(id)).toEqual([
        { action: 'submit', actor: HOST, version: 1 },
        { action: 'start_publishing', actor: LEAD, version: 2 },
        { action: 'created', actor: 'system', version: 3 },
        { action: 'published', actor: 'system', version: 4 },
      ]);
    });

    it('an overtaken publisher can neither record nor finish', async () => {
      const { id } = await repo.create(request());
      // A claims at version 2, stalls; B takes the stuck row over (version 3).
      await repo.startPublishing(id, 1, LEAD, ['pending']);
      const future = new Date(Date.now() + 60_000);
      const b = await repo.startPublishing(
        id,
        2,
        '323456789012345678',
        ['failed', 'publishing'],
        future,
      );
      expect(b?.version).toBe(3);
      const url = 'https://www.meetup.com/g/events/317000001/';
      expect(await repo.recordCreated(id, 2, '317000001', url)).toBe(false);
      expect(
        await repo.finish(id, 2, { status: 'failed', failure: 'A gave up' }),
      ).toBeUndefined();
      expect(await repo.recordCreated(id, 3, '317000002', url)).toBe(true);
      expect(await repo.finish(id, 4, { status: 'published' })).toMatchObject({
        status: 'published',
        meetupEventId: '317000002',
      });
    });

    it('a failure is stored (capped by characters) and can be retried', async () => {
      const { id } = await repo.create(request());
      await repo.startPublishing(id, 1, LEAD, ['pending']);
      const failed = await repo.finish(id, 2, {
        status: 'failed',
        failure: '🎲'.repeat(5000),
      });
      expect(Array.from(failed?.failure ?? '')).toHaveLength(1000);
      const retried = await repo.startPublishing(id, 3, LEAD, ['failed']);
      expect(retried).toMatchObject({ status: 'publishing', failure: null });
    });

    it('denies only a pending request at its version', async () => {
      const { id } = await repo.create(request());
      expect(await repo.deny(id, 2, LEAD, 'Too close')).toBeUndefined();
      const denied = await repo.deny(id, 1, LEAD, 'Too close to another event');
      expect(denied).toMatchObject({
        status: 'denied',
        denyReason: 'Too close to another event',
        decidedBy: LEAD,
      });
      expect(await repo.startPublishing(id, 2, LEAD, ['pending'])).toBe(
        undefined,
      );
    });

    it('a deny blocked by a row lock gives up within its lock timeout, writing nothing', async () => {
      const created = await repo.create(request());
      if (created === undefined) {
        throw new Error('no request');
      }
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(
          'SELECT id FROM event_requests WHERE id = $1 FOR UPDATE',
          [created.id],
        );
        const started = Date.now();
        await expect(
          repo.deny(created.id, 1, LEAD, 'Too close', { lockTimeoutMs: 200 }),
        ).rejects.toThrow();
        expect(Date.now() - started).toBeLessThan(3_000);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
      expect((await repo.get(created.id))?.status).toBe('pending');
    });

    it('a failed request with no event can be denied; one with an event cannot', async () => {
      const { id } = await repo.create(request());
      await repo.startPublishing(id, 1, LEAD, ['pending']);
      await repo.finish(id, 2, { status: 'failed', failure: 'No host.' });
      expect(await repo.deny(id, 3, LEAD, 'No longer a host')).toMatchObject({
        status: 'denied',
        denyReason: 'No longer a host',
        version: 4,
      });

      const other = await repo.create(request());
      await repo.startPublishing(other.id, 1, LEAD, ['pending']);
      await repo.recordCreated(other.id, 2, '317000001', 'https://x/');
      await repo.finish(other.id, 3, { status: 'failed', failure: 'RSVPs.' });
      expect(await repo.deny(other.id, 4, LEAD, 'No')).toBeUndefined();
      expect((await repo.get(other.id))?.status).toBe('failed');
    });

    it('a form token makes one request per host, however often it is sent', async () => {
      const token = 'form-token-0123456789';
      const first = await repo.create(request({ submitToken: token }));
      expect(first?.submitToken).toBe(token);
      const [a, b] = await Promise.all([
        repo.create(request({ submitToken: token })),
        repo.create(request({ submitToken: token })),
      ]);
      expect(a).toBeUndefined();
      expect(b).toBeUndefined();
      expect(await repo.findBySubmitToken(HOST, token)).toEqual(first);
      // Another host's form with the same token is its own request.
      const theirs = await repo.create(
        request({ meetupMemberId: '5151', submitToken: token }),
      );
      expect(theirs?.id).not.toBe(first?.id);
      expect(await repo.findBySubmitToken('9999', token)).toBeUndefined();
      expect(await repo.findBySubmitToken(HOST, 'bad token')).toBeUndefined();
      // Requests without a token are never merged.
      await repo.create(request());
      await repo.create(request());
      const { rows } = await pool.query<{ n: string }>(
        'SELECT count(*) AS n FROM event_requests',
      );
      expect(Number(rows[0].n)).toBe(4);
      expect(
        (
          await pool.query<{ n: string }>(
            "SELECT count(*) AS n FROM event_request_events WHERE action = 'submit'",
          )
        ).rows[0].n,
      ).toBe('4');
    });

    it('adds the token column to a table made before it', async () => {
      await pool.query('DROP INDEX event_requests_submit_token_idx');
      await pool.query('ALTER TABLE event_requests DROP COLUMN submit_token');
      await ensureEventRequestSchema(pool);
      const made = await repo.create(
        request({ submitToken: 'form-token-after-alter' }),
      );
      expect(made?.submitToken).toBe('form-token-after-alter');
      expect(
        await repo.create(request({ submitToken: 'form-token-after-alter' })),
      ).toBeUndefined();
    });

    it('the history is append-only', async () => {
      const { id } = await repo.create(request());
      await expect(
        pool.query('UPDATE event_request_events SET actor = $1', ['x']),
      ).rejects.toThrow(/append-only/);
      await expect(
        pool.query('DELETE FROM event_request_events WHERE request_id = $1', [
          id,
        ]),
      ).rejects.toThrow(/append-only/);
    });

    it('lists a member’s requests newest first, and by status oldest first', async () => {
      const a = await repo.create(request({ title: 'A' }));
      const b = await repo.create(request({ title: 'B' }));
      await repo.create(request({ meetupMemberId: '5555', title: 'Other' }));
      expect((await repo.listForMember(HOST)).map((r) => r.title)).toEqual([
        'B',
        'A',
      ]);
      expect(await repo.countPending(HOST)).toBe(2);
      await repo.deny(a.id, 1, LEAD, 'No');
      expect(
        (await repo.listByStatus(['pending'])).map((r) => r.title),
      ).toEqual(['B', 'Other']);
      expect((await repo.listDecided()).map((r) => r.id)).toEqual([a.id]);
      expect(b.id).not.toBe(a.id);
    });

    it('the database refuses values outside the rules', async () => {
      await expect(repo.create(request({ title: '' }))).rejects.toThrow();
      await expect(
        repo.create(request({ startLocal: '2026-12-05 19:00' })),
      ).rejects.toThrow();
      await expect(
        repo.create(request({ meetupMemberId: 'abc' })),
      ).rejects.toThrow();
    });
  },
);
