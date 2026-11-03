import { describe, expect, it, afterEach } from 'vitest';

import express from 'express';
import { hostRouterFromEnv } from '../../../src/web/host/hostDeps.js';
import { clientFor, closeServers, listen } from '../../setup/loopbackServer.js';

afterEach(closeServers);

async function mount(env: Record<string, string | undefined>) {
  const app = express();
  // As on Heroku: the router marks HTTPS, so no 308 to the origin.
  app.set('trust proxy', 1);
  app.use('/host', hostRouterFromEnv(env));
  return clientFor(await listen(app));
}

describe('hostRouterFromEnv', () => {
  it('without a session secret, every path is the not-set-up page', async () => {
    const req = await mount({});
    const res = await req.get('/host/login');
    expect(res.status).toBe(503);
    expect(res.text).toContain('The host dashboard is not set up yet.');
    expect(res.headers['content-security-policy']).toContain(
      "default-src 'none'",
    );
  });

  it('with a secret, the login page offers both providers', async () => {
    const req = await mount({ DASHBOARD_SESSION_SECRET: 'k'.repeat(48) });
    const res = await req.get('/host/login').set('X-Forwarded-Proto', 'https');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Sign in with Meetup');
  });

  it('the Discord start uses the host redirect URI', async () => {
    const req = await mount({ DASHBOARD_SESSION_SECRET: 'k'.repeat(48) });
    const res = await req
      .get('/host/auth/discord/start')
      .set('X-Forwarded-Proto', 'https');
    const location = new URL(String(res.headers.location));
    expect(location.hostname).toBe('discord.com');
    expect(location.searchParams.get('redirect_uri')).toMatch(
      /\/host\/auth\/discord\/callback$/,
    );
  });
});
