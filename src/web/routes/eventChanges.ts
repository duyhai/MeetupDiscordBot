import dayjs from 'dayjs';
import express, { RequestHandler } from 'express';
import { Logger } from 'tslog';

import {
  EventAuditRefusal,
  EventAuditRequestResult,
} from '../../lib/eventAudit/job.js';
import {
  EVENT_CHANGE_KINDS,
  EventChange,
  EventChangeKind,
  EventHost,
  EventSnapshot,
  isEventChangeKind,
} from '../../lib/eventAudit/types.js';
import {
  DASHBOARD_PATHS,
  dashboardPath,
  eventHistoryPath,
} from '../../lib/reports/dashboardPaths.js';
import { GROUP_TIMEZONE } from '../../lib/reports/period.js';
import { UNCONFIRMED_ALERT_AFTER } from '../../lib/eventAudit/run.js';
import {
  EventAuditRun,
  EventHistory,
  EventState,
  PostgresEventAuditRepository,
  parseHosts,
} from '../../lib/repositories/postgresEventAuditRepository.js';
import { dashboardLocals } from '../dashboardRouter.js';
import {
  SafeHtml,
  html,
  localUrl,
  memberText,
  pageLink,
  safeHref,
} from '../html.js';
import { eventLink, memberLink } from '../links.js';
import { dashboardPage, load, notFound, pacificDateTime } from '../pageKit.js';
import { PAGE_SIZE } from '../paging.js';
import { CacheTimeoutError } from '../timedCache.js';

const logger = new Logger({ name: 'dashboard' });

const WHAT = 'Event changes';
const EVENT_ID = /^[0-9]{1,20}$/;
/** At most 18 digits, so it always fits a bigint. */
const CHANGE_ID = /^[0-9]{1,18}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Snapshot rows on the history page. */
const SNAPSHOTS_SHOWN = 200;

/** The page's reads: never a write. */
export type EventAuditPageReader = Pick<
  PostgresEventAuditRepository,
  'listChanges' | 'eventHistory' | 'latestRun' | 'unconfirmable'
>;

/** The event changes pages' dependencies, on DashboardPageDeps. */
export interface EventChangesDeps {
  /** Rejects when Postgres cannot answer. */
  eventAudit: () => Promise<EventAuditPageReader>;
  /** Snapshot now (requestEventAudit); 'unavailable' while the bot is starting. May reject. */
  snapshotNow: (
    requestedBy: string,
  ) => Promise<EventAuditRequestResult | { status: 'unavailable' }>;
}

export const KIND_LABELS: Record<EventChangeKind, string> = {
  created: 'Created',
  cancelled: 'Cancelled',
  deleted: 'Deleted',
  host_changed: 'Hosts changed',
  start_moved: 'Start moved',
  title_changed: 'Title changed',
  rsvp_drop: 'RSVPs dropped',
  rsvps_closed: 'RSVPs closed',
};

export type SnapshotCode =
  EventAuditRefusal | 'started' | 'error' | 'unavailable';

/** Fixed text per code. Nothing from the request is ever shown. */
export const SNAPSHOT_MESSAGES = {
  started:
    'Taking a snapshot now. Reload this page in a minute; deletions, cancellations and host changes are also posted to #meetup-bot-alerts.',
  'quiet-hour':
    'Snapshots are not taken between 17:45 and 19:00 UTC while the daily identity sweep runs. Try again after 19:00 UTC.',
  'identity-sweep':
    'The daily identity sweep is still running. Try again in a few minutes.',
  busy: 'A report build or snapshot is already running. Try again when it finishes.',
  cooldown: 'A snapshot was taken in the last 2 minutes. Try again shortly.',
  'bad-requester': 'Only a signed-in staff member can take a snapshot.',
  error: 'The snapshot could not be started. Please try again later.',
  unavailable: 'Snapshots are unavailable right now. Please try again later.',
} as const satisfies Record<SnapshotCode, string>;

const isSnapshotCode = (code: unknown): code is SnapshotCode =>
  typeof code === 'string' && Object.hasOwn(SNAPSHOT_MESSAGES, code);

function resultNotice(code: unknown): SafeHtml | '' {
  if (!isSnapshotCode(code)) {
    return '';
  }
  return code === 'started'
    ? html`<p class="note info">${SNAPSHOT_MESSAGES[code]}</p>`
    : html`<p class="note attn">${SNAPSHOT_MESSAGES[code]}</p>`;
}

/** The page's query, validated. Every value passed its pattern, or is undefined. */
interface ChangesQuery {
  kind?: EventChangeKind;
  host?: string;
  from?: string;
  to?: string;
  before?: string;
}

function matching(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

/** YYYY-MM-DD naming a real calendar day. */
function calendarDay(value: unknown): string | undefined {
  const day = matching(value, DAY);
  if (day === undefined) {
    return undefined;
  }
  const [, y, m, d] = DAY.exec(day) ?? [];
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return date.toISOString().slice(0, 10) === day ? day : undefined;
}

/** Midnight Pacific at the start of `day`, `offsetDays` later. */
function pacificMidnight(day: string, offsetDays = 0): Date {
  const shifted = dayjs
    .utc(`${day}T00:00:00Z`)
    .add(offsetDays, 'day')
    .format('YYYY-MM-DD');
  return dayjs.tz(`${shifted}T00:00:00`, GROUP_TIMEZONE).toDate();
}

function parseQuery(query: Record<string, unknown>): ChangesQuery {
  return {
    kind: isEventChangeKind(query.kind) ? query.kind : undefined,
    host: matching(query.host, EVENT_ID),
    from: calendarDay(query.from),
    to: calendarDay(query.to),
    before: matching(query.before, CHANGE_ID),
  };
}

const filterParams = (q: ChangesQuery) => ({
  kind: q.kind,
  host: q.host,
  from: q.from,
  to: q.to,
});

const PATH = dashboardPath(DASHBOARD_PATHS.eventChanges);

function hostsCell(hosts: EventHost[]): SafeHtml {
  if (hosts.length === 0) {
    return html`<span class="muted">unknown hosts</span>`;
  }
  return html`${hosts.map(
    (h, i) =>
      html`${i > 0 ? ', ' : ''}${memberLink({ id: h.id, name: h.name })}
        <a
          class="muted"
          href="${pageLink(PATH, { host: h.id })}"
          title="Only this host"
          >(only)</a
        >`,
  )}`;
}

const hostNames = (value: unknown): string =>
  parseHosts((value as { hosts?: unknown } | null)?.hosts)
    .map((h) => h.name || `member ${h.id}`)
    .join(', ') || '(none)';

function asText(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function asCount(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : '?';
}
function dateText(v: unknown): string {
  return typeof v === 'string' && dayjs(v).isValid() ? pacificDateTime(v) : '?';
}

/** Old → new in fixed wording per kind; every member-written piece escaped. */
function detailsCell(c: EventChange): SafeHtml {
  const old = c.oldValue as Record<string, unknown> | null;
  const next = c.newValue as Record<string, unknown> | null;
  switch (c.kind) {
    case 'created':
      return html`New event`;
    case 'cancelled':
      return html`${asText(old?.status) || '?'} → ${asText(next?.status) || '?'}`;
    case 'deleted':
      return html`Gone from Meetup`;
    case 'host_changed':
      return html`${memberText(hostNames(old))} → ${memberText(hostNames(next))}`;
    case 'start_moved':
      return html`${dateText(old?.startAt)} → ${dateText(next?.startAt)}`;
    case 'title_changed':
      return html`“${memberText(asText(old?.title))}” →
      “${memberText(asText(next?.title))}”`;
    case 'rsvp_drop':
      return html`${asCount(old?.rsvpYes)} → ${asCount(next?.rsvpYes)} going`;
    case 'rsvps_closed':
      return html`RSVPs closed`;
  }
}

function rsvpCell(rsvpYes: number | null, waitlist: number | null): SafeHtml {
  if (rsvpYes === null) {
    return html`<span class="muted">unknown</span>`;
  }
  return html`${rsvpYes}
  going${waitlist === null ? '' : `, ${waitlist} waiting`}`;
}

function eventCell(c: {
  eventId: string;
  title: string;
  eventUrl: string | null;
}): SafeHtml {
  const history = eventHistoryPath(c.eventId);
  return html`${eventLink({ title: c.title, eventUrl: c.eventUrl ?? '' })}${
    history ? html`<br /><a href="${localUrl(history)}">History</a>` : ''
  }`;
}

function changeRow(c: EventChange): SafeHtml {
  return html`<tr>
    <td data-label="Detected (Pacific)">${pacificDateTime(c.detectedAt)}</td>
    <td data-label="Change">
      <span
        class="badge ${c.kind === 'deleted' || c.kind === 'cancelled' ? 'attn' : 'neutral'}"
        >${KIND_LABELS[c.kind]}</span
      >
    </td>
    <td data-label="Event">${eventCell(c)}</td>
    <td data-label="Start">${pacificDateTime(c.startAt)}</td>
    <td data-label="Hosts">${hostsCell(c.hosts)}</td>
    <td data-label="Details">${detailsCell(c)}</td>
    <td data-label="RSVPs">${rsvpCell(c.rsvpYes, c.waitlist)}</td>
  </tr>`;
}

function kindOption(
  value: EventChangeKind | '',
  label: string,
  current: EventChangeKind | undefined,
): SafeHtml {
  return (current ?? '') === value
    ? html`<option value="${value}" selected>${label}</option>`
    : html`<option value="${value}">${label}</option>`;
}

function filterForm(q: ChangesQuery): SafeHtml {
  return html`<form method="get" action="${localUrl(PATH)}" class="filters">
    <label
      >Change
      <select name="kind">
        ${kindOption('', 'All', q.kind)}
        ${EVENT_CHANGE_KINDS.map((k) => kindOption(k, KIND_LABELS[k], q.kind))}
      </select>
    </label>
    <label
      >Host (Meetup id)
      <input
        name="host"
        value="${q.host ?? ''}"
        inputmode="numeric"
        maxlength="20"
        autocomplete="off"
      />
    </label>
    <label
      >From <input type="date" name="from" value="${q.from ?? ''}"
    /></label>
    <label>To <input type="date" name="to" value="${q.to ?? ''}" /></label>
    <button type="submit">Filter</button>
  </form>`;
}

function pager(q: ChangesQuery, rows: EventChange[]): SafeHtml {
  const last = rows[rows.length - 1];
  const older =
    rows.length === PAGE_SIZE && last
      ? html`<a
          href="${pageLink(PATH, { ...filterParams(q), before: String(last.id) })}"
          >Older changes</a
        >`
      : '';
  const newest =
    q.before !== undefined
      ? html`<a href="${pageLink(PATH, filterParams(q))}">Newest changes</a>`
      : '';
  return html`<nav class="pager" aria-label="Older and newer changes">
    ${newest} ${older}
  </nav>`;
}

function changesTable(q: ChangesQuery, rows: EventChange[]): SafeHtml {
  if (rows.length === 0) {
    return html`<p>No event changes match these filters.</p>
      ${pager(q, rows)}`;
  }
  return html`<table class="stack">
      <thead>
        <tr>
          <th>Detected (Pacific)</th>
          <th>Change</th>
          <th>Event</th>
          <th>Start</th>
          <th>Hosts</th>
          <th>Details</th>
          <th>RSVPs</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(changeRow)}
      </tbody>
    </table>
    ${pager(q, rows)}`;
}

function lastRunText(run: EventAuditRun | undefined): SafeHtml {
  if (run === undefined) {
    return html`No snapshot yet.`;
  }
  return html`Last snapshot: ${pacificDateTime(run.startedAt)}
  (${run.outcome === 'failed' ? 'failed' : 'saved'}${
    run.listed === null ? '' : `, ${run.listed} events listed`
  }).`;
}

/** Events that left the listing but whose confirmation keeps failing: they may be gone. */
function unconfirmedNote(states: EventState[]): SafeHtml | '' {
  if (states.length === 0) {
    return '';
  }
  return html`<div class="note attn">
    <p>
      ${states.length === 1 ? 'One event has' : `${states.length} events have`}
      left Meetup's upcoming list, but the read that would confirm a deletion
      has failed ${UNCONFIRMED_ALERT_AFTER} or more runs in a row. They may be
      gone.
    </p>
    <ul>
      ${states.map(
        (s) =>
          html`<li>
            ${eventCell({
              eventId: s.eventId,
              title: s.latest.title,
              eventUrl: null,
            })}
            (${s.unconfirmedRuns} runs)
          </li>`,
      )}
    </ul>
  </div>`;
}

function snapshotCard(
  run: EventAuditRun | undefined,
  unconfirmed: EventState[],
  csrf: string,
  notice: SafeHtml | '',
): SafeHtml {
  return html`<div class="card">
    <h1>Event changes</h1>
    <p class="muted">
      Every upcoming Meetup event is snapshotted hourly; deletions are confirmed
      by a direct read before they are recorded. Dates are Pacific; the "To" day
      is included.
    </p>
    ${notice} ${unconfirmedNote(unconfirmed)}
    <form
      method="post"
      action="${localUrl(dashboardPath(DASHBOARD_PATHS.eventSnapshot))}"
    >
      <input type="hidden" name="_csrf" value="${csrf}" />
      <p>${lastRunText(run)}</p>
      <button type="submit" class="ghost">Snapshot now</button>
    </form>
  </div>`;
}

function snapshotRow(s: EventSnapshot): SafeHtml {
  return html`<tr>
    <td data-label="Taken (Pacific)">${pacificDateTime(s.takenAt)}</td>
    <td data-label="Status">${s.status}</td>
    <td data-label="Title">${memberText(s.title || '(untitled)')}</td>
    <td data-label="Start">${pacificDateTime(s.startAt)}</td>
    <td data-label="Hosts">${hostsCell(s.hosts)}</td>
    <td data-label="RSVPs">
      ${rsvpCell(s.rsvpYes, s.waitlist)}${
        s.rsvpsClosed === true ? ' (closed)' : ''
      }
    </td>
  </tr>`;
}

function historyBody(history: EventHistory): SafeHtml {
  const { state } = history;
  const { latest } = state;
  const meetup =
    latest.eventUrl === null ? undefined : safeHref(latest.eventUrl);
  return html`<div class="card">
      <h1>${memberText(latest.title || '(untitled event)')}</h1>
      <p>
        ${
          state.deletedAt !== null
            ? html`<span class="badge attn">Deleted</span> on
                ${pacificDateTime(state.deletedAt)}`
            : html`<span class="badge neutral">${latest.status}</span>`
        }
      </p>
      <p>
        Start ${pacificDateTime(latest.startAt)}. Hosts:
        ${hostsCell(latest.hosts)}. RSVPs at the last snapshot:
        ${rsvpCell(latest.rsvpYes, latest.waitlist)}.
      </p>
      <p>
        First seen ${pacificDateTime(state.firstSeenAt)}, last seen
        ${pacificDateTime(state.lastSeenAt)}.
        ${
          meetup && state.deletedAt === null
            ? html`<a href="${meetup}" rel="noopener noreferrer" target="_blank"
                >Meetup event</a
              >`
            : ''
        }
        <a href="${localUrl(PATH)}">All event changes</a>
      </p>
    </div>
    <div class="card">
      <h2>Changes</h2>
      ${
        history.changes.length === 0
          ? html`<p class="muted">None recorded.</p>`
          : html`<table class="stack">
              <thead>
                <tr>
                  <th>Detected (Pacific)</th>
                  <th>Change</th>
                  <th>Event</th>
                  <th>Start</th>
                  <th>Hosts</th>
                  <th>Details</th>
                  <th>RSVPs</th>
                </tr>
              </thead>
              <tbody>
                ${history.changes.map(changeRow)}
              </tbody>
            </table>`
      }
    </div>
    <div class="card">
      <h2>Snapshots</h2>
      <table class="stack">
        <thead>
          <tr>
            <th>Taken (Pacific)</th>
            <th>Status</th>
            <th>Title</th>
            <th>Start</th>
            <th>Hosts</th>
            <th>RSVPs</th>
          </tr>
        </thead>
        <tbody>
          ${history.snapshots.map(snapshotRow)}
        </tbody>
      </table>
    </div>`;
}

/**
 * GET /dashboard/events, GET /dashboard/events/:eventId (every
 * staff member) and POST /dashboard/events/snapshot. CSRF, Origin,
 * Sec-Fetch-Site and the per-user action rate limit are the router's
 * unsafe-method guard, which runs before this handler.
 */
export function registerEventChangeRoutes(
  router: express.Router,
  deps: Pick<EventChangesDeps, 'eventAudit' | 'snapshotNow'>,
): void {
  router.get(DASHBOARD_PATHS.eventChanges, (async (req, res) => {
    const q = parseQuery(req.query);
    const loaded = await load(res, WHAT, async () => {
      const reader = await deps.eventAudit();
      const filter = {
        ...(q.kind === undefined ? {} : { kind: q.kind }),
        ...(q.host === undefined ? {} : { hostId: q.host }),
        ...(q.from === undefined ? {} : { from: pacificMidnight(q.from) }),
        // Inclusive day: up to the next day's Pacific midnight.
        ...(q.to === undefined ? {} : { to: pacificMidnight(q.to, 1) }),
        ...(q.before === undefined ? {} : { beforeId: Number(q.before) }),
      };
      const [rows, run, unconfirmed] = await Promise.all([
        reader.listChanges(filter, PAGE_SIZE),
        reader.latestRun(),
        reader.unconfirmable(UNCONFIRMED_ALERT_AFTER),
      ]);
      return { rows, run, unconfirmed };
    });
    if (!loaded.ok) {
      return;
    }
    const { session } = dashboardLocals(res);
    dashboardPage(res, {
      title: 'Event changes',
      body: html`${snapshotCard(
          loaded.value.run,
          loaded.value.unconfirmed,
          session.csrfToken,
          resultNotice(req.query.result),
        )}
        <div class="card">
          ${filterForm(q)} ${changesTable(q, loaded.value.rows)}
        </div>`,
    });
  }) as RequestHandler);

  router.post(DASHBOARD_PATHS.eventSnapshot, (async (_req, res) => {
    const { session } = dashboardLocals(res);
    let code: SnapshotCode;
    try {
      const result = await deps.snapshotNow(session.userId);
      code = isSnapshotCode(result.status) ? result.status : 'error';
      if (result.status === 'started') {
        result.done
          .then((outcome) =>
            logger.info(
              `Dashboard snapshot finished: ${outcome.ok ? 'saved' : 'failed'}`,
            ),
          )
          .catch(() => undefined);
      }
    } catch (error: unknown) {
      if (error instanceof CacheTimeoutError) {
        throw error; // Redis is not answering: the router's 503
      }
      logger.warn(
        `Dashboard snapshot could not start: ${error instanceof Error ? error.name : 'Error'}`,
      );
      code = 'error';
    }
    res.redirect(303, `${PATH}?result=${code}`);
  }) as RequestHandler);

  router.get(DASHBOARD_PATHS.eventHistory, (async (req, res) => {
    const { eventId } = req.params;
    if (typeof eventId !== 'string' || !EVENT_ID.test(eventId)) {
      notFound(res);
      return;
    }
    const loaded = await load(res, WHAT, async () =>
      (await deps.eventAudit()).eventHistory(eventId, SNAPSHOTS_SHOWN),
    );
    if (!loaded.ok) {
      return;
    }
    if (loaded.value === undefined) {
      notFound(res);
      return;
    }
    dashboardPage(res, {
      title: 'Event history',
      body: historyBody(loaded.value),
    });
  }) as RequestHandler);
}
