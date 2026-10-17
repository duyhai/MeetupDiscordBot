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

import { LogEntry } from '../../src/lib/helpers/discordLogger.js';
import { Period } from '../../src/lib/reports/period.js';
import {
  ensureWorkspaceSchema,
  PostgresNoShowWorkspaceRepository,
} from '../../src/lib/repositories/postgresNoShowWorkspaceRepository.js';
import {
  leadershipRefusalEntry,
  performWorkspaceAction,
} from '../../src/lib/workspace/service.js';
import { WorkspaceAction } from '../../src/lib/workspace/types.js';
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

if (!POSTGRES_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    'Skipping workspace action route integration tests: set DATABASE_URL to a reachable Postgres to run them.',
  );
}

const SEPTEMBER: Period = { year: 2026, month: 9 };
const MEMBER = '222';
const MONTH = '/dashboard/no-shows/2026-09';

/**
 * The real route, service and repository on an isolated schema; only
 * Discord is faked (the live Leadership check and the moderation log).
 */
(POSTGRES_AVAILABLE ? describe : describe.skip)(
  'workspace action routes on Postgres',
  () => {
    let schema: { drop(): Promise<void> };
    let pool: pg.Pool;
    let repo: PostgresNoShowWorkspaceRepository;

    const count = async (table: string): Promise<number> =>
      (
        await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${table}`,
        )
      ).rows[0].n;

    const rowState = async (id: number) =>
      (
        await pool.query<{
          status: string;
          version: number;
          suspension_record_id: number | null;
        }>(
          'SELECT status, version, suspension_record_id FROM noshow_workspace_rows WHERE id = $1',
          [id],
        )
      ).rows[0];

    const liveSuspensions = async (): Promise<number> =>
      (
        await pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM suspension_records WHERE voided_at IS NULL',
        )
      ).rows[0].n;

    beforeAll(async () => {
      // Before any pool exists, so every write lands in the isolated schema.
      schema = await useIsolatedSchema('workspace_routes');
      pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        max: 3,
      });
      await ensureWorkspaceSchema(pool);
    });

    beforeEach(async () => {
      await pool.query(
        `TRUNCATE noshow_workspace_events, noshow_workspace_rows,
           noshow_workspace_months, suspension_records RESTART IDENTITY CASCADE`,
      );
      repo = new PostgresNoShowWorkspaceRepository(pool);
      await repo.syncFromSnapshot({
        period: SEPTEMBER,
        snapshotId: 1,
        snapshotBuiltAt: new Date('2026-10-01T15:00:00Z'),
        cases: [
          {
            memberId: MEMBER,
            memberName: 'Test Member',
            classification: 'suspension',
          },
        ],
      });
    });

    afterEach(closeServers);

    afterAll(async () => {
      await pool?.end();
      await schema?.drop();
    });

    const rowId = async (): Promise<number> =>
      (
        await pool.query<{ id: number }>(
          'SELECT id FROM noshow_workspace_rows WHERE meetup_member_id = $1',
          [MEMBER],
        )
      ).rows[0].id;

    async function setup(leader: () => Promise<boolean>) {
      const isLeadership = vi.fn<(id: string) => Promise<boolean>>(leader);
      const moderationLog = vi.fn<(entry: LogEntry) => Promise<unknown>>(
        async () => true,
      );
      const serviceDeps = {
        now: () => PAGE_NOW,
        repository: async () => repo,
        moderationLog,
      };
      const { req } = await makeApp({
        now: () => PAGE_NOW.getTime(),
        protectedRoutes: (r) =>
          registerAllProtectedRoutes(r, {
            organizer: fakeOrganizerDeps(),
            pages: fakePageDeps({
              isLeadership,
              workspaceActions: {
                perform: (input) => performWorkspaceAction(serviceDeps, input),
                sync: vi.fn(),
                moderationLog,
              },
            }),
          }),
      });
      const cookie = await signIn(req);
      const token = await tokenOf(req, cookie);
      const id = await rowId();
      const post = (action: WorkspaceAction, body: Record<string, string>) =>
        req
          .post(`${MONTH}/rows/${id}`)
          .set('Cookie', cookie)
          .set('Origin', ORIGIN)
          .type('form')
          .send({ _csrf: token, action, ...body });
      return { id, post, isLeadership, moderationLog };
    }

    async function tokenOf(req: Client, cookie: string): Promise<string> {
      const home = await req.get('/dashboard').set('Cookie', cookie);
      return /name="_csrf" value="([^"]+)"/.exec(home.text)?.[1] ?? '';
    }

    const settle = () =>
      new Promise((resolve) => {
        setImmediate(resolve);
      });

    const record = { version: '1', confirm: 'yes', date: '2026-09-15' };
    const yes = async () => true;
    const no = async () => false;

    it('Leadership records a suspension: 303 and a suspension row', async () => {
      const { id, post, isLeadership, moderationLog } = await setup(yes);
      const res = await post('record_suspension', record);
      expect(res.status).toBe(303);
      expect(res.headers.location).toBe(`${MONTH}?result=done`);
      expect(isLeadership).toHaveBeenCalledWith(USER.id);
      expect(await count('suspension_records')).toBe(1);
      expect(await rowState(id)).toMatchObject({
        status: 'suspended',
        version: 2,
        suspension_record_id: 1,
      });
      // sync_created, then the recording.
      expect(await count('noshow_workspace_events')).toBe(2);
      await settle();
      expect(moderationLog).toHaveBeenCalledTimes(1);
      expect(moderationLog.mock.calls[0][0].title).toBe(
        'No-show workspace: Suspension recorded',
      );
    });

    it('a Moderator records: refused, no row, no transition, no event, refusal logged', async () => {
      const { id, post, moderationLog } = await setup(no);
      const res = await post('record_suspension', record);
      expect(res.status).toBe(303);
      expect(res.headers.location).toBe(`${MONTH}?result=not-leadership`);
      expect(await count('suspension_records')).toBe(0);
      expect(await rowState(id)).toMatchObject({ status: 'new', version: 1 });
      expect(await count('noshow_workspace_events')).toBe(1);
      await settle();
      expect(moderationLog).toHaveBeenCalledTimes(1);
      expect(moderationLog).toHaveBeenCalledWith(
        leadershipRefusalEntry(
          SEPTEMBER,
          id,
          'record_suspension',
          USER.id,
          'not-leadership',
        ),
      );
    });

    it('a Moderator links: refused, nothing linked, no event', async () => {
      const existing = (
        await pool.query<{ id: number }>(
          `INSERT INTO suspension_records (member_id, member_name, suspended_at, duration_days)
           VALUES ($1, 'Test Member', '2026-09-20T00:00:00Z', 30) RETURNING id`,
          [MEMBER],
        )
      ).rows[0].id;
      const { id, post, moderationLog } = await setup(no);
      const res = await post('link_suspension', {
        version: '1',
        recordId: String(existing),
      });
      expect(res.headers.location).toBe(`${MONTH}?result=not-leadership`);
      expect(await rowState(id)).toMatchObject({
        status: 'new',
        version: 1,
        suspension_record_id: null,
      });
      expect(await count('noshow_workspace_events')).toBe(1);
      await settle();
      expect(moderationLog.mock.calls[0][0]).toEqual(
        leadershipRefusalEntry(
          SEPTEMBER,
          id,
          'link_suspension',
          USER.id,
          'not-leadership',
        ),
      );
    });

    it('a Moderator voids: refused, the suspension stays live, no event', async () => {
      let leader = true;
      const { id, post, isLeadership, moderationLog } = await setup(
        async () => leader,
      );
      expect((await post('record_suspension', record)).headers.location).toBe(
        `${MONTH}?result=done`,
      );
      // The role removed between the page load and this POST.
      leader = false;
      const res = await post('void', { version: '2', note: 'recorded twice' });
      expect(res.headers.location).toBe(`${MONTH}?result=not-leadership`);
      expect(isLeadership).toHaveBeenCalledTimes(2);
      expect(await liveSuspensions()).toBe(1);
      expect(await rowState(id)).toMatchObject({
        status: 'suspended',
        version: 2,
      });
      expect(await count('noshow_workspace_events')).toBe(2);
      await settle();
      expect(moderationLog).toHaveBeenLastCalledWith(
        leadershipRefusalEntry(
          SEPTEMBER,
          id,
          'void',
          USER.id,
          'not-leadership',
        ),
      );
    });

    it('Discord unreachable: refused, nothing written', async () => {
      const { id, post, moderationLog } = await setup(async () => {
        throw new Error('gateway down');
      });
      const res = await post('record_suspension', record);
      expect(res.headers.location).toBe(
        `${MONTH}?result=leadership-unavailable`,
      );
      expect(await count('suspension_records')).toBe(0);
      expect(await rowState(id)).toMatchObject({ status: 'new', version: 1 });
      expect(await count('noshow_workspace_events')).toBe(1);
      await settle();
      expect(moderationLog).toHaveBeenCalledWith(
        leadershipRefusalEntry(
          SEPTEMBER,
          id,
          'record_suspension',
          USER.id,
          'discord-unreachable',
        ),
      );
    });

    it('a Moderator can still hold a card, without a Discord role check', async () => {
      const { id, post, isLeadership } = await setup(no);
      const res = await post('hold', { version: '1', note: 'travelling' });
      expect(res.headers.location).toBe(`${MONTH}?result=done`);
      expect(await rowState(id)).toMatchObject({
        status: 'on_hold',
        version: 2,
      });
      expect(isLeadership).not.toHaveBeenCalled();
    });

    it('a stale version is 409 and writes nothing', async () => {
      const { id, post } = await setup(no);
      const res = await post('hold', { version: '7', note: 'travelling' });
      expect(res.status).toBe(409);
      expect(res.text).toContain('Someone just updated this card');
      expect(await rowState(id)).toMatchObject({ status: 'new', version: 1 });
      expect(await count('noshow_workspace_events')).toBe(1);
    });

    it('already-suspended without a record to link redirects as an overlap', async () => {
      // A live suspension from August overlapping September 15, linked to no card.
      await pool.query(
        `INSERT INTO suspension_records (member_id, member_name, suspended_at, duration_days)
         VALUES ($1, 'Test Member', '2026-08-20T00:00:00Z', 60)`,
        [MEMBER],
      );
      const { post } = await setup(yes);
      const res = await post('record_suspension', record);
      expect(res.headers.location).toBe(`${MONTH}?result=suspension-overlap`);
      expect(await count('suspension_records')).toBe(1);
    });

    it('already-suspended with a record in the month offers the link', async () => {
      await pool.query(
        `INSERT INTO suspension_records (member_id, member_name, suspended_at, duration_days)
         VALUES ($1, 'Test Member', '2026-09-03T00:00:00Z', 30)`,
        [MEMBER],
      );
      const { post } = await setup(yes);
      const res = await post('record_suspension', record);
      expect(res.headers.location).toBe(`${MONTH}?result=already-suspended`);
      expect(await count('suspension_records')).toBe(1);
    });
  },
);
