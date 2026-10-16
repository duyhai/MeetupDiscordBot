import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DASHBOARD_BASE } from '../../../src/lib/reports/dashboardPaths.js';
import {
  createDashboardRouter,
  protectedRouteList,
} from '../../../src/web/dashboardRouter.js';
import { registerAllProtectedRoutes } from '../../../src/web/routes/dashboardPages.js';
import { ROLE_RECHECK_MS } from '../../../src/web/session.js';
import { clientFor } from '../../setup/loopbackServer.js';
import {
  Client,
  ORIGIN,
  closeServers,
  listen,
  makeDeps,
  signIn,
} from '../dashboardHarness.js';
import { PAGE_NOW, fakeOrganizerDeps, fakePageDeps } from './pageFakes.js';

afterEach(closeServers);

/**
 * The router production builds: the same protectedRoutes hook, fake data.
 * One clock for the router (sessions, role re-check) and the pages, so a
 * test that advances it moves both.
 */
function buildRouter(clock: () => number = () => PAGE_NOW.getTime()) {
  const { deps } = makeDeps({ now: clock });
  const router = createDashboardRouter({
    ...deps,
    protectedRoutes: (r) =>
      registerAllProtectedRoutes(r, {
        organizer: fakeOrganizerDeps(),
        pages: fakePageDeps({ now: () => new Date(clock()) }),
      }),
  });
  return { deps, router };
}

// Derived from the router itself, never hand-written: a page added through
// registerAllProtectedRoutes is in the matrix by construction.
const MATRIX_ROUTER = buildRouter().router;
const ROUTES = protectedRouteList(MATRIX_ROUTER);

/** Express 5 layer shape, read only to find layers protectedRouteList cannot list. */
interface StackLayer {
  name: string;
  route?: unknown;
  handle: { stack?: StackLayer[] };
}

/**
 * The names of the protected router's non-route layers, in order. Anything
 * mounted with use() inside the hook (a sub-router, a path-scoped handler)
 * is a non-route layer that protectedRouteList skips, so it shows up here.
 */
function protectedUseLayers(router: express.Router): string[] {
  const outer = (router as unknown as { stack: StackLayer[] }).stack;
  const gate = outer.findIndex((l) => l.name === 'dashboardSessionGate');
  const inner = outer[gate + 1]?.handle.stack ?? [];
  return inner.filter((l) => !l.route).map((l) => l.name);
}
const GETS = ROUTES.filter((r) => r.method === 'get');
const UNSAFE = ROUTES.filter((r) => r.method !== 'get' && r.method !== 'head');

const SAMPLE_PARAMS: Record<string, string> = {
  period: '2026-09',
  memberId: '123456',
  id: '1',
  side: 'old',
};

/** Statuses other than 200 that a signed-in, allowed GET is expected to answer. */
const EXPECTED_ALLOWED: Record<string, number> = {
  'GET /organizer-login/complete': 400,
};

/**
 * What every state-changing route answers to a signed-in POST with a valid
 * token and an empty form. Required for each one, so a crash (500) or a
 * rate-limit answer (429) fails rather than passing as "not 403".
 */
const EXPECTED_UNSAFE_ALLOWED: Record<string, number> = {
  'POST /logout': 303,
  'POST /organizer-login/start': 200,
  'POST /sessions/revoke': 303,
  'POST /reports/:period/refresh': 303,
};

function concrete(path: string): string {
  return `${DASHBOARD_BASE}${path.replace(
    /:([A-Za-z]+)/g,
    (_m, name: string) => {
      const sample = SAMPLE_PARAMS[name];
      if (sample === undefined) {
        throw new Error(`add a sample for :${name}`);
      }
      return sample;
    },
  )}`.replace(/\/$/, '');
}

const label = (r: { method: string; path: string }) =>
  `${r.method.toUpperCase()} ${r.path}`;

async function setup() {
  let clock = PAGE_NOW.getTime();
  const { deps, router } = buildRouter(() => clock);
  const app = express();
  app.set('trust proxy', 1);
  app.use(DASHBOARD_BASE, router);
  const req = clientFor(await listen(app));
  return {
    deps,
    req,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

async function csrfToken(req: Client, cookie: string): Promise<string> {
  const home = await req.get('/dashboard').set('Cookie', cookie);
  const match = /name="_csrf" value="([^"]+)"/.exec(home.text);
  if (!match) {
    throw new Error('home page has no CSRF field');
  }
  return match[1];
}

describe('access matrix', () => {
  it('is built from the protected router', () => {
    expect(ROUTES.length).toBeGreaterThan(0);
    const labels = ROUTES.map(label);
    expect(labels).toContain('GET /');
    expect(labels).toContain('POST /logout');
    expect(labels).toContain('GET /organizer-login');
    expect(labels).toContain('GET /sessions');
    expect(labels).toContain('POST /sessions/revoke');
    expect(labels).toContain('GET /hall-of-fame');
    expect(labels).toContain('GET /hall-of-fame/:period');
    expect(labels).toContain('POST /reports/:period/refresh');
    expect(UNSAFE.length).toBeGreaterThan(0);
  });

  it('has no use() layers the route list cannot see', () => {
    // Only the CSRF / Origin / rate-limit guard first and the 404 fallback
    // last. A page mounted with router.use(...) would be gated but missing
    // from the matrix, so any extra layer fails here.
    expect(protectedUseLayers(MATRIX_ROUTER)).toEqual([
      'dashboardUnsafeMethodGuard',
      'dashboardNotFound',
    ]);
  });

  it('has a sample for every route parameter', () => {
    for (const route of ROUTES) {
      expect(() => concrete(route.path)).not.toThrow();
    }
  });

  describe.each(GETS.map((r) => [label(r), r] as const))(
    '%s',
    (name, route) => {
      const path = concrete(route.path);

      it('signed out → 302 to /dashboard/login', async () => {
        const { req } = await setup();
        const res = await req.get(path);
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/dashboard/login');
      });

      it('role gone at re-check → 403', async () => {
        const { deps, req, advance } = await setup();
        const cookie = await signIn(req);
        advance(ROLE_RECHECK_MS);
        vi.mocked(deps.checkAccess).mockResolvedValueOnce(false);
        const res = await req.get(path).set('Cookie', cookie);
        expect(res.status).toBe(403);
      });

      it(`allowed → ${EXPECTED_ALLOWED[name] ?? 200}`, async () => {
        const { req } = await setup();
        const cookie = await signIn(req);
        const res = await req.get(path).set('Cookie', cookie);
        expect(res.status).toBe(EXPECTED_ALLOWED[name] ?? 200);
      });

      it('answers no-store and nosniff', async () => {
        const { req } = await setup();
        const cookie = await signIn(req);
        const res = await req.get(path).set('Cookie', cookie);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.headers['x-content-type-options']).toBe('nosniff');
      });
    },
  );

  describe.each(UNSAFE.map((r) => [label(r), r] as const))(
    '%s',
    (name, route) => {
      const path = concrete(route.path);
      const send = (req: Client) => {
        const method = route.method as 'post' | 'put' | 'patch' | 'delete';
        return req[method](path);
      };

      it('signed out → 403', async () => {
        const { req } = await setup();
        const res = await send(req).set('Origin', ORIGIN).type('form').send({});
        expect(res.status).toBe(403);
      });

      it('no token → 403', async () => {
        const { req } = await setup();
        const cookie = await signIn(req);
        const res = await send(req)
          .set('Cookie', cookie)
          .set('Origin', ORIGIN)
          .type('form')
          .send({});
        expect(res.status).toBe(403);
      });

      it('wrong token → 403', async () => {
        const { req } = await setup();
        const cookie = await signIn(req);
        const res = await send(req)
          .set('Cookie', cookie)
          .set('Origin', ORIGIN)
          .type('form')
          .send({ _csrf: 'not-the-token' });
        expect(res.status).toBe(403);
      });

      it('cross-site → 403', async () => {
        const { req } = await setup();
        const cookie = await signIn(req);
        const token = await csrfToken(req, cookie);
        const res = await send(req)
          .set('Cookie', cookie)
          .set('Origin', ORIGIN)
          .set('Sec-Fetch-Site', 'cross-site')
          .type('form')
          .send({ _csrf: token });
        expect(res.status).toBe(403);
      });

      it(`with a token → ${EXPECTED_UNSAFE_ALLOWED[name] ?? '(add an expected status)'}`, async () => {
        expect(
          EXPECTED_UNSAFE_ALLOWED[name],
          'add an expected status',
        ).toBeDefined();
        const { req } = await setup();
        const cookie = await signIn(req);
        const token = await csrfToken(req, cookie);
        const res = await send(req)
          .set('Cookie', cookie)
          .set('Origin', ORIGIN)
          .set('Sec-Fetch-Site', 'same-origin')
          .type('form')
          .send({ _csrf: token });
        expect(res.status).toBe(EXPECTED_UNSAFE_ALLOWED[name]);
      });
    },
  );
});
