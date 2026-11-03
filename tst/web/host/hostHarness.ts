import express from 'express';
import { vi } from 'vitest';

import { HostResolution } from '../../../src/lib/hosts/eligibility.js';
import { FixedWindowLimiter } from '../../../src/web/rateLimit.js';
import {
  HostRouterDeps,
  createHostRouter,
} from '../../../src/web/host/hostRouter.js';
import {
  clientFor,
  listen,
  LoopbackClient,
  LoopbackResponse,
} from '../../setup/loopbackServer.js';
import { FakeCache } from '../fakeCache.js';

export { closeServers } from '../../setup/loopbackServer.js';

export const SECRET = 's'.repeat(48);
export const ORIGIN = 'https://meetup-discord-bot.herokuapp.com';
export const DISCORD_USER = { id: '123456789012345678', username: 'Dee' };
export const MEETUP_SELF = { id: '4242', name: 'Ann' };

export const HOST: HostResolution = {
  kind: 'host',
  meetupMemberId: '4242',
  discordUserId: DISCORD_USER.id,
  tier: 'regular',
  hostedCount: 3,
};

export function makeHostDeps(overrides: Partial<HostRouterDeps> = {}): {
  cache: FakeCache;
  deps: HostRouterDeps;
} {
  const cache = new FakeCache();
  const deps: HostRouterDeps = {
    cache: async () => cache,
    resolve: vi.fn().mockResolvedValue(HOST),
    discord: {
      buildLoginUrl: vi.fn(
        (state: string) =>
          `https://discord.com/oauth2/authorize?state=${state}`,
      ),
      exchangeCode: vi.fn().mockResolvedValue('discord-access'),
      fetchIdentity: vi.fn().mockResolvedValue(DISCORD_USER),
    },
    meetup: {
      buildAuthUrl: vi.fn(
        (state: string) =>
          `https://secure.meetup.com/oauth2/authorize?state=${state}`,
      ),
      exchangeCode: vi.fn().mockResolvedValue('meetup-access'),
      fetchSelf: vi.fn().mockResolvedValue(MEETUP_SELF),
    },
    sessionSecret: SECRET,
    origin: ORIGIN,
    audit: vi.fn().mockResolvedValue(true),
    loginLimiter: new FixedWindowLimiter(1000, 60_000),
    ...overrides,
  };
  return { cache, deps };
}

/** Mounted under /host like production, already listening. */
export async function makeHostApp(overrides: Partial<HostRouterDeps> = {}) {
  const { cache, deps } = makeHostDeps(overrides);
  const app = express();
  app.set('trust proxy', 1);
  app.use('/host', createHostRouter(deps));
  const server = await listen(app);
  return { cache, deps, server, req: clientFor(server) };
}

export function setCookie(res: LoopbackResponse, name: string) {
  const all = (res.headers['set-cookie'] ?? []) as unknown as string[];
  return all.find((c) => c.startsWith(`${name}=`))?.split(';')[0];
}

export function locationOf(res: LoopbackResponse): URL {
  const { location } = res.headers as Record<string, string | undefined>;
  if (res.status !== 302 || !location) {
    throw new Error(
      `expected a 302 with a Location, got ${res.status}: ${res.text.slice(0, 300)}`,
    );
  }
  return new URL(location, ORIGIN);
}

/** Discord: start → callback; returns the host_sid pair. */
export async function signInWithDiscord(req: LoopbackClient): Promise<string> {
  const start = await req.get('/host/auth/discord/start');
  const state = locationOf(start).searchParams.get('state') ?? '';
  const cookie = setCookie(start, 'host_oauth_discord') ?? '';
  const cb = await req
    .get(`/host/auth/discord/callback?state=${state}&code=c`)
    .set('Cookie', cookie);
  const sid = setCookie(cb, 'host_sid');
  if (!sid) {
    throw new Error(
      `Discord sign-in set no session: ${cb.status} ${cb.text.slice(0, 200)}`,
    );
  }
  return sid;
}

/** Meetup: start → complete (as forwarded by /connect/meetup/callback). */
export async function startMeetup(req: LoopbackClient) {
  const start = await req.get('/host/auth/meetup/start');
  return {
    state: locationOf(start).searchParams.get('state') ?? '',
    cookie: setCookie(start, 'host_oauth_meetup') ?? '',
  };
}

export async function signInWithMeetup(req: LoopbackClient): Promise<string> {
  const { state, cookie } = await startMeetup(req);
  const cb = await req
    .get(`/host/auth/meetup/complete?state=${state}&code=m`)
    .set('Cookie', cookie);
  const sid = setCookie(cb, 'host_sid');
  if (!sid) {
    throw new Error(
      `Meetup sign-in set no session: ${cb.status} ${cb.text.slice(0, 200)}`,
    );
  }
  return sid;
}
