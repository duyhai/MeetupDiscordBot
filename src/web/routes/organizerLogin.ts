import crypto from 'crypto';
import dayjs from 'dayjs';
import express, { RequestHandler, Response } from 'express';
import { Logger } from 'tslog';

import { Tokens } from '../../lib/client/discord/types.js';
import { OAuthStateRecord } from '../../lib/client/oauth/state.js';
import { LogEntry } from '../../lib/helpers/discordLogger.js';
import { CredentialMeta } from '../../lib/repositories/postgresCredentialRepository.js';
import { tz } from '../../util/timezone.js';
import { dashboardLocals } from '../dashboardRouter.js';
import { SafeHtml, html, safeHref } from '../html.js';
import { layout } from '../pages.js';
import { safeEqual } from '../session.js';

const logger = new Logger({ name: 'dashboard' });

const MEMBER_ID_PATTERN = /^[0-9]{1,20}$/;

/**
 * Everything the "Renew organizer login" routes touch, injectable for tests.
 * Production wiring lives in organizerLoginDeps.ts.
 */
export interface OrganizerLoginDeps {
  /** The credential's meta row; undefined when there is no credential store (no DATABASE_URL). */
  credentialStatus: () => Promise<CredentialMeta | undefined>;
  /** Stored member id, else MEETUP_ORGANIZER_MEMBER_ID, else undefined. */
  expectedMemberId: () => Promise<string | undefined>;
  createState: (discordUserId: string, sessionHash: string) => Promise<string>;
  resolveState: (state: string) => Promise<OAuthStateRecord | undefined>;
  /** True for exactly one caller per state. */
  claimState: (state: string) => Promise<boolean>;
  buildAuthUrl: (state: string) => string;
  exchangeCode: (code: string) => Promise<Tokens>;
  fetchMeetupMemberId: (accessToken: string) => Promise<string>;
  /** The locked write: tokens, member id and episode close in one transaction. */
  saveRenewedCredential: (tokens: Tokens, memberId: string) => Promise<void>;
  /** Staff moderation channel. */
  audit: (entry: LogEntry) => Promise<unknown>;
}

/** Binds a renewal to the dashboard session without storing the session id. */
export function sessionHashOf(sid: string): string {
  return crypto.createHash('sha256').update(sid).digest('hex');
}

/**
 * The HTTP status from an exchangeMeetupCode error, whose message is
 * `... [NNN] <raw body>`. Only the three digits are ever logged.
 */
function statusFrom(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : '';
  return /\[(\d{3})\]/.exec(message)?.[1];
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error';
}

const PRIVATE_WINDOW_STEPS = html`<ol>
  <li>
    Open this page in a <strong>private window</strong> (so your own Meetup
    login is not used) and sign in with Discord.
  </li>
  <li>
    Press <strong>Renew organizer login</strong>, then
    <strong>Continue to Meetup sign-in</strong>.
  </li>
  <li>
    Sign in to Meetup as the <strong>shared organizer account</strong>, not your
    personal account, and allow access.
  </li>
  <li>Close the private window when the dashboard says it is renewed.</li>
</ol>`;

function statusLine(meta: CredentialMeta): SafeHtml {
  if (!meta.failingSince) {
    return html`<p>
      <strong>Healthy.</strong> No failure of the organizer login is on record.
    </p>`;
  }
  const since = tz(dayjs(meta.failingSince)).format('MMM D, YYYY h:mm A');
  return html`<p>
    <strong>Failing since ${since} Pacific time.</strong> Meetup identity
    monitoring is paused until the login is renewed.
  </p>`;
}

export function registerOrganizerLoginRoutes(
  router: express.Router,
  deps: OrganizerLoginDeps,
): void {
  // Fire-and-forget, like the router's own audit: a slow or failing Discord
  // post never holds up or breaks a renewal.
  const audit = (entry: LogEntry) => {
    Promise.resolve()
      .then(() => deps.audit(entry))
      .catch((error: unknown) =>
        logger.warn(`Organizer login audit post failed: ${errorName(error)}`),
      );
  };

  const page = (
    res: Response,
    status: number,
    title: string,
    body: SafeHtml,
  ) => {
    const { session, nonce } = dashboardLocals(res);
    res
      .status(status)
      .type('html')
      .send(layout({ title, nonce, user: session, body }));
  };

  const result = (
    res: Response,
    status: number,
    heading: string,
    message: string,
  ) =>
    page(
      res,
      status,
      'Renew organizer login',
      html`<div class="card">
        <h1>${heading}</h1>
        <p>${message}</p>
        <p><a href="/dashboard/organizer-login">Back to organizer login</a></p>
      </div>`,
    );

  const STORE_DOWN =
    'The credential store cannot be reached right now. Please try again in a minute.';
  const UNAVAILABLE =
    'Renewal is unavailable: this deployment has no credential database.';

  router.get('/organizer-login', (async (_req, res) => {
    const { session } = dashboardLocals(res);
    let meta: CredentialMeta | undefined;
    try {
      meta = await deps.credentialStatus();
    } catch (error: unknown) {
      logger.warn(`Organizer login status read failed: ${errorName(error)}`);
      result(res, 503, 'Unable to continue', STORE_DOWN);
      return;
    }
    const action = meta
      ? html`${statusLine(meta)}
          <h2>Renew</h2>
          ${PRIVATE_WINDOW_STEPS}
          <form method="post" action="/dashboard/organizer-login/start">
            <input type="hidden" name="_csrf" value="${session.csrfToken}" />
            <button type="submit">Renew organizer login</button>
          </form>`
      : html`<p>${UNAVAILABLE}</p>`;
    page(
      res,
      200,
      'Organizer login',
      html`<div class="card">
        <h1>Meetup organizer login</h1>
        <p>
          The bot reads Meetup with the shared organizer account's login. When
          it stops working, any Moderator or 1.5 Leadership Team member can
          renew it here.
        </p>
        ${action}
        <p>
          Fallback: <code>/meetup_get_token sweep_credential:True</code> in
          Discord still works.
        </p>
      </div>`,
    );
  }) as RequestHandler);

  // Behind the unsafe-method guard: CSRF token, Origin and rate limit.
  // Answers with a page that LINKS to Meetup rather than a redirect: browsers
  // apply the dashboard's `form-action 'self'` to every redirect after a form
  // POST, and Meetup's sign-in may bounce through more than one host.
  router.post('/organizer-login/start', (async (_req, res) => {
    const { session, sid } = dashboardLocals(res);
    let meta: CredentialMeta | undefined;
    try {
      meta = await deps.credentialStatus();
    } catch (error: unknown) {
      logger.warn(`Organizer login status read failed: ${errorName(error)}`);
      result(res, 503, 'Unable to continue', STORE_DOWN);
      return;
    }
    if (!meta) {
      result(res, 503, 'Unable to continue', UNAVAILABLE);
      return;
    }
    const state = await deps.createState(session.userId, sessionHashOf(sid));
    // Only Meetup's authorize endpoint passes safeHref; anything else is a
    // wiring fault, refused rather than linked.
    const href = safeHref(deps.buildAuthUrl(state));
    if (!href) {
      logger.error(
        'Organizer login start built a sign-in URL safeHref refused',
      );
      result(
        res,
        500,
        'Something went wrong',
        'The Meetup sign-in link could not be built. Please try again.',
      );
      return;
    }
    audit({
      title: 'Organizer login renewal started',
      description: `<@${session.userId}> started renewing the shared Meetup organizer login.`,
    });
    page(
      res,
      200,
      'Renew organizer login',
      html`<div class="card">
        <h1>Continue to Meetup</h1>
        <p>
          Sign in to Meetup as the <strong>shared organizer account</strong>,
          not your personal account. This link works once, in this window, for
          10 minutes.
        </p>
        <p>
          <a class="button" href="${href}">Continue to Meetup sign-in</a>
        </p>
        <p><a href="/dashboard/organizer-login">Back to organizer login</a></p>
      </div>`,
    );
  }) as RequestHandler);

  /**
   * The one state-changing GET on the dashboard: Meetup redirects the browser
   * here (via /connect/meetup/callback), so it cannot carry our CSRF token.
   * Its CSRF protection is the state itself: one-time (claimState), issued by
   * a CSRF-checked POST, and bound to sha256 of THIS session's id and to this
   * session's Discord user. A link lured into another browser or session
   * fails the binding before anything is exchanged or stored.
   */
  router.get('/organizer-login/complete', (async (req, res) => {
    const { session, sid } = dashboardLocals(res);
    const actor = `<@${session.userId}>`;
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const record = state ? await deps.resolveState(state) : undefined;
    if (
      !record ||
      record.purpose !== 'organizer-renew' ||
      typeof record.sessionHash !== 'string' ||
      !safeEqual(record.sessionHash, sessionHashOf(sid)) ||
      record.discordUserId !== session.userId ||
      !(await deps.claimState(state))
    ) {
      logger.warn('Organizer login completion refused: state not valid here');
      result(
        res,
        400,
        'Unable to continue',
        'This renewal link expired or belongs to another session. Start again.',
      );
      return;
    }

    const { code, error } = req.query;
    if (error !== undefined || typeof code !== 'string' || !code) {
      audit({
        title: 'Organizer login renewal cancelled',
        description: `${actor} did not complete the Meetup sign-in. Nothing was saved.`,
      });
      result(res, 400, 'Unable to continue', 'Meetup sign-in was cancelled.');
      return;
    }

    const refused = (reason: string, description: string) =>
      audit({
        title: 'Organizer login renewal refused',
        description: `${actor}: ${description} (${reason}). Nothing was saved.`,
      });
    const failed = (what: string) =>
      audit({
        title: 'Organizer login renewal failed',
        description: `${actor}: ${what}. Nothing was saved.`,
      });

    // Read before exchanging, so a deployment that cannot check the account
    // never obtains a token it would have to throw away.
    let expected: string | undefined;
    try {
      expected = await deps.expectedMemberId();
    } catch (err: unknown) {
      logger.warn(`Organizer member id read failed: ${errorName(err)}`);
      failed('the credential store could not be read');
      result(res, 503, 'Unable to continue', STORE_DOWN);
      return;
    }
    if (!expected) {
      refused('not configured', 'no organizer account is on record');
      result(
        res,
        409,
        'Not configured',
        'No organizer account is on record. Set MEETUP_ORGANIZER_MEMBER_ID.',
      );
      return;
    }

    let tokens: Tokens;
    try {
      tokens = await deps.exchangeCode(code);
    } catch (err: unknown) {
      // The message embeds Meetup's raw response body: name and status only.
      const status = statusFrom(err);
      logger.warn(
        `Organizer login code exchange failed: ${errorName(err)}${
          status ? ` [${status}]` : ''
        }`,
      );
      failed('Meetup did not complete the sign-in');
      result(
        res,
        502,
        'Unable to continue',
        'Meetup did not complete the sign-in. Please start again.',
      );
      return;
    }

    let memberId: string;
    try {
      memberId = await deps.fetchMeetupMemberId(tokens.accessToken);
    } catch (err: unknown) {
      logger.warn(`Organizer member id lookup failed: ${errorName(err)}`);
      memberId = '';
    }
    if (!MEMBER_ID_PATTERN.test(memberId)) {
      failed('Meetup did not say which account signed in');
      result(
        res,
        502,
        'Unable to continue',
        'Meetup did not say which account signed in. Please start again.',
      );
      return;
    }

    if (memberId !== expected) {
      refused(
        'wrong account',
        'the Meetup account does not match the shared organizer account',
      );
      result(
        res,
        403,
        'Wrong Meetup account',
        'This Meetup account is not the shared organizer account. Nothing was saved.',
      );
      return;
    }

    try {
      await deps.saveRenewedCredential(tokens, memberId);
    } catch (err: unknown) {
      logger.error(`Organizer login could not be saved: ${errorName(err)}`);
      failed('the renewed login could not be saved');
      result(
        res,
        503,
        'Unable to continue',
        'The renewed login could not be saved. Please start again in a minute.',
      );
      return;
    }
    audit({
      title: 'Organizer login renewed',
      description: `${actor} renewed the shared Meetup organizer login; the account matches.`,
    });
    result(
      res,
      200,
      'Renewed',
      'Meetup organizer login renewed. Identity monitoring resumes with the next sweep.',
    );
  }) as RequestHandler);
}
