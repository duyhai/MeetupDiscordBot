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
   * Set only on a state the staff dashboard issued to renew the shared
   * Meetup organizer login. The Meetup callback hands such a state to the
   * dashboard instead of linking a member account. Absent: member link.
   */
  purpose?: 'organizer-renew';
  /** sha256 (hex) of the dashboard session id that started the renewal. */
  sessionHash?: string;
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

/**
 * A state for the dashboard's "Renew organizer login" flow, bound to the
 * Discord user and the dashboard session (by hash: the raw session id never
 * reaches the cache) that started it. The completion route refuses it from
 * any other session.
 */
export async function createOrganizerRenewState(
  discordUserId: string,
  sessionHash: string,
): Promise<string> {
  const state = uuidv4();
  await writeState(state, {
    discordUserId,
    purpose: 'organizer-renew',
    sessionHash,
  });
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
    if (parsed.purpose === undefined) {
      return { discordUserId: parsed.discordUserId };
    }
    // Fail closed: a record that claims a purpose but is malformed is not
    // quietly downgraded to a member link.
    if (
      parsed.purpose !== 'organizer-renew' ||
      typeof parsed.sessionHash !== 'string'
    ) {
      return undefined;
    }
    return {
      discordUserId: parsed.discordUserId,
      purpose: parsed.purpose,
      sessionHash: parsed.sessionHash,
    };
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

/**
 * Marks a state used, without deleting it: true for exactly one caller per
 * state. The claim outlives the state itself (same TTL, set later), so a
 * claimed state can never be claimed again.
 */
export async function claimOAuthState(state: string): Promise<boolean> {
  if (!state) {
    return false;
  }
  const cache = await ApplicationCache();
  return cache.exclusive_set(
    `${STATE_KEY_PREFIX}consumed-${state}`,
    '1',
    STATE_TTL_SEC,
  );
}
