import nock from 'nock';
import { afterEach, describe, expect, it } from 'vitest';

import { refreshMeetupToken } from '../../../../src/lib/client/oauth/providers.js';

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

  it('throws with the status when Meetup rejects the refresh', async () => {
    nock('https://secure.meetup.com')
      .post('/oauth2/access')
      .reply(400, 'invalid_grant');

    await expect(refreshMeetupToken('revoked')).rejects.toThrow(/400/);
  });
});
