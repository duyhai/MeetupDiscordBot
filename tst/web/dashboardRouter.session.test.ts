import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import {
  PUBLIC_ROUTE_PATHS,
  createDashboardRouter,
  protectedRouteList,
} from '../../src/web/dashboardRouter.js';
import { ORIGIN, makeApp, signIn } from './dashboardHarness.js';
import { FakeCache } from './fakeCache.js';

const hasSession = (cache: FakeCache) =>
  [...cache.values.keys()].some((k) => k.startsWith('dashboard-session-'));

describe('dashboard session gate', () => {
  it('redirects a signed-out GET to the login page', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/dashboard');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/dashboard/login');
  });

  it('refuses a signed-out POST with 403', async () => {
    const { app } = makeApp();
    expect((await request(app).post('/dashboard/logout')).status).toBe(403);
  });

  it('rejects a forged or tampered session cookie', async () => {
    const { app } = makeApp();
    const cookie = await signIn(app);
    const tampered = `${cookie.slice(0, -2)}xx`;
    expect(
      (await request(app).get('/dashboard').set('Cookie', tampered)).status,
    ).toBe(302);
    expect(
      (await request(app).get('/dashboard').set('Cookie', 'dash_sid=abc.def'))
        .status,
    ).toBe(302);
  });

  it('serves pages without re-checking the role inside 10 minutes', async () => {
    let now = 0;
    const checkAccess = vi.fn().mockResolvedValue(true);
    const { app } = makeApp({ checkAccess, now: () => now });
    const cookie = await signIn(app);
    now = 9 * 60 * 1000;
    expect(
      (await request(app).get('/dashboard').set('Cookie', cookie)).status,
    ).toBe(200);
    expect(checkAccess).toHaveBeenCalledTimes(1);
  });

  it('re-checks the role after 10 minutes and destroys the session when it is gone', async () => {
    let now = 0;
    const checkAccess = vi.fn().mockResolvedValue(true);
    const { app, cache, deps } = makeApp({ checkAccess, now: () => now });
    const cookie = await signIn(app);
    now = 10 * 60 * 1000;
    checkAccess.mockResolvedValue(false);
    const res = await request(app).get('/dashboard').set('Cookie', cookie);
    expect(res.status).toBe(403);
    expect(hasSession(cache)).toBe(false);
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Dashboard session ended' }),
    );
    expect(
      (await request(app).get('/dashboard').set('Cookie', cookie)).status,
    ).toBe(302);
  });

  it('keeps the session but answers 503 when Discord is unreachable at re-check', async () => {
    let now = 0;
    const checkAccess = vi.fn().mockResolvedValue(true);
    const { app } = makeApp({ checkAccess, now: () => now });
    const cookie = await signIn(app);
    now = 11 * 60 * 1000;
    checkAccess.mockRejectedValueOnce(new Error('down'));
    expect(
      (await request(app).get('/dashboard').set('Cookie', cookie)).status,
    ).toBe(503);
    expect(
      (await request(app).get('/dashboard').set('Cookie', cookie)).status,
    ).toBe(200);
  });

  it('expires the session 12 hours after sign-in', async () => {
    let now = 0;
    const { app } = makeApp({ now: () => now });
    const cookie = await signIn(app);
    // Re-check runs here and resets roleCheckedAt, so the request at the
    // 12-hour mark is inside the re-check window and only the absolute
    // expiry in SessionStore.get can end the session.
    now = (11 * 60 + 55) * 60 * 1000;
    expect(
      (await request(app).get('/dashboard').set('Cookie', cookie)).status,
    ).toBe(200);
    now = 12 * 60 * 60 * 1000;
    expect(
      (await request(app).get('/dashboard').set('Cookie', cookie)).status,
    ).toBe(302);
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
      ...makeApp().deps,
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
    const { app } = withDummies();
    const cookie = await signIn(app);
    const statuses = await Promise.all(
      (['post', 'put', 'delete'] as const).map(
        async (method) =>
          (await request(app)[method]('/dashboard/dummy').set('Cookie', cookie))
            .status,
      ),
    );
    expect(statuses).toEqual([403, 403, 403]);
    expect(
      (await request(app).get('/dashboard/dummy').set('Cookie', cookie)).status,
    ).toBe(200);
  });

  it('accepts a hook route with the token in the body or the header', async () => {
    const { app } = withDummies();
    const cookie = await signIn(app);
    const token = /name="_csrf" value="([^"]+)"/.exec(
      (await request(app).get('/dashboard').set('Cookie', cookie)).text,
    )[1];
    expect(
      (
        await request(app)
          .post('/dashboard/dummy')
          .set('Cookie', cookie)
          .type('form')
          .send({ _csrf: token })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .delete('/dashboard/dummy')
          .set('Cookie', cookie)
          .set('X-CSRF-Token', token)
      ).status,
    ).toBe(200);
  });

  it('refuses a hook route when signed out', async () => {
    const { app } = withDummies();
    expect((await request(app).put('/dashboard/dummy')).status).toBe(403);
    expect((await request(app).get('/dashboard/dummy')).status).toBe(302);
  });
});

describe('dashboard CSRF and logout', () => {
  const csrfFrom = (page: string) =>
    /name="_csrf" value="([^"]+)"/.exec(page)[1];

  it('rejects a POST without the CSRF token', async () => {
    const { app } = makeApp();
    const cookie = await signIn(app);
    const res = await request(app)
      .post('/dashboard/logout')
      .set('Cookie', cookie)
      .type('form')
      .send({});
    expect(res.status).toBe(403);
  });

  it('rejects a same-origin POST that has no token', async () => {
    const { app } = makeApp();
    const cookie = await signIn(app);
    const res = await request(app)
      .post('/dashboard/logout')
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .type('form')
      .send({});
    expect(res.status).toBe(403);
  });

  it('rejects Origin: null and Sec-Fetch-Site: cross-site even with the token', async () => {
    const { app } = makeApp();
    const cookie = await signIn(app);
    const token = csrfFrom(
      (await request(app).get('/dashboard').set('Cookie', cookie)).text,
    );
    expect(
      (
        await request(app)
          .post('/dashboard/logout')
          .set('Cookie', cookie)
          .set('Origin', 'null')
          .type('form')
          .send({ _csrf: token })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post('/dashboard/logout')
          .set('Cookie', cookie)
          .set('Sec-Fetch-Site', 'cross-site')
          .type('form')
          .send({ _csrf: token })
      ).status,
    ).toBe(403);
  });

  it('rejects a POST with the wrong token or a foreign Origin', async () => {
    const { app } = makeApp();
    const cookie = await signIn(app);
    const token = csrfFrom(
      (await request(app).get('/dashboard').set('Cookie', cookie)).text,
    );
    expect(
      (
        await request(app)
          .post('/dashboard/logout')
          .set('Cookie', cookie)
          .type('form')
          .send({ _csrf: 'nope' })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post('/dashboard/logout')
          .set('Cookie', cookie)
          .set('Origin', 'https://evil.example')
          .type('form')
          .send({ _csrf: token })
      ).status,
    ).toBe(403);
  });

  it('logs out with a valid token and the session no longer works', async () => {
    const { app } = makeApp();
    const cookie = await signIn(app);
    const token = csrfFrom(
      (await request(app).get('/dashboard').set('Cookie', cookie)).text,
    );
    const out = await request(app)
      .post('/dashboard/logout')
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: token });
    expect(out.status).toBe(303);
    expect(out.headers.location).toBe('/dashboard/login');
    expect(
      (await request(app).get('/dashboard').set('Cookie', cookie)).status,
    ).toBe(302);
  });

  it('answers unknown dashboard paths with the generic 404 page when signed in', async () => {
    const { app } = makeApp();
    const cookie = await signIn(app);
    const res = await request(app).get('/dashboard/nope').set('Cookie', cookie);
    expect(res.status).toBe(404);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('answers an oversized form body with the generic 400 page', async () => {
    const { app } = makeApp();
    const cookie = await signIn(app);
    const res = await request(app)
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
    const { app } = makeApp({
      cache: async () => {
        throw new Error('redis gone: secret detail');
      },
    });
    const res = await request(app).get('/dashboard/auth/start');
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('secret detail');
  });
});

describe('protectedRouteList', () => {
  it('protectedRouteList throws for a router without the gate', () => {
    expect(() => protectedRouteList(express.Router())).toThrow(
      'dashboard router has no session gate',
    );
  });
});
