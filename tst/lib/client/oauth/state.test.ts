import { describe, expect, it } from 'vitest';

import {
  consumeOAuthState,
  createOAuthState,
  markOAuthStateDiscordVerified,
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

  it('defaults to not requiring Discord verification (V1 direct-to-Meetup flow)', async () => {
    const state = await createOAuthState('discord-v1');
    expect(await resolveOAuthState(state)).toMatchObject({
      requiresDiscordVerification: false,
      discordVerified: false,
    });
  });

  it('keeps a Discord-first state unverified until the Discord hop completes', async () => {
    const state = await createOAuthState('discord-v2', {
      requiresDiscordVerification: true,
    });
    expect(await resolveOAuthState(state)).toMatchObject({
      requiresDiscordVerification: true,
      discordVerified: false,
    });

    await markOAuthStateDiscordVerified(state);

    expect(await resolveOAuthState(state)).toMatchObject({
      discordUserId: 'discord-v2',
      requiresDiscordVerification: true,
      discordVerified: true,
    });
  });

  it('marking an unknown state is a no-op rather than creating one', async () => {
    await markOAuthStateDiscordVerified('never-issued');
    expect(await resolveOAuthState('never-issued')).toBeUndefined();
  });

  it('reads legacy plain-string states left in the cache mid-deploy', async () => {
    const cache = await ApplicationCache();
    await cache.set('maskedUserId-legacy-state', 'discord-legacy');

    expect(await resolveOAuthState('legacy-state')).toMatchObject({
      discordUserId: 'discord-legacy',
      requiresDiscordVerification: false,
      discordVerified: false,
    });
  });
});
