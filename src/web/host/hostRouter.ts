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

import { GUEST_HOST_BLACKLIST } from '../../constants.js';
import { KeyValueCache } from '../../lib/cache/base.js';
import type {
  HostIdentity,
  HostResolution,
} from '../../lib/hosts/eligibility.js';
import { Tokens } from '../../lib/client/discord/types.js';
import { LogEntry } from '../../lib/helpers/discordLogger.js';
import { MeetupTokenOwner } from '../../lib/helpers/meetupTokens.js';
import { DuplicateMeetupAccountError } from '../../lib/helpers/memberLink.js';
import { NonMemberError } from '../../lib/helpers/onboardUser.js';
import { VerificationSummary } from '../../lib/helpers/verificationSummary.js';
import { WebLinkStore, linkDiscordFromWeb } from '../../lib/hosts/webLink.js';
import {
  clearCookie,
  parseCookieValues,
  parseCookies,
  serializeCookie,
} from '../cookies.js';
import {
  DashboardOAuth,
  baseSecurityHeaders,
  httpsRedirectTarget,
} from '../dashboardRouter.js';
import { html, localUrl, safeHref } from '../html.js';
import { openOAuthCookie, sealOAuthCookie } from '../oauthCookie.js';
import { FixedWindowLimiter } from '../rateLimit.js';
import {
  ROLE_RECHECK_MS,
  SESSION_MAX_SEC,
  SessionStore,
  safeEqual,
  signSessionId,
  verifySignedSessionId,
} from '../session.js';
import { CacheTimeoutError } from '../timedCache.js';
import {
  HostErrorStatus,
  NOT_LINKED_MESSAGE,
  hostErrorPage,
  hostLayout,
  hostLoginPage,
  hostLogoutUnconfirmedPage,
} from './hostLayout.js';
import {
  HOST_BASE,
  HOST_OAUTH_DOMAIN,
  HOST_SESSION_COOKIE,
  HOST_SESSION_OPTIONS,
  HOST_SID_DOMAIN,
  HostSession,
} from './hostSession.js';
import { isHostState, newHostState } from './meetupSignIn.js';
import {
  ServerJoinResult,
  VERIFY_MARK,
  VerifyResult,
  joinFlags,
  joinOf,
  verifyResultPage,
} from './verifyPage.js';

const logger = new Logger({ name: 'hostDashboard' });

/** One cookie per provider, so neither callback can consume the other's. */
export const HOST_DISCORD_OAUTH_COOKIE = 'host_oauth_discord';
export const HOST_MEETUP_OAUTH_COOKIE = 'host_oauth_meetup';
const OAUTH_COOKIE_PATH = '/host/auth';
const OAUTH_TTL_SEC = 10 * 60;
/** The Meetup flow has no PKCE verifier; the sealed cookie needs a non-empty one. */
const MEETUP_NO_VERIFIER = 'meetup';
const MAX_SESSION_COOKIES = 3;
const MAX_SESSION_COOKIE_CANDIDATES = 20;
const SAFE_METHODS = new Set(['GET', 'HEAD']);
const DISCORD_ID = /^[0-9]{17,20}$/;
/**
 * A Discord sign-in started by "Verify on Discord": the same
 * redirect URI and cookie as a sign-in, told apart by this prefix (a
 * sign-in state is base64url, so it never has a dot). It ends with a tag of
 * the session that started it, so a callback reaching a different session
 * (someone else signed in on that browser meanwhile) links nothing.
 */
const LINK_STATE = /^link\.[A-Za-z0-9_-]{16,128}\.([A-Za-z0-9_-]{22})$/;

/** Every `?link=` code the home page can show; fixed texts only. */
export const HOST_LINK_RESULTS = [
  'linked',
  'already',
  'cancelled',
  'meetup-taken',
  'discord-taken',
  'error',
] as const;
export type HostLinkResult = (typeof HOST_LINK_RESULTS)[number];

export interface HostMeetupOAuth {
  buildAuthUrl(state: string): string;
  /**
   * The member's token set (access and refresh). The access token reads
   * who they are; the set is kept in the member token store, for the
   * Verify steps only (see meetupTokens).
   */
  exchangeCode(code: string): Promise<Tokens>;
  fetchSelf(accessToken: string): Promise<{ id: string; name: string }>;
}

export interface HostRouterDeps {
  /** Sessions only: nothing writes here before a host has authenticated. */
  cache: () => Promise<KeyValueCache>;
  /** Throws when Discord, Postgres or Meetup cannot answer. */
  resolve: (who: HostIdentity) => Promise<HostResolution>;
  /** The staff dashboard's Discord OAuth, on the host redirect URI. */
  discord: DashboardOAuth;
  meetup: HostMeetupOAuth;
  sessionSecret: string;
  /** The only Origin a POST may carry. */
  origin: string;
  requireHttps?: boolean;
  audit: (entry: LogEntry) => Promise<unknown>;
  /** #meetup-bot-alerts, plain (no mentions); falls back to `audit`. */
  alert?: (entry: LogEntry) => Promise<unknown>;
  /**
   * The member links, for "Verify on Discord". Without it the
   * link routes answer 404. Rejects when Postgres cannot answer.
   */
  members?: () => Promise<WebLinkStore>;
  /**
   * "Verify on Discord"'s authorize URL: identify plus guilds.join, so the
   * member can be added to our server. Falls back to discord.buildLoginUrl.
   */
  discordVerifyUrl?: (state: string, codeVerifier: string) => string;
  /**
   * Adds the member to our server with their own OAuth access token when
   * they are not in it. Throws when Discord cannot answer or refuses.
   */
  joinServer?: (
    discordUserId: string,
    accessToken: string,
  ) => Promise<{ joined: boolean; pending: boolean }>;
  /**
   * The Verify button's steps (link, nickname, lounge, roles, badges) for
   * this Discord account, with the member's fresh Meetup access token, used
   * once. Throws NonMemberError, DuplicateMeetupAccountError, or anything
   * Discord or Meetup throws. Without it the link ends at the home page.
   */
  runVerify?: (
    meetupAccessToken: string,
    discordUserId: string,
  ) => Promise<VerificationSummary>;
  /**
   * The bot's member Meetup token store (30-day sliding TTL, silent
   * refresh): a host Meetup sign-in keeps its set here, so "Verify on
   * Discord" can run without a second Meetup step. Owners as in
   * meetupTokens: a Discord id, or { meetup } before a Discord link.
   */
  meetupTokens?: {
    keep: (owner: MeetupTokenOwner, tokens: Tokens) => Promise<void>;
    usable: (owner: MeetupTokenOwner) => Promise<Tokens | undefined>;
    move: (from: MeetupTokenOwner, to: MeetupTokenOwner) => Promise<void>;
  };
  now?: () => number;
  loginLimiter?: FixedWindowLimiter; // default 10 per minute per IP
  actionLimiter?: FixedWindowLimiter; // default 30 per minute per host
  /** Caps "sign-in refused" audit posts; default 1 per hour per person. */
  refusedAuditLimiter?: FixedWindowLimiter;
  /**
   * The host pages. Mounted AFTER the session gate and AFTER the
   * unsafe-method guard (rate limit, Origin, Sec-Fetch-Site, CSRF).
   */
  pages?: (router: express.Router) => void;
}

interface Locals {
  nonce: string;
  session?: HostSession;
  sid?: string;
}

const locals = (res: Response) => res.locals as Locals;

/** What the gate leaves for a host page; throws outside the gate (fails closed). */
export function hostLocals(res: Response): {
  session: HostSession;
  sid: string;
  nonce: string;
} {
  const { session, sid, nonce } = locals(res);
  if (!session || !sid) {
    throw new Error('hostLocals read outside the host session gate');
  }
  return { session, sid, nonce };
}

function send(res: Response, status: number, body: string) {
  res.status(status).type('html').send(body);
}

function fail(res: Response, status: HostErrorStatus, message?: string) {
  if (!locals(res).nonce) {
    locals(res).nonce = crypto.randomBytes(16).toString('base64');
  }
  send(res, status, hostErrorPage(status, locals(res).nonce, message));
}

/** Who a refused sign-in was, for the audit line: ids only, never a name. */
function who(identity: HostIdentity): string {
  return 'discordUserId' in identity
    ? `<@${identity.discordUserId}>`
    : `Meetup member ${identity.meetupMemberId}`;
}

export function createHostRouter(deps: HostRouterDeps): express.Router {
  const now = deps.now ?? Date.now;
  const loginLimiter = deps.loginLimiter ?? new FixedWindowLimiter(10, 60_000);
  const actionLimiter =
    deps.actionLimiter ?? new FixedWindowLimiter(30, 60_000);
  const refusedAuditLimiter =
    deps.refusedAuditLimiter ?? new FixedWindowLimiter(1, 60 * 60 * 1000);
  // One duplicate-link alert per host and kind an hour: retries add nothing.
  // In-memory per dyno, like refusedAuditLimiter: a few extra alerts at most.
  const linkAlertLimiter = new FixedWindowLimiter(1, 60 * 60 * 1000);
  // One Verify run at a time per host (Meetup id), so a double click on
  // "Finish verification" never grants roles twice. In-memory per dyno.
  const verifyInFlight = new Set<string>();
  /** The session tag a link state carries: a keyed hash, never the sid. */
  const sessionTag = (sid: string) =>
    crypto
      .createHmac('sha256', deps.sessionSecret)
      .update(`host-link:${sid}`)
      .digest('base64url')
      .slice(0, 22);
  const sessions = async () =>
    new SessionStore<HostSession>(
      await deps.cache(),
      now,
      HOST_SESSION_OPTIONS,
    );
  const byIp = (req: Request) => req.ip ?? 'unknown';

  // Fire-and-forget: a slow Discord post never holds up a sign-in.
  const audit = (entry: LogEntry) => {
    Promise.resolve()
      .then(() => deps.audit(entry))
      .catch((error: unknown) =>
        logger.warn(`Host dashboard audit post failed: ${String(error)}`),
      );
  };

  const alert = (entry: LogEntry) => {
    Promise.resolve()
      .then(() => (deps.alert ?? deps.audit)(entry))
      .catch((error: unknown) =>
        logger.warn(`Host dashboard alert post failed: ${String(error)}`),
      );
  };

  async function liveSession(sid: string): Promise<HostSession | undefined> {
    const store = await sessions();
    const session = await store.get(sid);
    if (!session) {
      return undefined;
    }
    if (await store.isRevoked(session)) {
      await store.destroy(sid);
      return undefined;
    }
    return session;
  }

  /** As the staff dashboard's readSession, on host_sid and the host MAC domain. */
  async function readSession(
    req: Request,
  ): Promise<
    | { sid: string; session: HostSession; stale?: undefined }
    | { sid?: undefined; session?: undefined; stale: boolean }
  > {
    let stale = false;
    const verified = [
      ...new Set(parseCookieValues(req.headers.cookie, HOST_SESSION_COOKIE)),
    ]
      .slice(0, MAX_SESSION_COOKIE_CANDIDATES)
      .map((signed) =>
        verifySignedSessionId(signed, deps.sessionSecret, HOST_SID_DOMAIN),
      )
      .filter((sid): sid is string => Boolean(sid))
      .slice(0, MAX_SESSION_COOKIES);
    for (const sid of verified) {
      // eslint-disable-next-line no-await-in-loop
      const session = await liveSession(sid);
      if (session) {
        return { sid, session };
      }
      stale = true;
    }
    return { stale };
  }

  function limit(
    limiter: FixedWindowLimiter,
    keyOf: (req: Request) => string,
  ): RequestHandler {
    return (req, res, next) => {
      const key = keyOf(req);
      if (limiter.take(key)) {
        next();
        return;
      }
      res.set('Retry-After', String(limiter.retryAfterSec(key)));
      fail(res, 429);
    };
  }

  function sealedStart(
    res: Response,
    cookie: string,
    state: string,
    verifier: string,
  ) {
    const sealed = sealOAuthCookie(
      { state, verifier, expiresAt: now() + OAUTH_TTL_SEC * 1000 },
      deps.sessionSecret,
      HOST_OAUTH_DOMAIN,
    );
    res.append(
      'Set-Cookie',
      serializeCookie(cookie, sealed, {
        path: OAUTH_COOKIE_PATH,
        maxAgeSec: OAUTH_TTL_SEC,
      }),
    );
  }

  /**
   * The verifier of the browser that started this sign-in, or undefined.
   * The cookie is cleared on every callback, so each is good for one try.
   */
  function boundStart(
    req: Request,
    res: Response,
    cookie: string,
  ): { state: string; verifier: string } | undefined {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const sealed = parseCookies(req.headers.cookie).get(cookie) ?? '';
    res.append('Set-Cookie', clearCookie(cookie, OAUTH_COOKIE_PATH));
    const bound = openOAuthCookie(
      sealed,
      deps.sessionSecret,
      now(),
      HOST_OAUTH_DOMAIN,
    );
    if (!state || !bound || !safeEqual(state, bound.state)) {
      return undefined;
    }
    return { state, verifier: bound.verifier };
  }

  /** Resolves the person, then either refuses or starts a session. */
  async function admit(
    res: Response,
    identity: HostIdentity,
    displayName: string,
    via: HostSession['via'],
    meetupTokens?: Tokens,
  ) {
    let resolution: HostResolution;
    try {
      resolution = await deps.resolve(identity);
    } catch (error: unknown) {
      logger.warn(
        `Host eligibility check failed at sign-in: ${error instanceof Error ? error.name : 'Error'}`,
      );
      fail(res, 503);
      return;
    }
    if (resolution.kind === 'refused') {
      const key = who(identity);
      if (refusedAuditLimiter.take(key)) {
        audit({
          title: 'Host dashboard sign-in refused',
          description: `${key} tried to sign in to the host dashboard (${resolution.reason}).`,
        });
      }
      // The same text for blacklisted and not-a-host: a refusal never
      // reveals a blacklist.
      fail(
        res,
        403,
        resolution.reason === 'not-linked' ? NOT_LINKED_MESSAGE : undefined,
      );
      return;
    }
    const { sid } = await (
      await sessions()
    ).create({
      userId: resolution.meetupMemberId,
      username: displayName,
      // A malformed id would make a session isExtra can never read back.
      discordUserId: DISCORD_ID.test(resolution.discordUserId ?? '')
        ? resolution.discordUserId
        : null,
      tier: resolution.tier,
      via,
    });
    res.append(
      'Set-Cookie',
      serializeCookie(
        HOST_SESSION_COOKIE,
        signSessionId(sid, deps.sessionSecret, HOST_SID_DOMAIN),
        { path: HOST_BASE, maxAgeSec: SESSION_MAX_SEC },
      ),
    );
    audit({
      title: 'Host dashboard sign-in',
      description: `${
        resolution.discordUserId
          ? `<@${resolution.discordUserId}>`
          : `Meetup member ${resolution.meetupMemberId}`
      } signed in to the host dashboard with ${via === 'discord' ? 'Discord' : 'Meetup'}.`,
    });
    if (meetupTokens && deps.meetupTokens) {
      // Kept for "Verify on Discord" (and the bot's Verify, under the
      // Discord id when already linked). Sign-out does not forget them:
      // retention is the store's TTL, as for the bot.
      const owner: MeetupTokenOwner = DISCORD_ID.test(
        resolution.discordUserId ?? '',
      )
        ? resolution.discordUserId
        : { meetup: resolution.meetupMemberId };
      try {
        await deps.meetupTokens.keep(owner, meetupTokens);
      } catch (error: unknown) {
        logger.warn(
          `Host Meetup tokens could not be kept: ${error instanceof Error ? error.name : 'Error'}`,
        );
      }
    }
    res.redirect(302, HOST_BASE);
  }

  /**
   * A usable member token set for Verify: under the Discord id first, then
   * under the Meetup id (a sign-in from before the link), which then moves
   * to the Discord id. undefined when there is none or the store cannot
   * answer: the Meetup step gets a fresh one.
   */
  async function storedMeetupToken(
    discordUserId: string,
    meetupId: string,
  ): Promise<string | undefined> {
    if (!deps.meetupTokens) {
      return undefined;
    }
    try {
      const linked = await deps.meetupTokens.usable(discordUserId);
      if (linked) {
        return linked.accessToken;
      }
      const signedIn = await deps.meetupTokens.usable({ meetup: meetupId });
      if (signedIn) {
        await deps.meetupTokens.move({ meetup: meetupId }, discordUserId);
        return signedIn.accessToken;
      }
    } catch (error: unknown) {
      logger.warn(
        `Host Meetup token read failed: ${error instanceof Error ? error.name : 'Error'}`,
      );
    }
    return undefined;
  }

  /** A refused host: every session ends, as the gate's re-check does. */
  async function endSessions(meetupId: string, reason: string) {
    await (await sessions()).revokeUser(meetupId);
    audit({
      title: 'Host dashboard session ended',
      description: `Meetup member ${meetupId} is no longer eligible for the host dashboard (${reason}).`,
    });
  }

  /**
   * The Discord step of "Verify on Discord": the signed-in host proved they
   * own this Discord account, so link it to their Meetup account (the same
   * duplicate rules as Verify), take it into the session, add them to our
   * server, and go on to the Verify steps (onToVerify). A blacklisted Discord account
   * is refused before anything is written (the eligibility check reads the
   * current link, so it cannot see the one about to be made). Eligibility
   * is checked live before the write (this route is outside the session
   * gate) and again after it, to read the tier through the new link; a
   * refusal ends every session of the host, and an outage changes nothing.
   */
  async function linkCallback(
    req: Request,
    res: Response,
    state: string,
    verifier: string,
  ) {
    const back = (code: HostLinkResult) =>
      res.redirect(302, `${HOST_BASE}?link=${code}`);
    const refused = async (meetupId: string, sid: string, reason: string) => {
      await endSessions(meetupId, reason);
      await (await sessions()).destroy(sid);
      res.append('Set-Cookie', clearCookie(HOST_SESSION_COOKIE, HOST_BASE));
      fail(res, 403);
    };
    let read: Awaited<ReturnType<typeof readSession>>;
    try {
      read = await readSession(req);
    } catch (error: unknown) {
      logger.warn(
        `Host Discord link session read failed: ${error instanceof Error ? error.name : 'Error'}`,
      );
      back('error');
      return;
    }
    const { sid, session } = read;
    if (!sid || !session) {
      res.redirect(302, '/host/login');
      return;
    }
    // Started by a different session: link nothing, change nothing.
    const tag = LINK_STATE.exec(state)?.[1] ?? '';
    if (!safeEqual(tag, sessionTag(sid))) {
      back('error');
      return;
    }
    if (!deps.members) {
      fail(res, 404);
      return;
    }
    if (session.discordUserId !== null) {
      back('already');
      return;
    }
    // As at the start: the link saves the session's name as the Meetup
    // name, so only a Meetup sign-in may finish one, however it started.
    if (session.via !== 'meetup') {
      fail(res, 403);
      return;
    }
    if (req.query.error || typeof req.query.code !== 'string') {
      back('cancelled');
      return;
    }
    let identity: { id: string; username: string };
    // Used for /users/@me and, once linked, to add them to our server;
    // never stored.
    let accessToken: string;
    try {
      accessToken = await deps.discord.exchangeCode(req.query.code, verifier);
      identity = await deps.discord.fetchIdentity(accessToken);
    } catch (error: unknown) {
      logger.warn(
        `Host Discord link exchange failed: ${error instanceof Error ? error.name : 'Error'}`,
      );
      back('error');
      return;
    }
    if (!DISCORD_ID.test(identity.id)) {
      back('error');
      return;
    }
    const meetupId = session.userId;
    // The eligibility check below reads the member's current link, so it
    // cannot see the Discord account about to be linked: refuse a
    // blacklisted one here, before anything is written.
    if (GUEST_HOST_BLACKLIST.includes(identity.id)) {
      await refused(meetupId, sid, 'blacklisted');
      return;
    }
    // Still a host, right now: the link is a write.
    try {
      const before = await deps.resolve({ meetupMemberId: meetupId });
      if (before.kind === 'refused') {
        await refused(meetupId, sid, before.reason);
        return;
      }
    } catch (error: unknown) {
      logger.warn(
        `Host check before linking failed: ${error instanceof Error ? error.name : 'Error'}`,
      );
      back('error');
      return;
    }
    let outcome: Awaited<ReturnType<typeof linkDiscordFromWeb>>;
    try {
      outcome = await linkDiscordFromWeb(await deps.members(), {
        meetupId,
        meetupName: session.username,
        discordUserId: identity.id,
      });
    } catch (error: unknown) {
      logger.warn(
        `Host Discord link write failed: ${error instanceof Error ? error.name : 'Error'}`,
      );
      back('error');
      return;
    }
    if (outcome.kind === 'meetup-taken' || outcome.kind === 'discord-taken') {
      if (linkAlertLimiter.take(`${meetupId}:${outcome.kind}`)) {
        alert(
          outcome.kind === 'meetup-taken'
            ? {
                title: 'Duplicate Meetup link blocked (host dashboard)',
                description:
                  `<@${identity.id}> tried to link Meetup member ${meetupId} on the host dashboard, ` +
                  `but it is already linked to ${outcome.otherDiscordId ? `<@${outcome.otherDiscordId}>` : 'another member'}.`,
              }
            : {
                title: 'Duplicate Discord link blocked (host dashboard)',
                description:
                  `Meetup member ${meetupId} tried to link <@${identity.id}> on the host dashboard, ` +
                  `but that Discord account is already linked to ${
                    outcome.otherMeetupId
                      ? `Meetup member ${outcome.otherMeetupId}`
                      : 'another Meetup account'
                  }.`,
              },
        );
      }
      back(outcome.kind);
      return;
    }
    // Into our server, with their own token (guilds.join), once the link
    // is written. A failure keeps the link: the result page says so.
    let join: ServerJoinResult;
    if (deps.joinServer) {
      try {
        join = await deps.joinServer(identity.id, accessToken);
      } catch (error: unknown) {
        logger.warn(
          `Host Discord server join failed: ${error instanceof Error ? error.name : 'Error'}`,
        );
        join = 'failed';
        alert({
          title: 'Could not add a member to the server (host dashboard)',
          description:
            `<@${identity.id}> (Meetup member ${meetupId}) verified on the host ` +
            'dashboard, but Discord did not let us add them to the server.',
        });
      }
    }
    const joined = join !== undefined && join !== 'failed' && join.joined;
    if (outcome.kind === 'linked' || joined) {
      audit({
        title:
          outcome.kind === 'linked'
            ? 'Meetup account linked (host dashboard)'
            : 'Joined the server (host dashboard)',
        description: `<@${identity.id}> ↔ Meetup member ${meetupId}`,
        fields: [
          { name: 'Method', value: 'web_link', inline: true },
          ...(joined
            ? [{ name: 'Joined the server', value: 'Yes', inline: true }]
            : []),
        ],
      });
    }
    /**
     * Verify, as the member, exactly as the Discord button does: with the
     * Meetup token kept from their sign-in when there is a usable one, else
     * through Meetup's sign-in for a fresh one (the sealed cookie carries
     * this session's tag, the Discord account and the join result). Not
     * when they could not be added to the server: every step after the
     * link needs them in it.
     */
    const onToVerify = async () => {
      if (!deps.runVerify) {
        back(outcome.kind === 'linked' ? 'linked' : 'already');
        return;
      }
      if (join === 'failed') {
        send(
          res,
          200,
          verifyResultPage(
            locals(res).nonce,
            session,
            { kind: 'not-in-server' },
            join,
          ),
        );
        return;
      }
      const stored = await storedMeetupToken(identity.id, meetupId);
      if (stored) {
        await runAndShow(res, session, identity.id, stored, join);
        return;
      }
      const state = newHostState();
      sealedStart(
        res,
        HOST_MEETUP_OAUTH_COOKIE,
        state,
        `verify.${sessionTag(sid)}.${identity.id}.${joinFlags(join)}`,
      );
      res.redirect(302, deps.meetup.buildAuthUrl(state));
    };
    // Re-checked through the new link (a Discord role can change the tier,
    // a blacklisted Discord account ends it). An outage leaves the session
    // as it was: the gate's next re-check reads the link by Meetup id.
    let after: HostResolution;
    try {
      after = await deps.resolve({ meetupMemberId: meetupId });
    } catch (error: unknown) {
      logger.warn(
        `Host check after linking failed: ${error instanceof Error ? error.name : 'Error'}`,
      );
      await onToVerify();
      return;
    }
    if (after.kind === 'refused') {
      await refused(meetupId, sid, after.reason);
      return;
    }
    const kept = await (
      await sessions()
    ).markRoleChecked(sid, session, {
      discordUserId: identity.id,
      tier: after.tier,
    });
    if (!kept) {
      // Past its lifetime: the link is saved, the session is over.
      res.append('Set-Cookie', clearCookie(HOST_SESSION_COOKIE, HOST_BASE));
      res.redirect(302, '/host/login');
      return;
    }
    await onToVerify();
  }

  /**
   * The end of "Verify on Discord": back from Meetup with the member's own
   * token. It must be the Meetup account this session signed in with; then
   * the Verify button's steps run with it and the page shows their summary.
   * The link itself is already saved, so a failure here never undoes it.
   */
  async function verifyCallback(req: Request, res: Response, mark: string) {
    const parsed = VERIFY_MARK.exec(mark);
    if (!parsed) {
      fail(res, 400);
      return;
    }
    const [, tag, discordUserId, flags] = parsed;
    const join = joinOf(flags);
    let read: Awaited<ReturnType<typeof readSession>>;
    try {
      read = await readSession(req);
    } catch (error: unknown) {
      logger.warn(
        `Host verify session read failed: ${error instanceof Error ? error.name : 'Error'}`,
      );
      res.redirect(302, `${HOST_BASE}?link=error`);
      return;
    }
    const { sid, session } = read;
    if (!sid || !session) {
      res.redirect(302, '/host/login');
      return;
    }
    if (!safeEqual(tag, sessionTag(sid)) || !deps.runVerify) {
      res.redirect(302, `${HOST_BASE}?link=error`);
      return;
    }
    const page = (result: VerifyResult, status = 200) =>
      send(
        res,
        status,
        verifyResultPage(locals(res).nonce, session, result, join),
      );
    if (req.query.error || typeof req.query.code !== 'string') {
      page({ kind: 'unfinished' });
      return;
    }
    let tokens: Tokens;
    let self: { id: string; name: string };
    try {
      tokens = await deps.meetup.exchangeCode(req.query.code);
      self = await deps.meetup.fetchSelf(tokens.accessToken);
    } catch (error: unknown) {
      logger.warn(
        `Host verify Meetup exchange failed: ${error instanceof Error ? error.name : 'Error'}`,
      );
      page({ kind: 'unfinished' });
      return;
    }
    if (self.id !== session.userId) {
      alert({
        title: 'Verify on the host dashboard: a different Meetup account',
        description:
          `Meetup member ${session.userId} (with <@${discordUserId}>) came back from ` +
          `Meetup signed in as Meetup member ${self.id}. Nothing was verified.`,
      });
      page({ kind: 'other-account' }, 403);
      return;
    }
    // Kept under the Discord id, as the bot's Verify keeps it, so the next
    // Verify (here or in Discord) needs no Meetup step.
    if (deps.meetupTokens) {
      try {
        await deps.meetupTokens.keep(discordUserId, tokens);
      } catch (error: unknown) {
        logger.warn(
          `Host verify Meetup tokens could not be kept: ${error instanceof Error ? error.name : 'Error'}`,
        );
      }
    }
    await runAndShow(res, session, discordUserId, tokens.accessToken, join);
  }

  /**
   * Runs the Verify steps once for this host (one run in flight per host)
   * and answers with the result page. The link is already saved, so a
   * failure here never undoes it.
   */
  async function runAndShow(
    res: Response,
    session: HostSession,
    discordUserId: string,
    meetupAccessToken: string,
    join: ServerJoinResult,
  ) {
    const page = (result: VerifyResult, status = 200) =>
      send(
        res,
        status,
        verifyResultPage(locals(res).nonce, session, result, join),
      );
    if (!deps.runVerify) {
      res.redirect(302, `${HOST_BASE}?link=already`);
      return;
    }
    if (verifyInFlight.has(session.userId)) {
      page({ kind: 'busy' }, 409);
      return;
    }
    verifyInFlight.add(session.userId);
    let summary: VerificationSummary;
    try {
      summary = await deps.runVerify(meetupAccessToken, discordUserId);
    } catch (error: unknown) {
      // Both already alerted where they were thrown.
      if (
        error instanceof NonMemberError ||
        error instanceof DuplicateMeetupAccountError
      ) {
        page({ kind: 'refused', message: error.message });
        return;
      }
      logger.warn(
        `Host verify steps failed: ${error instanceof Error ? error.name : 'Error'}`,
      );
      alert({
        title: 'Verify on the host dashboard did not finish',
        description:
          `<@${discordUserId}> ↔ Meetup member ${session.userId} is linked, but ` +
          `the roles and badges could not be updated (${error instanceof Error ? error.name : 'Error'}). ` +
          'They were told to press Verify in Discord.',
      });
      page({ kind: 'roles-failed' });
      return;
    } finally {
      verifyInFlight.delete(session.userId);
    }
    page({ kind: 'verified', summary });
  }

  /**
   * The Meetup step of "Verify on Discord" again, for a host already linked
   * (they backed out at Meetup, or the roles step failed): no new Discord
   * step. Answers with a page that LINKS to Meetup, not a redirect, for the
   * same `form-action 'self'` reason as the Discord start.
   */
  async function finishStart(res: Response) {
    const { session, sid, nonce } = hostLocals(res);
    if (
      !deps.runVerify ||
      session.via !== 'meetup' ||
      session.discordUserId === null
    ) {
      res.redirect(303, HOST_BASE);
      return;
    }
    const stored = await storedMeetupToken(
      session.discordUserId,
      session.userId,
    );
    if (stored) {
      await runAndShow(res, session, session.discordUserId, stored, undefined);
      return;
    }
    const state = newHostState();
    const href = safeHref(deps.meetup.buildAuthUrl(state));
    if (!href) {
      logger.error('Host verify finish built a Meetup URL safeHref refused');
      fail(res, 500);
      return;
    }
    sealedStart(
      res,
      HOST_MEETUP_OAUTH_COOKIE,
      state,
      `verify.${sessionTag(sid)}.${session.discordUserId}.x`,
    );
    send(
      res,
      200,
      hostLayout({
        title: 'Finish verification',
        nonce,
        user: session,
        current: 'home',
        body: html`<div class="card">
          <h1>Finish verification</h1>
          <p>
            Your Meetup and Discord accounts are already linked. Meetup will
            confirm your account, and then you get the same roles and badges as
            pressing Verify in our Discord server.
          </p>
          <p><a class="button" href="${href}">Continue to Meetup</a></p>
          <p><a href="${localUrl(HOST_BASE)}">Back to home</a></p>
        </div>`,
      }),
    );
  }

  const router = express.Router({ caseSensitive: true });

  router.use(function hostSecurityHeaders(_req, res, next) {
    const nonce = crypto.randomBytes(16).toString('base64');
    locals(res).nonce = nonce;
    res.set(baseSecurityHeaders(nonce));
    next();
  });
  router.use(function hostHttpsRedirect(req, res, next) {
    if (!deps.requireHttps || req.secure) {
      next();
      return;
    }
    res.redirect(308, httpsRedirectTarget(deps.origin, req.originalUrl));
  });
  router.use(express.urlencoded({ extended: false, limit: '32kb' }));

  // ---- Public routes. ----

  router.get('/login', (async (req, res) => {
    if ((await readSession(req)).session) {
      res.redirect(302, HOST_BASE);
      return;
    }
    send(res, 200, hostLoginPage(locals(res).nonce));
  }) as RequestHandler);

  router.get('/auth/discord/start', limit(loginLimiter, byIp), (_req, res) => {
    const state = generateState();
    const verifier = generateCodeVerifier();
    sealedStart(res, HOST_DISCORD_OAUTH_COOKIE, state, verifier);
    res.redirect(302, deps.discord.buildLoginUrl(state, verifier));
  });

  router.get('/auth/discord/callback', limit(loginLimiter, byIp), (async (
    req,
    res,
  ) => {
    const bound = boundStart(req, res, HOST_DISCORD_OAUTH_COOKIE);
    if (!bound || bound.verifier === MEETUP_NO_VERIFIER) {
      fail(res, 400);
      return;
    }
    if (LINK_STATE.test(bound.state)) {
      await linkCallback(req, res, bound.state, bound.verifier);
      return;
    }
    if (req.query.error || typeof req.query.code !== 'string') {
      send(
        res,
        400,
        hostLoginPage(locals(res).nonce, 'Sign-in was cancelled.'),
      );
      return;
    }
    let identity: { id: string; username: string };
    try {
      const accessToken = await deps.discord.exchangeCode(
        req.query.code,
        bound.verifier,
      );
      identity = await deps.discord.fetchIdentity(accessToken);
    } catch (error: unknown) {
      logger.warn(`Host Discord sign-in exchange failed: ${String(error)}`);
      fail(res, 502);
      return;
    }
    await admit(
      res,
      { discordUserId: identity.id },
      identity.username,
      'discord',
    );
  }) as RequestHandler);

  router.get('/auth/meetup/start', limit(loginLimiter, byIp), (_req, res) => {
    const state = newHostState();
    sealedStart(res, HOST_MEETUP_OAUTH_COOKIE, state, MEETUP_NO_VERIFIER);
    res.redirect(302, deps.meetup.buildAuthUrl(state));
  });

  // Reached through /connect/meetup/callback, which forwards host- states
  // here with only state, code and error.
  router.get('/auth/meetup/complete', limit(loginLimiter, byIp), (async (
    req,
    res,
  ) => {
    const bound = boundStart(req, res, HOST_MEETUP_OAUTH_COOKIE);
    if (bound && isHostState(bound.state) && VERIFY_MARK.test(bound.verifier)) {
      await verifyCallback(req, res, bound.verifier);
      return;
    }
    if (
      !bound ||
      bound.verifier !== MEETUP_NO_VERIFIER ||
      !isHostState(bound.state)
    ) {
      fail(res, 400);
      return;
    }
    if (req.query.error || typeof req.query.code !== 'string') {
      send(
        res,
        400,
        hostLoginPage(locals(res).nonce, 'Sign-in was cancelled.'),
      );
      return;
    }
    let self: { id: string; name: string };
    let tokens: Tokens;
    try {
      tokens = await deps.meetup.exchangeCode(req.query.code);
      self = await deps.meetup.fetchSelf(tokens.accessToken);
    } catch (error: unknown) {
      // The name only: exchange errors embed Meetup's response body.
      logger.warn(
        `Host Meetup sign-in exchange failed: ${error instanceof Error ? error.name : 'Error'}`,
      );
      fail(res, 502);
      return;
    }
    await admit(res, { meetupMemberId: self.id }, self.name, 'meetup', tokens);
  }) as RequestHandler);

  // ---- The gate: a live session whose tier check is current. ----

  /**
   * One re-check per host at a time, as the staff gate's recheckRole. Always
   * by Meetup member id, so a Discord link added or removed since sign-in is
   * picked up. Ineligible: every session of the host is revoked.
   */
  const checks = new Map<string, Promise<HostResolution | 'unreachable'>>();
  const recheck = (memberId: string) => {
    const inFlight = checks.get(memberId);
    if (inFlight !== undefined) {
      return inFlight;
    }
    const check = (async (): Promise<HostResolution | 'unreachable'> => {
      let resolution: HostResolution;
      try {
        resolution = await deps.resolve({ meetupMemberId: memberId });
      } catch (error: unknown) {
        // Fail closed, but keep the session: an outage is not a demotion.
        logger.warn(
          `Host tier re-check failed: ${error instanceof Error ? error.name : 'Error'}`,
        );
        return 'unreachable';
      }
      if (resolution.kind === 'refused') {
        await (await sessions()).revokeUser(memberId);
        audit({
          title: 'Host dashboard session ended',
          description: `Meetup member ${memberId} is no longer eligible for the host dashboard (${resolution.reason}).`,
        });
      }
      return resolution;
    })().finally(() => {
      checks.delete(memberId);
    });
    checks.set(memberId, check);
    return check;
  };

  const hostSessionGate = async function hostSessionGate(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    const signedOut = (clear: boolean) => {
      if (clear) {
        res.append('Set-Cookie', clearCookie(HOST_SESSION_COOKIE, HOST_BASE));
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        res.redirect(302, '/host/login');
      } else {
        fail(res, 403);
      }
    };
    const { sid, session, stale } = await readSession(req);
    if (!session) {
      signedOut(stale);
      return;
    }
    let current = session;
    if (now() - session.roleCheckedAt >= ROLE_RECHECK_MS) {
      const outcome = await recheck(session.userId);
      if (outcome === 'unreachable') {
        fail(res, 503);
        return;
      }
      const store = await sessions();
      if (outcome.kind === 'refused') {
        await store.destroy(sid);
        res.append('Set-Cookie', clearCookie(HOST_SESSION_COOKIE, HOST_BASE));
        fail(res, 403);
        return;
      }
      const patch = {
        tier: outcome.tier,
        discordUserId: DISCORD_ID.test(outcome.discordUserId ?? '')
          ? outcome.discordUserId
          : null,
      };
      if (!(await store.markRoleChecked(sid, session, patch))) {
        signedOut(true);
        return;
      }
      current = { ...session, ...patch, roleCheckedAt: now() };
    }
    locals(res).session = current;
    locals(res).sid = sid;
    next();
  };

  const protectedRouter = express.Router({ caseSensitive: true });

  /** As the staff dashboard's guard: every check stands alone. */
  protectedRouter.use(function hostUnsafeMethodGuard(req, res, next) {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    const { session } = hostLocals(res);
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

  protectedRouter.post('/logout', (async (_req, res) => {
    // Clear the cookie first, so the browser forgets it even if the store
    // call below fails.
    res.append('Set-Cookie', clearCookie(HOST_SESSION_COOKIE, HOST_BASE));
    try {
      await (await sessions()).destroy(hostLocals(res).sid);
    } catch (error: unknown) {
      if (!(error instanceof CacheTimeoutError)) {
        throw error;
      }
      // The browser forgot the cookie, but the server may still hold the
      // session: say so, rather than the generic access-check text.
      logger.warn('Host dashboard logout cache timed out');
      send(res, 503, hostLogoutUnconfirmedPage(hostLocals(res).nonce));
      return;
    }
    res.redirect(303, '/host/login');
  }) as RequestHandler);

  // "Verify on Discord": a POST (CSRF-checked by the guard), then
  // Discord's sign-in, back to the Discord callback with a link. state.
  // Answers with a page that LINKS to Discord rather than a redirect:
  // browsers apply the host pages' `form-action 'self'` to every redirect
  // after a form POST, so a 303 to discord.com would be blocked.
  protectedRouter.post('/link/discord', (_req, res) => {
    if (!deps.members) {
      fail(res, 404);
      return;
    }
    const { session, sid, nonce } = hostLocals(res);
    if (session.discordUserId !== null) {
      res.redirect(303, `${HOST_BASE}?link=already`);
      return;
    }
    // The link saves the session's username as the Meetup name, so only a
    // Meetup sign-in may start one (a Discord sign-in unlinked since has a
    // Discord name there). The home page shows no button for it either.
    if (session.via !== 'meetup') {
      fail(res, 403);
      return;
    }
    const state = `link.${generateState()}.${sessionTag(sid)}`;
    const verifier = generateCodeVerifier();
    // Only Discord's authorize endpoint passes safeHref; anything else is a
    // wiring fault, refused rather than linked.
    const href = safeHref(
      (deps.discordVerifyUrl ?? deps.discord.buildLoginUrl)(state, verifier),
    );
    if (!href) {
      logger.error(
        'Host Discord link start built a sign-in URL safeHref refused',
      );
      fail(res, 500);
      return;
    }
    sealedStart(res, HOST_DISCORD_OAUTH_COOKIE, state, verifier);
    send(
      res,
      200,
      hostLayout({
        title: 'Verify on Discord',
        nonce,
        user: session,
        current: 'home',
        body: html`<div class="card">
          <h1>Verify on Discord</h1>
          <p>
            Discord will ask you to sign in, and to let us see which account is
            yours and add you to our server. Then Meetup confirms your account,
            and you get the same roles and badges as pressing Verify in our
            Discord server.
          </p>
          <p><a class="button" href="${href}">Continue to Discord</a></p>
          <p><a href="${localUrl(HOST_BASE)}">Back to home</a></p>
        </div>`,
      }),
    );
  });

  protectedRouter.post('/verify/finish', (async (_req, res) => {
    await finishStart(res);
  }) as RequestHandler);

  deps.pages?.(protectedRouter);

  protectedRouter.use(function hostNotFound(_req, res) {
    fail(res, 404);
  });

  router.use(hostSessionGate as RequestHandler, protectedRouter);

  router.use(function hostErrorHandler(error, _req, res, _next) {
    if (res.headersSent) {
      logger.error(
        `Host dashboard error after the response started: ${String(error)}`,
      );
      res.destroy();
      return;
    }
    if (error instanceof CacheTimeoutError) {
      logger.warn('Host dashboard cache timed out');
      fail(res, 503);
      return;
    }
    const { status, statusCode } = (error ?? {}) as {
      status?: unknown;
      statusCode?: unknown;
    };
    const code = typeof status === 'number' ? status : statusCode;
    if (typeof code === 'number' && code >= 400 && code < 500) {
      logger.warn(`Host dashboard request rejected: ${code}`);
      fail(res, 400);
      return;
    }
    logger.error(
      `Host dashboard route error: ${error instanceof Error ? error.name : 'Error'}`,
    );
    fail(res, 500);
  } as ErrorRequestHandler);

  return router;
}
