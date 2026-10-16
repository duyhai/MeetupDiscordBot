import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BASE_DISCORD_BOT_URL, SERVER_ROLES } from '../../src/constants.js';
import {
  dashboardDisabledReason,
  dashboardOrigin,
  dashboardPageDeps,
  dashboardRebuildCache,
  dashboardRouterFromEnv,
  manualRebuildDeps,
  setDashboardClient,
} from '../../src/web/dashboardDeps.js';
import { defaultBuildJobDeps } from '../../src/lib/reports/buildJob.js';
import { BUILD_LEASE_KEY } from '../../src/lib/reports/buildLease.js';
import { ApplicationCache } from '../../src/util/cache.js';
import { signSessionId } from '../../src/web/session.js';
import {
  CacheTimeoutError,
  DASHBOARD_CACHE_TIMEOUT_MS,
} from '../../src/web/timedCache.js';
import { FakeCache } from './fakeCache.js';
import { DashboardUnavailableError } from '../../src/web/roleGate.js';
import {
  createDashboardRouter,
  protectedRouteList,
} from '../../src/web/dashboardRouter.js';
import { organizerLoginDeps } from '../../src/web/organizerLoginDeps.js';
import { closeServers, serve } from './dashboardHarness.js';

vi.mock('../../src/web/organizerLoginDeps.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../src/web/organizerLoginDeps.js')
    >();
  return { ...actual, organizerLoginDeps: vi.fn(actual.organizerLoginDeps) };
});

vi.mock('../../src/util/cache.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/util/cache.js')>();
  return { ...actual, ApplicationCache: vi.fn(actual.ApplicationCache) };
});

vi.mock('../../src/lib/reports/buildJob.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/lib/reports/buildJob.js')>();
  return { ...actual, defaultBuildJobDeps: vi.fn() };
});

vi.mock('../../src/web/dashboardRouter.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/web/dashboardRouter.js')>();
  return {
    ...actual,
    createDashboardRouter: vi.fn(actual.createDashboardRouter),
  };
});

afterEach(closeServers);

const appWith = (env: Record<string, string | undefined>) => {
  const app = express();
  app.set('trust proxy', 1);
  app.use('/dashboard', dashboardRouterFromEnv(env));
  return serve(app);
};

describe('dashboardRouterFromEnv', () => {
  it('serves a not-configured page when the session secret is missing', async () => {
    const res = await (await appWith({})).get('/dashboard/login');
    expect(res.status).toBe(503);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain('not set up yet');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toContain(
      "frame-ancestors 'none'",
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('refuses a session secret shorter than 32 characters', async () => {
    const res = await (
      await appWith({ DASHBOARD_SESSION_SECRET: 'short' })
    ).get('/dashboard/login');
    expect(res.status).toBe(503);
  });

  it('serves the login page when configured', async () => {
    const res = await (
      await appWith({ DASHBOARD_SESSION_SECRET: 'k'.repeat(48) })
    )
      .get('/dashboard/login')
      .set('X-Forwarded-Proto', 'https');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Sign in with Discord');
  });

  it('registers the organizer login routes behind the session gate', () => {
    const router = dashboardRouterFromEnv({
      DASHBOARD_SESSION_SECRET: 'k'.repeat(48),
    });
    expect(protectedRouteList(router)).toEqual(
      expect.arrayContaining([
        { method: 'get', path: '/organizer-login' },
        { method: 'post', path: '/organizer-login/start' },
        { method: 'get', path: '/organizer-login/complete' },
      ]),
    );
  });

  it('passes the same organizer deps credentialStatus to the router as homeStatus', () => {
    vi.mocked(organizerLoginDeps).mockClear();
    vi.mocked(createDashboardRouter).mockClear();
    dashboardRouterFromEnv({ DASHBOARD_SESSION_SECRET: 'k'.repeat(48) });
    expect(organizerLoginDeps).toHaveBeenCalledTimes(1);
    const deps = vi.mocked(createDashboardRouter).mock.calls[0][0];
    const built = vi.mocked(organizerLoginDeps).mock.results[0]
      .value as ReturnType<typeof organizerLoginDeps>;
    expect(deps.homeStatus).toBeDefined();
    expect(deps.homeStatus).toBe(built.credentialStatus);
  });

  it('redirects plain HTTP to HTTPS when the origin is HTTPS', async () => {
    expect(dashboardOrigin()).toBe('https://meetup-discord-bot.herokuapp.com');
    const res = await (
      await appWith({ DASHBOARD_SESSION_SECRET: 'k'.repeat(48) })
    ).get('/dashboard/login');
    expect(res.status).toBe(308);
    expect(res.headers.location).toBe(
      'https://meetup-discord-bot.herokuapp.com/dashboard/login',
    );
  });
});

describe('dashboardPageDeps', () => {
  it('registers the sessions page and its revoke action behind the gate', () => {
    const router = dashboardRouterFromEnv({
      DASHBOARD_SESSION_SECRET: 'k'.repeat(48),
    });
    expect(protectedRouteList(router)).toEqual(
      expect.arrayContaining([
        { method: 'get', path: '/sessions' },
        { method: 'post', path: '/sessions/revoke' },
      ]),
    );
  });

  it('the Leadership check fails closed before Discord is ready', async () => {
    setDashboardClient(undefined);
    await expect(
      dashboardPageDeps().isLeadership('123456789012345678'),
    ).rejects.toBeInstanceOf(DashboardUnavailableError);
  });

  it('the Leadership check asks Discord live for the Leadership role only', async () => {
    const fetchMember = vi.fn().mockResolvedValue({
      roles: { cache: new Map([[SERVER_ROLES.moderator, {}]]) },
    });
    setDashboardClient({
      guilds: {
        fetch: vi.fn().mockResolvedValue({ members: { fetch: fetchMember } }),
      },
    } as never);
    try {
      await expect(
        dashboardPageDeps().isLeadership('123456789012345678'),
      ).resolves.toBe(false);
      expect(fetchMember).toHaveBeenCalledWith({
        user: '123456789012345678',
        force: true,
      });
    } finally {
      setDashboardClient(undefined);
    }
  });

  it('the audit is a no-op without a Discord client', async () => {
    setDashboardClient(undefined);
    await expect(
      dashboardPageDeps().audit({ title: 't', description: 'd' }),
    ).resolves.toBe(false);
  });
});

describe('dashboard cache timeouts', () => {
  const never = () => new Promise<never>(() => undefined);
  const hangingCache = () => ({
    get: never,
    set: never,
    exclusive_set: never,
    set_existing: never,
    remove: never,
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(ApplicationCache).mockReset();
  });

  it('the production dashboard cache is timed', async () => {
    vi.mocked(ApplicationCache).mockResolvedValue(hangingCache() as never);
    const started = Date.now();
    const res = await (
      await appWith({ DASHBOARD_SESSION_SECRET: 's'.repeat(48) })
    )
      .get('/dashboard/login')
      .set('X-Forwarded-Proto', 'https')
      .set('Cookie', `dash_sid=${signSessionId('sid', 's'.repeat(48))}`);
    expect(res.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(DASHBOARD_CACHE_TIMEOUT_MS + 500);
  });

  it('the sessions page store uses the same timed cache', async () => {
    vi.useFakeTimers();
    vi.mocked(ApplicationCache).mockResolvedValue(hangingCache() as never);
    const store = await dashboardPageDeps().sessionStore();
    const pending = store.revokeUser('123456789012345678');
    pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(DASHBOARD_CACHE_TIMEOUT_MS);
    await expect(pending).rejects.toBeInstanceOf(CacheTimeoutError);
  });

  it('the rebuild cache times out and releases a lease granted late', async () => {
    vi.useFakeTimers();
    class LateLease extends FakeCache {
      override exclusive_set(key: string, value: string, ttl?: number) {
        return new Promise<boolean>((resolve) => {
          setTimeout(() => {
            resolve(super.exclusive_set(key, value, ttl));
          }, DASHBOARD_CACHE_TIMEOUT_MS + 1_000);
        });
      }
    }
    const inner = new LateLease();
    vi.mocked(ApplicationCache).mockResolvedValue(inner as never);
    const cache = await dashboardRebuildCache();
    const pending = cache.exclusive_set(BUILD_LEASE_KEY, 'late', 60);
    pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(DASHBOARD_CACHE_TIMEOUT_MS);
    await expect(pending).rejects.toBeInstanceOf(CacheTimeoutError);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(inner.values.has(BUILD_LEASE_KEY)).toBe(false);
  });

  it('manual rebuilds time the request phase and run the build on the untimed cache', async () => {
    const jobDeps = { cache: ApplicationCache, now: () => new Date() };
    vi.mocked(defaultBuildJobDeps).mockResolvedValue(jobDeps as never);
    const deps = await manualRebuildDeps({} as never);
    /* eslint-disable @typescript-eslint/unbound-method -- identity checks only */
    // The request phase (refusal checks, cooldown, lease) is timed ...
    expect(deps.cache).toBe(dashboardRebuildCache);
    // ... the detached build and its lease release are not.
    expect(deps.backgroundCache).toBe(ApplicationCache);
    /* eslint-enable @typescript-eslint/unbound-method */
    // The job's own deps are copied, not changed: the daily job keeps no
    // background cache and stays on the untimed one (buildJob.test checks
    // defaultBuildJobDeps' cache by identity).
    expect(deps).not.toBe(jobDeps);
    expect(jobDeps).not.toHaveProperty('backgroundCache');
  });
});

describe('dashboardOrigin', () => {
  it('has no trailing slash or path, so it equals a browser Origin header', () => {
    expect(dashboardOrigin('https://example.herokuapp.com/')).toBe(
      'https://example.herokuapp.com',
    );
    expect(dashboardOrigin('https://example.herokuapp.com/some/path/')).toBe(
      'https://example.herokuapp.com',
    );
  });

  it('defaults to the configured bot URL origin', () => {
    const origin = dashboardOrigin();
    expect(origin).toBe(new URL(BASE_DISCORD_BOT_URL).origin);
    expect(origin.endsWith('/')).toBe(false);
  });
});

describe('dashboardDisabledReason', () => {
  it('reports a missing secret', () => {
    expect(dashboardDisabledReason({})).toBe(
      'DASHBOARD_SESSION_SECRET is not set',
    );
  });

  it('reports a short secret without echoing it', () => {
    const secret = 'topsecret-short';
    const reason = dashboardDisabledReason({
      DASHBOARD_SESSION_SECRET: secret,
    });
    expect(reason).toBe(
      'DASHBOARD_SESSION_SECRET is shorter than 32 characters',
    );
    expect(reason).not.toContain(secret);
  });

  it('returns undefined when the secret is long enough', () => {
    expect(
      dashboardDisabledReason({ DASHBOARD_SESSION_SECRET: 'k'.repeat(32) }),
    ).toBeUndefined();
  });
});
