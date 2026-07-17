import crypto from 'crypto';
import { sign } from 'cookie-signature';
import express from 'express';
import session from 'express-session';
import request from 'supertest';

import app, {
  discordConnectCallbackHandler,
  meetupConnectCallbackHandler,
} from '../../src/app.js';
import { generateOAuthUrl } from '../../src/constants.js';
import { ApplicationCache } from '../../src/util/cache.js';

// Must match the `secret` passed to `session(...)` in src/app.ts.
const SESSION_SECRET = 'grant';

// The real app also runs `grant.express()`, which owns
// `/connect/:provider/callback` itself and intercepts the request before our
// handler ever runs (it needs live OAuth credentials to consider a provider
// "configured", which we don't have in CI). So for these two callback routes
// we mount the exported handlers directly on a minimal app instead -- this
// still exercises the real session/cookie pipeline, the real handler code,
// and the real cache, just without the vendor OAuth middleware in between.
function buildCallbackTestApp(store: session.Store) {
  const testApp = express();
  testApp.use(
    session({
      secret: SESSION_SECRET,
      saveUninitialized: true,
      resave: false,
      store,
    })
  );
  testApp.get('/connect/discord/callback', discordConnectCallbackHandler);
  testApp.get('/connect/meetup/callback', meetupConnectCallbackHandler);
  return testApp;
}

function seedSession(
  store: session.Store,
  sid: string,
  grant: Record<string, unknown>
): Promise<void> {
  return new Promise((resolve, reject) => {
    // express-session's Store.createSession reads sess.cookie.expires
    // unconditionally, so a bare cookie stub is required even though
    // these tests don't care about expiry.
    (
      store.set as (
        sid: string,
        session: unknown,
        cb: (err?: Error) => void
      ) => void
    )(
      sid,
      { cookie: { originalMaxAge: null, expires: null }, grant },
      (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      }
    );
  });
}

function cookieHeaderFor(sid: string): string {
  const signed = `s:${sign(sid, SESSION_SECRET)}`;
  return `connect.sid=${encodeURIComponent(signed)}`;
}

describe('app OAuth entry routes (integration)', () => {
  it('GET /discord-meetup-connect redirects to the Discord OAuth entry point', async () => {
    const res = await request(app).get('/discord-meetup-connect');

    expect(res.status).toBe(307);
    expect(res.headers.location).toBe(generateOAuthUrl('discord'));
  });

  it('GET /redirect/:url decodes the base64 target and forwards query params', async () => {
    const target = 'https://example.com/landing';
    const encoded = Buffer.from(target).toString('base64');

    const res = await request(app)
      .get(`/redirect/${encoded}`)
      .query({ foo: 'bar' });

    expect(res.status).toBe(307);
    expect(res.headers.location).toBe(`${target}?foo=bar`);
  });
});

describe('OAuth callback handlers (integration)', () => {
  const store = new session.MemoryStore();
  const testApp = buildCallbackTestApp(store);

  describe('/connect/discord/callback', () => {
    it('stores Discord tokens and the masked user id, then redirects into the Meetup OAuth step', async () => {
      const sid = `discord-success-${crypto.randomUUID()}`;
      const state = `state-${crypto.randomUUID()}`;
      await seedSession(store, sid, {
        response: {
          raw: {
            access_token: 'discord-access-token',
            refresh_token: 'discord-refresh-token',
            expires_in: 3600,
          },
          profile: { id: 'discord-user-1' },
        },
        state,
      });

      const res = await request(testApp)
        .get('/connect/discord/callback')
        .set('Cookie', cookieHeaderFor(sid));

      expect(res.status).toBe(307);
      expect(res.headers.location).toBe(generateOAuthUrl('meetup', { state }));

      const cache = await ApplicationCache();
      expect(await cache.get(`maskedUserId-${state}`)).toBe('discord-user-1');
      const storedTokens = await cache.get('discord-user-1-discord-tokens');
      expect(storedTokens && JSON.parse(storedTokens)).toMatchObject({
        accessToken: 'discord-access-token',
        refreshToken: 'discord-refresh-token',
      });
    });

    it('echoes the provider error when Discord auth fails', async () => {
      const sid = `discord-error-${crypto.randomUUID()}`;
      await seedSession(store, sid, {
        response: { error: { message: 'access_denied' } },
      });

      const res = await request(testApp)
        .get('/connect/discord/callback')
        .set('Cookie', cookieHeaderFor(sid));

      expect(res.status).toBe(200);
      expect(res.text).toBe(JSON.stringify({ message: 'access_denied' }));
    });
  });

  describe('/connect/meetup/callback', () => {
    it('stores Meetup tokens against the previously masked user id and renders the success landing page', async () => {
      const sid = `meetup-success-${crypto.randomUUID()}`;
      const state = `state-${crypto.randomUUID()}`;
      const cache = await ApplicationCache();
      await cache.set(`maskedUserId-${state}`, 'discord-user-2');

      await seedSession(store, sid, {
        response: {
          raw: {
            access_token: 'meetup-access-token',
            refresh_token: 'meetup-refresh-token',
            expires_in: 3600,
          },
        },
        state,
      });

      const res = await request(testApp)
        .get('/connect/meetup/callback')
        .set('Cookie', cookieHeaderFor(sid));

      expect(res.status).toBe(200);
      expect(res.text).toContain('Connected to Meetup');

      const storedTokens = await cache.get('discord-user-2-meetup-tokens');
      expect(storedTokens && JSON.parse(storedTokens)).toMatchObject({
        accessToken: 'meetup-access-token',
        refreshToken: 'meetup-refresh-token',
      });
    });

    it('renders the error landing page when Meetup auth fails', async () => {
      const sid = `meetup-error-${crypto.randomUUID()}`;
      await seedSession(store, sid, {
        response: { error: { message: 'access_denied' } },
      });

      const res = await request(testApp)
        .get('/connect/meetup/callback')
        .set('Cookie', cookieHeaderFor(sid));

      expect(res.status).toBe(200);
      expect(res.text).toContain('Something went wrong');
    });
  });
});
