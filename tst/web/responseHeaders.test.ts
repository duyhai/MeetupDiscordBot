import express, { RequestHandler } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { dashboardRouterFromEnv } from '../../src/web/dashboardDeps.js';
import {
  DashboardDeps,
  baseSecurityHeaders,
} from '../../src/web/dashboardRouter.js';
import { FixedWindowLimiter } from '../../src/web/rateLimit.js';
import { signSessionId } from '../../src/web/session.js';
import { timedCacheFactory } from '../../src/web/timedCache.js';
import { LoopbackResponse } from '../setup/loopbackServer.js';
import {
  Client,
  ORIGIN,
  SECRET,
  closeServers,
  makeApp,
  serve,
  signIn,
} from './dashboardHarness.js';

afterEach(closeServers);

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Hook routes that exercise the error and raw-bytes paths. */
const hooks: DashboardDeps['protectedRoutes'] = (r) => {
  r.get('/boom', (async () => {
    await Promise.resolve();
    throw new Error('boom');
  }) as RequestHandler);
  r.get('/image', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(PNG_HEAD);
  });
};

function expectFramingHeaders(res: LoopbackResponse, label: string) {
  const h = res.headers as Record<string, string | undefined>;
  expect(h['x-frame-options'], label).toBe('DENY');
  expect(h['content-security-policy'], label).toContain(
    "frame-ancestors 'none'",
  );
  expect(h['x-content-type-options'], label).toBe('nosniff');
  expect(h['cache-control'], label).toBe('no-store');
  expect(h['referrer-policy'], label).toBe('same-origin');
  expect(h['strict-transport-security'], label).toBe('max-age=15552000');
}

describe('baseSecurityHeaders', () => {
  it('carries the nonce in style-src and script-src', () => {
    const headers = baseSecurityHeaders('N0NCE');
    expect(headers['Content-Security-Policy']).toContain(
      "style-src 'nonce-N0NCE'; script-src 'nonce-N0NCE'",
    );
    expect(headers['Content-Security-Policy']).toContain("default-src 'none'");
    expect(headers['X-Robots-Tag']).toBe('noindex, nofollow');
    expect(headers.Pragma).toBe('no-cache');
  });
});

describe('every dashboard response path sends the framing and no-store headers', () => {
  it('the not-set-up page, on every path and method', async () => {
    const app = express();
    app.use('/dashboard', dashboardRouterFromEnv({}));
    const req = await serve(app);
    const rows: [string, LoopbackResponse][] = [
      ['GET /dashboard', await req.get('/dashboard')],
      ['GET /dashboard/anything', await req.get('/dashboard/anything')],
      ['POST /dashboard/x', await req.post('/dashboard/x')],
    ];
    for (const [label, res] of rows) {
      expect(res.status, label).toBe(503);
      expectFramingHeaders(res, label);
    }
  });

  it('the plain-HTTP 308', async () => {
    const { req } = await makeApp({ requireHttps: true });
    const res = await req.get('/dashboard/login');
    expect(res.status).toBe(308);
    expectFramingHeaders(res, '308');
  });

  it('the public routes', async () => {
    const { req } = await makeApp();
    const login = await req.get('/dashboard/login');
    expect(login.status).toBe(200);
    expectFramingHeaders(login, '/login');
    const start = await req.get('/dashboard/auth/start');
    expect(start.status).toBe(302);
    expectFramingHeaders(start, '/auth/start');
    const callback = await req.get('/dashboard/auth/callback?state=x&code=y');
    expect(callback.status).toBe(400);
    expectFramingHeaders(callback, '/auth/callback');
  });

  it('the gate', async () => {
    const { req } = await makeApp();
    const get = await req.get('/dashboard');
    expect(get.status).toBe(302);
    expectFramingHeaders(get, 'gate GET');
    const post = await req.post('/dashboard/logout');
    expect(post.status).toBe(403);
    expectFramingHeaders(post, 'gate POST');
  });

  it('the 404 fallback, a 500, and an image response', async () => {
    const { req } = await makeApp({ protectedRoutes: hooks });
    const cookie = await signIn(req);
    const missing = await req.get('/dashboard/nope').set('Cookie', cookie);
    expect(missing.status).toBe(404);
    expectFramingHeaders(missing, '404');
    const boom = await req.get('/dashboard/boom').set('Cookie', cookie);
    expect(boom.status).toBe(500);
    expectFramingHeaders(boom, '500');
    const image = await req.get('/dashboard/image').set('Cookie', cookie);
    expect(image.status).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');
    expectFramingHeaders(image, 'image');
  });

  it('the 429', async () => {
    const { req } = await makeApp({
      loginLimiter: new FixedWindowLimiter(0, 60_000),
    });
    const res = await req.get('/dashboard/auth/start');
    expect(res.status).toBe(429);
    expectFramingHeaders(res, '429');
  });

  it('the 400 for an oversized body', async () => {
    const { req } = await makeApp();
    const cookie = await signIn(req);
    const res = await req
      .post('/dashboard/logout')
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .type('form')
      .send(`_csrf=${'a'.repeat(33 * 1024)}`);
    expect(res.status).toBe(400);
    expectFramingHeaders(res, '400');
  });

  it('the 503 on a cache timeout', async () => {
    const never = () => new Promise<never>(() => undefined);
    const { req } = await makeApp({
      cache: timedCacheFactory(
        async () => ({
          get: never,
          set: never,
          exclusive_set: never,
          set_existing: never,
          remove: never,
        }),
        50,
      ),
    });
    const res = await req
      .get('/dashboard')
      .set('Cookie', `dash_sid=${signSessionId('sid', SECRET)}`);
    expect(res.status).toBe(503);
    expectFramingHeaders(res, '503 cache timeout');
  });

  it('the 503 when Discord cannot be asked', async () => {
    const { req } = await makeApp({
      checkAccess: vi.fn().mockRejectedValue(new Error('down')),
    });
    const res = await signInStatus(req);
    expect(res.status).toBe(503);
    expectFramingHeaders(res, '503');
  });
});

/** Runs start → callback and returns the callback response. */
async function signInStatus(req: Client): Promise<LoopbackResponse> {
  const start = await req.get('/dashboard/auth/start');
  const state =
    new URL(String(start.headers.location)).searchParams.get('state') ?? '';
  const cookie = ((start.headers['set-cookie'] ?? []) as unknown as string[])
    .find((c) => c.startsWith('dash_oauth='))
    ?.split(';')[0];
  return req
    .get(`/dashboard/auth/callback?state=${state}&code=c`)
    .set('Cookie', cookie ?? '');
}
