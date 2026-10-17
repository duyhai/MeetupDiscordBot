import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DASHBOARD_BASE,
  monthPageUrls,
} from '../../../src/lib/reports/dashboardPaths.js';
import {
  createDashboardRouter,
  protectedRouteList,
} from '../../../src/web/dashboardRouter.js';
import { registerAllProtectedRoutes } from '../../../src/web/routes/dashboardPages.js';
import { clientFor } from '../../setup/loopbackServer.js';
import { closeServers, listen, makeDeps, signIn } from '../dashboardHarness.js';
import { PAGE_NOW, fakeOrganizerDeps, fakePageDeps } from './pageFakes.js';

afterEach(closeServers);

/** The router production builds, with fake data. */
function buildRouter() {
  const { deps } = makeDeps({ now: () => PAGE_NOW.getTime() });
  return createDashboardRouter({
    ...deps,
    protectedRoutes: (r) =>
      registerAllProtectedRoutes(r, {
        organizer: fakeOrganizerDeps(),
        pages: fakePageDeps(),
      }),
  });
}

const SEPT = { year: 2026, month: 9 };
const urls = Object.values(monthPageUrls(SEPT));

describe('build alert month links', () => {
  it('links exactly the two month pages', () => {
    expect(urls).toEqual([
      'https://meetup-discord-bot.herokuapp.com/dashboard/hall-of-fame/2026-09',
      'https://meetup-discord-bot.herokuapp.com/dashboard/no-show-history/2026-09',
    ]);
  });

  it.each(urls)('%s is a registered GET route', (url) => {
    const pathname = new URL(url).pathname;
    expect(pathname.startsWith(`${DASHBOARD_BASE}/`)).toBe(true);
    const path = pathname.slice(DASHBOARD_BASE.length);
    const gets = protectedRouteList(buildRouter()).filter(
      (r) => r.method === 'get',
    );
    expect(
      gets.some((r) => r.path.replace(':period', '2026-09') === path),
    ).toBe(true);
  });

  it.each(urls)('%s opens the month page when signed in', async (url) => {
    const app = express();
    app.set('trust proxy', 1);
    app.use(DASHBOARD_BASE, buildRouter());
    const req = clientFor(await listen(app));
    const cookie = await signIn(req);
    const res = await req.get(new URL(url).pathname).set('Cookie', cookie);
    expect(res.status).toBe(200);
  });
});
