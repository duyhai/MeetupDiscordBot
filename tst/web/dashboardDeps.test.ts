import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BASE_DISCORD_BOT_URL } from '../../src/constants.js';
import {
  dashboardDisabledReason,
  dashboardOrigin,
  dashboardRouterFromEnv,
} from '../../src/web/dashboardDeps.js';
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
