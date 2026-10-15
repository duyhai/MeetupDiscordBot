// tst/web/discordOAuth.test.ts
import nock from 'nock';
import { afterEach, describe, expect, it } from 'vitest';

import { BASE_DISCORD_BOT_URL } from '../../src/constants.js';
import {
  buildDashboardLoginUrl,
  dashboardRedirectUri,
  exchangeDashboardCode,
  fetchDiscordIdentity,
} from '../../src/web/discordOAuth.js';

afterEach(() => nock.cleanAll());

describe('dashboard Discord OAuth', () => {
  it('uses the dashboard callback as the redirect URI', () => {
    expect(dashboardRedirectUri()).toBe(
      `${BASE_DISCORD_BOT_URL}/dashboard/auth/callback`,
    );
  });

  // BASE_DISCORD_BOT_URL is read at import time and flips to localhost when
  // TS_NODE_DEBUG is set, so the production value is only asserted without it.
  it.skipIf(Boolean(process.env.TS_NODE_DEBUG))(
    'is the URI registered in the Discord portal',
    () => {
      expect(dashboardRedirectUri()).toBe(
        'https://meetup-discord-bot.herokuapp.com/dashboard/auth/callback',
      );
    },
  );

  it('asks for identify only, with state and a PKCE challenge', () => {
    const url = new URL(buildDashboardLoginUrl('state-1', 'v'.repeat(43)));
    expect(url.origin + url.pathname).toBe(
      'https://discord.com/oauth2/authorize',
    );
    expect(url.searchParams.get('scope')).toBe('identify');
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(dashboardRedirectUri());
  });

  it('exchanges a code for an access token', async () => {
    const verifier = 'v'.repeat(43);
    let seen = '';
    nock('https://discord.com')
      .post('/api/oauth2/token', (body) => {
        seen = new URLSearchParams(body as Record<string, string>).toString();
        return true;
      })
      .reply(200, { access_token: 'at', token_type: 'Bearer' });
    await expect(exchangeDashboardCode('code', verifier)).resolves.toBe('at');
    const sent = new URLSearchParams(seen);
    expect(sent.get('code')).toBe('code');
    expect(sent.get('code_verifier')).toBe(verifier);
    expect(sent.get('grant_type')).toBe('authorization_code');
    expect(sent.get('redirect_uri')).toBe(dashboardRedirectUri());
  });

  it('rejects a failed exchange without echoing the body', async () => {
    nock('https://discord.com')
      .post('/api/oauth2/token')
      .reply(400, '{"error":"invalid_grant","secret":"leak"}');
    await expect(exchangeDashboardCode('code', 'v')).rejects.toThrow(
      /^Discord token exchange failed: 400$/,
    );
  });

  it('rejects an exchange response without an access token', async () => {
    nock('https://discord.com')
      .post('/api/oauth2/token')
      .reply(200, { token_type: 'Bearer' });
    await expect(exchangeDashboardCode('code', 'v')).rejects.toThrow(
      'Discord token exchange returned no access token',
    );
  });

  it('reads the signed-in user id and display name', async () => {
    nock('https://discord.com')
      .get('/api/v10/users/@me')
      .matchHeader('authorization', 'Bearer at')
      .reply(200, {
        id: '123456789012345678',
        username: 'handle',
        global_name: 'Shown',
      });
    await expect(fetchDiscordIdentity('at')).resolves.toEqual({
      id: '123456789012345678',
      username: 'Shown',
    });
  });

  it('falls back to the username when there is no display name', async () => {
    nock('https://discord.com')
      .get('/api/v10/users/@me')
      .reply(200, { id: '123456789012345678', username: 'handle' });
    await expect(fetchDiscordIdentity('at')).resolves.toEqual({
      id: '123456789012345678',
      username: 'handle',
    });
  });

  it('rejects a non-snowflake id', async () => {
    nock('https://discord.com')
      .get('/api/v10/users/@me')
      .reply(200, { id: '../x', username: 'h' });
    await expect(fetchDiscordIdentity('at')).rejects.toThrow('no usable id');
  });

  it('fails on a non-2xx identity response without echoing the body', async () => {
    nock('https://discord.com')
      .get('/api/v10/users/@me')
      .reply(401, 'secret-ish body');
    await expect(fetchDiscordIdentity('at')).rejects.toThrow(
      /^Discord identity lookup failed: 401$/,
    );
  });
});
