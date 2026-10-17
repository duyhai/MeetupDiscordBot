import { Logger } from 'tslog';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LogEntry } from '../../../src/lib/helpers/discordLogger.js';
import { workspaceRowPath } from '../../../src/lib/reports/dashboardPaths.js';
import { Period } from '../../../src/lib/reports/period.js';
import {
  WorkspaceActionInput,
  WorkspaceActionResult,
  WorkspaceSyncCode,
  leadershipRefusalEntry,
} from '../../../src/lib/workspace/service.js';
import { LEADERSHIP_ONLY_ACTIONS } from '../../../src/lib/workspace/transitions.js';
import {
  NOTES_MAX,
  VOID_REASON_MAX,
  WORKSPACE_ACTIONS,
  WorkspaceAction,
} from '../../../src/lib/workspace/types.js';
import {
  createDashboardRouter,
  protectedRouteList,
} from '../../../src/web/dashboardRouter.js';
import { escapeHtml } from '../../../src/web/html.js';
import { parseRowId, parseWorkspaceMonth } from '../../../src/web/pageKit.js';
import { FixedWindowLimiter } from '../../../src/web/rateLimit.js';
import { registerAllProtectedRoutes } from '../../../src/web/routes/dashboardPages.js';
import {
  WORKSPACE_REFUSAL_POST_WINDOW_MS,
  WORKSPACE_RESULT_MESSAGES,
  workspaceResultNotice,
} from '../../../src/web/routes/workspaceActions.js';
import {
  Client,
  ORIGIN,
  USER,
  closeServers,
  makeApp,
  makeDeps,
  signIn,
} from '../dashboardHarness.js';
import {
  PAGE_NOW,
  SEPT,
  fakeOrganizerDeps,
  fakePageDeps,
} from './pageFakes.js';

afterEach(() => {
  vi.restoreAllMocks();
  return closeServers();
});

const ROW = '/dashboard/no-shows/2026-09/rows/1';
const SYNC = '/dashboard/no-shows/2026-09/sync';
const MONTH = '/dashboard/no-shows/2026-09';

type Perform = (input: WorkspaceActionInput) => Promise<WorkspaceActionResult>;
type Sync = (period: Period) => Promise<WorkspaceSyncCode>;

async function setup(
  options: {
    perform?: Perform;
    sync?: Sync;
    leader?: boolean | Error;
    actionLimiter?: FixedWindowLimiter;
  } = {},
) {
  const perform = vi.fn<Perform>(
    options.perform ?? (async () => ({ code: 'done' })),
  );
  const sync = vi.fn<Sync>(options.sync ?? (async () => 'synced'));
  const moderationLog = vi.fn<(entry: LogEntry) => Promise<unknown>>(
    async () => true,
  );
  const isLeadership = vi.fn<(id: string) => Promise<boolean>>(async () => {
    if (options.leader instanceof Error) {
      throw options.leader;
    }
    return options.leader ?? false;
  });
  let clock = PAGE_NOW.getTime();
  const { req } = await makeApp({
    now: () => clock,
    actionLimiter: options.actionLimiter,
    protectedRoutes: (r) =>
      registerAllProtectedRoutes(r, {
        organizer: fakeOrganizerDeps(),
        pages: fakePageDeps({
          now: () => new Date(clock),
          isLeadership,
          workspaceActions: { perform, sync, moderationLog },
        }),
      }),
  });
  const cookie = await signIn(req);
  const token = await tokenOf(req, cookie);
  const post = (path: string, body: Record<string, string> = {}) =>
    req
      .post(path)
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: token, ...body });
  /** A raw urlencoded body, for repeated fields. */
  const postRaw = (path: string, body: string) =>
    req
      .post(path)
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .type('form')
      .send(`_csrf=${encodeURIComponent(token)}&${body}`);
  return {
    req,
    perform,
    sync,
    moderationLog,
    isLeadership,
    post,
    postRaw,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

async function tokenOf(req: Client, cookie: string): Promise<string> {
  const home = await req.get('/dashboard').set('Cookie', cookie);
  const match = /name="_csrf" value="([^"]+)"/.exec(home.text);
  if (!match) {
    throw new Error('home page has no CSRF field');
  }
  return match[1];
}

/** Lets a fire-and-forget post settle. */
const settle = () =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

const location = (res: { headers: Record<string, unknown> }) =>
  res.headers.location as string | undefined;

const MODERATOR_ACTIONS = WORKSPACE_ACTIONS.filter(
  (a) => !LEADERSHIP_ONLY_ACTIONS.includes(a),
);

/** A form a Leadership-only action would send from the page. */
const leadershipForm = (action: WorkspaceAction): Record<string, string> => ({
  action,
  version: '1',
  ...(action === 'record_suspension' && {
    confirm: 'yes',
    date: '2026-09-15',
  }),
  ...(action === 'link_suspension' && { recordId: '7' }),
  ...(action === 'void' && { note: 'recorded twice' }),
});

describe('workspace action routes', () => {
  it('both workspace POST routes are on the protected router', () => {
    const { deps } = makeDeps();
    const router = createDashboardRouter({
      ...deps,
      protectedRoutes: (r) =>
        registerAllProtectedRoutes(r, {
          organizer: fakeOrganizerDeps(),
          pages: fakePageDeps(),
        }),
    });
    const labels = protectedRouteList(router).map(
      (r) => `${r.method.toUpperCase()} ${r.path}`,
    );
    expect(labels).toContain('POST /no-shows/:period/rows/:rowId');
    expect(labels).toContain('POST /no-shows/:period/sync');
  });

  it('a done action redirects back to the month with result=done', async () => {
    const { post, perform } = await setup();
    const res = await post(ROW, { action: 'mark_sent', version: '3' });
    expect(res.status).toBe(303);
    expect(location(res)).toBe(`${MONTH}?result=done`);
    expect(perform).toHaveBeenCalledTimes(1);
    expect(perform.mock.calls[0][0]).toMatchObject({
      period: SEPT,
      rowId: 1,
      action: 'mark_sent',
      version: '3',
    });
  });

  it('stale version → 409 "someone just updated this, reload"', async () => {
    const { post, perform } = await setup({
      perform: async () => ({ code: 'stale' }),
    });
    const res = await post(ROW, { action: 'mark_sent', version: '1' });
    expect(res.status).toBe(409);
    expect(res.text).toContain('Someone just updated this card');
    expect(res.text).toContain(`href="${MONTH}"`);
    expect(perform).toHaveBeenCalledTimes(1);
  });

  it('a row that is not in the month → 404', async () => {
    const { post } = await setup({
      perform: async () => ({ code: 'not-found' }),
    });
    const res = await post(ROW, { action: 'mark_sent', version: '1' });
    expect(res.status).toBe(404);
  });

  it('record suspension needs the confirm step', async () => {
    const { post, perform } = await setup({ leader: true });
    const res = await post(ROW, {
      action: 'record_suspension',
      version: '1',
      date: '2026-09-15',
    });
    expect(res.status).toBe(303);
    expect(location(res)).toBe('/dashboard/no-shows/2026-09/rows/1/suspend');
    expect(perform).not.toHaveBeenCalled();
  });

  it('passes the signed-in user as the actor, never a form field', async () => {
    const { post, perform } = await setup();
    await post(ROW, {
      action: 'mark_sent',
      version: '1',
      actor: '999999999999999999',
    });
    expect(perform.mock.calls[0][0].actor).toBe(USER.id);
  });

  it('passes the raw form fields and drops repeated ones', async () => {
    const { postRaw, perform } = await setup();
    await postRaw(ROW, 'action=hold&version=2&note=a&note=b');
    expect(perform).toHaveBeenCalledTimes(1);
    expect(perform.mock.calls[0][0]).toMatchObject({
      action: 'hold',
      version: '2',
      note: undefined,
    });
  });

  it('a repeated action field is invalid and performs nothing', async () => {
    const { postRaw, perform } = await setup({ leader: true });
    const res = await postRaw(ROW, 'action=hold&action=void&version=2');
    expect(location(res)).toBe(`${MONTH}?result=invalid`);
    expect(perform).not.toHaveBeenCalled();
  });

  it.each([
    ['no action', {}],
    ['an unknown action', { action: 'delete', version: '1' }],
    ['no version', { action: 'hold', note: 'x' }],
    ['a signed version', { action: 'hold', version: '-1', note: 'x' }],
    ['a fractional version', { action: 'hold', version: '1.5', note: 'x' }],
    ['a padded version', { action: 'hold', version: ' 1', note: 'x' }],
    ['a ten-digit version', { action: 'hold', version: '1234567890' }],
  ])('%s → result=invalid, nothing performed', async (_name, body) => {
    const { post, perform } = await setup();
    const res = await post(ROW, body);
    expect(res.status).toBe(303);
    expect(location(res)).toBe(`${MONTH}?result=invalid`);
    expect(perform).not.toHaveBeenCalled();
  });

  it('a link with a non-digit record id is invalid, nothing performed', async () => {
    const { post, perform } = await setup({ leader: true });
    for (const recordId of ['', '7a', '-7', '1e3', '0x7']) {
      // eslint-disable-next-line no-await-in-loop -- one id at a time, so a failure names it
      const res = await post(ROW, {
        action: 'link_suspension',
        version: '1',
        recordId,
      });
      expect(location(res), recordId).toBe(`${MONTH}?result=invalid`);
    }
    expect(perform).not.toHaveBeenCalled();
  });

  it('a suspension date that is not YYYY-MM-DD → result=bad-date, nothing performed', async () => {
    const { post, perform } = await setup({ leader: true });
    for (const date of [
      '',
      '2026-9-15',
      '15/09/2026',
      '2026-09-15T00:00',
      '2026-02-30',
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one date at a time, so a failure names it
      const res = await post(ROW, {
        action: 'record_suspension',
        confirm: 'yes',
        version: '1',
        date,
      });
      expect(location(res), date).toBe(`${MONTH}?result=bad-date`);
    }
    expect(perform).not.toHaveBeenCalled();
  });

  it('the route refuses a date outside the month-to-today range, like the service', async () => {
    const { post, perform } = await setup({ leader: true });
    for (const date of ['2026-08-31', '2026-10-06']) {
      // eslint-disable-next-line no-await-in-loop -- one date at a time, so a failure names it
      const res = await post(ROW, {
        action: 'record_suspension',
        confirm: 'yes',
        version: '1',
        date,
      });
      expect(location(res), date).toBe(`${MONTH}?result=bad-date`);
    }
    expect(perform).not.toHaveBeenCalled();
  });

  it('a note over the limit → result=note-too-long, nothing performed', async () => {
    const { post, perform } = await setup({ leader: true });
    const long = await post(ROW, {
      action: 'hold',
      version: '1',
      note: 'x'.repeat(NOTES_MAX + 1),
    });
    expect(location(long)).toBe(`${MONTH}?result=note-too-long`);
    const longVoid = await post(ROW, {
      action: 'void',
      version: '1',
      note: 'x'.repeat(VOID_REASON_MAX + 1),
    });
    expect(location(longVoid)).toBe(`${MONTH}?result=note-too-long`);
    expect(perform).not.toHaveBeenCalled();
    // At the limit (counted in code points, after trimming) it goes through.
    await post(ROW, {
      action: 'hold',
      version: '1',
      // 3000 UTF-16 units, 2000 code points (the body limit is 16 kB).
      note: ` ${'😀'.repeat(NOTES_MAX / 2)}${'x'.repeat(NOTES_MAX / 2)} `,
    });
    expect(perform).toHaveBeenCalledTimes(1);
  });

  const REDIRECT_CODES = Object.keys(WORKSPACE_RESULT_MESSAGES).filter(
    (c) =>
      ![
        'not-leadership',
        'leadership-unavailable',
        'already-suspended',
        'suspension-overlap',
        'error',
        'synced',
        'current',
        'older',
        'no-report',
        'malformed',
        'not-eligible',
      ].includes(c),
  );

  it.each(REDIRECT_CODES)(
    'refusal %s redirects with that fixed result code',
    async (code) => {
      const { post } = await setup({
        perform: async () => ({ code }) as WorkspaceActionResult,
      });
      const res = await post(ROW, { action: 'hold', version: '1', note: 'x' });
      expect(res.status).toBe(303);
      expect(location(res)).toBe(`${MONTH}?result=${code}`);
    },
  );

  it('already-suspended has two shapes, each with its own fixed code', async () => {
    const withExisting = await setup({
      leader: true,
      perform: async () => ({
        code: 'already-suspended',
        existing: { id: 42, suspendedAt: new Date('2026-09-02T00:00:00Z') },
      }),
    });
    const offer = await withExisting.post(
      ROW,
      leadershipForm('record_suspension'),
    );
    // The record id is never echoed: the page finds the offer itself.
    expect(location(offer)).toBe(`${MONTH}?result=already-suspended`);
    const overlap = await setup({
      leader: true,
      perform: async () => ({ code: 'already-suspended' }),
    });
    const res = await overlap.post(ROW, leadershipForm('record_suspension'));
    expect(location(res)).toBe(`${MONTH}?result=suspension-overlap`);
    expect(WORKSPACE_RESULT_MESSAGES['already-suspended']).not.toBe(
      WORKSPACE_RESULT_MESSAGES['suspension-overlap'],
    );
  });

  it('an unknown code from the service redirects as error', async () => {
    const { post } = await setup({
      perform: async () =>
        ({ code: '<script>' }) as unknown as WorkspaceActionResult,
    });
    const res = await post(ROW, { action: 'hold', version: '1', note: 'x' });
    expect(location(res)).toBe(`${MONTH}?result=error`);
  });

  it('a service error redirects with result=error and logs the class name only', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const { post } = await setup({
      perform: async () => {
        throw new TypeError('secret detail 123456');
      },
    });
    const res = await post(ROW, { action: 'hold', version: '1', note: 'x' });
    expect(location(res)).toBe(`${MONTH}?result=error`);
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain('Dashboard workspace action failed: TypeError');
    expect(lines.join('\n')).not.toContain('secret detail');
  });

  it('bad period or row id → 404', async () => {
    const { post, perform } = await setup();
    const paths = [
      '/dashboard/no-shows/2026-08/rows/1',
      '/dashboard/no-shows/2013-02/rows/1',
      '/dashboard/no-shows/2026-11/rows/1',
      '/dashboard/no-shows/junk/rows/1',
      '/dashboard/no-shows/2026-9/rows/1',
      '/dashboard/no-shows/2026-09/rows/0',
      '/dashboard/no-shows/2026-09/rows/01',
      '/dashboard/no-shows/2026-09/rows/1e3',
      '/dashboard/no-shows/2026-09/rows/9999999999',
      '/dashboard/no-shows/2026-09/rows/-1',
    ];
    for (const path of paths) {
      // eslint-disable-next-line no-await-in-loop -- one path at a time, so a failure names it
      const res = await post(path, { action: 'hold', version: '1', note: 'x' });
      expect(res.status, path).toBe(404);
    }
    expect(perform).not.toHaveBeenCalled();
  });

  it('a month before the workspace (but a real dashboard month) is refused by the route', async () => {
    // monthPath allows 2013-03 to 2026-08; parseWorkspaceMonth does not.
    expect(() => workspaceRowPath({ year: 2026, month: 8 }, 1)).not.toThrow();
    const { post, perform, sync } = await setup();
    expect(
      (await post('/dashboard/no-shows/2026-08/rows/1', { action: 'hold' }))
        .status,
    ).toBe(404);
    expect((await post('/dashboard/no-shows/2026-08/sync')).status).toBe(404);
    expect(perform).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it('action rate limit: the third POST in a minute is 429', async () => {
    const { post, perform } = await setup({
      actionLimiter: new FixedWindowLimiter(2, 60_000),
    });
    const body = { action: 'mark_sent', version: '1' };
    expect((await post(ROW, body)).status).toBe(303);
    expect((await post(ROW, body)).status).toBe(303);
    const third = await post(ROW, body);
    expect(third.status).toBe(429);
    expect(perform).toHaveBeenCalledTimes(2);
  });

  it('sync posts redirect with the sync result', async () => {
    const synced = await setup();
    const res = await synced.post(SYNC);
    expect(res.status).toBe(303);
    expect(location(res)).toBe(`${MONTH}?result=synced`);
    expect(synced.sync).toHaveBeenCalledWith(SEPT);

    const noReport = await setup({ sync: async () => 'no-report' });
    expect(location(await noReport.post(SYNC))).toBe(
      `${MONTH}?result=no-report`,
    );

    const failing = await setup({
      sync: async () => {
        throw new Error('down');
      },
    });
    expect(location(await failing.post(SYNC))).toBe(`${MONTH}?result=error`);
  });

  it('a sync is open to moderators and never asks Discord', async () => {
    const { post, isLeadership, sync } = await setup({ leader: false });
    expect(location(await post(SYNC))).toBe(`${MONTH}?result=synced`);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(isLeadership).not.toHaveBeenCalled();
  });

  it('bad sync period → 404', async () => {
    const { post, sync } = await setup();
    for (const p of ['2026-11', 'junk', '2013-02', '2026-9']) {
      // eslint-disable-next-line no-await-in-loop -- one month at a time, so a failure names it
      const res = await post(`/dashboard/no-shows/${p}/sync`);
      expect(res.status, p).toBe(404);
    }
    expect(sync).not.toHaveBeenCalled();
  });
});

describe('Leadership-only workspace actions', () => {
  it.each(LEADERSHIP_ONLY_ACTIONS.map((a) => [a]))(
    '%s by Leadership: checked live, then performed',
    async (action) => {
      const { post, perform, isLeadership, moderationLog } = await setup({
        leader: true,
      });
      const res = await post(ROW, leadershipForm(action));
      expect(res.status).toBe(303);
      expect(location(res)).toBe(`${MONTH}?result=done`);
      expect(isLeadership).toHaveBeenCalledWith(USER.id);
      expect(perform).toHaveBeenCalledTimes(1);
      expect(perform.mock.calls[0][0].action).toBe(action);
      // The route's live check is passed on: one Discord call per request.
      expect(perform.mock.calls[0][0].leadershipConfirmed).toBe(true);
      expect(isLeadership).toHaveBeenCalledTimes(1);
      await settle();
      expect(moderationLog).not.toHaveBeenCalled();
    },
  );

  it.each(LEADERSHIP_ONLY_ACTIONS.map((a) => [a]))(
    '%s by a Moderator: refused, nothing performed, refusal logged without pings',
    async (action) => {
      const { post, perform, moderationLog } = await setup({ leader: false });
      const res = await post(ROW, leadershipForm(action));
      expect(res.status).toBe(303);
      expect(location(res)).toBe(`${MONTH}?result=not-leadership`);
      expect(perform).not.toHaveBeenCalled();
      await settle();
      expect(moderationLog).toHaveBeenCalledTimes(1);
      const entry = moderationLog.mock.calls[0][0];
      expect(entry).toEqual(
        leadershipRefusalEntry(SEPT, 1, action, USER.id, 'not-leadership'),
      );
      expect(JSON.stringify(entry)).not.toContain('<@&');
      expect(entry).not.toHaveProperty('content');
    },
  );

  it('a Moderator posting record without the confirm step is refused too', async () => {
    const { post, perform, moderationLog } = await setup({ leader: false });
    const res = await post(ROW, { action: 'record_suspension', version: '1' });
    expect(location(res)).toBe(`${MONTH}?result=not-leadership`);
    expect(perform).not.toHaveBeenCalled();
    await settle();
    expect(moderationLog).toHaveBeenCalledTimes(1);
  });

  it.each(LEADERSHIP_ONLY_ACTIONS.map((a) => [a]))(
    '%s when Discord cannot be reached: refused, nothing performed',
    async (action) => {
      const warn = vi.spyOn(Logger.prototype, 'warn');
      const { post, perform, moderationLog } = await setup({
        leader: new Error('gateway 123456 secret'),
      });
      const res = await post(ROW, leadershipForm(action));
      expect(res.status).toBe(303);
      expect(location(res)).toBe(`${MONTH}?result=leadership-unavailable`);
      expect(perform).not.toHaveBeenCalled();
      await settle();
      expect(moderationLog).toHaveBeenCalledWith(
        leadershipRefusalEntry(SEPT, 1, action, USER.id, 'discord-unreachable'),
      );
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain(
        'secret',
      );
    },
  );

  it('the role removed between page load and POST: refused', async () => {
    const { post, perform, isLeadership } = await setup({ leader: true });
    expect(location(await post(ROW, leadershipForm('void')))).toBe(
      `${MONTH}?result=done`,
    );
    // The role is taken away in Discord; the session still admits them (a Moderator too).
    isLeadership.mockResolvedValue(false);
    const res = await post(ROW, leadershipForm('void'));
    expect(location(res)).toBe(`${MONTH}?result=not-leadership`);
    expect(perform).toHaveBeenCalledTimes(1);
    expect(isLeadership).toHaveBeenCalledTimes(2);
  });

  it('refusal posts are throttled to one per user per minute; every refusal still redirects', async () => {
    const { post, perform, moderationLog, advance } = await setup({
      leader: false,
    });
    for (const action of LEADERSHIP_ONLY_ACTIONS) {
      // eslint-disable-next-line no-await-in-loop -- in order, so the first one is the one posted
      const res = await post(ROW, leadershipForm(action));
      expect(location(res), action).toBe(`${MONTH}?result=not-leadership`);
    }
    await settle();
    expect(moderationLog).toHaveBeenCalledTimes(1);
    expect(moderationLog.mock.calls[0][0]).toEqual(
      leadershipRefusalEntry(
        SEPT,
        1,
        'record_suspension',
        USER.id,
        'not-leadership',
      ),
    );
    advance(WORKSPACE_REFUSAL_POST_WINDOW_MS);
    expect(location(await post(ROW, leadershipForm('void')))).toBe(
      `${MONTH}?result=not-leadership`,
    );
    await settle();
    expect(moderationLog).toHaveBeenCalledTimes(2);
    expect(perform).not.toHaveBeenCalled();
  });

  it('a refusal log failure is swallowed: the refusal still answers', async () => {
    const { req } = await makeApp({
      now: () => PAGE_NOW.getTime(),
      protectedRoutes: (r) =>
        registerAllProtectedRoutes(r, {
          organizer: fakeOrganizerDeps(),
          pages: fakePageDeps({
            workspaceActions: {
              perform: vi.fn(),
              sync: vi.fn(),
              moderationLog: vi.fn(async () => {
                throw new Error('discord down');
              }),
            },
          }),
        }),
    });
    const cookie = await signIn(req);
    const token = await tokenOf(req, cookie);
    const res = await req
      .post(ROW)
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: token, ...leadershipForm('void') });
    expect(location(res)).toBe(`${MONTH}?result=not-leadership`);
    await settle();
  });

  it.each(MODERATOR_ACTIONS.map((a) => [a]))(
    '%s by a Moderator: performed without asking Discord',
    async (action) => {
      const { post, perform, isLeadership } = await setup({ leader: false });
      const res = await post(ROW, { action, version: '1', note: 'why' });
      expect(location(res)).toBe(`${MONTH}?result=done`);
      expect(perform).toHaveBeenCalledTimes(1);
      expect(perform.mock.calls[0][0].leadershipConfirmed).toBeUndefined();
      expect(isLeadership).not.toHaveBeenCalled();
    },
  );
});

describe('workspaceResultNotice', () => {
  it('renders fixed text for a known code', () => {
    for (const [code, text] of Object.entries(WORKSPACE_RESULT_MESSAGES)) {
      expect(String(workspaceResultNotice(code)), code).toContain(
        escapeHtml(text),
      );
    }
  });

  it('renders only known codes and never echoes the query', async () => {
    expect(workspaceResultNotice('<script>')).toBe('');
    expect(workspaceResultNotice(['done'])).toBe('');
    expect(workspaceResultNotice(undefined)).toBe('');
    expect(workspaceResultNotice('toString')).toBe('');
    expect(workspaceResultNotice('__proto__')).toBe('');
  });
});

describe('workspace route params', () => {
  it('parseRowId takes 1-9 digits, not 0 or a leading zero', () => {
    expect(parseRowId('1')).toBe(1);
    expect(parseRowId('999999999')).toBe(999_999_999);
    for (const bad of [
      '0',
      '01',
      '1e3',
      '-1',
      '1.0',
      '',
      ' 1',
      '1234567890',
      1,
    ]) {
      expect(parseRowId(bad), String(bad)).toBeUndefined();
    }
  });

  it('parseWorkspaceMonth is parseRouteMonth plus the workspace range', () => {
    expect(parseWorkspaceMonth('2026-09', PAGE_NOW)).toEqual(SEPT);
    expect(parseWorkspaceMonth('2026-10', PAGE_NOW)).toEqual({
      year: 2026,
      month: 10,
    });
    for (const bad of [
      '2026-08',
      '2013-02',
      '2026-11',
      '2026-9',
      'junk',
      202609,
    ]) {
      expect(parseWorkspaceMonth(bad, PAGE_NOW), String(bad)).toBeUndefined();
    }
  });

  it('workspaceRowPath builds the row and confirm paths', () => {
    expect(workspaceRowPath(SEPT, 12)).toBe(
      '/dashboard/no-shows/2026-09/rows/12',
    );
    expect(workspaceRowPath(SEPT, 12, 'suspend')).toBe(
      '/dashboard/no-shows/2026-09/rows/12/suspend',
    );
  });

  it('workspaceRowPath refuses a row id of 0, a fraction, 2^31 and a month before the group', () => {
    expect(() => workspaceRowPath(SEPT, 0)).toThrow(RangeError);
    expect(() => workspaceRowPath(SEPT, 1.5)).toThrow(RangeError);
    expect(() => workspaceRowPath(SEPT, 2 ** 31)).toThrow(RangeError);
    expect(() => workspaceRowPath(SEPT, Number.NaN)).toThrow(RangeError);
    expect(() => workspaceRowPath({ year: 2013, month: 2 }, 1)).toThrow(
      RangeError,
    );
    expect(workspaceRowPath(SEPT, 2 ** 31 - 1)).toBe(
      `/dashboard/no-shows/2026-09/rows/${2 ** 31 - 1}`,
    );
  });
});
