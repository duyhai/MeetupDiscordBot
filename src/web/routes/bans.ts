import express, { RequestHandler, Response } from 'express';
import { Logger } from 'tslog';

import { BAN_CSV_ERROR_TEXT, BanCsvError } from '../../lib/bans/banCsv.js';
import type { BanResultCode } from '../../lib/bans/service.js';
import { DASHBOARD_PATHS } from '../../lib/reports/dashboardPaths.js';
import { dashboardLocals } from '../dashboardRouter.js';
import { SafeHtml, html } from '../html.js';
import { sniffImageType } from '../images.js';
import { load, notFound, parseRowId } from '../pageKit.js';
import { bannedTabPath } from './bannedTab.js';
import type { DashboardPageDeps } from './dashboardPages.js';
import { renderBannedTab } from './suspensions.js';
import { leadershipOf, withDeadline } from './workspaceActions.js';

export { BAN_RESULT_MESSAGES, banResultNotice } from './bannedTab.js';

const logger = new Logger({ name: 'dashboard' });

/**
 * How long a ban POST's service call may run before the route answers
 * 'error'. With the Leadership check's 5 s it stays inside Heroku's 30 s
 * router timeout. A call still running is left to finish or fail
 * unobserved: its transaction commits or rolls back whole.
 */
export const BAN_REQUEST_DEADLINE_MS = 20_000;

/** At most this many refused rows are listed; the rest are counted. */
const IMPORT_ERRORS_SHOWN = 10;

/** True when any of the named fields came more than once (an array). */
const anyRepeated = (
  body: Record<string, unknown> | undefined,
  names: string[],
): boolean => names.some((name) => Array.isArray(body?.[name]));

/** One form field as a string; missing (or not a string) is undefined. */
function text(
  body: Record<string, unknown> | undefined,
  name: string,
): string | undefined {
  const value = body?.[name];
  return typeof value === 'string' ? value : undefined;
}

/** The import refusal's notice: fixed text per error, with its row number only. */
function importRefusalNotice(errors: BanCsvError[]): SafeHtml {
  const shown = errors.slice(0, IMPORT_ERRORS_SHOWN);
  const more = errors.length - shown.length;
  return html`<div class="note attn">
    <p>Nothing was imported.</p>
    <ul>
      ${shown.map((error) => {
        const message =
          BAN_CSV_ERROR_TEXT[error.code] ?? BAN_CSV_ERROR_TEXT.unreadable;
        return Number.isSafeInteger(error.row)
          ? html`<li>Row ${Number(error.row)}: ${message}</li>`
          : html`<li>${message}</li>`;
      })}
    </ul>
    ${more > 0 ? html`<p>…and ${more} more</p>` : ''}
  </div>`;
}

/**
 * The ban routes. Routes go on `router` itself (protectedRouteList and the
 * access matrix only see those).
 */
export function registerBanRoutes(
  router: express.Router,
  deps: Pick<
    DashboardPageDeps,
    'now' | 'bans' | 'suspensions' | 'banActions' | 'isLeadership'
  >,
): void {
  const back = (res: Response, code: BanResultCode) =>
    res.redirect(303, bannedTabPath({ result: code }));

  /**
   * The live 1.5 Leadership Team check every ban POST starts with (the
   * session's cached roles only decide what pages show). True when the
   * request may go on; otherwise it has already answered.
   */
  async function leaderOrBack(res: Response): Promise<boolean> {
    const { session } = dashboardLocals(res);
    const answer = await leadershipOf(deps.isLeadership, session.userId);
    if (answer === 'leader') {
      return true;
    }
    back(
      res,
      answer === 'not-leader' ? 'not-leadership' : 'leadership-unavailable',
    );
    return false;
  }

  /** A service call under BAN_REQUEST_DEADLINE_MS; a throw or timeout is undefined (logged by class only). */
  async function call<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await withDeadline(BAN_REQUEST_DEADLINE_MS, fn);
    } catch (error: unknown) {
      logger.warn(
        `Dashboard ban action failed: ${error instanceof Error ? error.name : 'Error'}`,
      );
      return undefined;
    }
  }

  // POST /dashboard/bans: Add a ban. CSRF, Origin, Sec-Fetch-Site and the
  // per-user rate limit are the router's unsafe-method guard.
  router.post(DASHBOARD_PATHS.bans, (async (req, res) => {
    if (!(await leaderOrBack(res))) {
      return;
    }
    const body = req.body as Record<string, unknown> | undefined;
    if (anyRepeated(body, ['memberId', 'memberName', 'bannedOn', 'notes'])) {
      back(res, 'invalid');
      return;
    }
    const { session } = dashboardLocals(res);
    const result = await call(() =>
      deps.banActions.record({
        // Always the session's user, never a form field.
        actor: session.userId,
        memberId: text(body, 'memberId'),
        memberName: text(body, 'memberName'),
        bannedOn: text(body, 'bannedOn'),
        notes: text(body, 'notes'),
        leadershipConfirmed: true,
      }),
    );
    back(res, result?.code ?? 'error');
  }) as RequestHandler);

  // POST /dashboard/bans/import: one CSV, all rows or none.
  router.post(DASHBOARD_PATHS.banImport, (async (req, res) => {
    if (!(await leaderOrBack(res))) {
      return;
    }
    const body = req.body as Record<string, unknown> | undefined;
    const csv = text(body, 'csv');
    if (anyRepeated(body, ['csv']) || csv === undefined || csv.trim() === '') {
      back(res, 'invalid');
      return;
    }
    const { session } = dashboardLocals(res);
    const result = await call(() =>
      deps.banActions.import({
        actor: session.userId,
        csv,
        leadershipConfirmed: true,
      }),
    );
    if (result === undefined) {
      back(res, 'error');
      return;
    }
    if ('errors' in result) {
      // Rendered in place, never echoing the CSV: fixed text and row
      // numbers only, and the textarea comes back empty.
      await renderBannedTab(res, deps, {
        show: 'active',
        page: 1,
        notice: importRefusalNotice(result.errors),
        leader: true,
        status: 422,
      });
      return;
    }
    back(res, result.code);
  }) as RequestHandler);

  // POST /dashboard/bans/:id/lift: the reason is required.
  router.post(DASHBOARD_PATHS.banLift, (async (req, res) => {
    const banId = parseRowId(req.params.id);
    if (banId === undefined) {
      notFound(res);
      return;
    }
    if (!(await leaderOrBack(res))) {
      return;
    }
    const body = req.body as Record<string, unknown> | undefined;
    if (anyRepeated(body, ['reason'])) {
      back(res, 'invalid');
      return;
    }
    const { session } = dashboardLocals(res);
    const result = await call(() =>
      deps.banActions.lift({
        actor: session.userId,
        banId,
        reason: text(body, 'reason'),
        leadershipConfirmed: true,
      }),
    );
    back(res, result?.code ?? 'error');
  }) as RequestHandler);

  // One photo per request, by ban id only. The type comes from the bytes;
  // anything that is not PNG, JPEG or WebP is the 404 page, never the bytes.
  router.get(DASHBOARD_PATHS.banPhoto, (async (req, res) => {
    const id = parseRowId(req.params.id);
    if (id === undefined) {
      notFound(res);
      return;
    }
    // An abandoned request (a lazy image scrolled past, a closed tab): do
    // not queue it on the dashboard pool.
    if (req.socket?.destroyed) {
      return;
    }
    const loaded = await load(res, 'The photo', async () =>
      (await deps.bans()).getPhoto(id),
    );
    if (!loaded.ok) {
      return;
    }
    const bytes = loaded.value;
    const type = Buffer.isBuffer(bytes) ? sniffImageType(bytes) : undefined;
    if (!Buffer.isBuffer(bytes) || type === undefined) {
      notFound(res);
      return;
    }
    // As the identity thumb route: no-store and nosniff also come from
    // baseSecurityHeaders, restated so this route cannot lose them;
    // setHeader so Express adds no charset.
    res.statusCode = 200;
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.end(bytes);
  }) as RequestHandler);
}
