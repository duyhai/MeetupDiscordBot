import { describe, expect, it } from 'vitest';

import {
  claimOAuthState,
  consumeOAuthState,
  createOAuthState,
  createOrganizerRenewState,
  resolveOAuthState,
} from '../../../../src/lib/client/oauth/state.js';
import { ApplicationCache } from '../../../../src/util/cache.js';

// Uses the real InMemoryCache singleton (no REDISCLOUD_URL in unit tests);
// uuid states are unique per call so tests don't collide.
describe('oauth state', () => {
  it('round-trips a state to the creating user', async () => {
    const state = await createOAuthState('discord-123');
    expect(state).toMatch(/^[0-9a-f-]{36}$/);
    expect(await resolveOAuthState(state)).toMatchObject({
      discordUserId: 'discord-123',
    });
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
    expect(await resolveOAuthState(state)).toMatchObject({
      discordUserId: 'discord-456',
    });
    await consumeOAuthState(state);
    expect(await resolveOAuthState(state)).toBeUndefined();
  });

  it('a member-link state carries no purpose or session binding', async () => {
    const state = await createOAuthState('discord-789');
    expect(await resolveOAuthState(state)).toEqual({
      discordUserId: 'discord-789',
    });
  });

  it('round-trips an organizer-renew state with its session hash', async () => {
    const state = await createOrganizerRenewState('discord-1', 'a'.repeat(64));
    expect(state).toMatch(/^[0-9a-f-]{36}$/);
    expect(await resolveOAuthState(state)).toEqual({
      discordUserId: 'discord-1',
      purpose: 'organizer-renew',
      sessionHash: 'a'.repeat(64),
    });
  });

  it('refuses a stored record whose purpose or session hash is malformed', async () => {
    const cache = await ApplicationCache();
    await cache.set(
      'maskedUserId-odd-purpose',
      JSON.stringify({ discordUserId: 'd', purpose: 'admin' }),
    );
    await cache.set(
      'maskedUserId-odd-hash',
      JSON.stringify({
        discordUserId: 'd',
        purpose: 'organizer-renew',
        sessionHash: 5,
      }),
    );
    expect(await resolveOAuthState('odd-purpose')).toBeUndefined();
    expect(await resolveOAuthState('odd-hash')).toBeUndefined();
  });

  it('claimOAuthState succeeds once per state', async () => {
    const state = await createOrganizerRenewState('discord-2', 'b'.repeat(64));
    expect(await claimOAuthState(state)).toBe(true);
    expect(await claimOAuthState(state)).toBe(false);
    expect(await claimOAuthState('')).toBe(false);
  });
});
