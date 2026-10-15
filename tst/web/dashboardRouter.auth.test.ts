import { afterEach, describe, expect, it, vi } from 'vitest';

import { DashboardDeps } from '../../src/web/dashboardRouter.js';
import { openOAuthCookie, sealOAuthCookie } from '../../src/web/oauthCookie.js';
import { FixedWindowLimiter } from '../../src/web/rateLimit.js';
import {
  SECRET,
  USER,
  closeServers,
  locationOf,
  makeApp,
  signIn,
  startSignIn,
} from './dashboardHarness.js';

afterEach(closeServers);

describe('dashboard sign-in', () => {
  it('sends security headers and no-store on every response', async () => {
    const { req } = await makeApp();
    const res = await req.get('/dashboard/login');
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

  it('starts sign-in with a signed OAuth cookie carrying state and verifier', async () => {
    const { req, deps } = await makeApp({ now: () => 1_000 });
    const res = await req.get('/dashboard/auth/start');
    const state = locationOf(res).searchParams.get('state');
    expect(state).toBeTruthy();
    const header = (res.headers['set-cookie'] as unknown as string[])[0];
    expect(header).toMatch(
      /^dash_oauth=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; Path=\/dashboard\/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/,
    );
    const value = header.split(';')[0].slice('dash_oauth='.length);
    const opened = openOAuthCookie(value, SECRET, 1_000);
    expect(opened?.state).toBe(state);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(deps.oauth.buildLoginUrl)).toHaveBeenCalledWith(
      state,
      opened?.verifier,
    );
    // Expires 10 minutes after start.
    expect(openOAuthCookie(value, SECRET, 1_000 + 600_000 - 1)).toBeDefined();
    expect(openOAuthCookie(value, SECRET, 1_000 + 600_000)).toBeUndefined();
  });

  it('start writes nothing to the cache', async () => {
    const { req, cache } = await makeApp();
    await startSignIn(req);
    await startSignIn(req);
    expect(cache.values.size).toBe(0);
  });

  it('no cache writes or removes on any path that does not sign someone in', async () => {
    const failingOauth = {
      buildLoginUrl: (s: string) => `https://discord.com/x?state=${s}`,
      exchangeCode: vi.fn().mockRejectedValue(new Error('x')),
      fetchIdentity: vi.fn(),
    };
    const touched: string[] = [];
    // Each scenario gets a fresh app; its cache's set and remove are spied.
    const scenario = async (
      name: string,
      overrides: Partial<DashboardDeps>,
      drive: (
        req: Awaited<ReturnType<typeof makeApp>>['req'],
      ) => Promise<number>,
      expected: number,
    ) => {
      const { req, cache } = await makeApp(overrides);
      const set = vi.spyOn(cache, 'set');
      const remove = vi.spyOn(cache, 'remove');
      expect(await drive(req), name).toBe(expected);
      if (set.mock.calls.length || remove.mock.calls.length) {
        touched.push(name);
      }
      expect(cache.values.size, name).toBe(0);
    };
    const callback = async (
      req: Awaited<ReturnType<typeof makeApp>>['req'],
      cookie: (c: { state: string; oauthCookie: string }) => string | undefined,
      query = (state: string) => `state=${state}&code=c`,
    ) => {
      const started = await startSignIn(req);
      const res = await req
        .get(`/dashboard/auth/callback?${query(started.state)}`)
        .set('Cookie', cookie(started) ?? '');
      return res.status;
    };

    await scenario(
      'start',
      {},
      async (req) => {
        await startSignIn(req);
        return 200;
      },
      200,
    );
    await scenario(
      'mismatched state',
      {},
      (req) =>
        callback(
          req,
          (c) => c.oauthCookie,
          () => 'state=other&code=c',
        ),
      400,
    );
    await scenario(
      'no OAuth cookie',
      {},
      (req) => callback(req, () => ''),
      400,
    );
    await scenario(
      'tampered OAuth cookie',
      {},
      (req) => callback(req, (c) => `${c.oauthCookie.slice(0, -2)}xx`),
      400,
    );
    let now = 0;
    await scenario(
      'expired OAuth cookie',
      { now: () => now },
      async (req) => {
        const started = await startSignIn(req);
        now = 10 * 60 * 1000;
        return (
          await req
            .get(`/dashboard/auth/callback?state=${started.state}&code=c`)
            .set('Cookie', started.oauthCookie)
        ).status;
      },
      400,
    );
    await scenario(
      '403 refusal',
      { checkAccess: vi.fn().mockResolvedValue(false) },
      (req) => callback(req, (c) => c.oauthCookie),
      403,
    );
    await scenario(
      '502 exchange failure',
      { oauth: failingOauth },
      (req) => callback(req, (c) => c.oauthCookie),
      502,
    );
    await scenario(
      '503 role check failure',
      { checkAccess: vi.fn().mockRejectedValue(new Error('discord down')) },
      (req) => callback(req, (c) => c.oauthCookie),
      503,
    );
    await scenario(
      'cancelled sign-in',
      {},
      (req) =>
        callback(
          req,
          (c) => c.oauthCookie,
          (state) => `state=${state}&error=access_denied`,
        ),
      400,
    );
    expect(touched).toEqual([]);
  });

  it('hands exchangeCode exactly the verifier given to buildLoginUrl', async () => {
    const { req, deps } = await makeApp();
    await signIn(req);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const [, verifier] = vi.mocked(deps.oauth.buildLoginUrl).mock.calls[0];
    expect(verifier).toBeTruthy();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(deps.oauth.exchangeCode)).toHaveBeenCalledWith(
      'c',
      verifier,
    );
  });

  it('signs an allowed member in and sends them home', async () => {
    const { req, deps } = await makeApp();
    const sessionCookie = await signIn(req);
    expect(sessionCookie).toMatch(/^dash_sid=.+/);
    expect(deps.checkAccess).toHaveBeenCalledWith(USER.id);
    const home = await req.get('/dashboard').set('Cookie', sessionCookie);
    expect(home.status).toBe(200);
    expect(home.text).toContain('<bdi>Mod</bdi>');
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Dashboard sign-in' }),
    );
  });

  it('sets the session cookie with all attributes and a 12-hour Max-Age', async () => {
    const { req } = await makeApp();
    const { state, oauthCookie } = await startSignIn(req);
    const cb = await req
      .get(`/dashboard/auth/callback?state=${state}&code=c`)
      .set('Cookie', oauthCookie);
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
    const { req, cache, deps } = await makeApp({
      checkAccess: vi.fn().mockResolvedValue(false),
    });
    const { state, oauthCookie } = await startSignIn(req);
    const cb = await req
      .get(`/dashboard/auth/callback?state=${state}&code=c`)
      .set('Cookie', oauthCookie);
    expect(cb.status).toBe(403);
    expect(cb.text).toContain('only for Moderators');
    expect(
      [...cache.values.keys()].some((k) => k.startsWith('dashboard-session-')),
    ).toBe(false);
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Dashboard sign-in refused' }),
    );
  });

  it('rejects a callback whose state does not match the OAuth cookie', async () => {
    const { req, deps } = await makeApp();
    const { state } = await startSignIn(req);
    const other = await startSignIn(req);
    const cb = await req
      .get(`/dashboard/auth/callback?state=${state}&code=c`)
      .set('Cookie', other.oauthCookie);
    expect(cb.status).toBe(400);
    const raw = await req
      .get(`/dashboard/auth/callback?state=${state}&code=c`)
      .set('Cookie', `dash_oauth=${state}`);
    expect(raw.status).toBe(400);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(deps.oauth.exchangeCode).not.toHaveBeenCalled();
  });

  it('a callback without the OAuth cookie is refused', async () => {
    const { req, deps } = await makeApp();
    const { state } = await startSignIn(req);
    const cb = await req.get(`/dashboard/auth/callback?state=${state}&code=c`);
    expect(cb.status).toBe(400);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(deps.oauth.exchangeCode).not.toHaveBeenCalled();
  });

  it('the callback always clears the OAuth cookie', async () => {
    const cleared =
      'dash_oauth=; Path=/dashboard/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
    const { req } = await makeApp();
    const { state, oauthCookie } = await startSignIn(req);
    const responses = [
      await req.get(`/dashboard/auth/callback?state=${state}&code=c`),
      await req
        .get(`/dashboard/auth/callback?state=${state}&error=access_denied`)
        .set('Cookie', oauthCookie),
      await req
        .get(`/dashboard/auth/callback?state=${state}&code=c`)
        .set('Cookie', oauthCookie),
    ];
    expect(responses.map((r) => r.status)).toEqual([400, 400, 302]);
    for (const res of responses) {
      expect(res.headers['set-cookie']).toContain(cleared);
    }
  });

  it('an expired OAuth cookie is refused', async () => {
    let now = 0;
    const { req, deps } = await makeApp({ now: () => now });
    const { state, oauthCookie } = await startSignIn(req);
    now = 10 * 60 * 1000;
    const cb = await req
      .get(`/dashboard/auth/callback?state=${state}&code=c`)
      .set('Cookie', oauthCookie);
    expect(cb.status).toBe(400);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(deps.oauth.exchangeCode).not.toHaveBeenCalled();
  });

  it('a tampered OAuth cookie is refused', async () => {
    const { req, deps } = await makeApp();
    const { state, oauthCookie } = await startSignIn(req);
    const value = oauthCookie.slice('dash_oauth='.length);
    const dot = value.lastIndexOf('.');
    const body = JSON.parse(
      Buffer.from(value.slice(0, dot), 'base64url').toString(),
    ) as Record<string, unknown>;
    const forgedBody = Buffer.from(
      JSON.stringify({ ...body, e: Number.MAX_SAFE_INTEGER }),
    ).toString('base64url');
    const lastMacChar = value.endsWith('A') ? 'B' : 'A';
    const tampered = [
      `${forgedBody}${value.slice(dot)}`,
      `${value.slice(0, -1)}${lastMacChar}`,
      sealOAuthCookie(
        { state, verifier: 'v', expiresAt: Number.MAX_SAFE_INTEGER },
        'another-secret-that-is-long-enough-000',
      ),
    ];
    const statuses = await Promise.all(
      tampered.map(
        async (forged) =>
          (
            await req
              .get(`/dashboard/auth/callback?state=${state}&code=c`)
              .set('Cookie', `dash_oauth=${forged}`)
          ).status,
      ),
    );
    expect(statuses).toEqual([400, 400, 400]);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(deps.oauth.exchangeCode).not.toHaveBeenCalled();
  });

  it('shows the login page again when the member cancels on Discord', async () => {
    const { req, deps } = await makeApp();
    const { state, oauthCookie } = await startSignIn(req);
    const cb = await req
      .get(`/dashboard/auth/callback?state=${state}&error=access_denied`)
      .set('Cookie', oauthCookie);
    expect(cb.status).toBe(400);
    expect(cb.text).toContain('Sign-in was cancelled');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(deps.oauth.exchangeCode).not.toHaveBeenCalled();
  });

  it('answers 502 with a generic page when the code exchange fails', async () => {
    const { req } = await makeApp({
      oauth: {
        buildLoginUrl: (s: string) => `https://discord.com/x?state=${s}`,
        exchangeCode: vi.fn().mockRejectedValue(new Error('token body leak')),
        fetchIdentity: vi.fn(),
      },
    });
    const { state, oauthCookie } = await startSignIn(req);
    const cb = await req
      .get(`/dashboard/auth/callback?state=${state}&code=c`)
      .set('Cookie', oauthCookie);
    expect(cb.status).toBe(502);
    expect(cb.text).not.toContain('token body leak');
  });

  it('answers 503 and creates no session when Discord cannot be asked about roles', async () => {
    const { req } = await makeApp({
      checkAccess: vi.fn().mockRejectedValue(new Error('discord down')),
    });
    const { state, oauthCookie } = await startSignIn(req);
    const cb = await req
      .get(`/dashboard/auth/callback?state=${state}&code=c`)
      .set('Cookie', oauthCookie);
    expect(cb.status).toBe(503);
    expect(JSON.stringify(cb.headers['set-cookie'] ?? [])).not.toContain(
      'dash_sid=',
    );
  });

  it('sends HSTS', async () => {
    const { req } = await makeApp();
    const res = await req.get('/dashboard/login');
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
        const { req } = await makeApp(overrides);
        const { state, oauthCookie } = await startSignIn(req);
        const cb = await req
          .get(`/dashboard/auth/callback?state=${state}&code=c`)
          .set('Cookie', oauthCookie);
        expect([403, 502]).toContain(cb.status);
        expect(JSON.stringify(cb.headers['set-cookie'] ?? [])).not.toContain(
          'dash_sid=',
        );
      }),
    );
  });

  it('posts "sign-in refused" at most once per user per hour', async () => {
    let now = 0;
    const fetchIdentity = vi.fn().mockResolvedValue(USER);
    const { req, deps } = await makeApp({
      checkAccess: vi.fn().mockResolvedValue(false),
      oauth: {
        buildLoginUrl: (s: string) => `https://discord.com/x?state=${s}`,
        exchangeCode: vi.fn().mockResolvedValue('access'),
        fetchIdentity,
      },
      refusedAuditLimiter: new FixedWindowLimiter(1, 3_600_000, () => now),
    });
    const refuse = async () => {
      const { state, oauthCookie } = await startSignIn(req);
      const cb = await req
        .get(`/dashboard/auth/callback?state=${state}&code=c`)
        .set('Cookie', oauthCookie);
      expect(cb.status).toBe(403);
    };
    const refusedPosts = () =>
      vi
        .mocked(deps.audit)
        .mock.calls.filter(([e]) => e.title === 'Dashboard sign-in refused')
        .map(([e]) => e.description);
    await refuse();
    await refuse();
    expect(refusedPosts()).toHaveLength(1);
    fetchIdentity.mockResolvedValue({
      id: '999999999999999999',
      username: 'B',
    });
    await refuse();
    expect(refusedPosts()).toHaveLength(2);
    expect(refusedPosts()[1]).toContain('<@999999999999999999>');
    now = 3_600_000;
    fetchIdentity.mockResolvedValue(USER);
    await refuse();
    expect(refusedPosts()).toHaveLength(3);
  });

  it('dedupes refused audit posts by default', async () => {
    const { req, deps } = await makeApp({
      checkAccess: vi.fn().mockResolvedValue(false),
    });
    const refuse = async () => {
      const { state, oauthCookie } = await startSignIn(req);
      return req
        .get(`/dashboard/auth/callback?state=${state}&code=c`)
        .set('Cookie', oauthCookie);
    };
    expect((await refuse()).status).toBe(403);
    expect((await refuse()).status).toBe(403);
    expect(deps.audit).toHaveBeenCalledTimes(1);
  });

  it('does not wait for the sign-in audit post', async () => {
    const { req } = await makeApp({
      audit: vi.fn(() => new Promise(() => undefined)),
    });
    await expect(signIn(req)).resolves.toMatch(/^dash_sid=/);
  });

  it('rate-limits the callback as well as the start', async () => {
    const { req } = await makeApp({
      loginLimiter: new FixedWindowLimiter(1, 60_000),
    });
    await req.get('/dashboard/auth/callback?state=a&code=c');
    const second = await req.get('/dashboard/auth/callback?state=a&code=c');
    expect(second.status).toBe(429);
  });

  it('rate-limits sign-in per IP', async () => {
    const { req } = await makeApp({
      loginLimiter: new FixedWindowLimiter(2, 60_000),
    });
    await req.get('/dashboard/auth/start');
    await req.get('/dashboard/auth/start');
    const third = await req.get('/dashboard/auth/start');
    expect(third.status).toBe(429);
    expect(third.headers['retry-after']).toBeDefined();
  });
});
