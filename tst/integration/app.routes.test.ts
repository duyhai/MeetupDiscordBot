import nock from 'nock';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import app from '../../src/app.js';
import { PUBLIC_APP_ORIGIN } from '../../src/constants.js';
import { createOAuthState } from '../../src/lib/client/oauth/state.js';
import { ApplicationCache } from '../../src/util/cache.js';

// Every request below is a FRESH supertest client with no cookie jar: the
// chain must work when each hop arrives from a different browser context
// (the iOS failure mode that killed the grant/session flow). Assertions on
// set-cookie prove the app never even tries to establish a session.

afterEach(() => {
  nock.cleanAll();
});

const nockMeetupExchange = () =>
  nock('https://secure.meetup.com').post('/oauth2/access').reply(200, {
    access_token: 'meetup-access',
    refresh_token: 'meetup-refresh',
    expires_in: 3600,
  });

describe('cookie-free OAuth chain', () => {
  it('rejects a replayed state after the Meetup callback consumes it', async () => {
    const state = await createOAuthState('user-1b');

    nockMeetupExchange();
    const first = await request(app).get(
      `/connect/meetup/callback?state=${state}&code=mcode`,
    );
    expect(first.status).toBe(200);

    const replay = await request(app).get(
      `/connect/meetup/callback?state=${state}&code=another-code`,
    );
    expect(replay.status).toBe(400);
    expect(replay.text).toContain('expired');
  });

  it('completes the Meetup chain with a fresh client per hop and no cookies', async () => {
    const state = await createOAuthState('user-1d');

    const meetupAuthorize = await request(app).get(
      `/connect/meetup?state=${state}`,
    );
    expect(meetupAuthorize.status).toBe(302);
    expect(meetupAuthorize.headers.location).toContain(
      'https://secure.meetup.com/oauth2/authorize',
    );

    nockMeetupExchange();
    const meetupCb = await request(app).get(
      `/connect/meetup/callback?state=${state}&code=mcode`,
    );
    expect(meetupCb.status).toBe(200);

    const cache = await ApplicationCache();
    expect(JSON.parse(await cache.get('user-1d-meetup-tokens'))).toMatchObject({
      accessToken: 'meetup-access',
    });
  });

  it('keeps the token set long enough for its refresh token to be used', async () => {
    const state = await createOAuthState('user-1e');
    const cache = await ApplicationCache();
    const set = vi.spyOn(cache, 'set');

    nockMeetupExchange();
    const meetupCb = await request(app).get(
      `/connect/meetup/callback?state=${state}&code=mcode`,
    );
    expect(meetupCb.status).toBe(200);

    // The cache default (12 hours) discards the refresh token before it has
    // ever been needed twice; the set is stored for 30 days instead.
    const tokenWrite = set.mock.calls.find(
      ([key]) => key === 'user-1e-meetup-tokens',
    );
    expect(tokenWrite?.[2]).toBe(30 * 24 * 60 * 60);
    set.mockRestore();
  });

  it('rejects an unknown state with the expired-link page', async () => {
    for (const path of [
      '/connect/meetup?state=nope',
      '/connect/meetup/callback?state=nope&code=x',
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).get(path);
      expect(res.status).toBe(400);
      expect(res.text).toContain('expired');
    }
  });

  it('shows the denied page when the provider returns an error', async () => {
    const state = await createOAuthState('user-3');
    const res = await request(app).get(
      `/connect/meetup/callback?state=${state}&error=access_denied`,
    );
    expect(res.status).toBe(400);
    expect(res.text).toContain('cancelled or denied');
  });

  it('shows the failure page when the token exchange fails', async () => {
    const state = await createOAuthState('user-4');
    nock('https://secure.meetup.com').post('/oauth2/access').reply(500, {});
    const res = await request(app).get(
      `/connect/meetup/callback?state=${state}&code=bad`,
    );
    expect(res.status).toBe(502);
    expect(res.text).toContain('Could not complete');
  });

  it('renders the branded page when the cache is unreachable', async () => {
    const cache = await ApplicationCache();
    const getSpy = vi
      .spyOn(cache, 'get')
      .mockRejectedValueOnce(new Error('cache down'));

    const res = await request(app).get('/connect/meetup?state=whatever');

    expect(res.status).toBe(500);
    expect(res.text).toContain('discord://-/channels/');
    expect(res.text).not.toContain('<pre>');
    getSpy.mockRestore();
  });

  it('keeps the /redirect trampoline working', async () => {
    const encoded = Buffer.from('http://localhost:5000/target').toString(
      'base64',
    );
    const res = await request(app).get(`/redirect/${encoded}?a=1`);
    expect(res.status).toBe(307);
    expect(res.headers.location).toBe('http://localhost:5000/target?a=1');
  });

  const trampoline = (target: string) =>
    `/redirect/${Buffer.from(target).toString('base64')}`;

  it('still redirects the production Meetup callback through the trampoline', async () => {
    const res = await request(app).get(
      `${trampoline(`${PUBLIC_APP_ORIGIN}/connect/meetup/callback`)}?code=c&state=s`,
    );
    expect(res.status).toBe(307);
    expect(res.headers.location).toBe(
      `${PUBLIC_APP_ORIGIN}/connect/meetup/callback?code=c&state=s`,
    );
  });

  it('redirects to a 127.0.0.1 dev target', async () => {
    const res = await request(app).get(trampoline('http://127.0.0.1:5055/x'));
    expect(res.status).toBe(307);
    expect(res.headers.location).toBe('http://127.0.0.1:5055/x');
  });

  it('refuses targets outside the allow-list with the branded page', async () => {
    const targets = [
      'https://evil.example/',
      `https://${new URL(PUBLIC_APP_ORIGIN).host}.evil.example/`,
      `https://${new URL(PUBLIC_APP_ORIGIN).host}@evil.example/`,
      `blob:${PUBLIC_APP_ORIGIN}/x`,
      'javascript:alert(1)',
      'https://localhost/',
    ];
    const responses = await Promise.all(
      targets.map((target) => request(app).get(trampoline(target))),
    );
    responses.forEach((res, i) => {
      expect(res.status, targets[i]).toBe(400);
      expect(res.headers.location, targets[i]).toBeUndefined();
      expect(res.text).toContain('This link is not valid');
    });
  });

  it('answers malformed input with 400, not 500', async () => {
    const res = await request(app).get('/redirect/@@@');
    expect(res.status).toBe(400);
  });

  it('never shows the default Express 404 for a stale or mistyped URL', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(404);
    expect(res.text).toContain('discord://-/channels/');
    expect(res.text).not.toContain('<pre>');
  });
});

describe('staff dashboard mount', () => {
  it('mounts the dashboard ahead of the generic 404 page', async () => {
    // Heroku's router marks HTTPS; without it a configured dashboard
    // answers 308 to the HTTPS origin.
    const res = await request(app)
      .get('/dashboard/login')
      .set('X-Forwarded-Proto', 'https');
    expect([200, 503]).toContain(res.status);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('trusts exactly one proxy hop, never all of them', () => {
    expect(app.get('trust proxy')).toBe(1);
  });
});
