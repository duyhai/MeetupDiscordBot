import express, { RequestHandler } from 'express';
import { Logger } from 'tslog';

import { LogEntry } from '../../lib/helpers/discordLogger.js';
import {
  DASHBOARD_PATHS,
  dashboardPath,
} from '../../lib/reports/dashboardPaths.js';
import { dashboardLocals } from '../dashboardRouter.js';
import { html, localUrl } from '../html.js';
import { dashboardPage } from '../pageKit.js';
import type { DashboardPageDeps } from './dashboardPages.js';

const logger = new Logger({ name: 'dashboard' });

export const SESSIONS_PATH = DASHBOARD_PATHS.sessions;
export const REVOKE_SESSIONS_PATH = DASHBOARD_PATHS.revokeSessions;

const DISCORD_ID = /^[0-9]{17,20}$/;

const NOTICES = {
  done: 'That staff member was signed out everywhere. They can sign in again only while they still hold a dashboard role.',
  'bad-id': 'That is not a Discord user id.',
  'not-leadership':
    'Only the 1.5 Leadership Team can sign out another staff member.',
  unavailable:
    'Discord could not be reached to check your role. Nothing was changed; try again in a minute.',
} as const;

type NoticeCode = keyof typeof NOTICES;

/** Fixed text for a known code only; anything else from the query renders nothing. */
function noticeFor(code: unknown) {
  if (typeof code !== 'string' || !Object.hasOwn(NOTICES, code)) {
    return '';
  }
  return html`<p class="note">${NOTICES[code as NoticeCode]}</p>`;
}

const back = (code: NoticeCode) =>
  `${dashboardPath(SESSIONS_PATH)}?done=${code}`;

/**
 * Sign out everywhere. Any staff member may end their own sessions; ending
 * another member's needs the 1.5 Leadership Team role, asked of Discord live,
 * so a Moderator cannot lock Leadership out. Both go through the protected
 * router, so CSRF, Origin, Sec-Fetch-Site and the per-user limit apply.
 */
export function registerSessionRoutes(
  router: express.Router,
  deps: Pick<DashboardPageDeps, 'sessionStore' | 'isLeadership' | 'audit'>,
): void {
  // Fire-and-forget like sign-ins: a slow or failing Discord post never
  // holds up or undoes a revocation.
  const audit = (entry: LogEntry) => {
    Promise.resolve()
      .then(() => deps.audit(entry))
      .catch((error: unknown) =>
        logger.warn(
          `Dashboard audit post failed: ${error instanceof Error ? error.name : 'Error'}`,
        ),
      );
  };

  router.get(SESSIONS_PATH, (req, res) => {
    const { session } = dashboardLocals(res);
    dashboardPage(res, {
      title: 'Sessions',
      body: html`<div class="card">
          <h1>Sessions</h1>
          ${noticeFor(req.query.done)}
          <form
            method="post"
            action="${localUrl(dashboardPath(REVOKE_SESSIONS_PATH))}"
          >
            <input type="hidden" name="_csrf" value="${session.csrfToken}" />
            <input type="hidden" name="userId" value="${session.userId}" />
            <button type="submit">Sign me out everywhere</button>
          </form>
        </div>
        <div class="card">
          <h2>Sign out another staff member</h2>
          <p class="muted">
            1.5 Leadership Team only. Removing their Discord role also signs
            them out within 10 minutes.
          </p>
          <form
            method="post"
            action="${localUrl(dashboardPath(REVOKE_SESSIONS_PATH))}"
          >
            <input type="hidden" name="_csrf" value="${session.csrfToken}" />
            <label
              >Discord user id
              <input
                name="userId"
                inputmode="numeric"
                pattern="[0-9]{17,20}"
                required
            /></label>
            <button type="submit">Sign them out everywhere</button>
          </form>
        </div>`,
    });
  });

  router.post(REVOKE_SESSIONS_PATH, (async (req, res) => {
    const { session } = dashboardLocals(res);
    const target = (req.body as Record<string, unknown> | undefined)?.userId;
    if (typeof target !== 'string' || !DISCORD_ID.test(target)) {
      res.redirect(303, back('bad-id'));
      return;
    }
    const store = await deps.sessionStore();
    if (target === session.userId) {
      await store.revokeUser(target);
      audit({
        title: 'Dashboard sessions ended',
        description: `<@${target}> signed out of the staff dashboard everywhere.`,
      });
      // This session is revoked too.
      res.redirect(303, '/dashboard/login');
      return;
    }
    let leader: boolean;
    try {
      leader = await deps.isLeadership(session.userId);
    } catch (error: unknown) {
      // Nothing is revoked when Discord cannot say who is asking.
      logger.warn(
        `Dashboard Leadership check failed: ${error instanceof Error ? error.name : 'Error'}`,
      );
      res.redirect(303, back('unavailable'));
      return;
    }
    if (leader !== true) {
      res.redirect(303, back('not-leadership'));
      return;
    }
    await store.revokeUser(target);
    audit({
      title: 'Dashboard sessions ended',
      description: `<@${session.userId}> signed <@${target}> out of the staff dashboard everywhere.`,
    });
    res.redirect(303, back('done'));
  }) as RequestHandler);
}
