import { Client } from 'discord.js';
import nock from 'nock';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as discordLogger from '../../src/lib/helpers/discordLogger.js';
import { createOAuthState } from '../../src/lib/client/oauth/state.js';

vi.mock('../../src/lib/helpers/discordLogger.js', () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
  logAlert: vi.fn().mockResolvedValue(undefined),
}));

// Imported after the mock so app.ts binds the mocked logger.
const { default: app, setOAuthAlertClient } = await import('../../src/app.js');

const fakeClient = {} as Client;

const alertTitles = () =>
  vi.mocked(discordLogger.logAlert).mock.calls.map(([, entry]) => entry.title);
const activityTitles = () =>
  vi
    .mocked(discordLogger.logActivity)
    .mock.calls.map(([, entry]) => entry.title);

beforeEach(() => {
  vi.clearAllMocks();
  setOAuthAlertClient(fakeClient);
});

afterEach(() => {
  nock.cleanAll();
});

describe('OAuth callback visibility', () => {
  it('alerts when a token exchange fails', async () => {
    const state = await createOAuthState('user-exchange');
    nock('https://secure.meetup.com').post('/oauth2/access').reply(500, {});

    await request(app).get(`/connect/meetup/callback?state=${state}&code=c`);

    expect(alertTitles().join()).toMatch(/exchange/i);
  });

  it('alerts when the member denies the provider prompt', async () => {
    const state = await createOAuthState('user-denied');

    await request(app).get(
      `/connect/meetup/callback?state=${state}&error=access_denied`,
    );

    expect(alertTitles().join()).toMatch(/denied/i);
  });

  it('does NOT alert on an expired or unknown state -- stale links and crawlers are not faults', async () => {
    await request(app).get('/connect/meetup/callback?state=nope&code=c');
    await request(app).get('/connect/meetup?state=nope');

    expect(alertTitles()).toEqual([]);
    expect(activityTitles().join()).toMatch(/expired/i);
  });

  it('stays silent when no Discord client has been wired in yet', async () => {
    setOAuthAlertClient(undefined);
    const state = await createOAuthState('user-noclient');

    await request(app).get(
      `/connect/meetup/callback?state=${state}&error=access_denied`,
    );

    expect(vi.mocked(discordLogger.logAlert)).not.toHaveBeenCalled();
  });
});
