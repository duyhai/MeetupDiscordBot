import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { DashboardDeps } from '../../src/web/dashboardRouter.js';
import { USER, makeApp, signIn } from './dashboardHarness.js';

describe('dashboard sign-in', () => {
  it('sends security headers and no-store on every response', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/dashboard/login');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('same-origin');
    expect(res.headers['content-security-policy']).toMatch(
      // eslint-disable-next-line @stylistic/max-len
      /default-src 'none'; style-src 'nonce-[A-Za-z0-9+/=]+'; script-src 'nonce-[A-Za-z0-9+/=]+'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'/,
    );
  });

  it('starts sign-in with a stored verifier and a state-binding cookie', async () => {
    const { app, cache, deps } = makeApp();
    const res = await request(app).get('/dashboard/auth/start');
    expect(res.status).toBe(302);
    const state = new URL(res.headers.location).searchParams.get('state');
    expect(state).toBeTruthy();
    expect(cache.ttls.get(`dashboard-oauth-${state}`)).toBe(600);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(deps.oauth.buildLoginUrl)).toHaveBeenCalledWith(
      state,
      cache.values.get(`dashboard-oauth-${state}`),
    );
    expect(res.headers['set-cookie'][0]).toBe(
      `dash_oauth=${state}; Path=/dashboard/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    );
  });

  it('signs an allowed member in and sends them home', async () => {
    const { app, deps } = makeApp();
    const sessionCookie = await signIn(app);
    expect(sessionCookie).toMatch(/^dash_sid=.+/);
    expect(deps.checkAccess).toHaveBeenCalledWith(USER.id);
    const home = await request(app)
      .get('/dashboard')
      .set('Cookie', sessionCookie);
    expect(home.status).toBe(200);
    expect(home.text).toContain('<bdi>Mod</bdi>');
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Dashboard sign-in' }),
    );
  });

  it('sets the session cookie with all attributes and a 12-hour Max-Age', async () => {
    const { app } = makeApp();
    const start = await request(app).get('/dashboard/auth/start');
    const state = new URL(start.headers.location).searchParams.get('state');
    const cb = await request(app)
      .get(`/dashboard/auth/callback?state=${state}&code=c`)
      .set('Cookie', `dash_oauth=${state}`);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe('/dashboard');
    const sid = (cb.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('dash_sid='),
    );
    expect(sid).toMatch(
      /; Path=\/dashboard; HttpOnly; Secure; SameSite=Lax; Max-Age=43200$/,
    );
  });

  it('refuses a member without a dashboard role and creates no session', async () => {
    const { app, cache, deps } = makeApp({
      checkAccess: vi.fn().mockResolvedValue(false),
    });
    const start = await request(app).get('/dashboard/auth/start');
    const state = new URL(start.headers.location).searchParams.get('state');
    const cb = await request(app)
      .get(`/dashboard/auth/callback?state=${state}&code=c`)
      .set('Cookie', `dash_oauth=${state}`);
    expect(cb.status).toBe(403);
    expect(cb.text).toContain('only for Moderators');
    expect(
      [...cache.values.keys()].some((k) => k.startsWith('dashboard-session-')),
    ).toBe(false);
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Dashboard sign-in refused' }),
    );
  });

  it('rejects a callback whose state does not match the login cookie', async () => {
    const { app } = makeApp();
    const start = await request(app).get('/dashboard/auth/start');
    const state = new URL(start.headers.location).searchParams.get('state');
    const cb = await request(app)
      .get(`/dashboard/auth/callback?state=${state}&code=c`)
      .set('Cookie', 'dash_oauth=someone-elses-state');
    expect(cb.status).toBe(400);
    const noCookie = await request(app).get(
      `/dashboard/auth/callback?state=${state}&code=c`,
    );
    expect(noCookie.status).toBe(400);
  });

  it('rejects a replayed state', async () => {
    const { app } = makeApp();
    const start = await request(app).get('/dashboard/auth/start');
    const state = new URL(start.headers.location).searchParams.get('state');
    const first = await request(app)
      .get(`/dashboard/auth/callback?state=${state}&code=c`)
      .set('Cookie', `dash_oauth=${state}`);
    expect(first.status).toBe(302);
    const replay = await request(app)
      .get(`/dashboard/auth/callback?state=${state}&code=c`)
      .set('Cookie', `dash_oauth=${state}`);
    expect(replay.status).toBe(400);
  });

  it('shows the login page again when the member cancels on Discord', async () => {
    const { app, deps } = makeApp();
    const start = await request(app).get('/dashboard/auth/start');
    const state = new URL(start.headers.location).searchParams.get('state');
    const cb = await request(app)
      .get(`/dashboard/auth/callback?state=${state}&error=access_denied`)
      .set('Cookie', `dash_oauth=${state}`);
    expect(cb.status).toBe(400);
    expect(cb.text).toContain('Sign-in was cancelled');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(deps.oauth.exchangeCode).not.toHaveBeenCalled();
  });

  it('answers 502 with a generic page when the code exchange fails', async () => {
    const { app } = makeApp({
      oauth: {
        buildLoginUrl: (s: string) => `https://discord.com/x?state=${s}`,
        exchangeCode: vi.fn().mockRejectedValue(new Error('token body leak')),
        fetchIdentity: vi.fn(),
      },
    });
    const start = await request(app).get('/dashboard/auth/start');
    const state = new URL(start.headers.location).searchParams.get('state');
    const cb = await request(app)
      .get(`/dashboard/auth/callback?state=${state}&code=c`)
      .set('Cookie', `dash_oauth=${state}`);
    expect(cb.status).toBe(502);
    expect(cb.text).not.toContain('token body leak');
  });

  it('answers 503 and creates no session when Discord cannot be asked about roles', async () => {
    const { app } = makeApp({
      checkAccess: vi.fn().mockRejectedValue(new Error('discord down')),
    });
    const start = await request(app).get('/dashboard/auth/start');
    const state = new URL(start.headers.location).searchParams.get('state');
    const cb = await request(app)
      .get(`/dashboard/auth/callback?state=${state}&code=c`)
      .set('Cookie', `dash_oauth=${state}`);
    expect(cb.status).toBe(503);
    expect(JSON.stringify(cb.headers['set-cookie'] ?? [])).not.toContain(
      'dash_sid=',
    );
  });

  it('sends HSTS', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/dashboard/login');
    expect(res.headers['strict-transport-security']).toBe('max-age=15552000');
  });

  it('sets no session cookie on a refused or failed callback', async () => {
    const cases: Partial<DashboardDeps>[] = [
      { checkAccess: vi.fn().mockResolvedValue(false) },
      {
        oauth: {
          buildLoginUrl: (s: string) => `https://discord.com/x?state=${s}`,
          exchangeCode: vi.fn().mockRejectedValue(new Error('x')),
          fetchIdentity: vi.fn(),
        },
      },
    ];
    await Promise.all(
      cases.map(async (overrides) => {
        const { app } = makeApp(overrides);
        const start = await request(app).get('/dashboard/auth/start');
        const state = new URL(start.headers.location).searchParams.get('state');
        const cb = await request(app)
          .get(`/dashboard/auth/callback?state=${state}&code=c`)
          .set('Cookie', `dash_oauth=${state}`);
        expect([403, 502]).toContain(cb.status);
        expect(JSON.stringify(cb.headers['set-cookie'] ?? [])).not.toContain(
          'dash_sid=',
        );
      }),
    );
  });

  it('does not wait for the sign-in audit post', async () => {
    const { app } = makeApp({
      audit: vi.fn(() => new Promise(() => undefined)),
    });
    await expect(signIn(app)).resolves.toMatch(/^dash_sid=/);
  });

  it('rate-limits the callback as well as the start', async () => {
    const { FixedWindowLimiter } = await import('../../src/web/rateLimit.js');
    const { app } = makeApp({
      loginLimiter: new FixedWindowLimiter(1, 60_000),
    });
    await request(app).get('/dashboard/auth/callback?state=a&code=c');
    const second = await request(app).get(
      '/dashboard/auth/callback?state=a&code=c',
    );
    expect(second.status).toBe(429);
  });

  it('rate-limits sign-in per IP', async () => {
    const { FixedWindowLimiter } = await import('../../src/web/rateLimit.js');
    const { app } = makeApp({
      loginLimiter: new FixedWindowLimiter(2, 60_000),
    });
    await request(app).get('/dashboard/auth/start');
    await request(app).get('/dashboard/auth/start');
    const third = await request(app).get('/dashboard/auth/start');
    expect(third.status).toBe(429);
    expect(third.headers['retry-after']).toBeDefined();
  });
});
