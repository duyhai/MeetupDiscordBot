import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { BASE_DISCORD_BOT_URL } from '../../src/constants.js';
import {
  dashboardDisabledReason,
  dashboardOrigin,
  dashboardRouterFromEnv,
} from '../../src/web/dashboardDeps.js';

const appWith = (env: Record<string, string | undefined>) => {
  const app = express();
  app.use('/dashboard', dashboardRouterFromEnv(env));
  return app;
};

describe('dashboardRouterFromEnv', () => {
  it('serves a not-configured page when the session secret is missing', async () => {
    const res = await request(appWith({})).get('/dashboard/login');
    expect(res.status).toBe(503);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain('not set up yet');
  });

  it('refuses a session secret shorter than 32 characters', async () => {
    const res = await request(
      appWith({ DASHBOARD_SESSION_SECRET: 'short' }),
    ).get('/dashboard/login');
    expect(res.status).toBe(503);
  });

  it('serves the login page when configured', async () => {
    const res = await request(
      appWith({ DASHBOARD_SESSION_SECRET: 'k'.repeat(48) }),
    ).get('/dashboard/login');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Sign in with Discord');
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
