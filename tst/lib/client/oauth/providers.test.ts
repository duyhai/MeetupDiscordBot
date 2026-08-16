import nock from 'nock';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildMeetupAuthUrl,
  exchangeMeetupCode,
} from '../../../../src/lib/client/oauth/providers.js';

afterEach(() => {
  nock.cleanAll();
});

describe('authorize URL construction', () => {
  it('builds the Meetup URL with state and scope', () => {
    const url = new URL(buildMeetupAuthUrl('state-abc'));
    expect(url.origin + url.pathname).toBe(
      'https://secure.meetup.com/oauth2/authorize',
    );
    expect(url.searchParams.get('state')).toBe('state-abc');
    expect(url.searchParams.get('scope')).toBe('basic');
  });
});

describe('exchangeMeetupCode', () => {
  it('POSTs credentials in the form body and maps the token response', async () => {
    let capturedBody = '';
    nock('https://secure.meetup.com')
      .post('/oauth2/access', (body) => {
        capturedBody = new URLSearchParams(
          body as Record<string, string>,
        ).toString();
        return true;
      })
      .reply(200, {
        access_token: 'meetup-access',
        refresh_token: 'meetup-refresh',
        expires_in: 3600,
      });

    const tokens = await exchangeMeetupCode('the-code');

    expect(capturedBody).toContain('grant_type=authorization_code');
    expect(capturedBody).toContain('code=the-code');
    expect(capturedBody).toContain('client_id=meetup-key');
    expect(capturedBody).toContain('client_secret=meetup-secret');
    expect(tokens.accessToken).toBe('meetup-access');
    expect(tokens.refreshToken).toBe('meetup-refresh');
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());

    // Classic OAuth mismatch bug: the redirect_uri sent in the token
    // exchange must be byte-identical to the one in the authorize URL.
    const authorizeUrl = new URL(buildMeetupAuthUrl('state-abc'));
    const exchangeParams = new URLSearchParams(capturedBody);
    expect(exchangeParams.get('redirect_uri')).toBe(
      authorizeUrl.searchParams.get('redirect_uri'),
    );
  });

  it('throws a descriptive error on a non-2xx response', async () => {
    nock('https://secure.meetup.com')
      .post('/oauth2/access')
      .reply(400, { error: 'invalid_grant' });

    await expect(exchangeMeetupCode('bad-code')).rejects.toThrow(
      /Meetup token exchange failed/,
    );
  });
});
