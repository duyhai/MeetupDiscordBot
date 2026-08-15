import { describe, expect, it } from 'vitest';

import {
  consumeOAuthState,
  createOAuthState,
  resolveOAuthState,
} from '../../../../src/lib/client/oauth/state.js';

// Uses the real InMemoryCache singleton (no REDISCLOUD_URL in unit tests);
// uuid states are unique per call so tests don't collide.
describe('oauth state', () => {
  it('round-trips a state to the creating user', async () => {
    const state = await createOAuthState('discord-123');
    expect(state).toMatch(/^[0-9a-f-]{36}$/);
    expect(await resolveOAuthState(state)).toBe('discord-123');
  });

  it('returns undefined for unknown or empty state', async () => {
    expect(await resolveOAuthState('unknown-state')).toBeUndefined();
    expect(await resolveOAuthState('')).toBeUndefined();
  });

  it('issues distinct states per call', async () => {
    const a = await createOAuthState('discord-123');
    const b = await createOAuthState('discord-123');
    expect(a).not.toBe(b);
  });

  it('consumeOAuthState makes the state unresolvable', async () => {
    const state = await createOAuthState('discord-456');
    expect(await resolveOAuthState(state)).toBe('discord-456');
    await consumeOAuthState(state);
    expect(await resolveOAuthState(state)).toBeUndefined();
  });
});
