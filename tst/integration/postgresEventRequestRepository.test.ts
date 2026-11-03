import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
