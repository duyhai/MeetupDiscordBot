import { v4 as uuidv4 } from 'uuid';

import { ApplicationCache } from '../../../util/cache.js';

const STATE_KEY_PREFIX = 'maskedUserId-';

/**
 * Binds a fresh OAuth state (uuid) to the Discord user who initiated the
 * flow. The state rides the OAuth `state` query parameter end to end, so the
 * flow never depends on cookies (the old grant/express-session flow broke
 * whenever iOS finished the round-trip in a different browser context).
 */
export async function createOAuthState(discordUserId: string): Promise<string> {
  const state = uuidv4();
  const cache = await ApplicationCache();
  await cache.set(`${STATE_KEY_PREFIX}${state}`, discordUserId);
  return state;
}

export async function resolveOAuthState(
  state: string,
): Promise<string | undefined> {
  if (!state) {
    return undefined;
  }
  const cache = await ApplicationCache();
  return cache.get(`${STATE_KEY_PREFIX}${state}`);
}
