import dayjs from 'dayjs';
import express, { RequestHandler, Response } from 'express';
import { Logger } from 'tslog';

import {
  PublishOutcome,
  STUCK_PUBLISHING_MS,
} from '../../lib/hosts/publishRequest.js';
import { LogEntry } from '../../lib/helpers/discordLogger.js';
import {
  DASHBOARD_PATHS,
  dashboardPath,
} from '../../lib/reports/dashboardPaths.js';
import {
  DENY_REASON_MAX,
  EventRequest,
  EventRequestStatus,
  PublishFrom,
} from '../../lib/repositories/postgresEventRequestRepository.js';
import { tz } from '../../util/timezone.js';
import { dashboardLocals } from '../dashboardRouter.js';
import { SafeHtml, html, localUrl, memberText, safeHref } from '../html.js';
import { dashboardPage, load, notFound } from '../pageKit.js';
import { FixedWindowLimiter } from '../rateLimit.js';
import type { DashboardPageDeps } from './dashboardPages.js';
import {
  LeadershipAnswer,
  WORKSPACE_REFUSAL_POST_WINDOW_MS,
  WORKSPACE_REQUEST_DEADLINE_MS,
  WorkspaceDeadlineError,
  leadershipOf,
  withDeadline,
} from './workspaceActions.js';

const logger = new Logger({ name: 'dashboard' });

const REQUEST_ID = /^[1-9][0-9]{0,17}$/;
const VERSION = /^[1-9][0-9]{0,8}$/;
const RECENT_DECIDED = 20;

/** The request store's reads and the deny write the queue uses. */
export interface StaffRequestStore {
  get: (id: string) => Promise<EventRequest | undefined>;
  listByStatus: (
    statuses: EventRequestStatus[],
    limit?: number,
  ) => Promise<EventRequest[]>;
  listDecided: (limit?: number) => Promise<EventRequest[]>;
  deny: (
    id: string,
    seenVersion: number,
    actor: string,
    reason: string,
  ) => Promise<EventRequest | undefined>;
}

/** The queue's two dependencies, on DashboardPageDeps. */
export interface HostRequestDeps {
  /** Rejects when Postgres cannot answer: the page answers 503. */
  eventRequests: () => Promise<StaffRequestStore>;
  /** publishRequest with the organizer credential; the actor is the leader's Discord id. */
  publishRequest: (
    id: string,
    version: number,
    actor: string,
    from: PublishFrom[],
  ) => Promise<PublishOutcome>;
}

const ACTIONS = ['approve', 'deny', 'retry'] as const;
type QueueAction = (typeof ACTIONS)[number];

/** Every code a queue POST can send back in `?result=`. Fixed text only. */
export const HOST_REQUEST_RESULT_MESSAGES = {
  published: 'Approved and published on Meetup.',
  failed:
    'Approved, but publishing failed. The card says what exists on Meetup; fix it or Retry.',
  denied: 'Denied. The host sees your reason on their dashboard.',
  'still-publishing':
    'Meetup is slow to answer. The request stays "publishing"; reload in a minute. If it is still stuck after 10 minutes, Retry.',
  'reason-required': 'Write a reason for the host, then deny again.',
  'reason-too-long': `Keep the reason to ${DENY_REASON_MAX} characters.`,
  invalid:
    'That request could not be understood. Reload the page and try again.',
  'not-leadership':
    'Only the 1.5 Leadership Team can approve or deny host requests. Nothing was changed.',
  'leadership-unavailable':
    'Discord could not be reached to check your role. Nothing was changed; try again in a minute.',
  error: 'That did not save. Please try again in a minute.',
} as const;
export type HostRequestResultCode = keyof typeof HOST_REQUEST_RESULT_MESSAGES;

const DONE: ReadonlySet<HostRequestResultCode> = new Set([
  'published',
  'denied',
]);

const isResultCode = (code: unknown): code is HostRequestResultCode =>
  typeof code === 'string' && Object.hasOwn(HOST_REQUEST_RESULT_MESSAGES, code);

function resultNotice(code: unknown): SafeHtml | '' {
  if (!isResultCode(code)) {
    return '';
  }
  return DONE.has(code)
    ? html`<p class="note info">${HOST_REQUEST_RESULT_MESSAGES[code]}</p>`
    : html`<p class="note attn">${HOST_REQUEST_RESULT_MESSAGES[code]}</p>`;
}

const queuePath = () => dashboardPath(DASHBOARD_PATHS.hostRequests);
const actionPath = (id: string, action: QueueAction) =>
  `${queuePath()}/${id}/${action}`;

/** One form field as a string; a missing or repeated field is undefined. */
function field(body: unknown, name: string): string | undefined {
  const value = (body as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' ? value : undefined;
}

const whenLabel = (startLocal: string) =>
  dayjs(startLocal).format('ddd, MMM D, YYYY [at] h:mm A');

function statusBadge(r: EventRequest): SafeHtml {
  switch (r.status) {
    case 'pending':
      return html`<span class="badge attn">Waiting</span>`;
    case 'publishing':
      return html`<span class="badge info">Publishing</span>`;
    case 'published':
      return html`<span class="badge ok">Published</span>`;
    case 'denied':
      return html`<span class="badge neutral">Denied</span>`;
    default:
      return html`<span class="badge attn">Failed</span>`;
  }
}

function tierBadge(r: EventRequest): SafeHtml {
  return r.tier === 'promoted'
    ? html`<span class="badge ok">Community Host</span>`
    : html`<span class="badge neutral">Guest Host</span>`;
}

/** The leader's buttons for one card; none for a Moderator. */
function cardActions(
  r: EventRequest,
  leader: boolean,
  csrf: string,
  now: Date,
): SafeHtml {
  if (!leader) {
    return html``;
  }
  const csrfField = html`<input type="hidden" name="_csrf" value="${csrf}" />
    <input type="hidden" name="version" value="${r.version}" />`;
  const denyForm = html`<form
    method="post"
    action="${localUrl(actionPath(r.id, 'deny'))}"
  >
    ${csrfField}
    <label class="field"
      >Reason (the host sees it)
      <textarea
        name="reason"
        rows="2"
        maxlength="${DENY_REASON_MAX}"
        required
      ></textarea>
    </label>
    <button type="submit" class="danger">Deny</button>
  </form>`;
  // Publishing refuses a start in the past; offer only Deny for one.
  const started = tz(dayjs(now)).format('YYYY-MM-DDTHH:mm') >= r.startLocal;
  if (r.status === 'pending') {
    return html`<div class="actions">
      ${
        started
          ? html`<p class="note attn">
              The start time has passed, so this can no longer be published.
            </p>`
          : html`<form
              method="post"
              action="${localUrl(actionPath(r.id, 'approve'))}"
            >
              ${csrfField}
              <button type="submit">Approve and publish</button>
            </form>`
      }
      ${denyForm}
    </div>`;
  }
  const stuck =
    r.status === 'publishing' &&
    now.getTime() - r.updatedAt.getTime() >= STUCK_PUBLISHING_MS;
  if (r.status === 'failed' || stuck) {
    // Deny closes a failed request with no event recorded; one with an
    // event on Meetup is finished by Retry instead.
    const deniable = r.status === 'failed' && r.meetupEventId === null;
    return html`<div class="actions">
      <form method="post" action="${localUrl(actionPath(r.id, 'retry'))}">
        ${csrfField}
        <button type="submit">Retry</button>
      </form>
      ${deniable ? denyForm : ''}
    </div>`;
  }
  return html``;
}

function requestCard(
  r: EventRequest,
  leader: boolean,
  csrf: string,
  now: Date,
): SafeHtml {
  const meetup = safeHref(r.eventUrl ?? '');
  return html`<div class="card">
    <h3>${memberText(r.title)}</h3>
    <p>${statusBadge(r)} ${tierBadge(r)}</p>
    <p>
      ${memberText(r.hostName)} · ${whenLabel(r.startLocal)} ·
      ${r.duration.replace(/^PT/, '').toLowerCase()} ·
      ${r.kind === 'copy' ? `copy of Meetup event ${r.sourceEventId ?? ''}` : 'new event'}
    </p>
    <p class="muted">
      Request #${r.id}, sent ${dayjs(r.createdAt).format('MMM D, h:mm A')}
    </p>
    ${r.denyReason ? html`<p>Reason: ${memberText(r.denyReason)}</p>` : ''}
    ${r.failure ? html`<p class="note attn wrap-anywhere">${r.failure}</p>` : ''}
    ${
      meetup
        ? html`<p>
            <a href="${meetup}" rel="noopener noreferrer" target="_blank"
              >Open on Meetup</a
            >
          </p>`
        : ''
    }
    ${cardActions(r, leader, csrf, now)}
  </div>`;
}

function queueBody(
  view: {
    pending: EventRequest[];
    attention: EventRequest[];
    decided: EventRequest[];
  },
  leadership: LeadershipAnswer,
  csrf: string,
  now: Date,
  notice: SafeHtml | '',
): SafeHtml {
  const leader = leadership === 'leader';
  const card = (r: EventRequest) => requestCard(r, leader, csrf, now);
  return html`<div class="card">
      <h1>Host requests</h1>
      <p>
        Events hosts asked for on the host dashboard. Approving publishes the
        event on Meetup with the organizer login, titled "[Guest Host] …".
        Community Hosts publish their own; theirs appear here only if publishing
        failed.
      </p>
      ${
        leader
          ? ''
          : html`<p class="muted">
              Only the 1.5 Leadership Team can approve or deny.
            </p>`
      }
      ${notice}
    </div>
    <h2>Waiting (${view.pending.length})</h2>
    ${
      view.pending.length === 0
        ? html`<p class="muted">No requests are waiting.</p>`
        : view.pending.map(card)
    }
    ${
      view.attention.length > 0
        ? html`<h2>Needs attention (${view.attention.length})</h2>
            ${view.attention.map(card)}`
        : ''
    }
    <h2>Recently decided</h2>
    ${
      view.decided.length === 0
        ? html`<p class="muted">Nothing yet.</p>`
        : view.decided.map(card)
    }`;
}

function stalePage(res: Response): void {
  dashboardPage(res, {
    title: 'Request changed',
    status: 409,
    body: html`<div class="card">
      <h1>Someone just acted on this request</h1>
      <p>Nothing was changed. Reload the queue to see where it stands.</p>
      <p><a href="${localUrl(queuePath())}">Reload the queue</a></p>
    </div>`,
  });
}

/**
 * GET /dashboard/hosts/requests (Moderators and Leadership) and
 * POST /dashboard/hosts/requests/:id/(approve|deny|retry) (Leadership,
 * checked live on every POST). CSRF, Origin, Sec-Fetch-Site and the
 * per-user action rate limit are the router's unsafe-method guard.
 */
export function registerHostRequestRoutes(
  router: express.Router,
  deps: Pick<
    DashboardPageDeps,
    'now' | 'isLeadership' | 'audit' | 'eventRequests' | 'publishRequest'
  >,
): void {
  const refusalPosts = new FixedWindowLimiter(
    1,
    WORKSPACE_REFUSAL_POST_WINDOW_MS,
    () => deps.now().getTime(),
  );
  const back = (res: Response, code: HostRequestResultCode) =>
    res.redirect(303, `${queuePath()}?result=${code}`);

  router.get(DASHBOARD_PATHS.hostRequests, (async (req, res) => {
    const { session } = dashboardLocals(res);
    const loaded = await load(res, 'host requests', async () => {
      const store = await deps.eventRequests();
      const [pending, attention, decided] = await Promise.all([
        store.listByStatus(['pending']),
        store.listByStatus(['failed', 'publishing']),
        store.listDecided(RECENT_DECIDED),
      ]);
      return { pending, attention, decided };
    });
    if (!loaded.ok) {
      return;
    }
    const leadership = await leadershipOf(deps.isLeadership, session.userId);
    dashboardPage(res, {
      title: 'Host requests',
      body: queueBody(
        loaded.value,
        leadership,
        session.csrfToken,
        deps.now(),
        resultNotice(req.query.result),
      ),
    });
  }) as RequestHandler);

  router.post(DASHBOARD_PATHS.hostRequestAction, (async (req, res) => {
    const { id, action } = req.params;
    if (
      typeof id !== 'string' ||
      !REQUEST_ID.test(id) ||
      !(ACTIONS as readonly string[]).includes(action)
    ) {
      notFound(res);
      return;
    }
    const verb = action as QueueAction;
    const { session } = dashboardLocals(res);
    // Live, on every request: the session's cached roles never decide this.
    const leadership = await leadershipOf(deps.isLeadership, session.userId);
    if (leadership !== 'leader') {
      if (refusalPosts.take(session.userId)) {
        deps
          .audit({
            title: 'Host request action refused',
            description: `<@${session.userId}> tried to ${verb} host request #${id} without the 1.5 Leadership Team role (${leadership}).`,
          })
          .catch(() => undefined);
      }
      back(
        res,
        leadership === 'not-leader'
          ? 'not-leadership'
          : 'leadership-unavailable',
      );
      return;
    }
    const body = req.body as unknown;
    const versionText = field(body, 'version');
    if (versionText === undefined || !VERSION.test(versionText)) {
      back(res, 'invalid');
      return;
    }
    const version = Number(versionText);
    let store: StaffRequestStore;
    try {
      store = await deps.eventRequests();
    } catch (error: unknown) {
      logger.warn(
        `Host request store failed: ${error instanceof Error ? error.name : 'Error'}`,
      );
      back(res, 'error');
      return;
    }
    const auditLine = (what: string, request: EventRequest | undefined) => {
      deps
        .audit({
          title: `Host request ${what}`,
          fields: [
            { name: 'Request', value: `#${id}`, inline: true },
            { name: 'By', value: `<@${session.userId}>`, inline: true },
            ...(request ? [{ name: 'Title', value: request.title }] : []),
          ],
        } satisfies LogEntry)
        .catch(() => undefined);
    };

    if (verb === 'deny') {
      // Browsers send a textarea's line breaks as CRLF but count them as one
      // character for maxlength; so does this, and so is it stored.
      const reason = (field(body, 'reason') ?? '')
        .replace(/\r\n?/g, '\n')
        .trim();
      if (reason === '') {
        back(res, 'reason-required');
        return;
      }
      if (Array.from(reason).length > DENY_REASON_MAX) {
        back(res, 'reason-too-long');
        return;
      }
      let denied: EventRequest | undefined;
      try {
        denied = await withDeadline(WORKSPACE_REQUEST_DEADLINE_MS, () =>
          store.deny(id, version, session.userId, reason),
        );
      } catch (error: unknown) {
        logger.warn(
          `Host request deny failed: ${error instanceof Error ? error.name : 'Error'}`,
        );
        back(res, 'error');
        return;
      }
      if (denied === undefined) {
        stalePage(res);
        return;
      }
      auditLine('denied', denied);
      back(res, 'denied');
      return;
    }

    const from: PublishFrom[] =
      verb === 'approve' ? ['pending'] : ['failed', 'publishing'];
    let outcome: PublishOutcome;
    try {
      outcome = await withDeadline(WORKSPACE_REQUEST_DEADLINE_MS, () =>
        deps.publishRequest(id, version, session.userId, from),
      );
    } catch (error: unknown) {
      if (error instanceof WorkspaceDeadlineError) {
        auditLine(
          `${verb === 'approve' ? 'approval' : 'retry'} started (still publishing)`,
          undefined,
        );
        back(res, 'still-publishing');
        return;
      }
      logger.warn(
        `Host request publish failed: ${error instanceof Error ? error.name : 'Error'}`,
      );
      back(res, 'error');
      return;
    }
    if (outcome.code === 'stale') {
      stalePage(res);
      return;
    }
    auditLine(verb === 'approve' ? 'approved' : 'retried', outcome.request);
    back(res, outcome.code);
  }) as RequestHandler);
}
