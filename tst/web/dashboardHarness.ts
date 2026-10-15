import express from 'express';
import request from 'supertest';
import { vi } from 'vitest';

import {
  DashboardDeps,
  createDashboardRouter,
} from '../../src/web/dashboardRouter.js';
import { FixedWindowLimiter } from '../../src/web/rateLimit.js';
import { FakeCache } from './fakeCache.js';

export const SECRET = 's'.repeat(48);
export const ORIGIN = 'https://meetup-discord-bot.herokuapp.com';
export const USER = { id: '123456789012345678', username: 'Mod' };

export function makeApp(overrides: Partial<DashboardDeps> = {}) {
  const cache = new FakeCache();
  const deps: DashboardDeps = {
    cache: async () => cache,
    checkAccess: vi.fn().mockResolvedValue(true),
    oauth: {
      buildLoginUrl: vi.fn(
        (state: string) =>
          `https://discord.com/oauth2/authorize?state=${state}`,
      ),
      exchangeCode: vi.fn().mockResolvedValue('access'),
      fetchIdentity: vi.fn().mockResolvedValue(USER),
    },
    sessionSecret: SECRET,
    origin: ORIGIN,
    audit: vi.fn().mockResolvedValue(true),
    loginLimiter: new FixedWindowLimiter(1000, 60_000),
    ...overrides,
  };
  const app = express();
  app.use('/dashboard', createDashboardRouter(deps));
  return { app, cache, deps };
}

/** Walks start → callback and returns the session cookie pair. */
export async function signIn(app: express.Express): Promise<string> {
  const start = await request(app).get('/dashboard/auth/start');
  const state = new URL(start.headers.location).searchParams.get('state');
  const oauthCookie = (start.headers['set-cookie'] as unknown as string[])
    .find((c) => c.startsWith('dash_oauth='))
    .split(';')[0];
  const cb = await request(app)
    .get(`/dashboard/auth/callback?state=${state}&code=c`)
    .set('Cookie', oauthCookie);
  return (cb.headers['set-cookie'] as unknown as string[])
    .find((c) => c.startsWith('dash_sid='))
    .split(';')[0];
}
