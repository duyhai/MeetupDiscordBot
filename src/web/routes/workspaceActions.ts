import express, { RequestHandler, Response } from 'express';
import { Logger } from 'tslog';

import {
  DASHBOARD_PATHS,
  monthPath,
  workspaceRowPath,
} from '../../lib/reports/dashboardPaths.js';
import { Period } from '../../lib/reports/period.js';
import {
  LeadershipRefusal,
  WorkspaceActionCode,
  WorkspaceActionResult,
  WorkspaceSyncCode,
  leadershipRefusalEntry,
  postWithoutWaiting,
  validateActionFields,
} from '../../lib/workspace/service.js';
import {
  TRANSITION_RULES,
  isLeadershipOnly,
  normalizeNote,
} from '../../lib/workspace/transitions.js';
import {
  WORKSPACE_ACTIONS,
  WorkspaceAction,
} from '../../lib/workspace/types.js';
import { dashboardLocals } from '../dashboardRouter.js';
import { SafeHtml, html, localUrl } from '../html.js';
import {
  dashboardPage,
  notFound,
  parseRowId,
  parseWorkspaceMonth,
} from '../pageKit.js';
import { FixedWindowLimiter } from '../rateLimit.js';
import type { AccessCheck } from '../roleGate.js';
import type { DashboardPageDeps } from './dashboardPages.js';

const logger = new Logger({ name: 'dashboard' });

/**
 * At most one Leadership refusal post per user per this window, like the
 * router's refusedAuditLimiter: a Moderator (or a script) repeating a
 * refused POST cannot flood the moderation log. Every refusal still
 * answers with its redirect. In-process, so per dyno.
 */
export const WORKSPACE_REFUSAL_POST_WINDOW_MS = 60_000;

/**
 * How long an action's service call or a sync may run before the route
 * answers 'error'. With the Leadership check's deadline it stays inside
 * Heroku's 30 s router timeout (H12). A call still running is left to
 * finish or fail unobserved: its transaction commits or rolls back whole,
 * and a retry after a late commit is refused as stale.
 */
export const WORKSPACE_REQUEST_DEADLINE_MS = 20_000;

/** How long the live Leadership check may take; past it, Discord counts as unreachable. */
export const LEADERSHIP_CHECK_DEADLINE_MS = 5_000;

export class WorkspaceDeadlineError extends Error {
  constructor(ms: number) {
    super(`workspace request took over ${ms} ms`);
    this.name = 'WorkspaceDeadlineError';
  }
}

/**
 * fn's answer, or a WorkspaceDeadlineError after `ms`. The timer is unref'd
 * and always cleared. Promise.race subscribes to the work, so a rejection
 * after the deadline is still handled (never an unhandled rejection).
 */
export async function withDeadline<T>(
  ms: number,
  fn: () => Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const work = fn();
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new WorkspaceDeadlineError(ms)), ms);
      timer.unref();
    });
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** The live Leadership check's answer for a page (see leadershipOf). */
export type LeadershipAnswer = 'leader' | 'not-leader' | 'unreachable';

/**
 * The live 1.5 Leadership Team check for a GET page, under
 * LEADERSHIP_CHECK_DEADLINE_MS. A failure or timeout is 'unreachable', which
 * pages treat as "not Leadership" (fail closed). It only decides what a
 * page shows; each POST runs its own check, which is the authority.
 */
export async function leadershipOf(
  isLeadership: AccessCheck,
  userId: string,
): Promise<LeadershipAnswer> {
  try {
    return (await withDeadline(LEADERSHIP_CHECK_DEADLINE_MS, () =>
      isLeadership(userId),
    )) === true
      ? 'leader'
      : 'not-leader';
  } catch (error: unknown) {
    logger.warn(
      `Dashboard Leadership check failed: ${error instanceof Error ? error.name : 'Error'}`,
    );
    return 'unreachable';
  }
}

/**
 * Every code a workspace POST can send back in `?result=`. 'stale' and
 * 'not-found' are answered in place (409, 404) and never redirect.
 * 'suspension-overlap' is the service's 'already-suspended' without a
 * record to link; 'out-of-order' goes back to the confirm page, which reads
 * the member's records and sets its earliest date; 'not-leadership' and
 * 'leadership-unavailable' are the live Leadership check's refusals.
 */
export type WorkspaceResultCode =
  | Exclude<WorkspaceActionCode, 'stale' | 'not-found'>
  | 'suspension-overlap'
  | 'not-leadership'
  | 'leadership-unavailable'
  | 'error'
  | WorkspaceSyncCode;

/** Fixed text per code. Nothing from the request or the database is ever shown. */
export const WORKSPACE_RESULT_MESSAGES = {
  done: 'Saved.',
  invalid:
    'That request could not be understood. Reload the page and try again.',
  'not-allowed':
    'That action is not available for this card right now. Reload the page.',
  'wrong-classification': 'That action does not apply to this kind of case.',
  'not-in-report':
    'This member is no longer in the latest report, so they cannot be warned or suspended from here.',
  'note-required': 'Add a note saying why, then try again.',
  'note-too-long':
    'That note is too long (notes up to 2000 characters, void reasons up to 500).',
  'no-earlier-status': 'This card has no earlier status to go back to.',
  'already-suspended':
    'This member already has a suspension dated in this month or the next. Link it from the card instead of recording another.',
  'suspension-overlap':
    'This member already has a live suspension covering some of those days. Nothing was recorded.',
  // The confirm page names the date from the member's own records.
  'out-of-order':
    "This member already has a later suspension. A new one can't be dated before it. Nothing was recorded.",
  'record-unavailable':
    "That suspension record cannot be linked or voided here (voided, someone else's, or already on another card).",
  'bad-date':
    'Pick a suspension date from the first of the month through today.',
  banned: 'This member is banned.',
  'not-leadership':
    'Only the 1.5 Leadership Team can record, link or void a suspension. Nothing was changed.',
  'leadership-unavailable':
    'Discord could not be reached to check your role. Nothing was changed; try again in a minute.',
  error: 'That did not save. Please try again in a minute.',
  synced: 'The workspace was updated from the stored report.',
  current: 'The workspace already matches the stored report.',
  older: 'A newer report is already in the workspace.',
  'no-report':
    'This month has no stored no-show report yet. Use "Refresh from Meetup" first.',
  malformed:
    'The stored report could not be read. The build alerts have the details.',
  'not-eligible': 'This month has no workspace.',
} as const satisfies Record<WorkspaceResultCode, string>;

const isResultCode = (code: unknown): code is WorkspaceResultCode =>
  typeof code === 'string' && Object.hasOwn(WORKSPACE_RESULT_MESSAGES, code);

/** The codes that report something done or already in order: a blurple notice; every other code needs a person (coral). */
const WORKSPACE_RESULT_INFO: ReadonlySet<WorkspaceResultCode> = new Set([
  'done',
  'synced',
  'current',
  'older',
]);

/** Fixed text for a known code; anything else in the query renders nothing (never echoed). */
export function workspaceResultNotice(code: unknown): SafeHtml | '' {
  if (!isResultCode(code)) {
    return '';
  }
  return WORKSPACE_RESULT_INFO.has(code)
    ? html`<p class="note info">${WORKSPACE_RESULT_MESSAGES[code]}</p>`
    : html`<p class="note attn">${WORKSPACE_RESULT_MESSAGES[code]}</p>`;
}

/** One form field as a string; a missing or repeated field (an array) is undefined. */
function field(
  body: Record<string, unknown> | undefined,
  name: string,
): string | undefined {
  const value = body?.[name];
  return typeof value === 'string' ? value : undefined;
}

const isAction = (value: unknown): value is WorkspaceAction =>
  typeof value === 'string' &&
  (WORKSPACE_ACTIONS as readonly string[]).includes(value);

/**
 * The form checks that need no database: a code to refuse with, or
 * undefined when the service may run. Version, date and record id are the
 * service's own validator; the service runs it again.
 */
function formRefusal(
  action: WorkspaceAction,
  body: Record<string, unknown> | undefined,
  period: Period,
  now: Date,
): WorkspaceResultCode | undefined {
  const checked = validateActionFields(
    action,
    {
      version: field(body, 'version'),
      date: field(body, 'date'),
      recordId: field(body, 'recordId'),
    },
    period,
    now,
  );
  if (checked.ok === false) {
    return checked.code;
  }
  const rule = TRANSITION_RULES[action];
  const note = field(body, 'note');
  if (
    rule.note !== 'ignored' &&
    note !== undefined &&
    Array.from(normalizeNote(note)).length > rule.noteMax
  ) {
    return 'note-too-long';
  }
  return undefined;
}

/** What the service's answer redirects as. */
function resultCode(result: WorkspaceActionResult): WorkspaceResultCode {
  if (result.code === 'already-suspended') {
    // With a record to link: the card offers it. Without: an overlap.
    return result.existing ? 'already-suspended' : 'suspension-overlap';
  }
  return isResultCode(result.code) ? result.code : 'error';
}

function stalePage(res: Response, period: Period): void {
  dashboardPage(res, {
    title: 'Card changed',
    status: 409,
    body: html`<div class="card">
      <h1>Someone just updated this card</h1>
      <p>
        Nothing was saved. Reload the workspace to see the change, then try
        again.
      </p>
      <p>
        <a href="${localUrl(monthPath(DASHBOARD_PATHS.workspaceMonth, period))}"
          >Reload the workspace</a
        >
      </p>
    </div>`,
  });
}

/**
 * POST /dashboard/no-shows/:period/rows/:rowId (one row action, `action` in
 * the form) and POST /dashboard/no-shows/:period/sync. CSRF, Origin,
 * Sec-Fetch-Site and the per-user action rate limit are the router's
 * unsafe-method guard, which runs before these handlers; nothing here adds
 * its own. Recording, linking and voiding a suspension also need the 1.5
 * Leadership Team role, asked of Discord live on every request.
 */
export function registerWorkspaceActionRoutes(
  router: express.Router,
  deps: Pick<DashboardPageDeps, 'now' | 'workspaceActions' | 'isLeadership'>,
): void {
  const refusalPosts = new FixedWindowLimiter(
    1,
    WORKSPACE_REFUSAL_POST_WINDOW_MS,
    () => deps.now().getTime(),
  );
  router.post(DASHBOARD_PATHS.workspaceRow, (async (req, res) => {
    const now = deps.now();
    const period = parseWorkspaceMonth(req.params.period, now);
    const rowId = parseRowId(req.params.rowId);
    if (period === undefined || rowId === undefined) {
      notFound(res);
      return;
    }
    const back = (code: WorkspaceResultCode) =>
      res.redirect(
        303,
        `${monthPath(DASHBOARD_PATHS.workspaceMonth, period)}?result=${code}`,
      );
    const body = req.body as Record<string, unknown> | undefined;
    const action = field(body, 'action');
    if (!isAction(action)) {
      back('invalid');
      return;
    }
    const { session } = dashboardLocals(res);
    let leadershipConfirmed = false;
    if (isLeadershipOnly(action)) {
      // Live, on every request: the session's cached roles (which only
      // decide what the page shows) are never the authority here.
      let why: LeadershipRefusal | undefined;
      try {
        why =
          (await withDeadline(LEADERSHIP_CHECK_DEADLINE_MS, () =>
            deps.isLeadership(session.userId),
          )) === true
            ? undefined
            : 'not-leadership';
      } catch (error: unknown) {
        logger.warn(
          `Dashboard Leadership check failed: ${error instanceof Error ? error.name : 'Error'}`,
        );
        why = 'discord-unreachable';
      }
      if (why !== undefined) {
        // Nothing is written: the moderation log is this refusal's only
        // audit, throttled per user.
        if (refusalPosts.take(session.userId)) {
          postWithoutWaiting(
            deps.workspaceActions,
            leadershipRefusalEntry(period, rowId, action, session.userId, why),
          );
        }
        back(
          why === 'not-leadership'
            ? 'not-leadership'
            : 'leadership-unavailable',
        );
        return;
      }
      leadershipConfirmed = true;
    }
    // The confirm step: a record request that did not come from the
    // confirm page shows it instead.
    if (action === 'record_suspension' && field(body, 'confirm') !== 'yes') {
      res.redirect(303, workspaceRowPath(period, rowId, 'suspend'));
      return;
    }
    const refusal = formRefusal(action, body, period, now);
    if (refusal !== undefined) {
      back(refusal);
      return;
    }
    let result: WorkspaceActionResult;
    try {
      result = await withDeadline(WORKSPACE_REQUEST_DEADLINE_MS, () =>
        deps.workspaceActions.perform({
          period,
          rowId,
          // Always the session's user, never a form field.
          actor: session.userId,
          action,
          version: field(body, 'version'),
          note: field(body, 'note'),
          date: field(body, 'date'),
          recordId: field(body, 'recordId'),
          // Set only after this request's own live check passed.
          ...(leadershipConfirmed && { leadershipConfirmed: true }),
        }),
      );
    } catch (error: unknown) {
      logger.warn(
        `Dashboard workspace action failed: ${error instanceof Error ? error.name : 'Error'}`,
      );
      back('error');
      return;
    }
    if (result.code === 'stale') {
      stalePage(res, period);
      return;
    }
    if (result.code === 'not-found') {
      notFound(res);
      return;
    }
    if (result.code === 'out-of-order') {
      // Only the fixed code: the confirm page finds the record itself.
      res.redirect(
        303,
        `${workspaceRowPath(period, rowId, 'suspend')}?result=out-of-order`,
      );
      return;
    }
    back(resultCode(result));
  }) as RequestHandler);

  router.post(DASHBOARD_PATHS.workspaceSync, (async (req, res) => {
    const period = parseWorkspaceMonth(req.params.period, deps.now());
    if (period === undefined) {
      notFound(res);
      return;
    }
    let code: WorkspaceResultCode;
    try {
      const synced = await withDeadline(WORKSPACE_REQUEST_DEADLINE_MS, () =>
        deps.workspaceActions.sync(period),
      );
      code = isResultCode(synced) ? synced : 'error';
    } catch (error: unknown) {
      logger.warn(
        `Dashboard workspace sync failed: ${error instanceof Error ? error.name : 'Error'}`,
      );
      code = 'error';
    }
    res.redirect(
      303,
      `${monthPath(DASHBOARD_PATHS.workspaceMonth, period)}?result=${code}`,
    );
  }) as RequestHandler);
}
