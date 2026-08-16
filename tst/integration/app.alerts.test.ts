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
  it('alerts when the authorizing Discord account is not the one that pressed the button', async () => {
    const state = await createOAuthState('user-mismatch');
    nock('https://discord.com').post('/api/oauth2/token').reply(200, {
      access_token: 'discord-access',
      refresh_token: 'discord-refresh',
      token_type: 'Bearer',
      expires_in: 604800,
    });
    nock('https://discord.com')
      .get('/api/v10/users/@me')
      .reply(200, { id: 'somebody-else' });

    await request(app).get(`/connect/discord/callback?state=${state}&code=c`);

    expect(alertTitles().join()).toMatch(/mismatch/i);
  });

  it('alerts when a token exchange fails', async () => {
    const state = await createOAuthState('user-exchange');
    nock('https://discord.com').post('/api/oauth2/token').reply(500, {});

    await request(app).get(`/connect/discord/callback?state=${state}&code=c`);

    expect(alertTitles().join()).toMatch(/exchange/i);
  });

  it('alerts when the member denies the provider prompt', async () => {
    const state = await createOAuthState('user-denied');

    await request(app).get(
      `/connect/discord/callback?state=${state}&error=access_denied`,
    );

    expect(alertTitles().join()).toMatch(/denied/i);
  });

  it('does NOT alert on an expired or unknown state -- stale links and crawlers are not faults', async () => {
    await request(app).get('/connect/discord/callback?state=nope&code=c');
    await request(app).get('/connect/discord?state=nope');

    expect(alertTitles()).toEqual([]);
    expect(activityTitles().join()).toMatch(/expired/i);
  });

  it('stays silent when no Discord client has been wired in yet', async () => {
    setOAuthAlertClient(undefined);
    const state = await createOAuthState('user-noclient');

    await request(app).get(
      `/connect/discord/callback?state=${state}&error=access_denied`,
    );

    expect(vi.mocked(discordLogger.logAlert)).not.toHaveBeenCalled();
  });
});
