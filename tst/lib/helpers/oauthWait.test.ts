import { describe, expect, it } from 'vitest';

import { waitForMeetupTokens } from '../../../src/lib/helpers/oauthWait.js';

const KEY = 'user-1-meetup-tokens';

// A short timeout keeps the suite fast; production waits 3 minutes.
const opts = { intervalMs: 5, timeoutMs: 40 };

describe('waitForMeetupTokens', () => {
  it('returns the tokens once they land', async () => {
    const store = new Map<string, string>();
    setTimeout(() => store.set(KEY, 'm-tok'), 5);

    const result = await waitForMeetupTokens(async (k) => store.get(k), KEY, {
      ...opts,
      timeoutMs: 500,
    });

    expect(result).toEqual({ status: 'ready', rawTokens: 'm-tok' });
  });

  it('returns pending rather than throwing when the member has not finished', async () => {
    // Not a fault: tokens outlive the interaction, so the next attempt picks
    // up instantly. Throwing here used to post a red alert for ordinary
    // human slowness.
    const result = await waitForMeetupTokens(async () => undefined, KEY, opts);

    expect(result).toEqual({ status: 'pending' });
  });

  it('returns immediately when tokens are already cached', async () => {
    const started = Date.now();
    const result = await waitForMeetupTokens(async () => 'cached', KEY, {
      intervalMs: 1000,
      timeoutMs: 5000,
    });

    expect(result).toEqual({ status: 'ready', rawTokens: 'cached' });
    expect(Date.now() - started).toBeLessThan(500);
  });
});
