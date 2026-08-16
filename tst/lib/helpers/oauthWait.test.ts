import { describe, expect, it } from 'vitest';

import { waitForOAuthTokens } from '../../../src/lib/helpers/oauthWait.js';

const KEY_DISCORD = 'user-1-discord-tokens';
const KEY_MEETUP = 'user-1-meetup-tokens';

// A short timeout keeps the suite fast; production passes 3 minutes.
const opts = { intervalMs: 5, timeoutMs: 40 };

describe('waitForOAuthTokens', () => {
  it('returns both token blobs once they land', async () => {
    const store = new Map<string, string>();
    // Both arrive shortly after the wait starts.
    setTimeout(() => store.set(KEY_DISCORD, 'd-tok'), 5);
    setTimeout(() => store.set(KEY_MEETUP, 'm-tok'), 10);

    const result = await waitForOAuthTokens(
      async (key) => store.get(key),
      { discordKey: KEY_DISCORD, meetupKey: KEY_MEETUP },
      { ...opts, timeoutMs: 500 },
    );

    expect(result).toEqual({
      status: 'ready',
      rawDiscordTokens: 'd-tok',
      rawMeetupTokens: 'm-tok',
    });
  });

  it('reports discord as the pending hop when nothing arrives', async () => {
    const result = await waitForOAuthTokens(
      async () => undefined,
      { discordKey: KEY_DISCORD, meetupKey: KEY_MEETUP },
      opts,
    );

    expect(result).toEqual({ status: 'pending', pendingHop: 'Discord' });
  });

  it('reports meetup as the pending hop when only discord finished', async () => {
    const store = new Map([[KEY_DISCORD, 'd-tok']]);

    const result = await waitForOAuthTokens(
      async (key) => store.get(key),
      { discordKey: KEY_DISCORD, meetupKey: KEY_MEETUP },
      opts,
    );

    expect(result).toEqual({ status: 'pending', pendingHop: 'Meetup' });
  });

  it('never throws on timeout -- an unfinished authorization is not a fault', async () => {
    await expect(
      waitForOAuthTokens(
        async () => undefined,
        { discordKey: KEY_DISCORD, meetupKey: KEY_MEETUP },
        opts,
      ),
    ).resolves.toMatchObject({ status: 'pending' });
  });
});
