import express from 'express';
import http from 'http';
import net, { AddressInfo } from 'net';
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

/** Requests against one long-lived test server, as `request(app)` would. */
export type Client = ReturnType<typeof request>;

const servers = new Set<http.Server>();

/**
 * Serves `app` on one loopback server for the whole test. Binding
 * 127.0.0.1 (not the dual-stack wildcard supertest uses) means the OS never
 * hands out a port another local process already holds on 127.0.0.1, so a
 * request cannot land on someone else's server. Close with closeServers().
 */
export async function serve(app: express.Express): Promise<Client> {
  return request(await listen(app));
}

/** The loopback server behind serve(); closed by closeServers(). */
export async function listen(app: express.Express): Promise<http.Server> {
  const server = http.createServer(app);
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return server;
}

/**
 * One HTTP/1.1 request over a raw socket, sending `path` byte for byte.
 * For paths an HTTP client would reinterpret: nock (active in every test)
 * reads `//dashboard` as a protocol-relative URL and retargets it to host
 * "dashboard". nock does not intercept raw `net`, so this reaches the real
 * loopback server. Repeated headers (Set-Cookie) are joined with newlines.
 */
export async function rawRequest(
  server: http.Server,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const { port } = server.address() as AddressInfo;
  const extra = Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join('');
  const reply = await new Promise<string>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
    socket.write(
      `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
        `Connection: close\r\n${extra}\r\n`,
    );
  });
  const split = reply.indexOf('\r\n\r\n');
  const [statusLine, ...lines] = reply.slice(0, split).split('\r\n');
  const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(statusLine)?.[1]);
  if (!status) {
    throw new Error(`no HTTP status line in reply: ${statusLine}`);
  }
  const parsed: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    parsed[name] = name in parsed ? `${parsed[name]}\n${value}` : value;
  }
  return { status, headers: parsed, body: reply.slice(split + 4) };
}

/** For afterEach: closes every server serve() opened. */
export async function closeServers(): Promise<void> {
  const open = [...servers];
  servers.clear();
  await Promise.all(
    open.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
}

export function makeDeps(overrides: Partial<DashboardDeps> = {}): {
  cache: FakeCache;
  deps: DashboardDeps;
} {
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
  return { cache, deps };
}

/** The dashboard mounted under /dashboard like production, already listening. */
export async function makeApp(overrides: Partial<DashboardDeps> = {}) {
  const { cache, deps } = makeDeps(overrides);
  const app = express();
  app.set('trust proxy', 1);
  app.use('/dashboard', createDashboardRouter(deps));
  const server = await listen(app);
  return { app, cache, deps, server, req: request(server) };
}

/** Asserts a 302 with a Location, failing with the status and body otherwise. */
export function locationOf(res: request.Response): URL {
  const { location } = res.headers as Record<string, string | undefined>;
  if (res.status !== 302 || !location) {
    throw new Error(
      `expected a 302 with a Location, got ${res.status}: ${res.text.slice(0, 500)}`,
    );
  }
  return new URL(location, ORIGIN);
}

/** The `name=value` pair of a Set-Cookie the response sent, if any. */
export function setCookie(
  res: request.Response,
  name: string,
): string | undefined {
  const all = (res.headers['set-cookie'] ?? []) as unknown as string[];
  return all.find((c) => c.startsWith(`${name}=`))?.split(';')[0];
}

/** Starts sign-in and returns the state and the `dash_oauth=...` pair. */
export async function startSignIn(
  req: Client,
): Promise<{ state: string; oauthCookie: string }> {
  const start = await req.get('/dashboard/auth/start');
  const state = locationOf(start).searchParams.get('state') ?? '';
  const oauthCookie = setCookie(start, 'dash_oauth');
  if (!state || !oauthCookie) {
    throw new Error('sign-in start sent no state or no OAuth cookie');
  }
  return { state, oauthCookie };
}

/** Walks start → callback and returns the session cookie pair. */
export async function signIn(req: Client): Promise<string> {
  const { state, oauthCookie } = await startSignIn(req);
  const cb = await req
    .get(`/dashboard/auth/callback?state=${state}&code=c`)
    .set('Cookie', oauthCookie);
  const sid = setCookie(cb, 'dash_sid');
  if (!sid) {
    throw new Error(`sign-in set no session cookie: ${cb.status}`);
  }
  return sid;
}
