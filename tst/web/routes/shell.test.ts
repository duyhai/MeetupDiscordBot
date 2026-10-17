import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DASHBOARD_BASE } from '../../../src/lib/reports/dashboardPaths.js';
import {
  createDashboardRouter,
  protectedRouteList,
} from '../../../src/web/dashboardRouter.js';
import { WorkspaceStatus } from '../../../src/lib/workspace/types.js';
import { NavKey, navKeyFor } from '../../../src/web/pages.js';
import { registerAllProtectedRoutes } from '../../../src/web/routes/dashboardPages.js';
import { statusBadge } from '../../../src/web/routes/workspace.js';
import { clientFor } from '../../setup/loopbackServer.js';
import { closeServers, listen, makeDeps, signIn } from '../dashboardHarness.js';
import { PAGE_SIZE } from '../../../src/web/paging.js';
import {
  PAGE_NOW,
  fakeIdentity,
  fakeOrganizerDeps,
  fakePageDeps,
  fakeSnapshots,
  hofPayload,
  identityChange,
  noShowPayload,
  seedRow,
} from './pageFakes.js';

afterEach(closeServers);

/** The production router with fake data, signed in as a 1.5 Leadership Team member (every control shown). */
function buildRouter() {
  const { deps } = makeDeps({ now: () => PAGE_NOW.getTime() });
  return createDashboardRouter({
    ...deps,
    protectedRoutes: (r) =>
      registerAllProtectedRoutes(r, {
        organizer: fakeOrganizerDeps(),
        pages: fakePageDeps({ isLeadership: vi.fn().mockResolvedValue(true) }),
      }),
  });
}

/**
 * A full page of stored months and of identity changes, so the "older"
 * pagers on the Hall of Fame, no-show history and identity pages render.
 */
function fullPagesRouter() {
  const { deps } = makeDeps({ now: () => PAGE_NOW.getTime() });
  const months = Array.from({ length: PAGE_SIZE }, (_, i) => {
    const d = new Date(Date.UTC(2026, 8 - i, 1));
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
  });
  const rows = months.flatMap((p) => [
    seedRow('hall_of_fame', p, hofPayload()),
    seedRow('no_show', p, noShowPayload()),
  ]);
  const changes = Array.from({ length: PAGE_SIZE }, (_, i) =>
    identityChange({ id: String(1000 - i) }),
  );
  return createDashboardRouter({
    ...deps,
    protectedRoutes: (r) =>
      registerAllProtectedRoutes(r, {
        organizer: fakeOrganizerDeps(),
        pages: fakePageDeps({
          isLeadership: vi.fn().mockResolvedValue(true),
          snapshots: async () => fakeSnapshots(rows),
          identity: async () => fakeIdentity(changes),
        }),
      }),
  });
}

async function setup(router = buildRouter()) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(DASHBOARD_BASE, router);
  const req = clientFor(await listen(app));
  const cookie = await signIn(req);
  const get = async (path: string) => {
    const res = await req.get(path).set('Cookie', cookie);
    return res;
  };
  return { req, get };
}

const SAMPLE_PARAMS: Record<string, string> = {
  period: '2026-09',
  memberId: '123456',
  id: '1',
  side: 'old',
  rowId: '1',
};

const concrete = (path: string) =>
  `${DASHBOARD_BASE}${path.replace(
    /:([A-Za-z]+)/g,
    (_m, name: string) => SAMPLE_PARAMS[name] ?? '',
  )}`.replace(/\/$/, '');

/** Every signed-in GET page the router lists (the workspace confirm page among them). */
const PAGE_PATHS = protectedRouteList(buildRouter())
  .filter((r) => r.method === 'get')
  .map((r) => concrete(r.path));

/** The site nav's markup, or '' when the page has none. */
const siteNav = (body: string) =>
  /<nav class="site"[^>]*>[\s\S]*?<\/nav>/.exec(body)?.[0] ?? '';

/** The text of every nav link that carries aria-current. */
const currentItems = (body: string) =>
  [
    ...siteNav(body).matchAll(/<a [^>]*aria-current="page"[^>]*>([^<]*)<\/a>/g),
  ].map((m) => m[1]);

/** An inline style attribute on any element (not the nonce'd <style> element). */
const INLINE_STYLE = /<[a-z][^>]*\sstyle\s*=/i;

describe('page shell', () => {
  it('a signed-in page has a skip link to main and the landmarks, once each', async () => {
    const { get } = await setup();
    const pages = await Promise.all(
      ['/dashboard', '/dashboard/no-shows/2026-09'].map(get),
    );
    for (const { text } of pages) {
      expect(text).toContain('<a class="skip" href="#main">');
      // The skip link comes before the header, so it is the first tab stop.
      expect(text.indexOf('class="skip"')).toBeLessThan(
        text.indexOf('<header'),
      );
      expect(text.match(/<header[\s>]/g)).toHaveLength(1);
      expect(text.match(/<main[\s>]/g)).toHaveLength(1);
      expect(text).toContain('<main id="main"');
      expect(text).toMatch(/<nav class="site" aria-label="[^"]+">/);
      // The nav sits between the header and main, not inside main.
      const main = text.indexOf('<main');
      expect(text.indexOf('<nav class="site"')).toBeGreaterThan(
        text.indexOf('</header>'),
      );
      expect(text.indexOf('<nav class="site"')).toBeLessThan(main);
    }
  });

  it('the sign-in and error pages have the skip link and main, and no site nav', async () => {
    const { req, get } = await setup();
    const login = await req.get('/dashboard/login');
    const missing = await get('/dashboard/no-such-page');
    expect(missing.status).toBe(404);
    for (const { text } of [login, missing]) {
      expect(text).toContain('<a class="skip" href="#main">');
      expect(text).toContain('<main id="main"');
      expect(text).toMatch(/<header[\s>]/);
      expect(siteNav(text)).toBe('');
    }
  });

  it('keeps every nav link and label', async () => {
    const { get } = await setup();
    const nav = siteNav((await get('/dashboard/sessions')).text);
    const links = [...nav.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map(
      (m) => [m[1], m[2]],
    );
    expect(links).toEqual([
      ['/dashboard', 'Home'],
      ['/dashboard/no-shows', 'No-show workspace'],
      ['/dashboard/hall-of-fame', 'Hall of Fame'],
      ['/dashboard/no-show-history', 'No-show history'],
      ['/dashboard/suspensions', 'Suspensions'],
      ['/dashboard/identity', 'Identity changes'],
      ['/dashboard/link-progress', 'Link progress'],
      ['/dashboard/trends', 'Trends'],
      ['/dashboard/sessions', 'Sessions'],
    ]);
  });

  it.each([
    ['/dashboard', 'Home'],
    ['/dashboard/no-shows', 'No-show workspace'],
    ['/dashboard/no-shows/2026-09', 'No-show workspace'],
    ['/dashboard/no-shows/2026-09/rows/1/suspend', 'No-show workspace'],
    ['/dashboard/hall-of-fame', 'Hall of Fame'],
    ['/dashboard/hall-of-fame/2026-09', 'Hall of Fame'],
    ['/dashboard/no-show-history', 'No-show history'],
    ['/dashboard/no-show-history/members/123456', 'No-show history'],
    ['/dashboard/suspensions', 'Suspensions'],
    ['/dashboard/identity', 'Identity changes'],
    ['/dashboard/link-progress', 'Link progress'],
    ['/dashboard/trends', 'Trends'],
    ['/dashboard/sessions', 'Sessions'],
    ['/dashboard/sessions?done=done', 'Sessions'],
  ])('%s marks only "%s" as the current page', async (path, label) => {
    const { get } = await setup();
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(currentItems(res.text)).toEqual([label]);
    // Exactly one nav link carries aria-current at all.
    expect(siteNav(res.text).match(/aria-current=/g)).toHaveLength(1);
  });

  it('a page outside the nav (organizer login) marks nothing current', async () => {
    const { get } = await setup();
    const { text } = await get('/dashboard/organizer-login');
    expect(siteNav(text)).not.toBe('');
    expect(currentItems(text)).toEqual([]);
  });
});

describe('nav landmarks', () => {
  it('every <nav> on every page has an aria-label', async () => {
    const plain = await setup();
    const full = await setup(fullPagesRouter());
    const texts = [
      ...(await Promise.all(PAGE_PATHS.map(plain.get))),
      ...(await Promise.all(
        [
          '/dashboard/hall-of-fame',
          '/dashboard/no-show-history',
          '/dashboard/identity',
        ].map(full.get),
      )),
    ]
      .filter((res) =>
        String(res.headers['content-type']).startsWith('text/html'),
      )
      .map((res) => res.text);
    const labels = new Set<string>();
    for (const text of texts) {
      for (const [tag] of text.matchAll(/<nav\b[^>]*>/g)) {
        const label = /\saria-label="([^"]+)"/.exec(tag)?.[1];
        expect(label, tag).toBeDefined();
        labels.add(label ?? '');
      }
    }
    // The pagers were rendered, so the check above covered them.
    for (const label of ['Pages', 'Older and newer changes', 'Older months']) {
      expect(labels).toContain(label);
    }
  });
});

describe('no inline styles', () => {
  it('lists the pages it checks', () => {
    expect(PAGE_PATHS.length).toBeGreaterThan(10);
  });

  it.each(PAGE_PATHS)('%s has no style= attribute', async (path) => {
    const { get } = await setup();
    const res = await get(path);
    if (!String(res.headers['content-type']).startsWith('text/html')) {
      return;
    }
    expect(res.text).not.toMatch(INLINE_STYLE);
    // The one stylesheet is the nonce'd <style> element.
    expect(res.text.match(/<style[\s>]/g)).toHaveLength(1);
  });

  it('nor do the sign-in, 404 and error pages', async () => {
    const { req, get } = await setup();
    const pages = [
      await req.get('/dashboard/login'),
      await req.get('/dashboard/auth/callback?error=access_denied'),
      await get('/dashboard/no-such-page'),
    ];
    for (const res of pages) {
      expect(res.text).toContain('<main id="main"');
      expect(res.text).not.toMatch(INLINE_STYLE);
    }
  });

  it('the check catches an inline style', () => {
    expect('<p class="note" style="color:red">x</p>').toMatch(INLINE_STYLE);
    expect('<div\nstyle="x">').toMatch(INLINE_STYLE);
    expect('<style nonce="n">p{}</style>').not.toMatch(INLINE_STYLE);
  });
});

describe('status colours', () => {
  it('workspace badges and result notices take a fixed colour class', async () => {
    const { get } = await setup();
    const res = await get(
      '/dashboard/no-shows/2026-09?result=done&refresh=busy',
    );
    // Markup whitespace collapsed, so the assertions read the element.
    const text = res.text.replace(/\s+/g, ' ').replace(/> </g, '><');
    expect(text).toContain(
      '<span class="badge info">Suspension candidate</span>',
    );
    expect(text).toContain('<span class="badge attn">New</span>');
    expect(text).toContain('<p class="note info">Saved.</p>');
    expect(text).toMatch(
      /<p class="note attn">A report build is already running/,
    );
  });

  it.each(PAGE_PATHS)(
    '%s uses only the known badge and note classes',
    async (path) => {
      const { get } = await setup();
      const res = await get(path);
      const text = String(res.text ?? '');
      for (const [, cls] of text.matchAll(/class="((?:badge|note)[^"]*)"/g)) {
        expect(cls).toMatch(
          /^(?:badge(?: (?:attn|info|ok|neutral))?|note(?: (?:attn|info))?)$/,
        );
      }
    },
  );
});

describe('navKeyFor', () => {
  it.each([
    ['/dashboard', 'home'],
    ['/dashboard/', 'home'],
    ['/dashboard?x=1', 'home'],
    ['/dashboard/sessions', 'sessions'],
    ['/dashboard/sessions/', 'sessions'],
    ['/dashboard/sessions//', 'sessions'],
    ['/Dashboard/Sessions', 'sessions'],
    ['/dashboard/no-shows/2026-09/rows/1', 'workspace'],
    ['/dashboard/no-showsx', undefined],
    ['/dashboard/sessionsx/1', undefined],
    ['/dashboard/organizer-login', undefined],
    ['/dashboardx', undefined],
    ['/', undefined],
    ['', undefined],
    [undefined, undefined],
  ] as [string | undefined, NavKey | undefined][])('%s → %s', (path, key) => {
    expect(navKeyFor(path)).toBe(key);
  });

  it('stays fast on a long run of slashes', () => {
    const start = Date.now();
    expect(navKeyFor(`/dashboard/sessions${'/'.repeat(100_000)}x`)).toBe(
      'sessions',
    );
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe('statusBadge', () => {
  it.each([
    ['new', 'attn'],
    ['warning_copied', 'info'],
    ['suspended', 'info'],
    ['warning_sent', 'ok'],
    ['on_hold', 'neutral'],
    ['skipped', 'neutral'],
    ['voided', 'neutral'],
  ] as const)('%s → badge %s', (status, cls) => {
    expect(statusBadge(status).value).toMatch(
      new RegExp(`^<span class="badge ${cls}">[^<]+</span>$`),
    );
  });

  it('an unknown stored status is a neutral "Unknown" badge', () => {
    expect(statusBadge('<b>odd</b>' as WorkspaceStatus).value).toBe(
      '<span class="badge neutral">Unknown</span>',
    );
  });
});
