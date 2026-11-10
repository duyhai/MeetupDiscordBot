import { afterEach, describe, expect, it, vi } from 'vitest';

import { HostResolution } from '../../../src/lib/hosts/eligibility.js';
import { hostLayout } from '../../../src/web/host/hostLayout.js';
import { MEMBER_PATHS } from '../../../src/web/host/hostRouter.js';
import { HostSession } from '../../../src/web/host/hostSession.js';
import { html } from '../../../src/web/html.js';
import {
  DISCORD_USER,
  HOST,
  ORIGIN,
  closeServers,
  makeHostApp,
  signInWithDiscord,
  signInWithMeetup,
  startMeetup,
} from './hostHarness.js';

afterEach(closeServers);

const MEMBER: HostResolution = {
  kind: 'member',
  meetupMemberId: '4242',
  discordUserId: DISCORD_USER.id,
};

/** Every host page as an echo, so the matrix tests the gate, not the pages. */
const echoPages = (router: import('express').Router) => {
  const echo = (path: string) => {
    router.get(path, (_req, res) => {
      res.type('text').send(`GET ${path}`);
    });
    router.post(path, (_req, res) => {
      res.type('text').send(`POST ${path}`);
    });
  };
  [
    '/',
    '/wrapped',
    '/wrapped/rebuild',
    '/calendar',
    '/history',
    '/create',
  ].forEach(echo);
  echo('/events/1/announce');
};

const GETS = ['/', '/wrapped', '/calendar', '/history', '/create'];
const POSTS = [
  '/wrapped/rebuild',
  '/link/discord',
  '/verify/finish',
  '/events/1/announce',
];

async function csrfOf(cache: { values: Map<string, string> }) {
  for (const [key, raw] of cache.values) {
    if (key.startsWith('host-session-')) {
      return (JSON.parse(raw) as { csrfToken: string }).csrfToken;
    }
  }
  throw new Error('no session');
}

describe('a linked member who is not a host', () => {
  it('signs in with Discord and gets a member session', async () => {
    const { req, cache } = await makeHostApp({
      resolve: vi.fn().mockResolvedValue(MEMBER),
      pages: echoPages,
    });
    await signInWithDiscord(req);
    const stored = [...cache.values.entries()].find(([k]) =>
      k.startsWith('host-session-'),
    );
    expect(JSON.parse(stored?.[1] ?? '{}')).toMatchObject({
      userId: '4242',
      discordUserId: DISCORD_USER.id,
      tier: 'regular',
      role: 'member',
      via: 'discord',
    });
  });

  it('reaches home and Wrapped, and nothing else', async () => {
    const { req, cache } = await makeHostApp({
      resolve: vi.fn().mockResolvedValue(MEMBER),
      pages: echoPages,
    });
    const sid = await signInWithMeetup(req);
    const csrf = await csrfOf(cache);
    const got: Record<string, number> = {};
    await Promise.all([
      ...GETS.map(async (path) => {
        got[`GET ${path}`] = (
          await req.get(`/host${path}`).set('Cookie', sid)
        ).status;
      }),
      ...POSTS.map(async (path) => {
        got[`POST ${path}`] = (
          await req
            .post(`/host${path}`)
            .set('Cookie', sid)
            .set('Origin', ORIGIN)
            .type('form')
            .send({ _csrf: csrf })
        ).status;
      }),
    ]);
    expect(got).toEqual({
      'GET /': 200,
      'GET /wrapped': 200,
      'GET /calendar': 403,
      'GET /history': 403,
      'GET /create': 403,
      'POST /wrapped/rebuild': 200,
      // The refresh flow is a member's too (the home page offers it): past
      // the gate, these answer as they do for a host of this harness (no
      // members store: 404; no verify runner: 303 home).
      'POST /link/discord': 404,
      'POST /verify/finish': 303,
      'POST /events/1/announce': 403,
    });
    expect(MEMBER_PATHS).toEqual([
      '/',
      '/wrapped',
      '/wrapped/rebuild',
      '/link/discord',
      '/verify/finish',
      '/logout',
    ]);
  });

  it('a refused host route reads as the existing host-only page', async () => {
    const { req } = await makeHostApp({
      resolve: vi.fn().mockResolvedValue(MEMBER),
      pages: echoPages,
    });
    const sid = await signInWithDiscord(req);
    const res = await req.get('/host/history').set('Cookie', sid);
    expect(res.status).toBe(403);
    expect(res.text).toContain(
      'The host dashboard is for members who have hosted an event with us.',
    );
  });

  it('can sign out', async () => {
    const { req, cache } = await makeHostApp({
      resolve: vi.fn().mockResolvedValue(MEMBER),
      pages: echoPages,
    });
    const sid = await signInWithDiscord(req);
    const res = await req
      .post('/host/logout')
      .set('Cookie', sid)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: await csrfOf(cache) });
    expect(res.status).toBe(303);
  });

  it('sees Home and Wrapped in the nav, hosts see Calendar and My history too', async () => {
    const page = (router: import('express').Router) => {
      router.get('/', (_req, res) => {
        const { session, nonce } = res.locals as {
          session: HostSession;
          nonce: string;
        };
        res.type('html').send(
          hostLayout({
            title: 'T',
            nonce,
            user: session,
            current: 'home',
            body: html`<p>x</p>`,
          }),
        );
      });
    };
    const member = await makeHostApp({
      resolve: vi.fn().mockResolvedValue(MEMBER),
      pages: page,
    });
    const asMember = await member.req
      .get('/host')
      .set('Cookie', await signInWithDiscord(member.req));
    expect(asMember.text).toContain('href="/host/wrapped"');
    expect(asMember.text).not.toContain('href="/host/calendar"');
    const host = await makeHostApp({ pages: page });
    const asHost = await host.req
      .get('/host')
      .set('Cookie', await signInWithDiscord(host.req));
    expect(asHost.text).toContain('href="/host/wrapped"');
    expect(asHost.text).toContain('href="/host/calendar"');
    expect(asHost.text).toContain('href="/host/history"');
  });
});

describe('an unlinked Meetup sign-in who is not a host', () => {
  it('is refused with a nudge to link in Discord, and no session', async () => {
    const { req } = await makeHostApp({
      resolve: vi
        .fn()
        .mockResolvedValue({ kind: 'refused', reason: 'not-linked' }),
    });
    const { state, cookie } = await startMeetup(req);
    const res = await req
      .get(`/host/auth/meetup/complete?state=${state}&code=m`)
      .set('Cookie', cookie);
    expect(res.status).toBe(403);
    expect(res.text).toContain('not linked to Discord yet');
    expect(res.text).toContain('Verify');
    expect(res.text).not.toContain('Sign in with Meetup instead');
    expect(res.headers['set-cookie'] ?? []).not.toContainEqual(
      expect.stringContaining('host_sid='),
    );
  });
});

describe('a host', () => {
  it('still has a host role and every host route', async () => {
    const { req, cache } = await makeHostApp({ pages: echoPages });
    const sid = await signInWithDiscord(req);
    expect([...cache.values.values()].join('\n')).toContain('"role":"host"');
    expect(HOST.kind).toBe('host');
    const statuses = await Promise.all(
      GETS.map(
        async (path) =>
          (await req.get(`/host${path}`).set('Cookie', sid)).status,
      ),
    );
    expect(statuses).toEqual(GETS.map(() => 200));
  });
});
