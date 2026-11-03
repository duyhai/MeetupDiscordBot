/* eslint-disable @typescript-eslint/unbound-method -- assertions on vi.fn mocks only */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { signSessionId } from '../../../src/web/session.js';
import {
  DISCORD_USER,
  HOST,
  MEETUP_SELF,
  ORIGIN,
  SECRET,
  closeServers,
  locationOf,
  makeHostApp,
  setCookie,
  signInWithDiscord,
  signInWithMeetup,
  startMeetup,
} from './hostHarness.js';

afterEach(closeServers);

describe('host sign-in', () => {
  it('signed out, a page redirects to the host login', async () => {
    const { req } = await makeHostApp();
    const res = await req.get('/host');
    expect(locationOf(res).pathname).toBe('/host/login');
  });

  it('the login page offers both providers, with the dashboard headers', async () => {
    const { req } = await makeHostApp();
    const res = await req.get('/host/login');
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/host/auth/discord/start"');
    expect(res.text).toContain('href="/host/auth/meetup/start"');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-security-policy']).toContain(
      "default-src 'none'",
    );
  });

  it('Discord sign-in resolves by Discord id and starts a host session', async () => {
    const { req, deps, cache } = await makeHostApp();
    const sid = await signInWithDiscord(req);
    expect(deps.resolve).toHaveBeenCalledWith({
      discordUserId: DISCORD_USER.id,
    });
    const stored = [...cache.values.entries()].find(([k]) =>
      k.startsWith('host-session-'),
    );
    expect(JSON.parse(stored?.[1] ?? '{}')).toMatchObject({
      userId: '4242',
      username: DISCORD_USER.username,
      discordUserId: DISCORD_USER.id,
      tier: 'regular',
      via: 'discord',
    });
    const home = await req.get('/host/nope').set('Cookie', sid);
    expect(home.status).toBe(404);
  });

  it('Meetup start sends a host- state and sets the Meetup cookie on /host/auth', async () => {
    const { req } = await makeHostApp();
    const start = await req.get('/host/auth/meetup/start');
    const state = locationOf(start).searchParams.get('state') ?? '';
    expect(state).toMatch(/^host-[A-Za-z0-9_-]{43}$/);
    const raw = (
      (start.headers['set-cookie'] ?? []) as unknown as string[]
    ).find((c) => c.startsWith('host_oauth_meetup='));
    expect(raw).toContain('Path=/host/auth');
    expect(raw).toContain('HttpOnly');
  });

  it('Meetup sign-in resolves by Meetup id, never stores the member token', async () => {
    const { req, deps, cache } = await makeHostApp({
      resolve: vi.fn().mockResolvedValue({ ...HOST, discordUserId: undefined }),
    });
    await signInWithMeetup(req);
    expect(deps.resolve).toHaveBeenCalledWith({
      meetupMemberId: MEETUP_SELF.id,
    });
    expect(deps.meetup.fetchSelf).toHaveBeenCalledWith('meetup-access');
    const values = [...cache.values.values()].join('\n');
    expect(values).not.toContain('meetup-access');
    expect(values).toContain('"via":"meetup"');
    expect(values).toContain('"discordUserId":null');
  });

  it('Meetup complete without the cookie is refused, and nothing is exchanged', async () => {
    const { req, deps } = await makeHostApp();
    const { state } = await startMeetup(req);
    const res = await req.get(
      `/host/auth/meetup/complete?state=${state}&code=m`,
    );
    expect(res.status).toBe(400);
    expect(deps.meetup.exchangeCode).not.toHaveBeenCalled();
  });

  it('Meetup complete with the cookie but another state is refused', async () => {
    const { req, deps } = await makeHostApp();
    const { cookie } = await startMeetup(req);
    const res = await req
      .get(`/host/auth/meetup/complete?state=host-${'b'.repeat(43)}&code=m`)
      .set('Cookie', cookie);
    expect(res.status).toBe(400);
    expect(deps.meetup.exchangeCode).not.toHaveBeenCalled();
  });

  it('the Discord cookie cannot complete a Meetup sign-in, nor the reverse', async () => {
    const { req, deps } = await makeHostApp();
    const start = await req.get('/host/auth/discord/start');
    const state = locationOf(start).searchParams.get('state') ?? '';
    const discordCookie = setCookie(start, 'host_oauth_discord') ?? '';
    const asMeetup = await req
      .get(`/host/auth/meetup/complete?state=${state}&code=m`)
      .set(
        'Cookie',
        discordCookie.replace('host_oauth_discord', 'host_oauth_meetup'),
      );
    expect(asMeetup.status).toBe(400);
    const meetup = await startMeetup(req);
    const asDiscord = await req
      .get(`/host/auth/discord/callback?state=${meetup.state}&code=c`)
      .set(
        'Cookie',
        meetup.cookie.replace('host_oauth_meetup', 'host_oauth_discord'),
      );
    expect(asDiscord.status).toBe(400);
    expect(deps.meetup.exchangeCode).not.toHaveBeenCalled();
    expect(deps.discord.exchangeCode).not.toHaveBeenCalled();
  });

  it('a Discord account with no Meetup link gets the link copy and no session', async () => {
    const { req, deps } = await makeHostApp({
      resolve: vi
        .fn()
        .mockResolvedValue({ kind: 'refused', reason: 'not-linked' }),
    });
    const start = await req.get('/host/auth/discord/start');
    const state = locationOf(start).searchParams.get('state') ?? '';
    const res = await req
      .get(`/host/auth/discord/callback?state=${state}&code=c`)
      .set('Cookie', setCookie(start, 'host_oauth_discord') ?? '');
    expect(res.status).toBe(403);
    expect(res.text).toContain('Sign in with Meetup instead');
    expect(setCookie(res, 'host_sid')).toBeUndefined();
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Host dashboard sign-in refused' }),
    );
  });

  it('not-a-host and blacklisted read the same', async () => {
    const texts: string[] = [];
    for (const reason of ['not-a-host', 'blacklisted'] as const) {
      // eslint-disable-next-line no-await-in-loop
      const { req } = await makeHostApp({
        resolve: vi.fn().mockResolvedValue({ kind: 'refused', reason }),
      });
      // eslint-disable-next-line no-await-in-loop
      const { state, cookie } = await startMeetup(req);
      // eslint-disable-next-line no-await-in-loop
      const res = await req
        .get(`/host/auth/meetup/complete?state=${state}&code=m`)
        .set('Cookie', cookie);
      expect(res.status).toBe(403);
      expect(setCookie(res, 'host_sid')).toBeUndefined();
      texts.push(res.text.replace(/nonce="[^"]*"/g, ''));
    }
    expect(texts[0]).toBe(texts[1]);
  });

  it('an eligibility outage at sign-in is a 503 with no session', async () => {
    const { req } = await makeHostApp({
      resolve: vi.fn().mockRejectedValue(new Error('discord down')),
    });
    const { state, cookie } = await startMeetup(req);
    const res = await req
      .get(`/host/auth/meetup/complete?state=${state}&code=m`)
      .set('Cookie', cookie);
    expect(res.status).toBe(503);
    expect(setCookie(res, 'host_sid')).toBeUndefined();
  });

  it('a failed Meetup exchange is a 502', async () => {
    const { req, deps } = await makeHostApp();
    vi.mocked(deps.meetup.exchangeCode).mockRejectedValue(
      new Error('[401] body'),
    );
    const { state, cookie } = await startMeetup(req);
    const res = await req
      .get(`/host/auth/meetup/complete?state=${state}&code=m`)
      .set('Cookie', cookie);
    expect(res.status).toBe(502);
  });

  it('a cancelled Meetup sign-in shows the login page', async () => {
    const { req, deps } = await makeHostApp();
    const { state, cookie } = await startMeetup(req);
    const res = await req
      .get(`/host/auth/meetup/complete?state=${state}&error=access_denied`)
      .set('Cookie', cookie);
    expect(res.status).toBe(400);
    expect(res.text).toContain('Sign-in was cancelled.');
    expect(deps.meetup.exchangeCode).not.toHaveBeenCalled();
  });

  it('a staff-signed session id is not a host session', async () => {
    const { req, deps } = await makeHostApp();
    await signInWithDiscord(req);
    const forged = `host_sid=${signSessionId('anything', SECRET)}`;
    const res = await req.get('/host').set('Cookie', forged);
    expect(locationOf(res).pathname).toBe('/host/login');
    expect(deps.resolve).toHaveBeenCalledTimes(1);
  });

  it('a POST without the CSRF token is refused; with it, logout works', async () => {
    const { req, cache } = await makeHostApp();
    const sid = await signInWithDiscord(req);
    const bare = await req
      .post('/host/logout')
      .set('Cookie', sid)
      .set('Origin', ORIGIN);
    expect(bare.status).toBe(403);
    const session = JSON.parse(
      [...cache.values.entries()].find(([k]) =>
        k.startsWith('host-session-'),
      )?.[1] ?? '{}',
    ) as { csrfToken: string };
    const ok = await req
      .post('/host/logout')
      .set('Cookie', sid)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: session.csrfToken });
    expect(ok.status).toBe(303);
    expect(ok.headers.location).toBe('/host/login');
    expect(
      [...cache.values.keys()].some((k) => k.startsWith('host-session-')),
    ).toBe(false);
  });

  it('a cross-origin POST is refused even with the token', async () => {
    const { req, cache } = await makeHostApp();
    const sid = await signInWithDiscord(req);
    const session = JSON.parse(
      [...cache.values.entries()].find(([k]) =>
        k.startsWith('host-session-'),
      )?.[1] ?? '{}',
    ) as { csrfToken: string };
    const res = await req
      .post('/host/logout')
      .set('Cookie', sid)
      .set('Origin', 'https://evil.example')
      .type('form')
      .send({ _csrf: session.csrfToken });
    expect(res.status).toBe(403);
  });
});

describe('host logout on a cache timeout', () => {
  it('clears the cookie and says the sign-out is not confirmed', async () => {
    const { CacheTimeoutError } =
      await import('../../../src/web/timedCache.js');
    const { req, cache } = await makeHostApp();
    const sid = await signInWithDiscord(req);
    const session = JSON.parse(
      [...cache.values.entries()].find(([k]) =>
        k.startsWith('host-session-'),
      )?.[1] ?? '{}',
    ) as { csrfToken: string };
    vi.spyOn(cache, 'remove').mockRejectedValue(
      new CacheTimeoutError('remove', 2000),
    );
    const res = await req
      .post('/host/logout')
      .set('Cookie', sid)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: session.csrfToken });
    expect(res.status).toBe(503);
    expect(res.text).toContain('Sign-out not confirmed');
    expect(String(res.headers['set-cookie'])).toContain('host_sid=;');
  });
});
