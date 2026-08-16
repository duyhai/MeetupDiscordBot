import { describe, expect, it } from 'vitest';

import {
  clearPendingOAuthState,
  getOrCreateOAuthState,
  resolveOAuthState,
} from '../../../../src/lib/client/oauth/state.js';

describe('getOrCreateOAuthState', () => {
  it('reuses the in-flight state so a retry re-shows the same link', async () => {
    const first = await getOrCreateOAuthState('user-reuse');
    const second = await getOrCreateOAuthState('user-reuse');

    expect(second).toBe(first);
    expect(await resolveOAuthState(first)).toMatchObject({
      discordUserId: 'user-reuse',
    });
  });

  it('mints a fresh state once the pending one is cleared', async () => {
    const first = await getOrCreateOAuthState('user-cleared');
    await clearPendingOAuthState('user-cleared');
    const second = await getOrCreateOAuthState('user-cleared');

    expect(second).not.toBe(first);
  });

  it('keeps members separate', async () => {
    const a = await getOrCreateOAuthState('user-a');
    const b = await getOrCreateOAuthState('user-b');

    expect(a).not.toBe(b);
    expect(await resolveOAuthState(a)).toMatchObject({
      discordUserId: 'user-a',
    });
    expect(await resolveOAuthState(b)).toMatchObject({
      discordUserId: 'user-b',
    });
  });

  it('mints a fresh state when the pending one no longer resolves', async () => {
    // A pending marker can outlive the state it points at -- the Meetup
    // callback consumes the state, and TTLs are independent. Handing back a
    // dead state would send the member to a link that reports "expired".
    const first = await getOrCreateOAuthState('user-stale');
    const { consumeOAuthState } =
      await import('../../../../src/lib/client/oauth/state.js');
    await consumeOAuthState(first);

    const second = await getOrCreateOAuthState('user-stale');

    expect(second).not.toBe(first);
    expect(await resolveOAuthState(second)).toMatchObject({
      discordUserId: 'user-stale',
    });
  });
});
