import { v4 as uuidv4 } from 'uuid';

import { ApplicationCache } from '../../../util/cache.js';

const STATE_KEY_PREFIX = 'maskedUserId-';

// The state is a bearer credential for one flow. It only has to survive a
// user walking through two consent screens, so it expires long before the
// cache's 12h default would let an abandoned state be replayed.
const STATE_TTL_SEC = 10 * 60;

export interface OAuthStateRecord {
  discordUserId: string;
  /**
   * True for the V2 (Discord-first) flow: the Meetup hop must refuse to run
   * until the Discord callback has proven the person walking the flow owns
   * the Discord account the state is bound to. False for the V1 flow, which
   * links straight to Meetup and has no Discord hop to verify with.
   */
}

const stateKey = (state: string) => `${STATE_KEY_PREFIX}${state}`;

async function writeState(
  state: string,
  record: OAuthStateRecord,
): Promise<void> {
  const cache = await ApplicationCache();
  await cache.set(stateKey(state), JSON.stringify(record), STATE_TTL_SEC);
}

/**
 * Binds a fresh OAuth state (uuid) to the Discord user who initiated the
 * flow. The state rides the OAuth `state` query parameter end to end, so the
 * flow never depends on cookies (the old grant/express-session flow broke
 * whenever iOS finished the round-trip in a different browser context).
 */
export async function createOAuthState(discordUserId: string): Promise<string> {
  const state = uuidv4();
  await writeState(state, { discordUserId });
  return state;
}

export async function resolveOAuthState(
  state: string,
): Promise<OAuthStateRecord | undefined> {
  if (!state) {
    return undefined;
  }
  const cache = await ApplicationCache();
  const raw = await cache.get(stateKey(state));
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<OAuthStateRecord>;
    if (typeof parsed?.discordUserId !== 'string') {
      return undefined;
    }
    return { discordUserId: parsed.discordUserId };
  } catch {
    // States issued before this shape existed are the bare Discord ID, from
    // flows still in flight across a deploy.
    return { discordUserId: raw };
  }
}

/**
 * Invalidates a state so it can't be replayed. Called after the terminal hop
 * of the flow (the Meetup callback) and on the Discord callback's failure
 * branches — the Discord callback's success path must leave the state alive
 * so it can carry through to Meetup.
 */
export async function consumeOAuthState(state: string): Promise<void> {
  const cache = await ApplicationCache();
  await cache.remove(stateKey(state));
}
