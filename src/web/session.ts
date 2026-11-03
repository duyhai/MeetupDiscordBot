import crypto from 'crypto';

import { KeyValueCache } from '../lib/cache/base.js';

export const SESSION_COOKIE = 'dash_sid';
export const SESSION_TTL_SEC = 12 * 60 * 60;
/** Losing the role locks someone out within this long. */
export const ROLE_RECHECK_MS = 10 * 60 * 1000;
/**
 * A revocation mark outlives every session it can end: once it expires, any
 * session created before it has expired too.
 */
export const VALID_AFTER_TTL_SEC = SESSION_TTL_SEC + 60;

const DISCORD_ID = /^[0-9]{17,20}$/;

/** Epoch ms: every session of this user created at or before it is revoked. */
export const validAfterKey = (userId: string) =>
  `dashboard-user-valid-after-${userId}`;

/**
 * What separates one site's sessions from another's in Redis. The staff
 * dashboard keys sessions by Discord id; the host dashboard by Meetup member
 * id, with its own prefixes, so neither store can read or revoke the other's.
 */
export interface SessionStoreOptions<S extends DashboardSession> {
  keyPrefix: string;
  validAfterPrefix: string;
  /** A session whose userId fails this counts as revoked. */
  userIdPattern: RegExp;
  /** Checks the fields S adds to DashboardSession on every read. */
  isExtra?: (
    value: Record<string, unknown>,
  ) => value is Record<string, unknown> & Omit<S, keyof DashboardSession>;
}

export const DASHBOARD_SESSION_OPTIONS: SessionStoreOptions<DashboardSession> =
  Object.freeze({
    keyPrefix: 'dashboard-session-',
    validAfterPrefix: 'dashboard-user-valid-after-',
    userIdPattern: DISCORD_ID,
  });

export interface DashboardSession {
  userId: string;
  username: string;
  csrfToken: string;
  /** Epoch ms. The lifetime is absolute from here, never extended. */
  createdAt: number;
  roleCheckedAt: number;
}

const randomToken = () => crypto.randomBytes(32).toString('base64url');

/**
 * Keyed by a hash of the id, so whoever can read Redis still cannot replay a
 * session cookie from what is stored there.
 */
const hashOf = (sid: string) =>
  crypto.createHash('sha256').update(sid).digest('hex');

/**
 * The `sid:` prefix separates this MAC from the OAuth cookie's (`oauth:`),
 * which uses the same secret and the same `body.mac` shape: neither value can
 * pass as the other. The host dashboard signs with `host-sid:`, so a staff
 * cookie never verifies there, nor a host cookie here.
 */
const mac = (sid: string, secret: string, domain: string) =>
  crypto
    .createHmac('sha256', secret)
    .update(`${domain}:${sid}`)
    .digest('base64url');

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function signSessionId(
  sid: string,
  secret: string,
  domain = 'sid',
): string {
  return `${sid}.${mac(sid, secret, domain)}`;
}

export function verifySignedSessionId(
  value: string,
  secret: string,
  domain = 'sid',
): string | undefined {
  const dot = value.lastIndexOf('.');
  if (dot <= 0) {
    return undefined;
  }
  const sid = value.slice(0, dot);
  return safeEqual(value.slice(dot + 1), mac(sid, secret, domain))
    ? sid
    : undefined;
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

/**
 * The options argument: optional only for the staff session type. A store
 * of any other session type must name its options, so it can never fall
 * back to the staff keyspace by a forgotten argument.
 */
type OptionsArg<S extends DashboardSession> = DashboardSession extends S
  ? [options?: SessionStoreOptions<S>]
  : [options: SessionStoreOptions<S>];

export class SessionStore<S extends DashboardSession = DashboardSession> {
  private readonly options: SessionStoreOptions<S>;

  constructor(
    private readonly cache: KeyValueCache,
    private readonly now: () => number = Date.now,
    ...[options]: OptionsArg<S>
  ) {
    this.options =
      options ??
      (DASHBOARD_SESSION_OPTIONS as unknown as SessionStoreOptions<S>);
  }

  private key(sid: string): string {
    return `${this.options.keyPrefix}${hashOf(sid)}`;
  }

  private validAfter(userId: string): string {
    return `${this.options.validAfterPrefix}${userId}`;
  }

  async create(
    user: Omit<S, 'csrfToken' | 'createdAt' | 'roleCheckedAt'>,
  ): Promise<{ sid: string; session: S }> {
    const sid = randomToken();
    const at = this.now();
    const session = {
      ...user,
      csrfToken: randomToken(),
      createdAt: at,
      roleCheckedAt: at,
    } as S;
    await this.cache.set(
      this.key(sid),
      JSON.stringify(session),
      SESSION_TTL_SEC,
    );
    return { sid, session };
  }

  async get(sid: string): Promise<S | undefined> {
    const raw = await this.cache.get(this.key(sid));
    if (!raw) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (
      !isSession(parsed) ||
      (this.options.isExtra &&
        !this.options.isExtra(parsed as unknown as Record<string, unknown>))
    ) {
      return undefined;
    }
    if (this.now() - parsed.createdAt >= SESSION_TTL_SEC * 1000) {
      await this.destroy(sid);
      return undefined;
    }
    return parsed as S;
  }

  /**
   * One SET ... XX: a logout (or revocation) that deleted the key before this
   * write is never undone, and one that lands after it still deletes the key.
   * There is no read first, so there is no window between check and write.
   * `patch` carries what the re-check learned (the host tier), never the
   * identity or the CSRF token.
   */
  async markRoleChecked(
    sid: string,
    session: S,
    patch: Partial<Omit<S, keyof DashboardSession>> = {},
  ): Promise<boolean> {
    const at = this.now();
    const remainingSec = Math.ceil(
      (session.createdAt + SESSION_TTL_SEC * 1000 - at) / 1000,
    );
    if (remainingSec <= 0) {
      await this.destroy(sid);
      return false;
    }
    return this.cache.set_existing(
      this.key(sid),
      // The identity, CSRF token and absolute lifetime are re-applied after
      // the patch, so no patch can change who this is or extend the session.
      JSON.stringify({
        ...session,
        ...patch,
        userId: session.userId,
        username: session.username,
        csrfToken: session.csrfToken,
        createdAt: session.createdAt,
        roleCheckedAt: at,
      }),
      remainingSec,
    );
  }

  async destroy(sid: string): Promise<void> {
    await this.cache.remove(this.key(sid));
  }

  /**
   * Ends every session of this user created at or before now, in every
   * browser. A per-user "valid after" mark rather than a session index:
   * the cache has no set operations, and one read per request cannot drift
   * from the session keys.
   */
  async revokeUser(userId: string): Promise<void> {
    if (
      typeof userId !== 'string' ||
      !this.options.userIdPattern.test(userId)
    ) {
      throw new RangeError('userId is not a valid id for this session store');
    }
    await this.cache.set(
      this.validAfter(userId),
      String(this.now()),
      VALID_AFTER_TTL_SEC,
    );
  }

  /**
   * True when the user has a mark at or after this session's createdAt.
   * Fails closed: a mark that does not read as a number, or a session whose
   * user id fails the store's userIdPattern, counts as revoked.
   */
  async isRevoked(session: S): Promise<boolean> {
    if (!this.options.userIdPattern.test(session.userId)) {
      return true;
    }
    const raw = await this.cache.get(this.validAfter(session.userId));
    if (raw === undefined) {
      return false;
    }
    const after = raw.trim() === '' ? NaN : Number(raw);
    return !Number.isFinite(after) || session.createdAt <= after;
  }
}
