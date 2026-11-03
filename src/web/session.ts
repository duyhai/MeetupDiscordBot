import crypto from 'crypto';

import { KeyValueCache } from '../lib/cache/base.js';

export const SESSION_COOKIE = 'dash_sid';
/**
 * A sign-in ends after this long without use. Each role re-check slides the
 * window, so in practice the limit is this minus up to ROLE_RECHECK_MS.
 */
export const SESSION_IDLE_SEC = 7 * 24 * 60 * 60;
/** No sign-in lasts longer than this from when it was made, however used. */
export const SESSION_MAX_SEC = 30 * 24 * 60 * 60;
/**
 * Losing the role locks someone out within this long. This, not the session
 * lifetime, is what bounds access after a role is taken away.
 */
export const ROLE_RECHECK_MS = 10 * 60 * 1000;
/**
 * A revocation mark outlives every session it can end: once it expires, any
 * session created before it has expired too.
 */
export const VALID_AFTER_TTL_SEC = SESSION_MAX_SEC + 60;

/**
 * Seconds a session key should live from `at`: the idle window, cut short
 * so it never outlives the absolute cap. Zero or less once the cap is hit.
 */
export function sessionKeyTtlSec(createdAt: number, at: number): number {
  const remainingSec = Math.ceil(
    (createdAt + SESSION_MAX_SEC * 1000 - at) / 1000,
  );
  return Math.min(SESSION_IDLE_SEC, remainingSec);
}

const DISCORD_ID = /^[0-9]{17,20}$/;

/** Epoch ms: every session of this user created at or before it is revoked. */
export const validAfterKey = (userId: string) =>
  `dashboard-user-valid-after-${userId}`;

export interface DashboardSession {
  userId: string;
  username: string;
  csrfToken: string;
  /** Epoch ms. SESSION_MAX_SEC from here is the hard end, never extended. */
  createdAt: number;
  roleCheckedAt: number;
}

const randomToken = () => crypto.randomBytes(32).toString('base64url');

/**
 * Keyed by a hash of the id, so whoever can read Redis still cannot replay a
 * session cookie from what is stored there.
 */
export const sessionKey = (sid: string) =>
  `dashboard-session-${crypto.createHash('sha256').update(sid).digest('hex')}`;

/**
 * The `sid:` prefix separates this MAC from the OAuth cookie's (`oauth:`),
 * which uses the same secret and the same `body.mac` shape: neither value can
 * pass as the other.
 */
const mac = (sid: string, secret: string) =>
  crypto.createHmac('sha256', secret).update(`sid:${sid}`).digest('base64url');

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function signSessionId(sid: string, secret: string): string {
  return `${sid}.${mac(sid, secret)}`;
}

export function verifySignedSessionId(
  value: string,
  secret: string,
): string | undefined {
  const dot = value.lastIndexOf('.');
  if (dot <= 0) {
    return undefined;
  }
  const sid = value.slice(0, dot);
  return safeEqual(value.slice(dot + 1), mac(sid, secret)) ? sid : undefined;
}

function isSession(value: unknown): value is DashboardSession {
  const v = value as Partial<DashboardSession> | null;
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof v.userId === 'string' &&
    typeof v.username === 'string' &&
    typeof v.csrfToken === 'string' &&
    typeof v.createdAt === 'number' &&
    typeof v.roleCheckedAt === 'number'
  );
}

export class SessionStore {
  constructor(
    private readonly cache: KeyValueCache,
    private readonly now: () => number = Date.now,
  ) {}

  async create(user: {
    userId: string;
    username: string;
  }): Promise<{ sid: string; session: DashboardSession }> {
    const sid = randomToken();
    const at = this.now();
    const session: DashboardSession = {
      ...user,
      csrfToken: randomToken(),
      createdAt: at,
      roleCheckedAt: at,
    };
    await this.cache.set(
      sessionKey(sid),
      JSON.stringify(session),
      sessionKeyTtlSec(at, at),
    );
    return { sid, session };
  }

  async get(sid: string): Promise<DashboardSession | undefined> {
    const raw = await this.cache.get(sessionKey(sid));
    if (!raw) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!isSession(parsed)) {
      return undefined;
    }
    if (this.now() - parsed.createdAt >= SESSION_MAX_SEC * 1000) {
      await this.destroy(sid);
      return undefined;
    }
    return parsed;
  }

  /**
   * Records the role check and slides the idle window: the key lives
   * another SESSION_IDLE_SEC, never past createdAt + SESSION_MAX_SEC. This
   * is the only write that extends a session, so it happens at most once
   * per ROLE_RECHECK_MS.
   *
   * One SET ... XX: a logout (or revocation) that deleted the key before this
   * write is never undone, and one that lands after it still deletes the key.
   * There is no read first, so there is no window between check and write.
   */
  async markRoleChecked(
    sid: string,
    session: DashboardSession,
  ): Promise<boolean> {
    const at = this.now();
    const ttlSec = sessionKeyTtlSec(session.createdAt, at);
    if (ttlSec <= 0) {
      // Tidy-up only: the key's TTL already ends at the cap, so a failed
      // delete must not fail the request.
      this.destroy(sid).catch(() => undefined);
      return false;
    }
    return this.cache.set_existing(
      sessionKey(sid),
      JSON.stringify({ ...session, roleCheckedAt: at }),
      ttlSec,
    );
  }

  async destroy(sid: string): Promise<void> {
    await this.cache.remove(sessionKey(sid));
  }

  /**
   * Ends every session of this user created at or before now, in every
   * browser. A per-user "valid after" mark rather than a session index:
   * the cache has no set operations, and one read per request cannot drift
   * from the session keys.
   */
  async revokeUser(userId: string): Promise<void> {
    if (typeof userId !== 'string' || !DISCORD_ID.test(userId)) {
      throw new RangeError('userId must be a Discord id');
    }
    await this.cache.set(
      validAfterKey(userId),
      String(this.now()),
      VALID_AFTER_TTL_SEC,
    );
  }

  /**
   * True when the user has a mark at or after this session's createdAt.
   * Fails closed: a mark that does not read as a number, or a session whose
   * user id is not a Discord id, counts as revoked.
   */
  async isRevoked(session: DashboardSession): Promise<boolean> {
    if (!DISCORD_ID.test(session.userId)) {
      return true;
    }
    const raw = await this.cache.get(validAfterKey(session.userId));
    if (raw === undefined) {
      return false;
    }
    const after = raw.trim() === '' ? NaN : Number(raw);
    return !Number.isFinite(after) || session.createdAt <= after;
  }
}
