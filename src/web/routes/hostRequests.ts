import dayjs from 'dayjs';
import express, { RequestHandler, Response } from 'express';
import { Logger } from 'tslog';

import {
  ExistingEvent,
  PublishOutcome,
  STUCK_PUBLISHING_MS,
  canDeny,
  canResolve,
  canRetry,
  startHasPassed,
} from '../../lib/hosts/publishRequest.js';
import {
  DECISION_ACTIONS,
  DECISION_MESSAGES,
  DecisionAction,
  REFUSAL_AUDIT_WINDOW_MS,
  StaffRequestStore,
  decideRequest,
} from '../../lib/hosts/requestDecision.js';
import {
  ChecklistKey,
  REVIEW_CHECKLIST,
  checklistLabel,
  parseChecklist,
} from '../../lib/hosts/reviewChecklist.js';
import {
  DASHBOARD_PATHS,
  dashboardPath,
} from '../../lib/reports/dashboardPaths.js';
import {
  DENY_REASON_MAX,
  EVENT_REQUEST_STATUSES,
  EventRequest,
  EventRequestStatus,
  PublishFrom,
} from '../../lib/repositories/postgresEventRequestRepository.js';
import {
  GUEST_HOST_EVENT_DESCRIPTION,
  createEventTemplate,
} from '../../templates/createEventTemplate.js';
import { dashboardLocals } from '../dashboardRouter.js';
import { SafeHtml, html, localUrl, memberText, safeHref } from '../html.js';
import { dashboardPage, load, notFound } from '../pageKit.js';
import { FixedWindowLimiter } from '../rateLimit.js';
import type { DashboardPageDeps } from './dashboardPages.js';
import { LeadershipAnswer, leadershipOf } from './workspaceActions.js';

const logger = new Logger({ name: 'dashboard' });

const REQUEST_ID = /^[1-9][0-9]{0,17}$/;
const VERSION = /^[1-9][0-9]{0,8}$/;
const RECENT_DECIDED = 20;
/** How many of one status a filtered page lists. */
const FILTERED_LIMIT = 100;

/** The store the queue reads and the decision service writes (requestDecision.ts). */
export type { StaffRequestStore } from '../../lib/hosts/requestDecision.js';

/** The queue's dependencies, on DashboardPageDeps. */
export interface HostRequestDeps {
  /** Rejects when Postgres cannot answer: the page answers 503. */
  eventRequests: () => Promise<StaffRequestStore>;
  /** publishRequest with the organizer credential; the actor is the leader's Discord id. */
  publishRequest: (
    id: string,
    version: number,
    actor: string,
    from: PublishFrom[],
    options?: { detail?: string | null },
  ) => Promise<PublishOutcome>;
  /**
   * The Meetup event a failed request may have become without it being
   * recorded (publishRequest's findExisting). Throws when Meetup cannot answer.
   */
  findExistingEvent: (
    request: EventRequest,
  ) => Promise<ExistingEvent | undefined>;
  /** Tests only: how long the pre-deny Meetup check may take. */
  denyCheckDeadlineMs?: number;
  /**
   * Shows a decision on the request's Discord post (requestPost.ts). Fire
   * and forget; absent in tests that have no Discord.
   */
  mirrorRequest?: (request: EventRequest) => Promise<unknown>;
}

type QueueAction = DecisionAction;

/** Every code a queue POST can send back in `?result=`: the service's texts plus the page's own. */
export const HOST_REQUEST_RESULT_MESSAGES = {
  ...DECISION_MESSAGES,
  invalid:
    'That request could not be understood. Reload the page and try again.',
} as const;
export type HostRequestResultCode = keyof typeof HOST_REQUEST_RESULT_MESSAGES;

const DONE: ReadonlySet<HostRequestResultCode> = new Set([
  'published',
  'denied',
  'resolved',
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

/** A field that may repeat (checkboxes): as the body parser gives it. */
function fieldValues(body: unknown, name: string): unknown {
  return (body as Record<string, unknown> | undefined)?.[name];
}

/**
 * The reviewer's checklist (reviewChecklist.ts) inside the Approve form:
 * what to confirm by eye before approving. A memory aid: nothing is
 * required, and Approve works however many are ticked.
 */
function checklistFields(): SafeHtml {
  return html`<fieldset class="review-checklist">
    <legend>Before approving, check on Meetup and in the request:</legend>
    ${REVIEW_CHECKLIST.map(
      (item) =>
        html`<label class="check">
          <input type="checkbox" name="check" value="${item.key}" />
          ${item.label}
        </label>`,
    )}
  </fieldset>`;
}

/** What the reviewer confirmed when they approved, from the history. */
function checklistRecord(ticked: ChecklistKey[] | undefined): SafeHtml | '' {
  if (ticked === undefined) {
    return '';
  }
  return ticked.length === 0
    ? html`<p class="muted">Reviewer checklist: nothing ticked.</p>`
    : html`<p class="muted">
        Reviewer confirmed: ${ticked.map(checklistLabel).join(' · ')}
      </p>`;
}

const whenLabel = (startLocal: string) =>
  dayjs(startLocal).format('ddd, MMM D, YYYY [at] h:mm A');

/** Each status as the queue names it, on the badge and the filter chip. */
export const STATUS_LABELS: Record<EventRequestStatus, string> = {
  pending: 'Waiting',
  publishing: 'Publishing',
  published: 'Published',
  failed: 'Failed',
  denied: 'Denied',
};

/** Denied is attention-coloured like Waiting and Failed: it should stand out. */
function statusBadge(r: EventRequest): SafeHtml {
  switch (r.status) {
    case 'publishing':
      return html`<span class="badge info">${STATUS_LABELS.publishing}</span>`;
    case 'published':
      return html`<span class="badge ok">${STATUS_LABELS.published}</span>`;
    default:
      return html`<span class="badge attn">${STATUS_LABELS[r.status]}</span>`;
  }
}

/** `?status=`: one of the table's statuses, else the default view. */
export function statusFilter(value: unknown): EventRequestStatus | undefined {
  return typeof value === 'string' &&
    (EVENT_REQUEST_STATUSES as readonly string[]).includes(value)
    ? (value as EventRequestStatus)
    : undefined;
}

function queueLink(status?: EventRequestStatus): string {
  return status ? `${queuePath()}?status=${status}` : queuePath();
}

/** All · Waiting · … chips, each with its count when the store counts. */
function filterChips(
  selected: EventRequestStatus | undefined,
  counts: Map<EventRequestStatus, number> | undefined,
): SafeHtml {
  const chip = (status: EventRequestStatus | undefined, label: string) => {
    const n = status && counts ? (counts.get(status) ?? 0) : undefined;
    const text = n === undefined ? label : `${label} (${n})`;
    return status === selected
      ? html`<a href="${localUrl(queueLink(status))}" aria-current="page"
          ><strong>${text}</strong></a
        >`
      : html`<a href="${localUrl(queueLink(status))}">${text}</a>`;
  };
  return html`<nav class="status-filter" aria-label="Request status">
    ${chip(undefined, 'All')}
    ${EVENT_REQUEST_STATUSES.map((s) => chip(s, STATUS_LABELS[s]))}
  </nav>`;
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
  const started = startHasPassed(r.startLocal, now);
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
              ${csrfField} ${checklistFields()}
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
    // Deny asks Meetup first (an event may exist that was never recorded);
    // a request with its event recorded is finished by Retry or by hand.
    const retryForm = canRetry(r, now)
      ? html`<form
          method="post"
          action="${localUrl(actionPath(r.id, 'retry'))}"
        >
          ${csrfField}
          <button type="submit">Retry</button>
        </form>`
      : html`<p class="note attn">
          The start time has passed and no event was recorded, so Retry can only
          fail. Deny it with a note to the host.
        </p>`;
    const resolveForm = canResolve(r)
      ? html`<form
          method="post"
          action="${localUrl(actionPath(r.id, 'resolve'))}"
        >
          ${csrfField}
          <p class="muted">
            Fixed it on Meetup by hand? Mark it resolved and the host sees it as
            published.
          </p>
          <button type="submit" class="secondary">Mark resolved</button>
        </form>`
      : '';
    return html`<div class="actions">
      ${retryForm} ${resolveForm} ${canDeny(r) ? denyForm : ''}
    </div>`;
  }
  return html``;
}

const DEFAULT_LIMITS = createEventTemplate.rsvpSettings;
const TEMPLATE_PHOTO = createEventTemplate.featuredPhotoId ?? null;
const TIP_LINE = /^💡 Host Tip: .* 💡\n\n/u;

/** Which description a request carries, for the card's label. */
function descriptionKind(r: EventRequest): 'standard' | 'custom' | 'copied' {
  if (r.kind === 'copy') {
    return 'copied';
  }
  return r.description.replace(TIP_LINE, '') === GUEST_HOST_EVENT_DESCRIPTION
    ? 'standard'
    : 'custom';
}

/** One limit, flagged when it is not the template's. */
function limitText(label: string, value: number, standard: number): SafeHtml {
  return value === standard
    ? html`${label} ${value}`
    : html`<strong>${label} ${value}</strong> (default ${standard})`;
}

/**
 * What approving publishes besides the title and time: the limits and the
 * description, escaped, folded away. Anything the host changed from the
 * template is marked, so a leader sees it before approving.
 */
function requestSettings(r: EventRequest): SafeHtml {
  const kind = descriptionKind(r);
  const limitsChanged =
    r.rsvpLimit !== DEFAULT_LIMITS.rsvpLimit ||
    r.guestLimit !== DEFAULT_LIMITS.guestLimit;
  const badges = [
    kind === 'custom'
      ? html`<span class="badge attn">Custom description</span>`
      : '',
    // Hosts edit their own events on Meetup, so a copied description is
    // host-written too: it gets the same attention.
    kind === 'copied'
      ? html`<span class="badge attn">Description from the host's event</span>`
      : '',
    limitsChanged && r.kind === 'fresh'
      ? html`<span class="badge attn">Custom limits</span>`
      : '',
  ];
  const summary = {
    standard: 'Description: the standard one',
    custom: 'Description: written by the host',
    copied: "Description: from the host's own event",
  }[kind];
  // On one line: the block keeps the description's line breaks.
  const text = html`<div class="desc-text">${memberText(r.description)}</div>`;
  return html`<p>
      ${limitText('RSVP limit', r.rsvpLimit, DEFAULT_LIMITS.rsvpLimit)} ·
      ${limitText('Guests per member', r.guestLimit, DEFAULT_LIMITS.guestLimit)}
      ${badges}
    </p>
    ${r.kind === 'copy' ? copyDetails(r) : ''}
    <details class="request-description">
      <summary>${summary}</summary>
      ${text}
    </details>`;
}

/**
 * What else a copy publishes, taken from the host's event: the venue,
 * the directions and the featured photo. Ids only (the staff CSP loads no
 * Meetup images), so a leader can look them up on Meetup.
 */
function copyDetails(r: EventRequest): SafeHtml {
  const photo =
    r.featuredPhotoId === null
      ? 'none'
      : r.featuredPhotoId === TEMPLATE_PHOTO
        ? "the group's standard photo"
        : `Meetup photo ${r.featuredPhotoId}`;
  return html`<ul class="copy-details">
    <li>
      Venue:
      ${r.venueId === null ? 'none (online, or none set)' : `Meetup venue ${r.venueId}`}
    </li>
    <li>
      Directions: ${r.howToFindUs === null ? 'none' : memberText(r.howToFindUs)}
    </li>
    <li>Photo: ${photo}</li>
  </ul>`;
}

function requestCard(
  r: EventRequest,
  leader: boolean,
  csrf: string,
  now: Date,
  checklist: ChecklistKey[] | undefined,
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
    ${requestSettings(r)}
    <p class="muted">
      Request #${r.id}, sent ${dayjs(r.createdAt).format('MMM D, h:mm A')}
    </p>
    ${r.denyReason ? html`<p>Reason: ${memberText(r.denyReason)}</p>` : ''}
    ${checklistRecord(checklist)}
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

/** The default view (waiting, needing attention, recently decided) or one status's list. */
type QueueView = {
  checklists: Map<string, ChecklistKey[]>;
  counts: Map<EventRequestStatus, number> | undefined;
} & (
  | {
      kind: 'default';
      pending: EventRequest[];
      attention: EventRequest[];
      decided: EventRequest[];
    }
  | { kind: 'one'; status: EventRequestStatus; listed: EventRequest[] }
);

function queueBody(
  view: QueueView,
  leadership: LeadershipAnswer,
  csrf: string,
  now: Date,
  notice: SafeHtml | '',
): SafeHtml {
  const leader = leadership === 'leader';
  const card = (r: EventRequest) =>
    requestCard(r, leader, csrf, now, view.checklists.get(r.id));
  const lists =
    view.kind === 'default'
      ? html`<h2>Waiting (${view.pending.length})</h2>
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
          }`
      : html`<h2>${STATUS_LABELS[view.status]} (${view.listed.length})</h2>
          ${
            view.listed.length === 0
              ? html`<p class="muted">
                  No ${STATUS_LABELS[view.status].toLowerCase()} requests.
                </p>`
              : view.listed.map(card)
          }`;
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
      ${filterChips(view.kind === 'one' ? view.status : undefined, view.counts)}
    </div>
    ${lists}`;
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
 * POST /dashboard/hosts/requests/:id/(approve|deny|retry|resolve) (Leadership,
 * checked live on every POST). CSRF, Origin, Sec-Fetch-Site and the
 * per-user action rate limit are the router's unsafe-method guard.
 */
export function registerHostRequestRoutes(
  router: express.Router,
  deps: Pick<
    DashboardPageDeps,
    | 'now'
    | 'isLeadership'
    | 'audit'
    | 'eventRequests'
    | 'publishRequest'
    | 'findExistingEvent'
    | 'denyCheckDeadlineMs'
    | 'mirrorRequest'
  >,
): void {
  const refusalPosts = new FixedWindowLimiter(1, REFUSAL_AUDIT_WINDOW_MS, () =>
    deps.now().getTime(),
  );
  const back = (res: Response, code: HostRequestResultCode) =>
    res.redirect(303, `${queuePath()}?result=${code}`);

  router.get(DASHBOARD_PATHS.hostRequests, (async (req, res) => {
    const { session } = dashboardLocals(res);
    const status = statusFilter(req.query.status);
    const loaded = await load(
      res,
      'host requests',
      async (): Promise<QueueView> => {
        const store = await deps.eventRequests();
        const counting = store.countByStatus?.();
        // The checklists are a note on the cards: a failure hides them only.
        const checklistsOf = async (rows: EventRequest[]) => {
          if (!store.reviewChecklists) {
            return new Map<string, ChecklistKey[]>();
          }
          try {
            return await store.reviewChecklists(rows.map((r) => r.id));
          } catch (error: unknown) {
            logger.warn(
              `Review checklists read failed: ${error instanceof Error ? error.name : 'Error'}`,
            );
            return new Map<string, ChecklistKey[]>();
          }
        };
        if (status) {
          // Decided ones newest first; the rest oldest first, as the queue is worked.
          const listed = await store.listByStatus(
            [status],
            FILTERED_LIMIT,
            status === 'published' || status === 'denied' ? 'newest' : 'oldest',
          );
          const checklists = await checklistsOf(
            listed.filter((r) => r.status !== 'pending'),
          );
          return {
            kind: 'one',
            status,
            listed,
            checklists,
            counts: await counting,
          };
        }
        const [pending, attention, decided] = await Promise.all([
          store.listByStatus(['pending']),
          store.listByStatus(['failed', 'publishing']),
          store.listDecided(RECENT_DECIDED),
        ]);
        const checklists = await checklistsOf([...attention, ...decided]);
        return {
          kind: 'default',
          pending,
          attention,
          decided,
          checklists,
          counts: await counting,
        };
      },
    );
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
      !(DECISION_ACTIONS as readonly string[]).includes(action)
    ) {
      notFound(res);
      return;
    }
    const { session } = dashboardLocals(res);
    const body = req.body as unknown;
    const versionText = field(body, 'version');
    if (versionText === undefined || !VERSION.test(versionText)) {
      back(res, 'invalid');
      return;
    }
    // The one decision path, shared with the Discord buttons: the live
    // Leadership check, the deny rules and the publish are all in there.
    const outcome = await decideRequest(
      {
        now: deps.now,
        isLeadership: deps.isLeadership,
        audit: deps.audit,
        store: deps.eventRequests,
        publishRequest: deps.publishRequest,
        findExistingEvent: deps.findExistingEvent,
        mirror: deps.mirrorRequest,
        refusals: refusalPosts,
        denyCheckDeadlineMs: deps.denyCheckDeadlineMs,
      },
      {
        id,
        version: Number(versionText),
        actor: session.userId,
        action: action as QueueAction,
        reason: field(body, 'reason'),
        ...(action === 'approve'
          ? { checklist: parseChecklist(fieldValues(body, 'check')) }
          : {}),
      },
    );
    if (outcome.code === 'stale') {
      stalePage(res);
      return;
    }
    back(res, outcome.code);
  }) as RequestHandler);
}
