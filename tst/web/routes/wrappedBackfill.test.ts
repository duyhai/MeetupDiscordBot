/* eslint-disable @typescript-eslint/no-unsafe-assignment -- expect.objectContaining() matchers */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LogEntry } from '../../../src/lib/helpers/discordLogger.js';
import { SnapshotRun } from '../../../src/lib/repositories/postgresSnapshotRepository.js';
import { BackfillRun } from '../../../src/lib/repositories/postgresWrappedBackfillRepository.js';
import { registerAllProtectedRoutes } from '../../../src/web/routes/dashboardPages.js';
import { renderSettingsCards } from '../../../src/web/routes/home.js';
import {
  BACKFILL_NOTICES,
  SNAPSHOT_REFRESH_PATH,
  WRAPPED_BACKFILL_PATH,
  WRAPPED_REBUILD_PATH,
  WrappedBackfillControl,
  parseRebuild,
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
  requests: 1830,
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
  requests: 410,
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
      entries: 0,
    })),
    runNow: vi.fn(async () => 'requested' as const),
    refreshSnapshot: vi.fn(async () => 'requested' as const),
    rebuildMember: vi.fn(async () => 'queued' as const),
    snapshot: vi.fn(async () => ({
      lastRun: undefined,
      openRun: undefined,
      events: 0,
      rsvps: 0,
      pending: 0,
      failing: 0,
      hidden: 0,
      pace: { callsPerTick: 150, concurrency: 1 },
      lastTick: undefined,
      now: new Date('2026-12-10T20:00:00Z'),
    })),
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
  (await renderSettingsCards(fakePageDeps({ wrappedBackfill }), view)).value
    .replace(/\s+/g, ' ')
    .replace(/> </g, '><');

describe('Settings Wrapped backfill card', () => {
  it('with no run yet, says so and offers Run now to leadership', async () => {
    const out = await render(control());
    expect(out).toContain('<h2>Wrapped backfill</h2>');
    expect(out).toContain('No run yet.');
    expect(out).toContain('Queue: 0');
    expect(out).toContain('Stored Wrapped entries: 0');
    expect(out).toContain('Next tick: the job is not running');
    expect(out).toContain('Next sweep: as soon as the job runs');
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
          entries: 1234,
        }),
      }),
    );
    expect(out).toContain('Last run finished Dec 9, 2026 1:30 PM Pacific');
    expect(out).toContain('240 members: built 600, skipped 300, failed 2');
    expect(out).toContain('1830 Meetup client calls');
    expect(out).toContain('Queue: 3');
    expect(out).toContain('Stored Wrapped entries: 1234');
    expect(out).toContain('Next tick: 12:05 PM Pacific');
    // 20 hours after the last finish: Dec 10, 2026 9:30 AM Pacific.
    expect(out).toContain('Next sweep: Dec 10, 2026 9:30 AM Pacific');
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
          entries: 900,
        }),
      }),
    );
    expect(out).toContain('Running: 96 of 240 members');
    expect(out).toContain('built 150, skipped 130, failed 1');
    expect(out).toContain('410 Meetup client calls so far');
    expect(out).toContain('Next sweep: running now');
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
  });

  it("offers Refresh a member's Wrapped in a confirm pop-up, never inline", async () => {
    const out = await render(control());
    expect(out).toContain('<details class="ui-modal" data-modal>');
    expect(out).toContain(
      '<summary class="button ghost" title="1.5 Leadership Team only">' +
        'Refresh a member&#39;s Wrapped…</summary>',
    );
    expect(out).toContain(`action="${WRAPPED_REBUILD_PATH}"`);
    expect(out).toContain('name="member"');
    expect(out).toContain('name="year"');
    expect(out).toContain('<button type="submit">Queue the refresh</button>');
  });

  it('without a CSRF token (a bare render) there is no form', async () => {
    const out = await render(control(), {});
    expect(out).not.toContain(`action="${WRAPPED_REBUILD_PATH}"`);
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
    settingsCards: (view) => renderSettingsCards(pages, view),
  });
  return { req, isLeadership, audit, runNow };
}

async function tokenOf(req: Client, cookie: string): Promise<string> {
  const page = await req.get('/dashboard/settings').set('Cookie', cookie);
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
    expect(res.headers.location).toBe(
      '/dashboard/settings?backfill=not-leadership',
    );
    expect(isLeadership).toHaveBeenCalledWith(USER.id);
    expect(runNow).not.toHaveBeenCalled();
  });

  it('Leadership asks for a run; the outcome comes back as a notice, audited', async () => {
    const { req, isLeadership, runNow, audit } = await setup();
    isLeadership.mockResolvedValue(true);
    const cookie = await signIn(req);
    const res = await pressRunNow(req, cookie);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/dashboard/settings?backfill=requested');
    expect(runNow).toHaveBeenCalledWith(USER.id);
    const home = await req
      .get('/dashboard/settings?backfill=requested')
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
    expect(res.headers.location).toBe(
      '/dashboard/settings?backfill=already-running',
    );
    expect(audit).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Wrapped backfill requested' }),
    );
  });

  it('a Discord outage on the role check is "unavailable", nothing requested', async () => {
    const { req, isLeadership, runNow } = await setup();
    isLeadership.mockRejectedValue(new Error('gateway down'));
    const res = await pressRunNow(req, await signIn(req));
    expect(res.headers.location).toBe(
      '/dashboard/settings?backfill=unavailable',
    );
    expect(runNow).not.toHaveBeenCalled();
  });
});

const snapshotRun = (over: Partial<SnapshotRun> = {}): SnapshotRun => ({
  id: 3,
  trigger: 'job',
  kind: 'incremental',
  startedAt: new Date('2026-12-10T16:50:00Z'),
  finishedAt: new Date('2026-12-10T17:00:00Z'),
  listedAt: new Date('2026-12-10T16:51:00Z'),
  eventsListed: 2481,
  eventsFetched: 31,
  rsvpsStored: 600,
  failed: 0,
  requests: 62,
  lastError: undefined,
  ...over,
});

describe('Settings Wrapped backfill card: the group snapshot line', () => {
  const NOW = new Date('2026-12-10T20:00:00Z');
  const withSnapshot = (
    status: Awaited<ReturnType<WrappedBackfillControl['snapshot']>>,
  ) => control({ snapshot: async () => status });

  it('before any pull', async () => {
    const out = await render(control());
    expect(out).toContain('Group snapshot: not pulled yet.');
  });

  it('after a run: age, totals and the last run', async () => {
    const out = await render(
      withSnapshot({
        lastRun: snapshotRun(),
        openRun: undefined,
        events: 2481,
        rsvps: 51204,
        pending: 0,
        failing: 0,
        hidden: 0,
        pace: { callsPerTick: 150, concurrency: 1 },
        lastTick: undefined,
        now: NOW,
      }),
    );
    expect(out).toContain(
      'Group snapshot: updated 3 h ago (Dec 10, 2026 9:00 AM Pacific) · 2,481 events · ' +
        '51,204 RSVPs · last run: incremental, 62 calls, 0 failed.',
    );
  });

  it('during a run: progress, and the last tick’s error class', async () => {
    const out = await render(
      withSnapshot({
        lastRun: undefined,
        openRun: snapshotRun({
          kind: 'full',
          finishedAt: undefined,
          eventsFetched: 1204,
          lastError: 'TypeError',
        }),
        events: 2450,
        rsvps: 24000,
        pending: 1246,
        failing: 4,
        hidden: 0,
        pace: { callsPerTick: 150, concurrency: 1 },
        lastTick: undefined,
        now: NOW,
      }),
    );
    expect(out).toContain(
      'Group snapshot: refreshing (full): 1,204 of ~2,450 events read. Last tick failed (TypeError).',
    );
    expect(out).not.toContain('not pulled yet');
    expect(out).toContain(
      '4 events failed their last RSVP read; they are retried each run.',
    );
  });

  it('a failing snapshot status degrades the line alone', async () => {
    const out = await render(
      control({
        snapshot: async () => {
          throw new Error('pg <b>down</b>');
        },
      }),
    );
    expect(out).toContain('<h2>Wrapped backfill</h2>');
    expect(out).toContain('Group snapshot: status unavailable.');
    expect(out).not.toContain('down');
  });
});

async function pressRefresh(req: Client, cookie: string) {
  return req
    .post(SNAPSHOT_REFRESH_PATH)
    .set('Cookie', cookie)
    .set('Origin', ORIGIN)
    .type('form')
    .send({ _csrf: await tokenOf(req, cookie) });
}

describe('POST /dashboard/wrapped/snapshot/run (Refresh snapshot now)', () => {
  it('offers the button with a CSRF token and hides it during a snapshot run', async () => {
    const out = await render(control());
    expect(out).toContain(`action="${SNAPSHOT_REFRESH_PATH}"`);
    expect(out).toContain('>Refresh snapshot now</button>');
    const busy = await render(
      control({
        snapshot: async () => ({
          lastRun: undefined,
          openRun: snapshotRun({ finishedAt: undefined }),
          events: 1,
          rsvps: 1,
          pending: 1,
          failing: 0,
          hidden: 0,
          pace: { callsPerTick: 150, concurrency: 1 },
          lastTick: undefined,
          now: new Date('2026-12-10T20:00:00Z'),
        }),
      }),
    );
    expect(busy).not.toContain(`action="${SNAPSHOT_REFRESH_PATH}"`);
    expect(await render(control(), {})).not.toContain(
      `action="${SNAPSHOT_REFRESH_PATH}"`,
    );
  });

  it('needs Leadership, checked live; Discord down is "unavailable"', async () => {
    const refreshSnapshot = vi.fn(async (_by: string) => 'requested' as const);
    const { req, isLeadership } = await setup({ refreshSnapshot });
    isLeadership.mockResolvedValue(false);
    const cookie = await signIn(req);
    expect((await pressRefresh(req, cookie)).headers.location).toBe(
      '/dashboard/settings?backfill=snapshot-not-leadership',
    );
    const home = await req
      .get('/dashboard/settings?backfill=snapshot-not-leadership')
      .set('Cookie', cookie);
    expect(home.text).toContain('can refresh the group snapshot');
    expect(home.text).not.toContain('run the Wrapped backfill');
    isLeadership.mockRejectedValue(new Error('gateway down'));
    expect((await pressRefresh(req, cookie)).headers.location).toBe(
      '/dashboard/settings?backfill=snapshot-unavailable',
    );
    expect(refreshSnapshot).not.toHaveBeenCalled();
  });

  it('Leadership asks for a refresh: notice and audit; repeats and open runs say so', async () => {
    const refreshSnapshot = vi.fn<
      (
        by: string,
      ) => Promise<'requested' | 'already-running' | 'already-requested'>
    >(async () => 'requested');
    const { req, isLeadership, audit } = await setup({ refreshSnapshot });
    isLeadership.mockResolvedValue(true);
    const cookie = await signIn(req);
    const res = await pressRefresh(req, cookie);
    expect(res.headers.location).toBe(
      '/dashboard/settings?backfill=snapshot-requested',
    );
    expect(refreshSnapshot).toHaveBeenCalledWith(USER.id);
    const home = await req
      .get('/dashboard/settings?backfill=snapshot-requested')
      .set('Cookie', cookie);
    expect(home.text).toContain(BACKFILL_NOTICES['snapshot-requested']);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Group snapshot refresh requested' }),
    );

    refreshSnapshot.mockResolvedValue('already-requested');
    expect((await pressRefresh(req, cookie)).headers.location).toBe(
      '/dashboard/settings?backfill=snapshot-already-requested',
    );
    refreshSnapshot.mockResolvedValue('already-running');
    expect((await pressRefresh(req, cookie)).headers.location).toBe(
      '/dashboard/settings?backfill=snapshot-already-running',
    );
  });
});

describe('Settings Wrapped backfill card: the snapshot pace', () => {
  it('shows the configured pace and the last tick', async () => {
    const out = await render(
      control({
        snapshot: async () => ({
          lastRun: undefined,
          openRun: undefined,
          events: 0,
          rsvps: 0,
          pending: 0,
          failing: 0,
          hidden: 0,
          pace: { callsPerTick: 5000, concurrency: 1 },
          lastTick: { at: '2026-12-10T19:56:00Z', calls: 150, fetched: 148 },
          now: new Date('2026-12-10T20:00:00Z'),
        }),
      }),
    );
    expect(out).toContain(
      'Pace: 5,000 Meetup calls a tick, 1 at a time · last tick 4 min ago: 150 calls, 148 events read.',
    );
  });

  it('with no recent tick, the pace alone', async () => {
    const out = await render(control());
    expect(out).toContain('Pace: 150 Meetup calls a tick, 1 at a time.');
  });
});

describe('Settings Wrapped backfill card: hidden RSVPs and a failed last tick', () => {
  it('counts events whose attendees left Meetup, and shows a failed last tick', async () => {
    const out = await render(
      control({
        snapshot: async () => ({
          lastRun: undefined,
          openRun: undefined,
          events: 0,
          rsvps: 0,
          pending: 0,
          failing: 0,
          hidden: 7,
          pace: { callsPerTick: 150, concurrency: 1 },
          lastTick: {
            at: '2026-12-10T19:58:00Z',
            calls: 3,
            fetched: 2,
            error: 'RateLimited',
          },
          now: new Date('2026-12-10T20:00:00Z'),
        }),
      }),
    );
    expect(out).toContain(
      '7 events have RSVPs Meetup no longer shows (their attendees left Meetup).',
    );
    expect(out).toContain('2 events read (failed: RateLimited).');
  });
});

describe('Settings Wrapped backfill card: the last failed tick', () => {
  it('says the last tick failed, with the error class and time only', async () => {
    const out = await render(
      control({
        status: async () => ({
          lastRun: undefined,
          openRun: undefined,
          queueLength: 0,
          nextTickAt: undefined,
          entries: 0,
          lastError: { at: '2026-12-10T19:55:00Z', error: 'TypeError' },
        }),
      }),
    );
    expect(out).toContain(
      'Last tick failed (TypeError) at Dec 10, 2026 11:55 AM Pacific; the backfill retries every 5 minutes.',
    );
  });
});

describe('parseRebuild', () => {
  const now = new Date('2026-12-10T20:00:00Z');
  it('reads a Discord user id or a Meetup member id, and a year 2015..this year', () => {
    expect(
      parseRebuild({ member: ' 200000000000000001 ', year: '2025' }, now),
    ).toEqual({ target: { discordUserId: '200000000000000001' }, year: 2025 });
    expect(parseRebuild({ member: '182787593', year: '2026' }, now)).toEqual({
      target: { meetupMemberId: '182787593' },
      year: 2026,
    });
  });

  it('refuses anything else', () => {
    for (const body of [
      {},
      { member: '182787593' },
      { member: '<@200000000000000001>', year: '2026' },
      { member: '0', year: '2026' },
      { member: '182787593', year: '2014' },
      { member: '182787593', year: '2027' },
      { member: '182787593', year: '2026.5' },
      { member: ['1'], year: '2026' },
    ]) {
      expect(parseRebuild(body, now)).toBeUndefined();
    }
  });
});

describe('POST /dashboard/wrapped/rebuild', () => {
  async function rebuildSetup() {
    const rebuildMember = vi.fn<WrappedBackfillControl['rebuildMember']>(
      async () => 'queued',
    );
    const s = await setup({ rebuildMember });
    return { ...s, rebuildMember };
  }
  const press = async (
    req: Client,
    cookie: string,
    body: Record<string, string>,
  ) =>
    req
      .post(WRAPPED_REBUILD_PATH)
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: await tokenOf(req, cookie), ...body });

  it('needs the 1.5 Leadership Team role, checked live', async () => {
    const { req, isLeadership, rebuildMember } = await rebuildSetup();
    isLeadership.mockResolvedValue(false);
    const res = await press(req, await signIn(req), {
      member: '182787593',
      year: '2026',
    });
    expect(res.headers.location).toBe(
      '/dashboard/settings?backfill=rebuild-not-leadership',
    );
    expect(rebuildMember).not.toHaveBeenCalled();
  });

  it('a Discord outage asks to try again, nothing queued', async () => {
    const { req, isLeadership, rebuildMember } = await rebuildSetup();
    isLeadership.mockRejectedValue(new Error('down'));
    const res = await press(req, await signIn(req), {
      member: '182787593',
      year: '2026',
    });
    expect(res.headers.location).toBe(
      '/dashboard/settings?backfill=rebuild-unavailable',
    );
    expect(rebuildMember).not.toHaveBeenCalled();
  });

  it('Leadership queues it: audited by ids, the notice comes back', async () => {
    const { req, isLeadership, rebuildMember, audit } = await rebuildSetup();
    isLeadership.mockResolvedValue(true);
    const cookie = await signIn(req);
    const res = await press(req, cookie, {
      member: '200000000000000001',
      year: '2025',
    });
    expect(res.headers.location).toBe(
      '/dashboard/settings?backfill=rebuild-queued',
    );
    expect(rebuildMember).toHaveBeenCalledWith(
      { discordUserId: '200000000000000001' },
      2025,
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Wrapped rebuild requested',
        description: expect.stringContaining(
          "<@200000000000000001>'s 2025 Wrapped to be rebuilt from the latest group data",
        ),
      }),
    );
    const page = await req
      .get('/dashboard/settings?backfill=rebuild-queued')
      .set('Cookie', cookie);
    expect(page.text).toContain(
      BACKFILL_NOTICES['rebuild-queued'].replace("'", '&#39;'),
    );
  });

  it('without the CSRF token the guard refuses it, nothing asked', async () => {
    const { req, isLeadership, rebuildMember } = await rebuildSetup();
    isLeadership.mockResolvedValue(true);
    const res = await req
      .post(WRAPPED_REBUILD_PATH)
      .set('Cookie', await signIn(req))
      .set('Origin', ORIGIN)
      .type('form')
      .send({ member: '182787593', year: '2026' });
    expect(res.status).toBe(403);
    expect(isLeadership).not.toHaveBeenCalled();
    expect(rebuildMember).not.toHaveBeenCalled();
  });

  it('a bad member or year is refused before anything is asked', async () => {
    const { req, isLeadership, rebuildMember } = await rebuildSetup();
    isLeadership.mockResolvedValue(true);
    const res = await press(req, await signIn(req), {
      member: 'hai',
      year: '2026',
    });
    expect(res.headers.location).toBe(
      '/dashboard/settings?backfill=rebuild-invalid',
    );
    expect(rebuildMember).not.toHaveBeenCalled();
  });

  it('not linked, or another year queued: said so, not audited', async () => {
    for (const outcome of ['not-linked', 'already-queued'] as const) {
      // eslint-disable-next-line no-await-in-loop -- one app per outcome
      const { req, isLeadership, rebuildMember, audit } = await rebuildSetup();
      rebuildMember.mockResolvedValue(outcome);
      isLeadership.mockResolvedValue(true);
      // eslint-disable-next-line no-await-in-loop -- one app per outcome
      const res = await press(req, await signIn(req), {
        member: '182787593',
        year: '2026',
      });
      expect(res.headers.location).toBe(
        `/dashboard/settings?backfill=rebuild-${outcome}`,
      );
      expect(audit).not.toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Wrapped rebuild requested' }),
      );
    }
  });
});
