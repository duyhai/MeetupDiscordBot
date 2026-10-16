import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  RebuildRefusal,
  requestRebuild,
} from '../../../src/lib/reports/buildJob.js';
import { BUILD_LEASE_KEY } from '../../../src/lib/reports/buildLease.js';
import { Period } from '../../../src/lib/reports/period.js';
import { escapeHtml } from '../../../src/web/html.js';
import { FixedWindowLimiter } from '../../../src/web/rateLimit.js';
import {
  DashboardPageDeps,
  PageRebuildResult,
  registerAllProtectedRoutes,
} from '../../../src/web/routes/dashboardPages.js';
import {
  REFRESH_CODES,
  REFRESH_MESSAGES,
} from '../../../src/web/routes/refresh.js';
import {
  CacheTimeoutError,
  releaseLateBuildLease,
  timedCacheFactory,
} from '../../../src/web/timedCache.js';
import {
  Clock,
  makeDeps as makeBuildDeps,
} from '../../lib/reports/buildJobFakes.js';
import {
  Client,
  ORIGIN,
  USER,
  closeServers,
  makeApp,
  signIn,
} from '../dashboardHarness.js';
import { FakeCache } from '../fakeCache.js';
import { PAGE_NOW, fakeOrganizerDeps, fakePageDeps } from './pageFakes.js';

afterEach(closeServers);

const REFRESH = '/dashboard/reports/2026-09/refresh';
const MONTH = '/dashboard/hall-of-fame/2026-09';

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

type Rebuild = DashboardPageDeps['rebuild'];

/** A promise and its resolve, for gating a fake on the test's say-so. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function setup(
  options: {
    rebuild?: Rebuild;
    now?: Date;
    actionLimiter?: FixedWindowLimiter;
  } = {},
) {
  const now = options.now ?? PAGE_NOW;
  const rebuild = vi.fn<Rebuild>(
    options.rebuild ??
      (async () => ({
        status: 'started',
        done: Promise.resolve({ ok: true }),
      })),
  );
  const { req } = await makeApp({
    now: () => now.getTime(),
    actionLimiter: options.actionLimiter,
    protectedRoutes: (r) =>
      registerAllProtectedRoutes(r, {
        organizer: fakeOrganizerDeps(),
        pages: fakePageDeps({ now: () => now, rebuild }),
      }),
  });
  const cookie = await signIn(req);
  const token = await tokenOf(req, cookie);
  const post = (
    path: string = REFRESH,
    body: Record<string, string> = { _csrf: token },
  ) =>
    req
      .post(path)
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .type('form')
      .send(body);
  const get = (path: string) => req.get(path).set('Cookie', cookie);
  return { req, cookie, token, rebuild, post, get };
}

async function tokenOf(req: Client, cookie: string): Promise<string> {
  const page = await req.get(MONTH).set('Cookie', cookie);
  expect(page.status).toBe(200);
  const match = /name="_csrf" value="([^"]+)"/.exec(page.text);
  if (!match) {
    throw new Error('month page has no CSRF field');
  }
  return match[1];
}

const REFUSALS: RebuildRefusal[] = [
  'quiet-hour',
  'identity-sweep',
  'busy',
  'cooldown',
  'future-month',
  'bad-month',
  'bad-requester',
];

describe('POST /dashboard/reports/:period/refresh', () => {
  it('refresh calls rebuild with the parsed month and the session user, then 303s to the month page', async () => {
    const { post, rebuild } = await setup();
    const res = await post();
    expect(res.status).toBe(303);
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(rebuild).toHaveBeenCalledWith({ year: 2026, month: 9 }, USER.id);
    expect(res.headers.location).toBe(`${MONTH}?refresh=started`);
  });

  it('return=no-show-history goes to the no-show month; anything else to Hall of Fame', async () => {
    const { post, token } = await setup();
    const noShow = await post(REFRESH, {
      _csrf: token,
      return: 'no-show-history',
    });
    expect(noShow.headers.location).toBe(
      '/dashboard/no-show-history/2026-09?refresh=started',
    );
    const evil = await post(REFRESH, {
      _csrf: token,
      return: 'https://evil.example',
    });
    expect(evil.headers.location).toBe(`${MONTH}?refresh=started`);
    const hof = await post(REFRESH, { _csrf: token, return: 'hall-of-fame' });
    expect(hof.headers.location).toBe(`${MONTH}?refresh=started`);
  });

  it('every code has fixed text', () => {
    expect([...REFRESH_CODES].sort()).toEqual(
      [...REFUSALS, 'started', 'error', 'unavailable'].sort(),
    );
  });

  it('each refusal shows its fixed message', async () => {
    let status: PageRebuildResult['status'] = 'busy';
    const { post, get } = await setup({
      rebuild: async () =>
        ({ status, message: '<script>x</script>' }) as PageRebuildResult,
    });
    for (const code of [...REFUSALS, 'unavailable'] as const) {
      status = code;
      // eslint-disable-next-line no-await-in-loop -- one code at a time, so a failure names it
      const res = await post();
      expect(res.status, code).toBe(303);
      expect(res.headers.location, code).toBe(`${MONTH}?refresh=${code}`);
      // eslint-disable-next-line no-await-in-loop -- as above
      const page = await get(res.headers.location);
      expect(page.text, code).toContain(escapeHtml(REFRESH_MESSAGES[code]));
      expect(page.text, code).not.toContain('<script>x');
      expect(page.text, code).not.toContain('&lt;script&gt;x');
    }
  });

  it('refresh refused while a build runs', async () => {
    const h = makeBuildDeps();
    await h.cache.set(BUILD_LEASE_KEY, 'held-by-the-job', 600);
    const { post, get } = await setup({
      rebuild: (period, by) => requestRebuild(h.deps, period, by),
    });
    const res = await post();
    expect(res.headers.location).toBe(`${MONTH}?refresh=busy`);
    const page = await get(res.headers.location);
    expect(page.text).toContain('A report build is already running');
    expect(h.fetchMonthReports).not.toHaveBeenCalled();
  });

  it('refresh refused 17:45–19:00 UTC', async () => {
    const at = '2026-10-05T17:50:00Z';
    const h = makeBuildDeps({ clock: new Clock(at) });
    const { post, get } = await setup({
      now: new Date(at),
      rebuild: (period, by) => requestRebuild(h.deps, period, by),
    });
    const res = await post();
    expect(res.headers.location).toBe(`${MONTH}?refresh=quiet-hour`);
    const page = await get(res.headers.location);
    expect(page.text).toContain('17:45 and 19:00 UTC');
    expect(h.fetchMonthReports).not.toHaveBeenCalled();
  });

  it('the real requestRebuild starts a build for the session user', async () => {
    const h = makeBuildDeps();
    let done: Promise<unknown> = Promise.resolve();
    const { post } = await setup({
      rebuild: async (period, by) => {
        const result = await requestRebuild(h.deps, period, by);
        if (result.status === 'started') {
          done = result.done;
        }
        return result;
      },
    });
    const res = await post();
    expect(res.headers.location).toBe(`${MONTH}?refresh=started`);
    await expect(done).resolves.toEqual({ ok: true });
    expect(h.fetchMonthReports).toHaveBeenCalledTimes(1);
    expect(h.snapshots.rows.map((r) => r.builtBy)).toEqual([USER.id, USER.id]);
  });

  it('a rebuild that rejects answers refresh=error and leaves no unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const { post } = await setup({
        rebuild: () => Promise.reject(new Error('password=hunter2')),
      });
      const res = await post();
      expect(res.status).toBe(303);
      expect(res.headers.location).toBe(`${MONTH}?refresh=error`);
      await sleep(20);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('a done that rejects after all leaves no unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const { post } = await setup({
        rebuild: async () => ({
          status: 'started',
          done: Promise.reject(new Error('late')),
        }),
      });
      const res = await post();
      expect(res.headers.location).toBe(`${MONTH}?refresh=started`);
      await sleep(20);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('a timed-out lease answers 503, is released when it lands, and the next refresh starts', async () => {
    const TIMEOUT_MS = 50;
    /**
     * The build lease's SET NX is held at a gate until the test opens it, like
     * Redis returning from an outage; the deadline runs on fake timers, so
     * nothing depends on real elapsed time.
     */
    class GatedLeaseCache extends FakeCache {
      gated = true;

      private readonly gate = deferred();

      readonly requested = deferred();

      readonly removed = deferred();

      release(): void {
        this.gate.resolve();
      }

      override async exclusive_set(
        key: string,
        value: string,
        ttlSec?: number,
      ) {
        if (this.gated && key === BUILD_LEASE_KEY) {
          this.requested.resolve();
          await this.gate.promise;
        }
        return super.exclusive_set(key, value, ttlSec);
      }

      override async remove(key: string) {
        await super.remove(key);
        if (key === BUILD_LEASE_KEY) {
          this.removed.resolve();
        }
      }
    }
    const lease = new GatedLeaseCache();
    const h = makeBuildDeps();
    const deps = {
      ...h.deps,
      cache: timedCacheFactory(
        async () => lease,
        TIMEOUT_MS,
        releaseLateBuildLease(async () => lease),
      ),
    };
    let done: Promise<unknown> = Promise.resolve();
    const rebuild = vi.fn<Rebuild>(async (period, by) => {
      const result = await requestRebuild(deps, period, by);
      if (result.status === 'started') {
        done = result.done;
      }
      return result;
    });
    const { post } = await setup({ rebuild });

    // Only the deadline timers are faked: the HTTP round trip stays real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // .then sends the request now; the client is lazy until then.
      const first = post().then((res) => res);
      await lease.requested.promise;
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      expect((await first).status).toBe(503);
      await expect(rebuild.mock.results[0].value).rejects.toBeInstanceOf(
        CacheTimeoutError,
      );
      expect(lease.values.has(BUILD_LEASE_KEY)).toBe(false);

      // The SET NX lands after all; the late-lease hook releases it.
      lease.release();
      await lease.removed.promise;
      expect(lease.values.has(BUILD_LEASE_KEY)).toBe(false);
      // The first request failed before the cooldown step.
      expect([...lease.values.keys()].some((k) => k.includes('cooldown'))).toBe(
        false,
      );

      lease.gated = false;
      const second = await post();
      expect(second.status).toBe(303);
      expect(second.headers.location).toBe(`${MONTH}?refresh=started`);
      await done;
    } finally {
      vi.useRealTimers();
    }
  });

  it('a done that never settles does not hold the response', async () => {
    const { post } = await setup({
      rebuild: async () => ({
        status: 'started',
        done: new Promise(() => undefined),
      }),
    });
    const res = await post();
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`${MONTH}?refresh=started`);
  });

  it('requires CSRF', async () => {
    const { post, rebuild } = await setup();
    const res = await post(REFRESH, {});
    expect(res.status).toBe(403);
    const wrong = await post(REFRESH, { _csrf: 'not-the-token' });
    expect(wrong.status).toBe(403);
    expect(rebuild).not.toHaveBeenCalled();
  });

  it('rate-limited per user by the action limiter', async () => {
    const { post, rebuild } = await setup({
      actionLimiter: new FixedWindowLimiter(2, 60_000),
    });
    expect((await post()).status).toBe(303);
    expect((await post()).status).toBe(303);
    const third = await post();
    expect(third.status).toBe(429);
    expect(third.headers['retry-after']).toMatch(/^[0-9]+$/);
    expect(rebuild).toHaveBeenCalledTimes(2);
  });

  it('404 for a malformed or future month', async () => {
    const { post, token, rebuild } = await setup();
    for (const period of ['2026-9', '2026-13', '2026-11', '2027-01', 'x']) {
      // eslint-disable-next-line no-await-in-loop -- one month at a time, so a failure names it
      const res = await post(`/dashboard/reports/${period}/refresh`, {
        _csrf: token,
      });
      expect(res.status, period).toBe(404);
    }
    expect(rebuild).not.toHaveBeenCalled();
  });

  it("a month before the group's first is not found; the first month can be refreshed", async () => {
    const { post, token, rebuild } = await setup();
    const before = await post('/dashboard/reports/2013-02/refresh', {
      _csrf: token,
    });
    expect(before.status).toBe(404);
    expect(rebuild).not.toHaveBeenCalled();
    const first = await post('/dashboard/reports/2013-03/refresh', {
      _csrf: token,
    });
    expect(first.headers.location).toBe(
      '/dashboard/hall-of-fame/2013-03?refresh=started',
    );
  });

  it('the current month can be refreshed', async () => {
    const { post, rebuild } = await setup();
    const res = await post('/dashboard/reports/2026-10/refresh');
    expect(res.headers.location).toBe(
      '/dashboard/hall-of-fame/2026-10?refresh=started',
    );
    expect(rebuild.mock.calls[0][0]).toEqual<Period>({
      year: 2026,
      month: 10,
    });
  });

  it('an unknown refresh code is never echoed', async () => {
    const { get } = await setup();
    const res = await get(`${MONTH}?refresh=%3Cscript%3Ex`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<script>x');
    expect(res.text).not.toContain('&lt;script&gt;x');
    expect(res.text).not.toContain('class="note"');
    const proto = await get(`${MONTH}?refresh=toString`);
    expect(proto.text).not.toContain('class="note"');
    const repeated = await get(`${MONTH}?refresh=busy&refresh=busy`);
    expect(repeated.text).not.toContain('class="note"');
  });

  it('a known code shows its fixed text on the month page', async () => {
    const { get } = await setup();
    const res = await get(`${MONTH}?refresh=started`);
    expect(res.text).toContain(escapeHtml(REFRESH_MESSAGES.started));
  });
});
