import nock from 'nock';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MeetupTokenRefreshError,
  refreshMeetupToken,
} from '../../../../src/lib/client/oauth/providers.js';

afterEach(() => nock.cleanAll());

describe('refreshMeetupToken', () => {
  it('exchanges a refresh token for a new access token', async () => {
    nock('https://secure.meetup.com')
      .post(
        '/oauth2/access',
        (body) =>
          (body as Record<string, string>).grant_type === 'refresh_token',
      )
      .reply(200, {
        access_token: 'new-access',
        refresh_token: 'same-refresh',
        expires_in: 3600,
      });

    const tokens = await refreshMeetupToken('old-refresh');

    expect(tokens.accessToken).toBe('new-access');
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
  });

  it('surfaces the rotated refresh token when one comes back', async () => {
    nock('https://secure.meetup.com').post('/oauth2/access').reply(200, {
      access_token: 'new-access',
      refresh_token: 'ROTATED',
      expires_in: 3600,
    });

    // Whether Meetup rotates cannot be known without performing a refresh.
    // If it does and the new token is dropped, the next sweep authenticates
    // with a dead credential and monitoring stops.
    expect((await refreshMeetupToken('old')).refreshToken).toBe('ROTATED');
  });

  it('defaults the expiry to an hour when expires_in is absent', async () => {
    nock('https://secure.meetup.com').post('/oauth2/access').reply(200, {
      access_token: 'new-access',
      refresh_token: 'same-refresh',
    });

    const before = Date.now();
    const tokens = await refreshMeetupToken('old-refresh');

    // Without the guard this is `Date.now() + NaN` -- and NaN reaches the
    // credential row as `new Date(NaN)`, which Postgres rejects, so the
    // freshly-refreshed (and possibly sole-valid) pair is never stored.
    expect(Number.isFinite(tokens.expiresAt)).toBe(true);
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
  });

  it('defaults the expiry when expires_in is not a number', async () => {
    nock('https://secure.meetup.com').post('/oauth2/access').reply(200, {
      access_token: 'new-access',
      refresh_token: 'same-refresh',
      expires_in: 'soon',
    });

    expect(
      Number.isFinite((await refreshMeetupToken('old-refresh')).expiresAt),
    ).toBe(true);
  });

  it('throws with the status when Meetup rejects the refresh', async () => {
    nock('https://secure.meetup.com')
      .post('/oauth2/access')
      .reply(400, 'invalid_grant');

    await expect(refreshMeetupToken('revoked')).rejects.toThrow(/400/);
  });

  it('reports the HTTP status on its error, so callers need not parse the message', async () => {
    nock('https://secure.meetup.com')
      .post('/oauth2/access')
      .reply(401, { error: 'invalid_client' });

    const error: unknown = await refreshMeetupToken('revoked').catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(MeetupTokenRefreshError);
    expect((error as MeetupTokenRefreshError).status).toBe(401);
    expect((error as MeetupTokenRefreshError).oauthError).toBe(
      'invalid_client',
    );
  });

  it.each([
    ['is not JSON', 'Bad Gateway'],
    ['has no error field', { message: 'nope' }],
    // Only a short OAuth-style code is carried; anything else could be the
    // provider echoing request data, and this value gets logged.
    [
      'carries something that is not an error code',
      { error: 'token abc123 was REJECTED!' },
    ],
  ])('carries no OAuth error code when the body %s', async (_name, body) => {
    nock('https://secure.meetup.com').post('/oauth2/access').reply(400, body);

    const error: unknown = await refreshMeetupToken('revoked').catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(MeetupTokenRefreshError);
    expect((error as MeetupTokenRefreshError).oauthError).toBeUndefined();
  });
});
