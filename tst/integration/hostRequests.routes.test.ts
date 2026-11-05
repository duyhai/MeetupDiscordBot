import pg from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  ExistingEvent,
  PUBLISH_FAILURES,
} from '../../src/lib/hosts/publishRequest.js';
import {
  EventRequest,
  NewEventRequest,
  PostgresEventRequestRepository,
  ensureEventRequestSchema,
} from '../../src/lib/repositories/postgresEventRequestRepository.js';
import { registerAllProtectedRoutes } from '../../src/web/routes/dashboardPages.js';
import {
  Client,
  ORIGIN,
  USER,
  closeServers,
  makeApp,
  signIn,
} from '../web/dashboardHarness.js';
import {
  PAGE_NOW,
  fakeOrganizerDeps,
  fakePageDeps,
} from '../web/routes/pageFakes.js';
import { useIsolatedSchema } from './isolatedSchema.js';

// Requires DATABASE_URL against a throwaway Postgres; skipped otherwise.
const POSTGRES_AVAILABLE = Boolean(process.env.DATABASE_URL);

const QUEUE = '/dashboard/hosts/requests';
const LEAD = '223456789012345678';
const EVENT: ExistingEvent = {
  id: '317000001',
  eventUrl: 'https://www.meetup.com/1-5genasians/events/317000001/',
};

const request = (): NewEventRequest => ({
  meetupMemberId: '4242',
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
  featuredPhotoId: null,
  venueId: null,
  howToFindUs: null,
});

/**
 * The real queue route and repository on an isolated schema; Discord (the
 * live Leadership check) and Meetup (the existing-event check) are faked.
 */
(POSTGRES_AVAILABLE ? describe : describe.skip)(
  'host request queue routes on Postgres',
  () => {
    let schema: { drop(): Promise<void> };
    let pool: pg.Pool;
    let repo: PostgresEventRequestRepository;

    const actions = async (id: string): Promise<string[]> =>
      (
        await pool.query<{ action: string }>(
          'SELECT action FROM event_request_events WHERE request_id = $1 ORDER BY id',
          [id],
        )
      ).rows.map((r) => r.action);

    /** A request that failed at its version 3, with or without its event recorded. */
    async function failedRequest(recorded: boolean): Promise<EventRequest> {
      const created = await repo.create(request());
      if (created === undefined) {
        throw new Error('no request');
      }
      await repo.startPublishing(created.id, 1, LEAD, ['pending']);
      let version = 2;
      if (recorded) {
        await repo.recordCreated(created.id, 2, EVENT.id, EVENT.eventUrl);
        version = 3;
      }
      const failed = await repo.finish(created.id, version, {
        status: 'failed',
        failure: recorded
          ? PUBLISH_FAILURES.rsvp(EVENT.eventUrl)
          : PUBLISH_FAILURES.createFailed,
      });
      if (failed === undefined) {
        throw new Error('not failed');
      }
      return failed;
    }

    async function setup(existing: ExistingEvent | Error | undefined) {
      const findExistingEvent = vi.fn(async () => {
        if (existing instanceof Error) {
          throw existing;
        }
        return existing;
      });
      const { req } = await makeApp({
        now: () => PAGE_NOW.getTime(),
        protectedRoutes: (r) =>
          registerAllProtectedRoutes(r, {
            organizer: fakeOrganizerDeps(),
            pages: fakePageDeps({
              isLeadership: async () => true,
              eventRequests: async () => repo,
              findExistingEvent,
            }),
          }),
      });
      const cookie = await signIn(req);
      const token = await tokenOf(req, cookie);
      const post = (path: string, body: Record<string, string>) =>
        req
          .post(path)
          .set('Cookie', cookie)
          .set('Origin', ORIGIN)
          .type('form')
          .send({ _csrf: token, ...body });
      return { post, findExistingEvent };
    }

    beforeAll(async () => {
      schema = await useIsolatedSchema('hostreq_routes');
      pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        max: 3,
      });
      await ensureEventRequestSchema(pool);
    });

    beforeEach(async () => {
      await pool.query(
        'TRUNCATE event_request_events, event_requests RESTART IDENTITY',
      );
      repo = new PostgresEventRequestRepository(pool);
    });

    afterEach(closeServers);

    afterAll(async () => {
      await pool.end();
      await schema.drop();
    });

    it('a failed request whose event Meetup has is not denied', async () => {
      const failed = await failedRequest(false);
      const { post } = await setup(EVENT);
      const res = await post(`${QUEUE}/${failed.id}/deny`, {
        version: String(failed.version),
        reason: 'No',
      });
      expect(res.headers.location).toBe(`${QUEUE}?result=deny-event-exists`);
      expect((await repo.get(failed.id))?.status).toBe('failed');
      expect(await actions(failed.id)).not.toContain('deny');
    });

    it('a failed request is not denied while Meetup cannot be asked', async () => {
      const failed = await failedRequest(false);
      const { post } = await setup(new Error('meetup down'));
      const res = await post(`${QUEUE}/${failed.id}/deny`, {
        version: String(failed.version),
        reason: 'No',
      });
      expect(res.headers.location).toBe(`${QUEUE}?result=deny-check-failed`);
      expect((await repo.get(failed.id))?.status).toBe('failed');
    });

    it('a failed request with nothing on Meetup is denied and logged', async () => {
      const failed = await failedRequest(false);
      const { post, findExistingEvent } = await setup(undefined);
      const res = await post(`${QUEUE}/${failed.id}/deny`, {
        version: String(failed.version),
        reason: 'Pick a new date',
      });
      expect(res.headers.location).toBe(`${QUEUE}?result=denied`);
      expect(findExistingEvent).toHaveBeenCalledOnce();
      expect(await repo.get(failed.id)).toMatchObject({
        status: 'denied',
        denyReason: 'Pick a new date',
        decidedBy: USER.id,
      });
      expect((await actions(failed.id)).at(-1)).toBe('deny');
    });

    it('Mark resolved publishes a failed request with its event, once', async () => {
      const failed = await failedRequest(true);
      const { post } = await setup(undefined);
      const res = await post(`${QUEUE}/${failed.id}/resolve`, {
        version: String(failed.version),
      });
      expect(res.headers.location).toBe(`${QUEUE}?result=resolved`);
      expect(await repo.get(failed.id)).toMatchObject({
        status: 'published',
        failure: null,
        meetupEventId: EVENT.id,
        decidedBy: USER.id,
      });
      expect((await actions(failed.id)).at(-1)).toBe('resolve');
      const again = await post(`${QUEUE}/${failed.id}/resolve`, {
        version: String(failed.version),
      });
      expect(again.status).toBe(409);
    });

    it('Mark resolved does nothing to a request with no event recorded', async () => {
      const failed = await failedRequest(false);
      const { post } = await setup(undefined);
      const res = await post(`${QUEUE}/${failed.id}/resolve`, {
        version: String(failed.version),
      });
      expect(res.status).toBe(409);
      expect((await repo.get(failed.id))?.status).toBe('failed');
    });
  },
);

async function tokenOf(req: Client, cookie: string): Promise<string> {
  const home = await req.get('/dashboard').set('Cookie', cookie);
  const match = /name="_csrf" value="([^"]+)"/.exec(home.text);
  if (!match) {
    throw new Error('home page has no CSRF field');
  }
  return match[1];
}
