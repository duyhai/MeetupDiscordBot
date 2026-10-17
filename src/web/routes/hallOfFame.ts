import express, { RequestHandler } from 'express';

import { formatHallOfFamePost } from '../../lib/helpers/hallOfFame.js';
import {
  DASHBOARD_PATHS,
  dashboardPath,
  monthPath,
} from '../../lib/reports/dashboardPaths.js';
import {
  Period,
  monthLabel,
  parsePeriodKey,
  periodKey,
} from '../../lib/reports/period.js';
import { HallOfFameEvent, HallOfFamePayload } from '../../lib/reports/types.js';
import { dashboardLocals } from '../dashboardRouter.js';
import { SafeHtml, html, pageLink } from '../html.js';
import { discordMention, eventLink, memberLink } from '../links.js';
import {
  monthCell,
  builtByHtml,
  dashboardPage,
  load,
  loadOptional,
  notFound,
  pacificDate,
  pacificDateTime,
  parseRouteMonth,
  unavailable,
} from '../pageKit.js';
import { PAGE_SIZE, pageNav, parsePage } from '../paging.js';
import type { DashboardPageDeps } from './dashboardPages.js';
import { refreshForm, refreshNotice } from './refresh.js';

const WHAT = 'The Hall of Fame report';

/**
 * For the dashboard's copy text only: a zero-width space (U+200B) after
 * every "@" and after every "<#" and "</", so pasting the post into Discord
 * pings nobody and links nothing. That covers "@everyone", "@here", "<@…>"
 * user, nickname and role mentions, and typed "@Name" or "@RoleName" that
 * the client would turn into a mention, plus channel links and slash
 * command mentions. The fixed text of formatHallOfFamePost has none of
 * these (a test checks), so in effect this touches names and titles only.
 * Idempotent. Not in formatHallOfFamePost: the slash command's output (and
 * its goldens) stay byte-identical.
 */
export function neutralizeMentions(text: string): string {
  return text.replace(/(@|<#|<\/)(?!\u200b)/g, '$1\u200b');
}

/** '2026 September': the label the slash command uses, so the copy text matches it. */
export function commandPeriodLabel(period: Period): string {
  const [monthName] = monthLabel(period).split(' ');
  return `${period.year} ${monthName}`;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

/** Each host entry has a host object and an array of event objects, or the page cannot be built. */
const isHostEntry = (h: unknown): boolean =>
  isObject(h) &&
  isObject(h.host) &&
  Array.isArray(h.events) &&
  h.events.every(isObject);

/** A stored payload this page can render; anything else is the 503 page, never a 500. */
const isHallOfFame = (p: unknown): p is HallOfFamePayload =>
  isObject(p) &&
  p.reportType === 'hall_of_fame' &&
  Array.isArray(p.hosts) &&
  p.hosts.every(isHostEntry);

const count = (value: unknown): number => Number(value) || 0;

/** The number is an RSVP count (YES plus ATTENDED, which never comes back): "RSVPs", never attendance. */
function eventRow(e: HallOfFameEvent): SafeHtml {
  const rsvps = `${count(e.attendance)} RSVPs / ${count(e.maxTickets)} spots`;
  return html`<li>
    ${eventLink(e)}
    <span class="muted">${pacificDate(e.dateTime)} · ${rsvps}</span>
  </li>`;
}

/**
 * Everyone the post names, distinct, in first-seen order: the ranked hosts,
 * then the co-hosts in the "New hosts" section.
 */
function peopleInPost(payload: HallOfFamePayload): string[] {
  const ids = new Set(payload.hosts.map((h) => h.host.id));
  for (const h of payload.hosts) {
    if (h.isNew) {
      for (const e of h.events) {
        for (const { member } of e.eventHosts ?? []) {
          ids.add(member.id);
        }
      }
    }
  }
  return [...ids];
}

const newHostIdsOf = (payload: HallOfFamePayload) =>
  new Set(payload.hosts.filter((h) => h.isNew).map((h) => h.host.id));

/**
 * The ready-to-post text with a Discord mention for every linked person
 * (a 17-20 digit stored id only). Neutralised per field, never over the
 * whole text, so the bot's own mentions stay live: unlinked names and event
 * titles are Meetup text, and those are the only places a ping could hide.
 */
function mentionPost(
  payload: HallOfFamePayload,
  period: Period,
  links: Map<string, string>,
): { post: string; unlinked: number; people: number } {
  const hostStats = payload.hosts.map((h) => ({
    host: h.host,
    // String(): a stored payload is not type-checked field by field; this
    // is what the plain text's template literal makes of a non-string.
    // collapseByTitle groups by the neutralised title, so two titles that
    // differ only by an existing U+200B after an @ (say "@x" and "@\u200bx")
    // share one line here but not in the plain box. Accepted: not realistic.
    events: h.events.map((e) => ({
      ...e,
      title: neutralizeMentions(String(e.title)),
    })),
  }));
  const post = formatHallOfFamePost({
    periodLabel: commandPeriodLabel(period),
    hostStats,
    totalEvents: payload.totalEvents,
    newHostIds: newHostIdsOf(payload),
    nameOf: (member) =>
      discordMention(links.get(member.id)) ??
      neutralizeMentions(String(member.name)),
  });
  const people = peopleInPost(payload);
  const unlinked = people.filter(
    (id) => discordMention(links.get(id)) === undefined,
  ).length;
  return { post, unlinked, people: people.length };
}

const MENTIONS_UNAVAILABLE =
  'Mentions are unavailable right now; use the text above and add mentions by hand.';

/** The second copy box, or its fixed fallback line when the lookup failed. */
function mentionCard(
  payload: HallOfFamePayload,
  period: Period,
  links: Map<string, string> | undefined,
): SafeHtml {
  if (links === undefined) {
    return html`<div class="card">
      <h2>Ready to post (with mentions)</h2>
      <p class="muted">${MENTIONS_UNAVAILABLE}</p>
    </div>`;
  }
  const { post, unlinked, people } = mentionPost(payload, period, links);
  const note =
    unlinked === 0
      ? ''
      : html`<p class="muted">
          ${`${unlinked} of ${people} people have no linked Discord account and appear by name.`}
        </p>`;
  return html`<div class="card">
    <h2>Ready to post (with mentions)</h2>
    <textarea id="hof-post-mentions" class="copy" readonly>${post}</textarea>
    ${note}
    <p><button type="button" data-copy="hof-post-mentions">Copy</button></p>
  </div>`;
}

function monthPage(
  payload: HallOfFamePayload,
  period: Period,
  page: number,
): { hosts: SafeHtml; post: string } {
  const start = (page - 1) * PAGE_SIZE;
  const rows = payload.hosts.slice(start, start + PAGE_SIZE);
  const hosts = html`<table>
      <thead>
        <tr>
          <th>#</th>
          <th>Host</th>
          <th>Events</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(
          (h, i) =>
            html`<tr>
              <td>${start + i + 1}</td>
              <td>
                ${memberLink(h.host)}${
                  h.isNew ? html` <span class="badge">New host</span>` : ''
                }
              </td>
              <td>
                ${h.events.length}
                <ul>
                  ${h.events.map(eventRow)}
                </ul>
              </td>
            </tr>`,
        )}
      </tbody>
    </table>
    ${pageNav(
      monthPath(DASHBOARD_PATHS.hallOfFameMonth, period),
      page,
      start + PAGE_SIZE < payload.hosts.length,
    )}`;
  // The command's ready-to-post block, with mentions neutralised: staff
  // paste it into Discord, where a host named "@everyone" would ping.
  const post = neutralizeMentions(
    formatHallOfFamePost({
      periodLabel: commandPeriodLabel(period),
      hostStats: payload.hosts,
      totalEvents: payload.totalEvents,
      newHostIds: newHostIdsOf(payload),
    }),
  );
  return { hosts, post };
}

export function registerHallOfFameRoutes(
  router: express.Router,
  deps: Pick<DashboardPageDeps, 'now' | 'snapshots' | 'memberLinks'>,
): void {
  router.get(DASHBOARD_PATHS.hallOfFame, (async (req, res) => {
    const before =
      typeof req.query.before === 'string'
        ? parsePeriodKey(req.query.before)
        : undefined;
    const loaded = await load(res, 'The Hall of Fame reports', async () =>
      (await deps.snapshots()).listSummaries('hall_of_fame', {
        before,
        limit: PAGE_SIZE,
      }),
    );
    if (!loaded.ok) {
      return;
    }
    const metas = loaded.value;
    const last = metas[metas.length - 1];
    const older =
      metas.length === PAGE_SIZE && last
        ? html`<nav class="pager">
            <a
              href="${pageLink(dashboardPath(DASHBOARD_PATHS.hallOfFame), {
                before: periodKey(last.period),
              })}"
              >Older months</a
            >
          </nav>`
        : '';
    const table =
      metas.length === 0
        ? html`<p>No Hall of Fame reports have been built yet.</p>`
        : html`<table>
            <thead>
              <tr>
                <th>Month</th>
                <th>Events</th>
                <th>Hosts</th>
                <th>New hosts</th>
                <th>Built</th>
              </tr>
            </thead>
            <tbody>
              ${metas.map((meta) => {
                const s = (meta.summary ?? {}) as Record<string, unknown>;
                return html`<tr>
                  <td>
                    ${monthCell(DASHBOARD_PATHS.hallOfFameMonth, meta.period)}
                  </td>
                  <td>${count(s.events)}</td>
                  <td>${count(s.hosts)}</td>
                  <td>${count(s.newHosts)}</td>
                  <td>${pacificDateTime(meta.builtAt)} Pacific</td>
                </tr>`;
              })}
            </tbody>
          </table>`;
    dashboardPage(res, {
      title: 'Hall of Fame',
      body: html`<div class="card">
        <h1>Hall of Fame</h1>
        ${table} ${older}
      </div>`,
    });
  }) as RequestHandler);

  router.get(DASHBOARD_PATHS.hallOfFameMonth, (async (req, res) => {
    const period = parseRouteMonth(req.params.period, deps.now());
    if (period === undefined) {
      notFound(res);
      return;
    }
    const loaded = await load(res, WHAT, async () =>
      (await deps.snapshots()).getCurrent('hall_of_fame', period),
    );
    if (!loaded.ok) {
      return;
    }
    const { session } = dashboardLocals(res);
    const snapshot = loaded.value;
    const label = monthLabel(period);
    const head = html`<h1>Hall of Fame — ${label}</h1>
      ${refreshNotice(req.query.refresh)}`;
    const refresh = refreshForm(period, session.csrfToken, 'hall-of-fame');
    if (!snapshot) {
      dashboardPage(res, {
        title: `Hall of Fame ${label}`,
        body: html`<div class="card">
          ${head}
          <p>The ${label} reports have not been built yet.</p>
          ${refresh}
        </div>`,
      });
      return;
    }
    if (!isHallOfFame(snapshot.payload)) {
      unavailable(res, WHAT);
      return;
    }
    const payload = snapshot.payload;
    const { hosts, post } = monthPage(
      payload,
      period,
      parsePage(req.query.page),
    );
    // A failed or slow lookup costs only the mention box: the page is 200.
    // This is the page's second read in sequence, each under its own
    // PAGE_LOAD_DEADLINE_MS: about 20 s worst case, under Heroku's 30 s
    // router timeout. Do not add a third read in sequence; run it in
    // parallel with this one or not at all.
    const links = await loadOptional('Hall of Fame member links', async () =>
      (await deps.memberLinks()).discordIdsByMeetupIds(peopleInPost(payload)),
    );
    dashboardPage(res, {
      title: `Hall of Fame ${label}`,
      script: true,
      body: html`<div class="card">
          ${head}
          <p class="muted">
            Built ${pacificDateTime(snapshot.builtAt)} Pacific by
            ${builtByHtml(snapshot.builtBy)}; counts events up to
            ${pacificDateTime(payload.asOf)} Pacific.
          </p>
          <p>
            ${count(payload.summary?.events)} events ·
            ${count(payload.summary?.hosts)} hosts ·
            ${count(payload.summary?.newHosts)} new hosts
          </p>
          ${refresh}
        </div>
        <div class="card">
          <h2>Hosts</h2>
          ${hosts}
        </div>
        <div class="card">
          <h2>Ready to post</h2>
          <textarea id="hof-post" class="copy" readonly>${post}</textarea>
          <p><button type="button" data-copy="hof-post">Copy</button></p>
        </div>
        ${mentionCard(payload, period, links.ok ? links.value : undefined)}`,
    });
  }) as RequestHandler);
}
