import dayjs from 'dayjs';
import express, { RequestHandler, Response } from 'express';
import { Logger } from 'tslog';

import {
  COMMUNITY_HOST_PREFIX,
  GUEST_HOST_MEETUP_BLACKLIST,
} from '../../constants.js';
import { LogEntry, alertText } from '../../lib/helpers/discordLogger.js';
import {
  HostEvent,
  countedOnly,
  pacificDay,
} from '../../lib/hosts/hostEvents.js';
import {
  CANDIDATE_WINDOW_MONTHS,
  CandidateList,
  HostSeen,
  PROMOTION_MIN_EVENTS,
  PromotionCandidate,
} from '../../lib/hosts/promotionCandidates.js';
import {
  DASHBOARD_BASE,
  DASHBOARD_PATHS,
} from '../../lib/reports/dashboardPaths.js';
import {
  PROMOTION_REASON_MAX,
  PromotedHost,
  PromotionChange,
  PromotionEvent,
} from '../../lib/repositories/postgresPromotedHostRepository.js';
import { dashboardLocals } from '../dashboardRouter.js';
import { heatMapYear } from '../host/heatMap.js';
import { SafeHtml, html, localUrl, memberText, safeHref } from '../html.js';
import { discordUserLink, eventLink } from '../links.js';
import {
  dashboardPage,
  load,
  loadOptional,
  notFound,
  pacificDate,
} from '../pageKit.js';
import { FixedWindowLimiter } from '../rateLimit.js';
import {
  LeadershipAnswer,
  WORKSPACE_REFUSAL_POST_WINDOW_MS,
  leadershipOf,
} from './workspaceActions.js';
import type { DashboardPageDeps } from './dashboardPages.js';

const logger = new Logger({ name: 'dashboard' });

const MEETUP_ID = /^[1-9][0-9]{0,19}$/;
/** The version the leader saw; 0 when there was no row. */
const SEEN_VERSION = /^(0|[1-9][0-9]{0,8})$/;
/** Past events listed under the heat map when no day is picked. */
const EVENTS_SHOWN = 20;
/**
 * How long the promotion page waits for the candidates. Cold, they are a
 * year of past events and one count per host; the read goes on in the
 * background (production caches it), so a reload a minute later has them.
 */
const CANDIDATES_DEADLINE_MS = 6_000;

/** The promoted-hosts store's reads and its one write. */
export interface PromotionStore {
  list: () => Promise<PromotedHost[]>;
  get: (meetupMemberId: string) => Promise<PromotedHost | undefined>;
  history: (
    meetupMemberId: string,
    limit?: number,
  ) => Promise<PromotionEvent[]>;
  change: (
    action: 'promote' | 'demote',
    meetupMemberId: string,
    seenVersion: number,
    actorDiscordId: string,
    reason: string,
  ) => Promise<PromotionChange>;
}

/** The promotion pages' dependencies, on DashboardPageDeps. */
export interface HostPromotionDeps {
  /** Rejects when Postgres cannot answer. */
  promotedHosts: () => Promise<PromotionStore>;
  /**
   * Regular hosts meeting the promotion criteria (promotionCandidates.ts),
   * and every host seen (for names). Promoted hosts are not left out here;
   * the page leaves out the active ones. Slow when cold.
   */
  promotionCandidates: () => Promise<CandidateList>;
  /** One member's PAST hosted events, newest first (organizer read). */
  hostPastEvents: (meetupMemberId: string) => Promise<HostEvent[]>;
  /** Ends the member's host-dashboard sessions, so a new tier applies at once. */
  revokeHostSessions: (meetupMemberId: string) => Promise<void>;
  /** #meetup-bot-alerts: plain, no pings. */
  hostAlert: (entry: LogEntry) => Promise<unknown>;
}

/** Every code a promotion POST can send back in `?result=`. Fixed text only. */
export const PROMOTION_RESULT_MESSAGES = {
  promoted:
    'Promoted. Their next events publish without approval, titled ' +
    `"${COMMUNITY_HOST_PREFIX}…". They were signed out of the host dashboard ` +
    'so it takes effect now.',
  demoted:
    'Demoted. Their next events go through approval again; events already ' +
    'published stay. They were signed out of the host dashboard so it takes ' +
    'effect now.',
  'promoted-no-signout':
    'Promoted. Their next events publish without approval, titled ' +
    `"${COMMUNITY_HOST_PREFIX}…". They could not be signed out of the host ` +
    'dashboard, so it applies within 10 minutes.',
  'demoted-no-signout':
    'Demoted. Their next events go through approval again; events already ' +
    'published stay. They could not be signed out of the host dashboard, so ' +
    'it applies within 10 minutes.',
  blacklisted:
    'They are on the Guest Host blacklist, so they cannot be promoted. Nothing was changed.',
  unchanged: 'Nothing to change: they were already that.',
  'never-promoted': 'They were never promoted, so there is nothing to demote.',
  'reason-required': 'Write a reason, then try again.',
  'reason-too-long': `Keep the reason to ${PROMOTION_REASON_MAX} characters.`,
  invalid: 'That could not be understood. Reload the page and try again.',
  'not-leadership':
    'Only the 1.5 Leadership Team can promote or demote hosts. Nothing was changed.',
  'leadership-unavailable':
    'Discord could not be reached to check your role. Nothing was changed; try again in a minute.',
  error: 'That did not save. Please try again in a minute.',
} as const;
export type PromotionResultCode = keyof typeof PROMOTION_RESULT_MESSAGES;

const DONE: ReadonlySet<PromotionResultCode> = new Set([
  'promoted',
  'demoted',
  'promoted-no-signout',
  'demoted-no-signout',
]);

const isResultCode = (code: unknown): code is PromotionResultCode =>
  typeof code === 'string' && Object.hasOwn(PROMOTION_RESULT_MESSAGES, code);

function resultNotice(code: unknown): SafeHtml | '' {
  if (!isResultCode(code)) {
    return '';
  }
  return DONE.has(code)
    ? html`<p class="note info">${PROMOTION_RESULT_MESSAGES[code]}</p>`
    : html`<p class="note attn">${PROMOTION_RESULT_MESSAGES[code]}</p>`;
}

const memberPath = (id: string) => `${DASHBOARD_BASE}/hosts/promotion/${id}`;

/** One form field as a string; a missing or repeated field is undefined. */
function field(body: unknown, name: string): string | undefined {
  const value = (body as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' ? value : undefined;
}

/** A moment's day in the group's timezone (dynos run UTC). */
const dayText = (value: Date | string) => pacificDate(value);
/** A YYYY-MM-DD day as it is (already a Pacific day). */
const plainDay = (day: string) => dayjs(day).format('MMM D, YYYY');

function hostName(id: string, seen: Map<string, HostSeen>): SafeHtml {
  const name = seen.get(id)?.name;
  return name ? memberText(name) : html`Meetup member ${id}`;
}

function hostLink(id: string, seen: Map<string, HostSeen>): SafeHtml {
  return html`<a href="${localUrl(memberPath(id))}">${hostName(id, seen)}</a>`;
}

function promotedTable(
  rows: PromotedHost[],
  seen: Map<string, HostSeen>,
): SafeHtml {
  return html`<table class="stack">
    <thead>
      <tr>
        <th>Host</th>
        <th>Since</th>
        <th>Reason</th>
        <th>By</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map(
        (r) =>
          html`<tr>
            <td data-label="Host">${hostLink(r.meetupMemberId, seen)}</td>
            <td data-label="Since">${dayText(r.changedAt)}</td>
            <td data-label="Reason">${memberText(r.reason)}</td>
            <td data-label="By">${discordUserLink(r.changedBy, 'profile')}</td>
          </tr>`,
      )}
    </tbody>
  </table>`;
}

function candidatesSection(
  loaded:
    | { ok: true; value: PromotionCandidate[]; uncounted: number }
    | { ok: false },
  seen: Map<string, HostSeen>,
): SafeHtml {
  if (!loaded.ok) {
    return html`<p class="note attn">
      Meetup is slow to answer, so the list is still being worked out. Reload in
      a minute.
    </p>`;
  }
  const partial =
    loaded.uncounted > 0
      ? html`<p class="note attn">
          Meetup did not give the count for ${loaded.uncounted}
          ${loaded.uncounted === 1 ? 'host' : 'hosts'}, so the list may be
          missing someone. Reload later to ask again.
        </p>`
      : '';
  if (loaded.value.length === 0) {
    return html`${partial}
      <p class="muted">No regular host meets the criteria yet.</p>`;
  }
  return html`${partial}
    <table class="stack">
      <thead>
        <tr>
          <th>Host</th>
          <th>Last 18 months</th>
          <th>All time</th>
          <th>Member since</th>
          <th>Last hosted</th>
        </tr>
      </thead>
      <tbody>
        ${loaded.value.map(
          (c) =>
            html`<tr>
              <td data-label="Host">${hostLink(c.meetupMemberId, seen)}</td>
              <td data-label="Last 18 months">${c.recentCount}</td>
              <td data-label="All time">${c.pastCount}</td>
              <td data-label="Member since">${dayText(c.memberSince)}</td>
              <td data-label="Last hosted">${dayText(c.lastHosted)}</td>
            </tr>`,
        )}
      </tbody>
    </table>`;
}

/** The leader's form: Promote for a regular host, Demote for a Community Host. */
function changeForm(
  id: string,
  row: PromotedHost | undefined,
  csrf: string,
): SafeHtml {
  const promoted = row?.active === true;
  return html`<form method="post" action="${localUrl(memberPath(id))}">
    <input type="hidden" name="_csrf" value="${csrf}" />
    <input type="hidden" name="version" value="${row?.version ?? 0}" />
    <input
      type="hidden"
      name="change"
      value="${promoted ? 'demote' : 'promote'}"
    />
    <label class="field"
      >Reason (kept in the history)
      <textarea
        name="reason"
        rows="2"
        maxlength="${PROMOTION_REASON_MAX}"
        required
      ></textarea>
    </label>
    ${
      promoted
        ? html`<button type="submit" class="danger">Demote</button>`
        : html`<button type="submit">Promote to Community Host</button>`
    }
  </form>`;
}

function historyTable(events: PromotionEvent[]): SafeHtml {
  if (events.length === 0) {
    return html`<p class="muted">Never promoted.</p>`;
  }
  return html`<table class="stack">
    <thead>
      <tr>
        <th>When</th>
        <th>Change</th>
        <th>Reason</th>
        <th>By</th>
      </tr>
    </thead>
    <tbody>
      ${events.map(
        (e) =>
          html`<tr>
            <td data-label="When">${dayText(e.at)}</td>
            <td data-label="Change">
              ${e.action === 'promote' ? 'Promoted' : 'Demoted'}
            </td>
            <td data-label="Reason">${memberText(e.reason)}</td>
            <td data-label="By">
              ${discordUserLink(e.actorDiscordId, 'profile')}
            </td>
          </tr>`,
      )}
    </tbody>
  </table>`;
}

function memberBody(view: {
  id: string;
  past: HostEvent[];
  row: PromotedHost | undefined;
  history: PromotionEvent[];
  leadership: LeadershipAnswer;
  csrf: string;
  now: Date;
  day: string | undefined;
  notice: SafeHtml | '';
}): SafeHtml {
  const { id, row } = view;
  const name = view.past
    .flatMap((e) => e.hosts)
    .find((h) => h.id === id && h.name)?.name;
  // Counts and the heat map follow the shared rule; the excluded are a note.
  const past = countedOnly(view.past);
  const excluded = view.past.length - past.length;
  const byDay = new Map<string, HostEvent[]>();
  for (const event of past) {
    const day = pacificDay(event.dateTime);
    byDay.set(day, [...(byDay.get(day) ?? []), event]);
  }
  const today = pacificDay(view.now);
  const year = Number(today.slice(0, 4));
  const maps = [year, year - 1].map((y) =>
    heatMapYear({
      byDay,
      year: y,
      today,
      dayLink: (d) => localUrl(`${memberPath(id)}?day=${d}`),
    }),
  );
  const listed = view.day
    ? (byDay.get(view.day) ?? [])
    : past.slice(0, EVENTS_SHOWN);
  const meetupProfile = safeHref(`https://www.meetup.com/members/${id}/`);
  return html`<div class="card">
      <h1>${name ? memberText(name) : `Meetup member ${id}`}</h1>
      <p>
        ${
          row?.active
            ? html`<span class="badge ok">Community Host</span> since
                ${dayText(row.changedAt)}`
            : html`<span class="badge neutral">Guest Host</span>`
        }
      </p>
      <p>
        ${past.length} past hosted
        ${past.length === 1 ? 'event' : 'events'}${
          past[0] ? `, last on ${dayText(past[0].dateTime)}` : ''
        }.${
          excluded > 0
            ? ` ${excluded} more ${excluded === 1 ? 'is' : 'are'} not counted (cancelled or an Open House).`
            : ''
        }
        ${
          meetupProfile
            ? html`<a
                href="${meetupProfile}"
                rel="noopener noreferrer"
                target="_blank"
                >Meetup profile</a
              >`
            : ''
        }
      </p>
      ${view.notice}
      ${
        view.leadership === 'leader'
          ? changeForm(id, row, view.csrf)
          : html`<p class="muted">
              Only the 1.5 Leadership Team can promote or demote.
            </p>`
      }
    </div>
    <div class="card">
      <h2>Hosting</h2>
      ${maps}
      <h3>
        ${view.day ? `Events on ${plainDay(view.day)}` : 'Latest past events'}
      </h3>
      ${
        listed.length === 0
          ? html`<p class="muted">None.</p>`
          : html`<ul>
              ${listed.map(
                (e) => html`<li>${dayText(e.dateTime)}: ${eventLink(e)}</li>`,
              )}
            </ul>`
      }
    </div>
    <div class="card">
      <h2>Promotion history</h2>
      ${historyTable(view.history)}
    </div>`;
}

function stalePage(res: Response, id: string): void {
  dashboardPage(res, {
    title: 'Changed',
    status: 409,
    body: html`<div class="card">
      <h1>Someone just changed this host</h1>
      <p>Nothing was changed. Reload to see where they stand.</p>
      <p><a href="${localUrl(memberPath(id))}">Reload</a></p>
    </div>`,
  });
}

/**
 * GET /dashboard/hosts/promotion and /dashboard/hosts/promotion/:memberId
 * (Moderators and Leadership), and POST /dashboard/hosts/promotion/:memberId
 * (promote or demote; Leadership, checked live).
 * CSRF, Origin, Sec-Fetch-Site and the per-user action rate limit are the
 * router's unsafe-method guard.
 */
export function registerHostPromotionRoutes(
  router: express.Router,
  deps: Pick<
    DashboardPageDeps,
    | 'now'
    | 'isLeadership'
    | 'audit'
    | 'promotedHosts'
    | 'promotionCandidates'
    | 'hostPastEvents'
    | 'revokeHostSessions'
    | 'hostAlert'
  >,
): void {
  const refusalPosts = new FixedWindowLimiter(
    1,
    WORKSPACE_REFUSAL_POST_WINDOW_MS,
    () => deps.now().getTime(),
  );

  router.get(DASHBOARD_PATHS.hostPromotion, (async (_req, res) => {
    const rows = await load(res, 'promoted hosts', async () =>
      (await deps.promotedHosts()).list(),
    );
    if (!rows.ok) {
      return;
    }
    const active = rows.value.filter((r) => r.active);
    const former = rows.value.filter((r) => !r.active);
    const activeIds = new Set(active.map((r) => r.meetupMemberId));
    const read = await loadOptional(
      'promotion candidates',
      deps.promotionCandidates,
      CANDIDATES_DEADLINE_MS,
    );
    const seen = read.ok ? read.value.seen : new Map<string, HostSeen>();
    const candidates = read.ok
      ? {
          ok: true as const,
          value: read.value.candidates.filter(
            (c) => !activeIds.has(c.meetupMemberId),
          ),
          uncounted: read.value.uncounted,
        }
      : { ok: false as const };
    dashboardPage(res, {
      title: 'Host promotion',
      body: html`<div class="card">
          <h1>Host promotion</h1>
          <p>
            Community Hosts publish their events without approval, titled
            "${COMMUNITY_HOST_PREFIX}…". They are not organizers. Promote and
            demote are for the 1.5 Leadership Team, each with a reason that is
            kept with who made the change and when.
          </p>
        </div>
        <div class="card">
          <h2>Community Hosts (${active.length})</h2>
          ${
            active.length === 0
              ? html`<p class="muted">No one is promoted yet.</p>`
              : promotedTable(active, seen)
          }
        </div>
        <div class="card">
          <h2>Candidates</h2>
          <p class="muted">
            Guest Hosts with ${PROMOTION_MIN_EVENTS} or more counted hosted
            events in the last ${CANDIDATE_WINDOW_MONTHS} months who joined the
            group a year or more ago. Organizers are left out. Cancelled events
            and Open Houses do not count. Open one to see their hosting and
            promote them.
          </p>
          ${candidatesSection(candidates, seen)}
        </div>
        ${
          former.length > 0
            ? html`<div class="card">
                <h2>Demoted (${former.length})</h2>
                ${promotedTable(former, seen)}
              </div>`
            : ''
        }`,
    });
  }) as RequestHandler);

  router.get(DASHBOARD_PATHS.hostMember, (async (req, res) => {
    const id = req.params.memberId;
    if (typeof id !== 'string' || !MEETUP_ID.test(id)) {
      notFound(res);
      return;
    }
    const { session } = dashboardLocals(res);
    const loaded = await load(res, 'host member', async () => {
      const store = await deps.promotedHosts();
      const [past, row, history] = await Promise.all([
        deps.hostPastEvents(id),
        store.get(id),
        store.history(id),
      ]);
      return { past, row, history };
    });
    if (!loaded.ok) {
      return;
    }
    if (
      loaded.value.past.length === 0 &&
      loaded.value.row === undefined &&
      loaded.value.history.length === 0
    ) {
      notFound(res);
      return;
    }
    const day =
      typeof req.query.day === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(req.query.day)
        ? req.query.day
        : undefined;
    dashboardPage(res, {
      title: 'Host',
      body: memberBody({
        id,
        ...loaded.value,
        leadership: await leadershipOf(deps.isLeadership, session.userId),
        csrf: session.csrfToken,
        now: deps.now(),
        day,
        notice: resultNotice(req.query.result),
      }),
    });
  }) as RequestHandler);

  router.post(DASHBOARD_PATHS.hostMember, (async (req, res) => {
    const id = req.params.memberId;
    if (typeof id !== 'string' || !MEETUP_ID.test(id)) {
      notFound(res);
      return;
    }
    const back = (code: PromotionResultCode) =>
      res.redirect(303, `${memberPath(id)}?result=${code}`);
    const { session } = dashboardLocals(res);
    // Live, on every request: the session's cached roles never decide this.
    const leadership = await leadershipOf(deps.isLeadership, session.userId);
    if (leadership !== 'leader') {
      if (refusalPosts.take(session.userId)) {
        deps
          .audit({
            title: 'Host promotion refused',
            description:
              `<@${session.userId}> tried to change Meetup member ${id}'s ` +
              `promotion without the 1.5 Leadership Team role (${leadership}).`,
          })
          .catch(() => undefined);
      }
      back(
        leadership === 'not-leader'
          ? 'not-leadership'
          : 'leadership-unavailable',
      );
      return;
    }
    const body = req.body as unknown;
    const change = field(body, 'change');
    const versionText = field(body, 'version');
    if (
      (change !== 'promote' && change !== 'demote') ||
      versionText === undefined ||
      !SEEN_VERSION.test(versionText)
    ) {
      back('invalid');
      return;
    }
    // A textarea's CRLF counts as one character, as for deny reasons.
    const reason = (field(body, 'reason') ?? '').replace(/\r\n?/g, '\n').trim();
    if (reason === '') {
      back('reason-required');
      return;
    }
    if (Array.from(reason).length > PROMOTION_REASON_MAX) {
      back('reason-too-long');
      return;
    }
    if (change === 'promote' && GUEST_HOST_MEETUP_BLACKLIST.includes(id)) {
      back('blacklisted');
      return;
    }
    let result: PromotionChange;
    try {
      const store = await deps.promotedHosts();
      // Only someone the page would show: a row, a history, or a past
      // hosted event (as the GET's 404).
      const [row, history] = await Promise.all([
        store.get(id),
        store.history(id, 1),
      ]);
      if (
        row === undefined &&
        history.length === 0 &&
        (await deps.hostPastEvents(id)).length === 0
      ) {
        notFound(res);
        return;
      }
      result = await store.change(
        change,
        id,
        Number(versionText),
        session.userId,
        reason,
      );
    } catch (error: unknown) {
      logger.warn(
        `Host promotion change failed: ${error instanceof Error ? error.name : 'Error'}`,
      );
      back('error');
      return;
    }
    if (result.code === 'stale') {
      stalePage(res, id);
      return;
    }
    if (result.code !== 'changed') {
      back(result.code);
      return;
    }
    // The 10-minute tier re-check is the backstop if this fails.
    const signedOut = await deps.revokeHostSessions(id).then(
      () => true,
      (error: unknown) => {
        logger.warn(
          `Host session revoke after ${change} failed: ${error instanceof Error ? error.name : 'Error'}`,
        );
        return false;
      },
    );
    const entry: LogEntry = {
      title:
        change === 'promote'
          ? 'Host promoted to Community Host'
          : 'Community Host demoted',
      fields: [
        { name: 'Meetup member', value: id, inline: true },
        { name: 'By', value: `<@${session.userId}>`, inline: true },
        { name: 'Reason', value: alertText(reason).slice(0, 1000) },
      ],
    };
    deps.audit(entry).catch(() => undefined);
    deps.hostAlert(entry).catch(() => undefined);
    const done = change === 'promote' ? 'promoted' : 'demoted';
    back(signedOut ? done : `${done}-no-signout`);
  }) as RequestHandler);
}
