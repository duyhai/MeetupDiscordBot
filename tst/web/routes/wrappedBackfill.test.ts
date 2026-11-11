/* eslint-disable @typescript-eslint/no-unsafe-assignment -- expect.objectContaining() matchers */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LogEntry } from '../../../src/lib/helpers/discordLogger.js';
import { BackfillRun } from '../../../src/lib/repositories/postgresWrappedBackfillRepository.js';
import {
  DashboardPageDeps,
  registerAllProtectedRoutes,
} from '../../../src/web/routes/dashboardPages.js';
import { renderHomeReports } from '../../../src/web/routes/home.js';
import {
  BACKFILL_NOTICES,
  WRAPPED_BACKFILL_PATH,
  WrappedBackfillControl,
} from '../../../src/web/routes/wrappedBackfill.js';
import {
  Client,
  ORIGIN,
  USER,
  closeServers,
  makeApp,
  signIn,
} from '../dashboardHarness.js';
import { fakeOrganizerDeps, fakePageDeps } from './pageFakes.js';

afterEach(closeServers);

const finished: BackfillRun = {
  id: 7,
  trigger: 'job',
  startedAt: new Date('2026-12-09T20:00:00Z'),
  finishedAt: new Date('2026-12-09T21:30:00Z'),
  membersTotal: 240,
  membersDone: 240,
  built: 600,
  skipped: 300,
  failed: 2,
  cursor: '9',
};

const open: BackfillRun = {
  id: 8,
  trigger: '200000000000000001',
  startedAt: new Date('2026-12-10T19:00:00Z'),
  finishedAt: undefined,
  membersTotal: 240,
  membersDone: 96,
  built: 150,
  skipped: 130,
  failed: 1,
  cursor: '5',
};

function control(
  overrides: Partial<WrappedBackfillControl> = {},
): WrappedBackfillControl {
  return {
    status: vi.fn(async () => ({
      lastRun: undefined,
      openRun: undefined,
      queueLength: 0,
      nextTickAt: undefined,
    })),
    runNow: vi.fn(async () => 'requested' as const),
    ...overrides,
  };
}

/** Markup whitespace collapsed, so assertions read the sentence, not the formatting. */
const render = async (
  wrappedBackfill: WrappedBackfillControl,
  view: { csrfToken?: string; backfillNotice?: unknown } = {
    csrfToken: 'tok',
  },
) =>
  (await renderHomeReports(fakePageDeps({ wrappedBackfill }), view)).value
    .replace(/\s+/g, ' ')
    .replace(/> </g, '><');

describe('Home Wrapped backfill card', () => {
  it('with no run yet, says so and offers Run now to leadership', async () => {
    const out = await render(control());
    expect(out).toContain('<h2>Wrapped backfill</h2>');
    expect(out).toContain('No run yet.');
    expect(out).toContain('Queue: 0');
    expect(out).toContain(`action="${WRAPPED_BACKFILL_PATH}"`);
    expect(out).toContain('name="_csrf" value="tok"');
    expect(out).toContain('>Run now</button>');
    expect(out).toContain('1.5 Leadership Team only');
  });

  it('shows the last finished run and the next tick', async () => {
    const out = await render(
      control({
        status: async () => ({
          lastRun: finished,
          openRun: undefined,
          queueLength: 3,
          nextTickAt: new Date('2026-12-10T20:05:00Z'),
        }),
      }),
    );
    expect(out).toContain('Last run finished Dec 9, 2026 1:30 PM Pacific');
    expect(out).toContain('240 members: built 600, skipped 300, failed 2');
    expect(out).toContain('Queue: 3');
    expect(out).toContain('Next tick: 12:05 PM Pacific');
    expect(out).toContain('Run now');
  });

  it('shows an open run’s progress and no Run now button', async () => {
    const out = await render(
      control({
        status: async () => ({
          lastRun: finished,
          openRun: open,
          queueLength: 0,
          nextTickAt: new Date('2026-12-10T20:05:00Z'),
        }),
      }),
    );
    expect(out).toContain('Running: 96 of 240 members');
    expect(out).toContain('built 150, skipped 130, failed 1');
    expect(out).toContain('started Dec 10, 2026 11:00 AM Pacific');
    expect(out).not.toContain('Run now');
  });

  it('renders a known notice code and nothing for an unknown one', async () => {
    const out = await render(control(), {
      csrfToken: 'tok',
      backfillNotice: 'requested',
    });
    expect(out).toContain(BACKFILL_NOTICES.requested);
    const none = await render(control(), {
      csrfToken: 'tok',
      backfillNotice: '<script>alert(1)</script>',
    });
    expect(none).not.toContain('<script>');
    expect(none).not.toContain('alert(1)');
  });

  it('a failing status degrades the card alone, with no error text', async () => {
    const out = await render(
      control({
        status: async () => {
          throw new Error('secret');
        },
      }),
    );
    expect(out).toContain('Unavailable right now.');
    expect(out).not.toContain('secret');
    expect(out).toContain('identity changes in the last 7 days');
  });

  it('without a CSRF token (a bare render) there is no form', async () => {
    const out = await render(control(), {});
    expect(out).not.toContain(`action="${WRAPPED_BACKFILL_PATH}"`);
    expect(out).toContain('No run yet.');
  });
});

async function setup(overrides: Partial<WrappedBackfillControl> = {}) {
  const isLeadership = vi.fn<(id: string) => Promise<boolean>>();
  const audit = vi.fn<(entry: LogEntry) => Promise<unknown>>(async () => true);
  const runNow = vi.fn(async (_by: string) => 'requested' as const);
  const wrappedBackfill = control({ runNow, ...overrides });
  const pages = fakePageDeps({ isLeadership, audit, wrappedBackfill });
  const { req } = await makeApp({
    audit,
    protectedRoutes: (r) =>
      registerAllProtectedRoutes(r, { organizer: fakeOrganizerDeps(), pages }),
    homeReports: (view) => renderHomeReports(pages, view),
  });
  return { req, isLeadership, audit, runNow };
}

async function tokenOf(req: Client, cookie: string): Promise<string> {
  const page = await req.get('/dashboard').set('Cookie', cookie);
  expect(page.status).toBe(200);
  return /name="_csrf" value="([^"]+)"/.exec(page.text)?.[1] ?? '';
}

async function pressRunNow(req: Client, cookie: string) {
  return req
    .post(WRAPPED_BACKFILL_PATH)
    .set('Cookie', cookie)
    .set('Origin', ORIGIN)
    .type('form')
    .send({ _csrf: await tokenOf(req, cookie) });
}

describe('POST /dashboard/wrapped/backfill/run', () => {
  it('needs the 1.5 Leadership Team role, checked live', async () => {
    const { req, isLeadership, runNow } = await setup();
    isLeadership.mockResolvedValue(false);
    const res = await pressRunNow(req, await signIn(req));
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/dashboard?backfill=not-leadership');
    expect(isLeadership).toHaveBeenCalledWith(USER.id);
    expect(runNow).not.toHaveBeenCalled();
  });

  it('Leadership asks for a run; the outcome comes back as a notice, audited', async () => {
    const { req, isLeadership, runNow, audit } = await setup();
    isLeadership.mockResolvedValue(true);
    const cookie = await signIn(req);
    const res = await pressRunNow(req, cookie);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/dashboard?backfill=requested');
    expect(runNow).toHaveBeenCalledWith(USER.id);
    const home = await req
      .get('/dashboard?backfill=requested')
      .set('Cookie', cookie);
    expect(home.text).toContain(BACKFILL_NOTICES.requested);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Wrapped backfill requested',
        description: expect.stringContaining(`<@${USER.id}>`),
      }),
    );
  });

  it("Run now during a run is 'already running'", async () => {
    const { req, isLeadership, audit } = await setup({
      runNow: async () => 'already-running',
    });
    isLeadership.mockResolvedValue(true);
    const res = await pressRunNow(req, await signIn(req));
    expect(res.headers.location).toBe('/dashboard?backfill=already-running');
    expect(audit).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Wrapped backfill requested' }),
    );
  });

  it('a Discord outage on the role check is "unavailable", nothing requested', async () => {
    const { req, isLeadership, runNow } = await setup();
    isLeadership.mockRejectedValue(new Error('gateway down'));
    const res = await pressRunNow(req, await signIn(req));
    expect(res.headers.location).toBe('/dashboard?backfill=unavailable');
    expect(runNow).not.toHaveBeenCalled();
  });
});
