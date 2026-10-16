import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PUBLIC_ROUTE_PATHS,
  createDashboardRouter,
  httpsRedirectTarget,
  protectedRouteList,
} from '../../src/web/dashboardRouter.js';
import { FixedWindowLimiter } from '../../src/web/rateLimit.js';
import { signSessionId } from '../../src/web/session.js';
import {
  ORIGIN,
  SECRET,
  closeServers,
  makeApp,
  makeDeps,
  rawRequest,
  signIn,
  startSignIn,
} from './dashboardHarness.js';
import { FakeCache } from './fakeCache.js';

afterEach(closeServers);

const hasSession = (cache: FakeCache) =>
  [...cache.values.keys()].some((k) => k.startsWith('dashboard-session-'));

describe('dashboard session gate', () => {
  it('redirects a signed-out GET to the login page', async () => {
    const { req } = await makeApp();
    const res = await req.get('/dashboard');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/dashboard/login');
  });

  it('refuses a signed-out POST with 403', async () => {
    const { req } = await makeApp();
    expect((await req.post('/dashboard/logout')).status).toBe(403);
  });

  it('rejects a forged or tampered session cookie', async () => {
    const { req } = await makeApp();
    const cookie = await signIn(req);
    const tampered = `${cookie.slice(0, -2)}xx`;
    expect((await req.get('/dashboard').set('Cookie', tampered)).status).toBe(
      302,
    );
    expect(
      (await req.get('/dashboard').set('Cookie', 'dash_sid=abc.def')).status,
    ).toBe(302);
  });

  it('serves pages without re-checking the role inside 10 minutes', async () => {
    let now = 0;
    const checkAccess = vi.fn().mockResolvedValue(true);
    const { req } = await makeApp({ checkAccess, now: () => now });
    const cookie = await signIn(req);
    now = 9 * 60 * 1000;
    expect((await req.get('/dashboard').set('Cookie', cookie)).status).toBe(
      200,
    );
    expect(checkAccess).toHaveBeenCalledTimes(1);
  });

  it('re-checks the role after 10 minutes and destroys the session when it is gone', async () => {
    let now = 0;
    const checkAccess = vi.fn().mockResolvedValue(true);
    const { req, cache, deps } = await makeApp({ checkAccess, now: () => now });
    const cookie = await signIn(req);
    now = 10 * 60 * 1000;
    checkAccess.mockResolvedValue(false);
    const res = await req.get('/dashboard').set('Cookie', cookie);
    expect(res.status).toBe(403);
    expect(hasSession(cache)).toBe(false);
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Dashboard session ended' }),
    );
    expect((await req.get('/dashboard').set('Cookie', cookie)).status).toBe(
      302,
    );
  });

  it('keeps the session but answers 503 when Discord is unreachable at re-check', async () => {
    let now = 0;
    const checkAccess = vi.fn().mockResolvedValue(true);
    const { req } = await makeApp({ checkAccess, now: () => now });
    const cookie = await signIn(req);
    now = 11 * 60 * 1000;
    checkAccess.mockRejectedValueOnce(new Error('down'));
    expect((await req.get('/dashboard').set('Cookie', cookie)).status).toBe(
      503,
    );
    expect((await req.get('/dashboard').set('Cookie', cookie)).status).toBe(
      200,
    );
  });

  it('expires the session 12 hours after sign-in', async () => {
    let now = 0;
    const { req } = await makeApp({ now: () => now });
    const cookie = await signIn(req);
    // Re-check runs here and resets roleCheckedAt, so the request at the
    // 12-hour mark is inside the re-check window and only the absolute
    // expiry in SessionStore.get can end the session.
    now = (11 * 60 + 55) * 60 * 1000;
    expect((await req.get('/dashboard').set('Cookie', cookie)).status).toBe(
      200,
    );
    now = 12 * 60 * 60 * 1000;
    expect((await req.get('/dashboard').set('Cookie', cookie)).status).toBe(
      302,
    );
  });
});

describe('dashboard home organizer status', () => {
  const status = (over: Record<string, unknown> = {}) => ({
    stored: true,
    failingSince: null,
    ...over,
  });

  it('home shows the organizer login status from homeStatus', async () => {
    const { req } = await makeApp({
      homeStatus: async () => status() as never,
    });
    const cookie = await signIn(req);
    const res = await req.get('/dashboard').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('OK (no failure on record)');
    expect(res.text).toContain('href="/dashboard/organizer-login"');
  });

  it('home shows Not set up when there is no credential store', async () => {
    const { req } = await makeApp({ homeStatus: async () => undefined });
    const cookie = await signIn(req);
    const res = await req.get('/dashboard').set('Cookie', cookie);
    expect(res.text).toContain('Not set up');
  });

  it('home still answers 200 with "Status unavailable" when homeStatus throws', async () => {
    const { req } = await makeApp({
      homeStatus: async () => {
        throw new Error('db down');
      },
    });
    const cookie = await signIn(req);
    const res = await req.get('/dashboard').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Status unavailable');
    expect(res.text).not.toContain('db down');
  });

  it('signed-out home still redirects', async () => {
    const { req } = await makeApp({
      homeStatus: async () => status() as never,
    });
    const res = await req.get('/dashboard');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/dashboard/login');
  });
});

describe('signed-out requests leave the session cookie alone', () => {
  const clearsSid = (res: { headers: Record<string, unknown> }) =>
    ((res.headers['set-cookie'] ?? []) as string[]).some((c) =>
      c.startsWith('dash_sid='),
    );

  it('does not clear an absent or unverifiable session cookie', async () => {
    const { req } = await makeApp();
    const responses = [
      await req.get('/dashboard'),
      await req.get('/dashboard').set('Cookie', 'dash_sid=abc.def'),
      await req.post('/dashboard/logout').set('Cookie', 'dash_sid=abc.def'),
      await req.post('/dashboard/logout'),
    ];
    expect(responses.map((r) => r.status)).toEqual([302, 302, 403, 403]);
    expect(responses.some(clearsSid)).toBe(false);
  });

  it('clears a verified session cookie whose session is gone', async () => {
    const { req, cache } = await makeApp();
    const cookie = await signIn(req);
    cache.values.clear();
    const res = await req.get('/dashboard').set('Cookie', cookie);
    expect(res.status).toBe(302);
    expect(res.headers['set-cookie']).toContain(
      'dash_sid=; Path=/dashboard; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
    );
  });

  it('a forged dash_sid placed first does not hide the real one', async () => {
    const { req } = await makeApp();
    const cookie = await signIn(req);
    const res = await req
      .get('/dashboard')
      .set('Cookie', `dash_sid=forged.x; ${cookie}`);
    expect(res.status).toBe(200);
    expect(clearsSid(res)).toBe(false);
  });

  it('a sealed OAuth cookie sent as dash_sid is not a session', async () => {
    const { req } = await makeApp();
    const { oauthCookie } = await startSignIn(req);
    const value = oauthCookie.slice('dash_oauth='.length);
    const res = await req.get('/dashboard').set('Cookie', `dash_sid=${value}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/dashboard/login');
    expect(clearsSid(res)).toBe(false);
  });

  it('forged values ahead of the real cookie cannot hide it', async () => {
    const { req } = await makeApp();
    const cookie = await signIn(req);
    const forged = ['f1', 'f2.x', 'f3.y', `f4.${'A'.repeat(43)}`].map(
      (v) => `dash_sid=${v}`,
    );
    const res = await req
      .get('/dashboard')
      .set('Cookie', [...forged, cookie].join('; '));
    expect(res.status).toBe(200);
    expect(clearsSid(res)).toBe(false);
  });

  it('tries at most three distinct dash_sid values', async () => {
    const { req, cache } = await makeApp();
    const cookie = await signIn(req);
    const get = vi.spyOn(cache, 'get');
    // Many copies of one value cost one lookup.
    const copies = Array.from({ length: 50 }, () => cookie).join('; ');
    expect((await req.get('/dashboard').set('Cookie', copies)).status).toBe(
      200,
    );
    expect(get).toHaveBeenCalledTimes(1);
    // Validly signed but sessionless values: the real one 4th is not reached.
    const ghosts = ['g1', 'g2', 'g3', 'g4'].map(
      (sid) => `dash_sid=${signSessionId(sid, SECRET)}`,
    );
    get.mockClear();
    const fourth = await req
      .get('/dashboard')
      .set('Cookie', [...ghosts.slice(0, 3), cookie].join('; '));
    expect(fourth.status).toBe(302);
    expect(get).toHaveBeenCalledTimes(3);
    const third = await req
      .get('/dashboard')
      .set('Cookie', [...ghosts.slice(0, 2), cookie].join('; '));
    expect(third.status).toBe(200);
  });

  it('wrong-case and encoded paths never serve a protected page or log out', async () => {
    const { req, server } = await makeApp();
    const cookie = await signIn(req);
    const paths = [
      '/Dashboard',
      '/DASHBOARD/',
      '/dashboard/Login',
      '/dashboard%2flogin',
      '/dashboard/./',
    ];
    // Sent over a raw socket: through nock, an HTTP client would read
    // `//dashboard` as a protocol-relative URL to host "dashboard".
    const RAW_PATH = '//dashboard';
    const raw = (headers: Record<string, string> = {}) =>
      rawRequest(server, 'GET', RAW_PATH, headers);
    const rawClearsSid = (res: { headers: Record<string, string> }) =>
      (res.headers['set-cookie'] ?? '')
        .split('\n')
        .some((c) => c.startsWith('dash_sid='));

    const rawSignedOut = await raw();
    expect(rawSignedOut.status).toBe(404);
    // Express itself answered, for the exact path bytes sent.
    expect(rawSignedOut.body).toContain('Cannot GET //dashboard');
    expect(rawClearsSid(rawSignedOut)).toBe(false);
    const rawSignedIn = await raw({ Cookie: cookie });
    expect(rawSignedIn.status).toBe(404);
    expect(rawClearsSid(rawSignedIn)).toBe(false);

    const signedOut = await Promise.all(paths.map(async (p) => req.get(p)));
    for (const [i, res] of signedOut.entries()) {
      const gated =
        res.status === 404 ||
        (res.status === 302 && res.headers.location === '/dashboard/login');
      expect({ path: paths[i], gated }).toEqual({
        path: paths[i],
        gated: true,
      });
      expect(clearsSid(res)).toBe(false);
    }
    // Browsers match cookie paths case-sensitively; a signed-in member who
    // lands on a wrong-case URL with or without the cookie keeps it.
    const signedIn = await Promise.all(
      paths.map(async (p) => req.get(p).set('Cookie', cookie)),
    );
    expect(signedIn.some(clearsSid)).toBe(false);
  });
});

describe('httpsRedirectTarget', () => {
  it('keeps the path and query on the configured origin', () => {
    expect(httpsRedirectTarget(ORIGIN, '/dashboard/login?a=b')).toBe(
      `${ORIGIN}/dashboard/login?a=b`,
    );
    expect(
      httpsRedirectTarget(ORIGIN, 'http://evil.example/dashboard/login?a=b'),
    ).toBe(`${ORIGIN}/dashboard/login?a=b`);
  });

  it('falls back to /dashboard when the target cannot be parsed', () => {
    expect(httpsRedirectTarget(ORIGIN, 'http://[bad/dashboard')).toBe(
      `${ORIGIN}/dashboard`,
    );
    expect(httpsRedirectTarget(ORIGIN, 'http://a:99999/dashboard')).toBe(
      `${ORIGIN}/dashboard`,
    );
  });
});

describe('HTTPS redirect', () => {
  it('redirects plain HTTP to the configured origin before anything runs', async () => {
    const { req, deps } = await makeApp({ requireHttps: true });
    const res = await req.get('/dashboard/login');
    expect(res.status).toBe(308);
    expect(res.headers.location).toBe(`${ORIGIN}/dashboard/login`);
    expect(res.headers['set-cookie']).toBeUndefined();
    // The callback would clear dash_oauth; the redirect comes first.
    const cb = await req
      .get('/dashboard/auth/callback?state=a&code=b')
      .set('Cookie', 'dash_oauth=x');
    expect(cb.status).toBe(308);
    expect(cb.headers.location).toBe(
      `${ORIGIN}/dashboard/auth/callback?state=a&code=b`,
    );
    expect(cb.headers['set-cookie']).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(deps.oauth.exchangeCode).not.toHaveBeenCalled();
  });

  it('serves requests the proxy marks as HTTPS', async () => {
    const { req } = await makeApp({ requireHttps: true });
    const res = await req
      .get('/dashboard/login')
      .set('X-Forwarded-Proto', 'https');
    expect(res.status).toBe(200);
  });

  it('never builds the redirect from the Host header', async () => {
    const { req } = await makeApp({ requireHttps: true });
    const res = await req.get('/dashboard/login').set('Host', 'evil.example');
    expect(res.status).toBe(308);
    expect(res.headers.location).toBe(`${ORIGIN}/dashboard/login`);
  });

  it('is off by default', async () => {
    const { req } = await makeApp();
    expect((await req.get('/dashboard/login')).status).toBe(200);
  });
});

describe('routes are gated by construction', () => {
  const ok = (_req: express.Request, res: express.Response) => {
    res.status(200).send('ok');
  };
  const withDummies = () =>
    makeApp({
      protectedRoutes: (r) => {
        r.get('/dummy', ok);
        r.post('/dummy', ok);
        r.put('/dummy', ok);
        r.delete('/dummy', ok);
      },
    });

  it('has no direct routes before the gate except the public ones', () => {
    const router = createDashboardRouter({
      ...makeDeps().deps,
      protectedRoutes: (r) => {
        r.post('/dummy', ok);
      },
    });
    interface Layer {
      name: string;
      route?: { path: string };
      handle: { stack?: Layer[] };
    }
    const stack = (router as unknown as { stack: Layer[] }).stack;
    const gate = stack.findIndex((l) => l.name === 'dashboardSessionGate');
    expect(gate).toBeGreaterThan(-1);
    const beforeGate = stack.slice(0, gate);
    expect(
      beforeGate
        .filter((l) => l.route)
        .map((l) => l.route.path)
        .sort(),
    ).toEqual([...PUBLIC_ROUTE_PATHS].sort());
    expect(beforeGate.filter((l) => !l.route).map((l) => l.name)).toEqual([
      'dashboardHttpsRedirect',
      'securityHeaders',
      'urlencodedParser',
    ]);
    // The gate is followed directly by the protected router, and nothing
    // after it but the error handler.
    const after = stack.slice(gate + 1);
    expect(after.map((l) => l.name)).toEqual([
      'router',
      'dashboardErrorHandler',
    ]);
    // Inside the protected router the unsafe-method guard comes first.
    expect(after[0].handle.stack[0].name).toBe('dashboardUnsafeMethodGuard');
    expect(protectedRouteList(router)).toEqual(
      expect.arrayContaining([
        { method: 'get', path: '/' },
        { method: 'post', path: '/logout' },
        { method: 'post', path: '/dummy' },
      ]),
    );
  });

  it('refuses POST, PUT and DELETE on a hook route without a token', async () => {
    const { req } = await withDummies();
    const cookie = await signIn(req);
    const statuses = await Promise.all(
      (['post', 'put', 'delete'] as const).map(
        async (method) =>
          (await req[method]('/dashboard/dummy').set('Cookie', cookie)).status,
      ),
    );
    expect(statuses).toEqual([403, 403, 403]);
    expect(
      (await req.get('/dashboard/dummy').set('Cookie', cookie)).status,
    ).toBe(200);
  });

  it('accepts a hook route with the token in the body or the header', async () => {
    const { req } = await withDummies();
    const cookie = await signIn(req);
    const token = /name="_csrf" value="([^"]+)"/.exec(
      (await req.get('/dashboard').set('Cookie', cookie)).text,
    )[1];
    expect(
      (
        await req
          .post('/dashboard/dummy')
          .set('Cookie', cookie)
          .type('form')
          .send({ _csrf: token })
      ).status,
    ).toBe(200);
    expect(
      (
        await req
          .delete('/dashboard/dummy')
          .set('Cookie', cookie)
          .set('X-CSRF-Token', token)
      ).status,
    ).toBe(200);
  });

  it('refuses a hook route when signed out', async () => {
    const { req } = await withDummies();
    expect((await req.put('/dashboard/dummy')).status).toBe(403);
    expect((await req.get('/dashboard/dummy')).status).toBe(302);
  });

  it('treats only GET and HEAD as safe', async () => {
    const { req } = await withDummies();
    const head = await req.head('/dashboard');
    expect(head.status).toBe(302);
    expect(head.headers.location).toBe('/dashboard/login');
    expect((await req.options('/dashboard')).status).toBe(403);
    const cookie = await signIn(req);
    expect((await req.head('/dashboard').set('Cookie', cookie)).status).toBe(
      200,
    );
    expect(
      (await req.options('/dashboard/dummy').set('Cookie', cookie)).status,
    ).toBe(403);
  });

  it('rate-limits unsafe requests per user', async () => {
    const { req } = await makeApp({
      actionLimiter: new FixedWindowLimiter(1, 60_000),
      protectedRoutes: (r) => {
        r.post('/dummy', ok);
      },
    });
    const cookie = await signIn(req);
    const token = /name="_csrf" value="([^"]+)"/.exec(
      (await req.get('/dashboard').set('Cookie', cookie)).text,
    )[1];
    const post = () =>
      req
        .post('/dashboard/dummy')
        .set('Cookie', cookie)
        .set('Origin', ORIGIN)
        .type('form')
        .send({ _csrf: token });
    expect((await post()).status).toBe(200);
    const second = await post();
    expect(second.status).toBe(429);
    expect(Number(second.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('dashboard CSRF and logout', () => {
  const csrfFrom = (page: string) =>
    /name="_csrf" value="([^"]+)"/.exec(page)[1];

  it('rejects a POST without the CSRF token', async () => {
    const { req } = await makeApp();
    const cookie = await signIn(req);
    const res = await req
      .post('/dashboard/logout')
      .set('Cookie', cookie)
      .type('form')
      .send({});
    expect(res.status).toBe(403);
  });

  it('rejects a same-origin POST that has no token', async () => {
    const { req } = await makeApp();
    const cookie = await signIn(req);
    const res = await req
      .post('/dashboard/logout')
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .type('form')
      .send({});
    expect(res.status).toBe(403);
  });

  it('rejects Origin: null and Sec-Fetch-Site: cross-site even with the token', async () => {
    const { req } = await makeApp();
    const cookie = await signIn(req);
    const token = csrfFrom(
      (await req.get('/dashboard').set('Cookie', cookie)).text,
    );
    expect(
      (
        await req
          .post('/dashboard/logout')
          .set('Cookie', cookie)
          .set('Origin', 'null')
          .type('form')
          .send({ _csrf: token })
      ).status,
    ).toBe(403);
    expect(
      (
        await req
          .post('/dashboard/logout')
          .set('Cookie', cookie)
          .set('Sec-Fetch-Site', 'cross-site')
          .type('form')
          .send({ _csrf: token })
      ).status,
    ).toBe(403);
  });

  it('rejects a POST with the wrong token or a foreign Origin', async () => {
    const { req } = await makeApp();
    const cookie = await signIn(req);
    const token = csrfFrom(
      (await req.get('/dashboard').set('Cookie', cookie)).text,
    );
    expect(
      (
        await req
          .post('/dashboard/logout')
          .set('Cookie', cookie)
          .type('form')
          .send({ _csrf: 'nope' })
      ).status,
    ).toBe(403);
    expect(
      (
        await req
          .post('/dashboard/logout')
          .set('Cookie', cookie)
          .set('Origin', 'https://evil.example')
          .type('form')
          .send({ _csrf: token })
      ).status,
    ).toBe(403);
  });

  it('logs out with a valid token and the session no longer works', async () => {
    const { req } = await makeApp();
    const cookie = await signIn(req);
    const token = csrfFrom(
      (await req.get('/dashboard').set('Cookie', cookie)).text,
    );
    const out = await req
      .post('/dashboard/logout')
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: token });
    expect(out.status).toBe(303);
    expect(out.headers.location).toBe('/dashboard/login');
    expect((await req.get('/dashboard').set('Cookie', cookie)).status).toBe(
      302,
    );
  });

  it('answers unknown dashboard paths with the generic 404 page when signed in', async () => {
    const { req } = await makeApp();
    const cookie = await signIn(req);
    const res = await req.get('/dashboard/nope').set('Cookie', cookie);
    expect(res.status).toBe(404);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('answers an oversized form body with the generic 400 page', async () => {
    const { req } = await makeApp();
    const cookie = await signIn(req);
    const res = await req
      .post('/dashboard/logout')
      .set('Cookie', cookie)
      .type('form')
      .send(`_csrf=${'a'.repeat(20 * 1024)}`);
    expect(res.status).toBe(400);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).not.toContain('entity too large');
    expect(res.text).not.toContain('PayloadTooLarge');
  });

  it('renders the generic 500 page when a dependency throws', async () => {
    const { req } = await makeApp({
      cache: async () => {
        throw new Error('redis gone: secret detail');
      },
    });
    const res = await req
      .get('/dashboard')
      .set('Cookie', `dash_sid=${signSessionId('sid', SECRET)}`);
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('secret detail');
  });
});

describe('protected router case sensitivity', () => {
  const csrfOf = async (
    req: Awaited<ReturnType<typeof makeApp>>['req'],
    cookie: string,
  ) =>
    /name="_csrf" value="([^"]+)"/.exec(
      (await req.get('/dashboard').set('Cookie', cookie)).text,
    )[1];

  it('wrong-case protected paths are 404, not the real route', async () => {
    const { req } = await makeApp({
      protectedRoutes: (r) => {
        r.get('/dummy', (_req, res) => {
          res.status(200).send('ok');
        });
      },
    });
    const cookie = await signIn(req);
    const token = await csrfOf(req, cookie);
    const wrong = await req
      .post('/dashboard/Logout')
      .set('Cookie', cookie)
      .type('form')
      .send({ _csrf: token });
    expect(wrong.status).toBe(404);
    // The session survived: the wrong-case path did not log anyone out.
    expect((await req.get('/dashboard').set('Cookie', cookie)).status).toBe(
      200,
    );
    expect(
      (await req.get('/dashboard/DUMMY').set('Cookie', cookie)).status,
    ).toBe(404);
    expect(
      (await req.get('/dashboard/dummy').set('Cookie', cookie)).status,
    ).toBe(200);
  });
});

describe('protectedRouteList', () => {
  it('protectedRouteList throws for a router without the gate', () => {
    expect(() => protectedRouteList(express.Router())).toThrow(
      'dashboard router has no session gate',
    );
  });
});
