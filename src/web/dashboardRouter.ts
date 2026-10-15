import crypto from 'crypto';
import express, {
  ErrorRequestHandler,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from 'express';
import { generateCodeVerifier, generateState } from 'arctic';
import { Logger } from 'tslog';

import { KeyValueCache } from '../lib/cache/base.js';
import { LogEntry } from '../lib/helpers/discordLogger.js';
import {
  clearCookie,
  parseCookieValues,
  parseCookies,
  serializeCookie,
} from './cookies.js';
import { openOAuthCookie, sealOAuthCookie } from './oauthCookie.js';
import { errorPage, homePage, loginPage } from './pages.js';
import { FixedWindowLimiter } from './rateLimit.js';
import { AccessCheck } from './roleGate.js';
import {
  DashboardSession,
  ROLE_RECHECK_MS,
  SESSION_COOKIE,
  SESSION_TTL_SEC,
  SessionStore,
  safeEqual,
  signSessionId,
  verifySignedSessionId,
} from './session.js';

const logger = new Logger({ name: 'dashboard' });

export const OAUTH_COOKIE = 'dash_oauth';
export const PUBLIC_ROUTE_PATHS: readonly string[] = [
  '/login',
  '/auth/start',
  '/auth/callback',
];
const OAUTH_COOKIE_PATH = '/dashboard/auth';
const SESSION_COOKIE_PATH = '/dashboard';
const OAUTH_TTL_SEC = 10 * 60;
/** Everything else, OPTIONS included, needs the CSRF token. */
const SAFE_METHODS = new Set(['GET', 'HEAD']);

export interface DashboardOAuth {
  buildLoginUrl(state: string, codeVerifier: string): string;
  exchangeCode(code: string, codeVerifier: string): Promise<string>;
  fetchIdentity(accessToken: string): Promise<{ id: string; username: string }>;
}

export interface DashboardDeps {
  /** Sessions only: nothing writes here before a member has authenticated. */
  cache: () => Promise<KeyValueCache>;
  checkAccess: AccessCheck;
  oauth: DashboardOAuth;
  sessionSecret: string;
  /** e.g. https://meetup-discord-bot.herokuapp.com — the only Origin a POST may carry. */
  origin: string;
  audit: (entry: LogEntry) => Promise<unknown>;
  now?: () => number;
  /**
   * Answer plain-HTTP requests with a 308 to `origin` before anything else
   * runs. Needs `trust proxy` so req.secure reflects X-Forwarded-Proto.
   */
  requireHttps?: boolean;
  loginLimiter?: FixedWindowLimiter; // default 10 per minute per IP
  actionLimiter?: FixedWindowLimiter; // default 30 per minute per user
  /**
   * Later PRs add their pages here. Whatever this registers is mounted
   * AFTER the session gate and AFTER the unsafe-method guard (CSRF, Origin,
   * Sec-Fetch-Site, per-user rate limit), so a route cannot be added
   * without them. The unsafe-method guard reads `_csrf` only from a
   * urlencoded form body, so routes that take JSON or multipart bodies must
   * send the token in the `X-CSRF-Token` header.
   */
  protectedRoutes?: (router: express.Router) => void;
}

interface Locals {
  nonce: string;
  session?: DashboardSession;
  sid?: string;
}

const locals = (res: Response) => res.locals as Locals;

function send(res: Response, status: number, body: string) {
  res.status(status).type('html').send(body);
}

function fail(res: Response, status: Parameters<typeof errorPage>[0]) {
  if (!locals(res).nonce) {
    locals(res).nonce = crypto.randomBytes(16).toString('base64');
  }
  send(res, status, errorPage(status, locals(res).nonce));
}

const securityHeaders: RequestHandler = function securityHeaders(
  _req,
  res,
  next,
) {
  const nonce = crypto.randomBytes(16).toString('base64');
  locals(res).nonce = nonce;
  res.set({
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'Content-Security-Policy':
      `default-src 'none'; style-src 'nonce-${nonce}'; ` +
      `script-src 'nonce-${nonce}'; img-src 'self'; form-action 'self'; ` +
      "frame-ancestors 'none'; base-uri 'none'",
    'Strict-Transport-Security': 'max-age=15552000',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    // no-referrer makes browsers send `Origin: null` on our own form posts,
    // which the CSRF guard refuses; same-origin keeps the real Origin for our
    // own requests and still sends no referrer off-site.
    'Referrer-Policy': 'same-origin',
    'X-Robots-Tag': 'noindex, nofollow',
  });
  next();
};

function limit(
  limiter: FixedWindowLimiter,
  keyOf: (req: Request, res: Response) => string,
): RequestHandler {
  return (req, res, next) => {
    const key = keyOf(req, res);
    if (limiter.take(key)) {
      next();
      return;
    }
    res.set('Retry-After', String(limiter.retryAfterSec(key)));
    fail(res, 429);
  };
}

/** Express 5 layer shape, read only to list routes for tests and PR 3. */
interface StackLayer {
  name: string;
  route?: { path: string; methods: Record<string, boolean> };
  handle: { stack?: StackLayer[] };
}

/**
 * Lists the routes registered through the `protectedRoutes` hook, for tests
 * and PR 3. Routes on sub-routers mounted with `r.use(...)` inside the hook
 * are gated but not listed. Throws if the router has no session gate.
 */
export function protectedRouteList(
  router: express.Router,
): { method: string; path: string }[] {
  const outer = (router as unknown as { stack: StackLayer[] }).stack;
  const gate = outer.findIndex((l) => l.name === 'dashboardSessionGate');
  if (gate === -1) {
    throw new Error('dashboard router has no session gate');
  }
  const inner = outer[gate + 1]?.handle.stack ?? [];
  return inner
    .filter((l) => l.route)
    .flatMap((l) =>
      Object.keys(l.route.methods)
        .filter((method) => l.route.methods[method])
        .map((method) => ({ method, path: l.route.path })),
    );
}

export function createDashboardRouter(deps: DashboardDeps): express.Router {
  const now = deps.now ?? Date.now;
  const loginLimiter = deps.loginLimiter ?? new FixedWindowLimiter(10, 60_000);
  const actionLimiter =
    deps.actionLimiter ?? new FixedWindowLimiter(30, 60_000);
  const sessions = async () => new SessionStore(await deps.cache(), now);
  const byIp = (req: Request) => req.ip ?? 'unknown';

  // Audit posts are fire-and-forget: a slow or failing Discord post must
  // never hold up or break a sign-in.
  const audit = (entry: LogEntry) => {
    Promise.resolve()
      .then(() => deps.audit(entry))
      .catch((error: unknown) =>
        logger.warn(`Dashboard audit post failed: ${String(error)}`),
      );
  };

  /**
   * Tries every dash_sid the browser sent, so a forged one planted ahead of
   * ours cannot hide it. `stale` is true when a cookie we signed was sent but
   * its session is gone: only then is clearing the cookie ours to do.
   */
  async function readSession(
    req: Request,
  ): Promise<
    | { sid: string; session: DashboardSession; stale?: undefined }
    | { sid?: undefined; session?: undefined; stale: boolean }
  > {
    let stale = false;
    for (const signed of parseCookieValues(
      req.headers.cookie,
      SESSION_COOKIE,
    )) {
      const sid = verifySignedSessionId(signed, deps.sessionSecret);
      if (!sid) {
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const session = await (await sessions()).get(sid);
      if (session) {
        return { sid, session };
      }
      stale = true;
    }
    return { stale };
  }

  // Case-sensitive like the cookie paths browsers match against, so
  // /dashboard/Login is not the login route.
  const router = express.Router({ caseSensitive: true });

  // First, so a plain-HTTP request reads no cookie and writes nothing. The
  // target comes from the configured origin, never the Host header; only
  // the path and query are taken from the request.
  router.use(function dashboardHttpsRedirect(req, res, next) {
    if (!deps.requireHttps || req.secure) {
      next();
      return;
    }
    const { pathname, search } = new URL(req.originalUrl, 'http://localhost');
    res.set('Cache-Control', 'no-store');
    res.redirect(308, `${deps.origin}${pathname}${search}`);
  });
  router.use(securityHeaders);
  router.use(express.urlencoded({ extended: false, limit: '16kb' }));

  // ---- Public routes: the only ones reachable without a session. ----

  router.get('/login', (async (req, res) => {
    if ((await readSession(req)).session) {
      res.redirect(302, '/dashboard');
      return;
    }
    send(res, 200, loginPage(locals(res).nonce));
  }) as RequestHandler);

  // Sign-in state lives in a signed cookie, not Redis: nothing a signed-out
  // request does writes to the cache that holds members' Meetup tokens.
  router.get('/auth/start', limit(loginLimiter, byIp), (_req, res) => {
    const state = generateState();
    const verifier = generateCodeVerifier();
    const sealed = sealOAuthCookie(
      { state, verifier, expiresAt: now() + OAUTH_TTL_SEC * 1000 },
      deps.sessionSecret,
    );
    res.append(
      'Set-Cookie',
      serializeCookie(OAUTH_COOKIE, sealed, {
        path: OAUTH_COOKIE_PATH,
        maxAgeSec: OAUTH_TTL_SEC,
      }),
    );
    res.redirect(302, deps.oauth.buildLoginUrl(state, verifier));
  });

  router.get('/auth/callback', limit(loginLimiter, byIp), (async (req, res) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const sealed = parseCookies(req.headers.cookie).get(OAUTH_COOKIE) ?? '';
    // Cleared on every callback, so each cookie is good for one attempt.
    res.append('Set-Cookie', clearCookie(OAUTH_COOKIE, OAUTH_COOKIE_PATH));
    // The cookie binds the callback to the browser that started sign-in, so
    // a callback URL lured into another browser cannot log that browser in.
    const bound = openOAuthCookie(sealed, deps.sessionSecret, now());
    if (!state || !bound || !safeEqual(state, bound.state)) {
      fail(res, 400);
      return;
    }
    const { verifier } = bound;
    if (req.query.error || !req.query.code) {
      send(res, 400, loginPage(locals(res).nonce, 'Sign-in was cancelled.'));
      return;
    }
    let identity: { id: string; username: string };
    try {
      const accessToken = await deps.oauth.exchangeCode(
        String(req.query.code),
        verifier,
      );
      identity = await deps.oauth.fetchIdentity(accessToken);
    } catch (error: unknown) {
      logger.warn(`Dashboard sign-in exchange failed: ${String(error)}`);
      fail(res, 502);
      return;
    }
    let allowed: boolean;
    try {
      allowed = await deps.checkAccess(identity.id);
    } catch (error: unknown) {
      logger.warn(`Dashboard role check failed at sign-in: ${String(error)}`);
      fail(res, 503);
      return;
    }
    if (!allowed) {
      audit({
        title: 'Dashboard sign-in refused',
        description: `<@${identity.id}> tried to sign in without a dashboard role.`,
      });
      fail(res, 403);
      return;
    }
    const { sid } = await (
      await sessions()
    ).create({
      userId: identity.id,
      username: identity.username,
    });
    res.append(
      'Set-Cookie',
      serializeCookie(SESSION_COOKIE, signSessionId(sid, deps.sessionSecret), {
        path: SESSION_COOKIE_PATH,
        maxAgeSec: SESSION_TTL_SEC,
      }),
    );
    audit({
      title: 'Dashboard sign-in',
      description: `<@${identity.id}> signed in to the staff dashboard.`,
    });
    res.redirect(302, '/dashboard');
  }) as RequestHandler);

  // ---- The gate: a live session whose role check is current. ----

  const dashboardSessionGate = async function dashboardSessionGate(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    // Clears the cookie only when it verified, so a forged cookie or a
    // wrong-case URL (whose request carries no cookie) cannot log anyone out.
    const signedOut = (clear: boolean) => {
      if (clear) {
        res.append(
          'Set-Cookie',
          clearCookie(SESSION_COOKIE, SESSION_COOKIE_PATH),
        );
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        res.redirect(302, '/dashboard/login');
      } else {
        fail(res, 403);
      }
    };
    const { sid, session, stale } = await readSession(req);
    if (!session) {
      signedOut(stale);
      return;
    }
    if (now() - session.roleCheckedAt >= ROLE_RECHECK_MS) {
      let allowed: boolean;
      try {
        allowed = await deps.checkAccess(session.userId);
      } catch (error: unknown) {
        // Fail closed, but keep the session: Discord being down is not the
        // member losing their role.
        logger.warn(`Dashboard role re-check failed: ${String(error)}`);
        fail(res, 503);
        return;
      }
      const store = await sessions();
      if (!allowed) {
        await store.destroy(sid);
        res.append(
          'Set-Cookie',
          clearCookie(SESSION_COOKIE, SESSION_COOKIE_PATH),
        );
        audit({
          title: 'Dashboard session ended',
          description: `<@${session.userId}> no longer holds a dashboard role.`,
        });
        fail(res, 403);
        return;
      }
      if (!(await store.markRoleChecked(sid, session))) {
        signedOut(true);
        return;
      }
    }
    locals(res).session = session;
    locals(res).sid = sid;
    next();
  };

  // ---- Everything behind the gate lives on this one router. ----

  const protectedRouter = express.Router({ caseSensitive: true });

  /**
   * Every method except GET and HEAD (OPTIONS too, since a hook route could
   * act on it): per-user rate limit, then a
   * same-origin request (Origin, when sent, must be ours; Sec-Fetch-Site
   * must not be cross-site), then the session's CSRF token from the form
   * body or the X-CSRF-Token header. Each check stands alone: a matching
   * Origin never excuses a missing token.
   */
  protectedRouter.use(function dashboardUnsafeMethodGuard(req, res, next) {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    const { session } = locals(res);
    if (!actionLimiter.take(session.userId)) {
      res.set(
        'Retry-After',
        String(actionLimiter.retryAfterSec(session.userId)),
      );
      fail(res, 429);
      return;
    }
    const origin = req.headers.origin;
    const body = req.body as Record<string, unknown> | undefined;
    const token =
      typeof body?._csrf === 'string'
        ? body._csrf
        : req.headers['x-csrf-token'];
    if (
      req.headers['sec-fetch-site'] === 'cross-site' ||
      (origin !== undefined && origin !== deps.origin) ||
      typeof token !== 'string' ||
      !safeEqual(token, session.csrfToken)
    ) {
      fail(res, 403);
      return;
    }
    next();
  });

  protectedRouter.get('/', (_req, res) => {
    const { session, nonce } = locals(res);
    send(res, 200, homePage(session, nonce));
  });

  protectedRouter.post('/logout', (async (_req, res) => {
    // Clear the cookie first, so the browser forgets it even if the store
    // call below fails.
    res.append('Set-Cookie', clearCookie(SESSION_COOKIE, SESSION_COOKIE_PATH));
    await (await sessions()).destroy(locals(res).sid);
    res.redirect(303, '/dashboard/login');
  }) as RequestHandler);

  deps.protectedRoutes?.(protectedRouter);

  protectedRouter.use((_req, res) => fail(res, 404));

  router.use(dashboardSessionGate as RequestHandler, protectedRouter);

  router.use(function dashboardErrorHandler(error, _req, res, _next) {
    const { status, statusCode } = (error ?? {}) as {
      status?: unknown;
      statusCode?: unknown;
    };
    const code = typeof status === 'number' ? status : statusCode;
    // Body-parser rejections (oversized or malformed bodies) are the
    // client's fault, not ours.
    if (typeof code === 'number' && code >= 400 && code < 500) {
      logger.warn(`Dashboard request rejected: ${code}`);
      fail(res, 400);
      return;
    }
    logger.error(`Dashboard route error: ${String(error)}`);
    fail(res, 500);
  } as ErrorRequestHandler);

  return router;
}
