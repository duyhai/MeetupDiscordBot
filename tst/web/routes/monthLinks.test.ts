import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PUBLIC_APP_ORIGIN } from '../../../src/constants.js';
import { runBuildTick } from '../../../src/lib/reports/buildJob.js';
import {
  DASHBOARD_BASE,
  monthPageUrls,
} from '../../../src/lib/reports/dashboardPaths.js';
import {
  createDashboardRouter,
  protectedRouteList,
} from '../../../src/web/dashboardRouter.js';
import { registerAllProtectedRoutes } from '../../../src/web/routes/dashboardPages.js';
import {
  Clock,
  makeDeps as makeBuildJobDeps,
} from '../../lib/reports/buildJobFakes.js';
import { clientFor } from '../../setup/loopbackServer.js';
import { closeServers, listen, makeDeps, signIn } from '../dashboardHarness.js';
import { PAGE_NOW, fakeOrganizerDeps, fakePageDeps } from './pageFakes.js';

afterEach(closeServers);

/**
 * The router production builds, with fake data, as the access matrix builds
 * it: a 1.5 Leadership Team member, so no page refuses for want of a role.
 */
function buildRouter() {
  const { deps } = makeDeps({ now: () => PAGE_NOW.getTime() });
  return createDashboardRouter({
    ...deps,
    protectedRoutes: (r) =>
      registerAllProtectedRoutes(r, {
        organizer: fakeOrganizerDeps(),
        pages: fakePageDeps({
          now: () => PAGE_NOW,
          isLeadership: vi.fn().mockResolvedValue(true),
        }),
      }),
  });
}

/** Signed in on the production-shaped router. */
async function signedIn() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(DASHBOARD_BASE, buildRouter());
  const req = clientFor(await listen(app));
  const cookie = await signIn(req);
  return { req, cookie };
}

/** Whether a dashboard path is a registered GET route (any parameter matches one segment). */
function isRegisteredGet(pathname: string): boolean {
  if (!pathname.startsWith(`${DASHBOARD_BASE}/`)) {
    return false;
  }
  const path = pathname.slice(DASHBOARD_BASE.length);
  return protectedRouteList(buildRouter())
    .filter((r) => r.method === 'get')
    .some((r) =>
      new RegExp(
        `^${r.path.replace(/:[A-Za-z]+/g, '[^/]+').replace(/\//g, '\\/')}$`,
      ).test(path),
    );
}

const SEPT = { year: 2026, month: 9 };
const urls = Object.values(monthPageUrls(SEPT));

describe('build alert month links', () => {
  it('links exactly the three month pages', () => {
    expect(urls).toEqual([
      'https://meetup-discord-bot.herokuapp.com/dashboard/hall-of-fame/2026-09',
      'https://meetup-discord-bot.herokuapp.com/dashboard/no-show-history/2026-09',
      'https://meetup-discord-bot.herokuapp.com/dashboard/no-shows/2026-09',
    ]);
  });

  it.each(urls)('%s is a registered GET route', (url) => {
    expect(isRegisteredGet(new URL(url).pathname)).toBe(true);
  });

  it.each(urls)('%s opens the month page when signed in', async (url) => {
    const { req, cookie } = await signedIn();
    const res = await req.get(new URL(url).pathname).set('Cookie', cookie);
    expect(res.status).toBe(200);
  });

  it('every URL in a build, failure or report-ready alert is a registered page that opens', async () => {
    const descriptions = new Map<string, string[]>();
    const collect = (h: ReturnType<typeof makeBuildJobDeps>) => {
      for (const [entry] of h.alert.mock.calls) {
        const type = entry.title.replace(/:.*$/, '');
        descriptions.set(type, [
          ...(descriptions.get(type) ?? []),
          entry.description ?? '',
        ]);
      }
    };
    // Oct 5: September and October build, September is ready.
    const october = makeBuildJobDeps();
    await runBuildTick(october.deps);
    collect(october);
    // The same tick with Meetup down: both months fail.
    const failing = makeBuildJobDeps();
    failing.fetchMonthReports.mockRejectedValue(new Error('boom'));
    await runBuildTick(failing.deps);
    collect(failing);
    // Sep 5: August (before the workspace) builds and is ready.
    const september = makeBuildJobDeps({
      clock: new Clock('2026-09-05T16:15:00Z'),
    });
    await runBuildTick(september.deps);
    collect(september);

    expect([...descriptions.keys()].sort()).toEqual([
      'Report build failed',
      'Reports built',
      'Reports ready',
    ]);
    const all = [...descriptions.values()].flat();
    // Every alert type links a workspace month's workspace.
    for (const [type, list] of descriptions) {
      expect(
        list.some((d) =>
          d.includes(`${PUBLIC_APP_ORIGIN}/dashboard/no-shows/2026-09`),
        ),
        type,
      ).toBe(true);
    }
    // August's alerts link its history, never a workspace.
    const august = all.filter((d) => d.includes('2026-08'));
    expect(august.length).toBeGreaterThanOrEqual(2);
    for (const d of august) {
      expect(d).toContain(
        `No-show history page: ${PUBLIC_APP_ORIGIN}/dashboard/no-show-history/2026-08`,
      );
      expect(d).not.toContain('/no-shows/2026-08');
    }

    const linked: string[] = [
      ...new Set(
        all.flatMap((d): string[] => [...(d.match(/https:\/\/\S+/g) ?? [])]),
      ),
    ];
    expect(linked.length).toBeGreaterThanOrEqual(7);
    const { req, cookie } = await signedIn();
    for (const url of linked) {
      const parsed = new URL(url);
      expect(parsed.origin, url).toBe(PUBLIC_APP_ORIGIN);
      expect(isRegisteredGet(parsed.pathname), url).toBe(true);
      // eslint-disable-next-line no-await-in-loop -- one page at a time
      const res = await req.get(parsed.pathname).set('Cookie', cookie);
      expect(res.status, url).toBe(200);
    }
  });

  it('a month before the group began is a 404 on every month page, and a month before the workspace on the workspace', async () => {
    const { req, cookie } = await signedIn();
    for (const path of [
      '/dashboard/hall-of-fame/2013-02',
      '/dashboard/no-show-history/2013-02',
      '/dashboard/no-shows/2013-02',
      '/dashboard/no-shows/2026-08',
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one page at a time
      const res = await req.get(path).set('Cookie', cookie);
      expect(res.status, path).toBe(404);
    }
  });
});
