/**
 * /host/leaderboard: this month's hosting standings with medals, and the
 * all-time Hall of fame, both from the group snapshot (no Meetup call).
 * Hosts only. Rules: src/lib/leaderboard/standings.ts.
 */
import dayjs from 'dayjs';
import express, { RequestHandler } from 'express';
import { Logger } from 'tslog';

import {
  LeaderboardData,
  LeaderboardDeps,
  loadLeaderboard,
} from '../../lib/leaderboard/leaderboard.js';
import {
  HostStreaks,
  LeaderboardEvent,
  Medal,
  MedalPlace,
  Standing,
  eventsByHost,
  monthCounts,
  pacificMonthOf,
  rank,
  streaksOf,
} from '../../lib/leaderboard/standings.js';
import { tz } from '../../util/timezone.js';
import { SafeHtml, html, memberText, pageLink } from '../html.js';
import { hostPage } from './hostPageKit.js';
import { hostLocals } from './hostRouter.js';
import { HOST_BASE } from './hostSession.js';

const logger = new Logger({ name: 'hostDashboard' });

export const LEADERBOARD_PATH = `${HOST_BASE}/leaderboard`;

const MEDAL_ICON: Record<MedalPlace, string> = { 1: '🥇', 2: '🥈', 3: '🥉' };
const MEDAL_NAME: Record<MedalPlace, string> = {
  1: 'Gold',
  2: 'Silver',
  3: 'Bronze',
};

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

const monthName = (month: string) => dayjs(`${month}-01`).format('MMMM YYYY');

/** An emoji with its words for screen readers and on hover. */
function emoji(icon: string, label: string): SafeHtml {
  return html`<span role="img" aria-label="${label}" title="${label}"
    >${icon}</span
  >`;
}

export function medalBadge(place: MedalPlace, month?: string): SafeHtml {
  const label = month
    ? `${MEDAL_NAME[place]} medal, ${monthName(month)}`
    : `${MEDAL_NAME[place]} medal`;
  return emoji(MEDAL_ICON[place], label);
}

/** Icons per Hai: weekly is the prestige streak (💎), daily is being on fire (🔥). */
export const WEEKLY_STREAK_ICON = '💎';
export const DAILY_STREAK_ICON = '🔥';

/**
 * Current streaks with their counts, weekly first (the more prestigious);
 * a broken streak is left out.
 */
export function streakBadges(streaks: HostStreaks): SafeHtml {
  const { daily, weekly } = streaks;
  const parts: SafeHtml[] = [];
  if (weekly.current > 0) {
    const label = `Weekly hosting streak: ${plural(weekly.current, 'week')}`;
    parts.push(
      html`<span class="streak"
        >${emoji(WEEKLY_STREAK_ICON, label)} ${weekly.current}</span
      >`,
    );
  }
  if (daily.current > 0) {
    const label = `Daily hosting streak: ${plural(daily.current, 'day')}`;
    parts.push(
      html`<span class="streak"
        >${emoji(DAILY_STREAK_ICON, label)} ${daily.current}</span
      >`,
    );
  }
  return parts.length === 0
    ? html`<span class="muted">None</span>`
    : html`${parts}`;
}

function bestStreaks(streaks: HostStreaks): string {
  return `Best: ${plural(streaks.weekly.best, 'week')} in a row, ${plural(
    streaks.daily.best,
    'day',
  )} in a row`;
}

type Ready = Extract<LeaderboardData, { ready: true }>;

/** `?month=YYYY-MM` within the first hosted month and this month; else this month. */
export function leaderboardMonth(
  query: unknown,
  first: string,
  current: string,
): string {
  return typeof query === 'string' &&
    /^\d{4}-(0[1-9]|1[0-2])$/.test(query) &&
    query >= first &&
    query <= current
    ? query
    : current;
}

function viewNav(view: 'month' | 'all', month: string): SafeHtml {
  const monthPart =
    view === 'month'
      ? html`<strong aria-current="page">This month</strong>`
      : html`<a href="${pageLink(LEADERBOARD_PATH, { month })}">This month</a>`;
  const allPart =
    view === 'all'
      ? html`<strong aria-current="page">Hall of fame</strong>`
      : html`<a href="${pageLink(LEADERBOARD_PATH, { view: 'all' })}"
          >Hall of fame</a
        >`;
  return html`<nav class="pager choices" aria-label="Leaderboard view">
    ${monthPart}${allPart}
  </nav>`;
}

function monthNav(month: string, first: string, current: string): SafeHtml {
  const at = dayjs(`${month}-01`);
  const prev = at.subtract(1, 'month').format('YYYY-MM');
  const next = at.add(1, 'month').format('YYYY-MM');
  const link = (m: string) => pageLink(LEADERBOARD_PATH, { month: m });
  const label = (m: string) => dayjs(`${m}-01`).format('MMM');
  const prevPart =
    month > first
      ? html`<a class="button ghost" href="${link(prev)}">← ${label(prev)}</a>`
      : html`<span class="button ghost disabled"
          >← ${label(prev)}<span class="sr-only">
            (no earlier events)</span
          ></span
        >`;
  const nextPart =
    month < current
      ? html`<a class="button ghost" href="${link(next)}">${label(next)} →</a>`
      : html`<span class="button ghost disabled"
          >${label(next)} →<span class="sr-only"> (not yet)</span></span
        >`;
  return html`<nav class="year-nav" aria-label="Month">
    ${prevPart}<strong>${monthName(month)}</strong>${nextPart}
  </nav>`;
}

function medalsNote(data: Ready): SafeHtml | '' {
  return data.medalsUnavailable
    ? html`<p class="note attn">
        Medals cannot be loaded right now; the standings are complete.
      </p>`
    : '';
}

function updatedLine(data: Ready): SafeHtml {
  return data.updatedAt
    ? html`<p class="muted">
        From Meetup as of ${tz(dayjs(data.updatedAt)).format('MMM D, h:mm A')}
        (updated about once a day). Cancelled events and Open Houses do not
        count, and every co-host of an event gets the event.
      </p>`
    : html``;
}

function nameCell(data: Ready, memberId: string, selfId: string): SafeHtml {
  const name = data.names.get(memberId);
  const shown = name
    ? memberText(name)
    : html`<span class="muted">Unnamed host</span>`;
  return memberId === selfId
    ? html`<strong>${shown}</strong> <span class="badge info">You</span>`
    : shown;
}

function monthBody(
  data: Ready,
  month: string,
  first: string,
  selfId: string,
  streaks: (memberId: string) => HostStreaks,
): SafeHtml {
  const current = data.today.slice(0, 7);
  const nameOf = (id: string) => data.names.get(id) ?? '';
  const standings: Standing[] = rank(monthCounts(data.events, month), nameOf);
  const awarded = data.awarded.has(month);
  const medalOf = new Map(
    data.medals.filter((m) => m.month === month).map((m) => [m.memberId, m]),
  );
  const status = awarded
    ? html`<p>Final standings. Medals went to the top three places.</p>`
    : data.medalsUnavailable
      ? html`<p>Standings for ${monthName(month)}.</p>`
      : month === current
        ? html`<p>
            Standings so far. Medals go to the top three places once the month
            is over.
          </p>`
        : html`<p>
            The month is over; medals are awarded a couple of days after it
            ends, once late changes on Meetup are in.
          </p>`;
  const rows = standings.map((s) => {
    const medal = medalOf.get(s.memberId);
    const hostStreaks = streaks(s.memberId);
    return html`<tr>
      <td data-label="Place">${s.place}</td>
      ${medalCell(awarded, medal ? medalBadge(medal.place, month) : '')}
      <td class="event" data-label="Host">
        ${nameCell(data, s.memberId, selfId)}
      </td>
      <td data-label="Events">${s.events}</td>
      <td data-label="Streaks" title="${bestStreaks(hostStreaks)}">
        ${streakBadges(hostStreaks)}
      </td>
    </tr>`;
  });
  return html`<div class="card">
    <h1>Leaderboard</h1>
    ${viewNav('month', month)} ${monthNav(month, first, current)}
    ${medalsNote(data)} ${status}
    ${
      standings.length === 0
        ? html`<p class="muted">
            No hosted events in ${monthName(month)} yet.
          </p>`
        : html`<table class="stack leaderboard">
            <thead>
              <tr>
                <th>Place</th>
                ${awarded ? html`<th>Medal</th>` : ''}
                <th>Host</th>
                <th>Events</th>
                <th>Current streaks</th>
              </tr>
            </thead>
            <tbody>
              ${rows}
            </tbody>
          </table>`
    }
    ${streakNote()} ${updatedLine(data)}
  </div>`;
}

/** Only an awarded month has a Medal column. */
function medalCell(awarded: boolean, content: SafeHtml | ''): SafeHtml | '' {
  return awarded ? html`<td data-label="Medal">${content}</td>` : '';
}

function streakNote(): SafeHtml {
  return html`<p class="muted">
    ${emoji(WEEKLY_STREAK_ICON, 'Weekly streak')} counts weeks in a row (Monday
    to Sunday) with a hosted event; ${emoji(DAILY_STREAK_ICON, 'Daily streak')}
    counts days in a row. A streak keeps going until a whole week or day passes
    without one.
  </p>`;
}

function medalTally(medals: Medal[]): SafeHtml {
  if (medals.length === 0) {
    return html`<span class="muted">None yet</span>`;
  }
  const parts = ([1, 2, 3] as const).flatMap((place) => {
    const n = medals.filter((m) => m.place === place).length;
    return n === 0
      ? []
      : [
          html`<span class="streak"
            >${emoji(MEDAL_ICON[place], `${plural(n, `${MEDAL_NAME[place].toLowerCase()} medal`)}`)}
            ×${n}</span
          >`,
        ];
  });
  return html`${parts}`;
}

function hallOfFameBody(
  data: Ready,
  selfId: string,
  byHost: Map<string, LeaderboardEvent[]>,
  streaks: (memberId: string) => HostStreaks,
): SafeHtml {
  const nameOf = (id: string) => data.names.get(id) ?? '';
  const counts = new Map(
    [...byHost].map(([id, events]) => [id, events.length]),
  );
  const standings = rank(counts, nameOf);
  const medalsOf = (id: string) => data.medals.filter((m) => m.memberId === id);
  const rows = standings.map((s) => {
    const hostStreaks = streaks(s.memberId);
    return html`<tr>
      <td data-label="Place">${s.place}</td>
      <td class="event" data-label="Host">
        ${nameCell(data, s.memberId, selfId)}
      </td>
      <td data-label="Events">${s.events}</td>
      <td data-label="Medals">${medalTally(medalsOf(s.memberId))}</td>
      <td data-label="Streaks">
        ${streakBadges(hostStreaks)}
        <span class="muted streak-best">${bestStreaks(hostStreaks)}</span>
      </td>
    </tr>`;
  });
  return html`<div class="card">
    <h1>Leaderboard</h1>
    ${viewNav('all', data.today.slice(0, 7))} ${medalsNote(data)}
    <p>
      Every host, by events hosted since the group began.
      ${`${plural(standings.length, 'host')}, ${plural(data.events.length, 'event')}.`}
    </p>
    <table class="stack leaderboard">
      <thead>
        <tr>
          <th>Place</th>
          <th>Host</th>
          <th>Events</th>
          <th>Medals</th>
          <th>Streaks</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
    ${streakNote()} ${updatedLine(data)}
  </div>`;
}

const notReadyBody = html`<div class="card">
  <h1>Leaderboard</h1>
  <p>
    The leaderboard is still being built from the group's event history. Please
    check back in a few hours.
  </p>
</div>`;

const unavailableBody = html`<div class="card">
  <h1>Unavailable</h1>
  <p>
    The leaderboard cannot be loaded right now. Please try again in a minute.
  </p>
</div>`;

export function registerLeaderboardPage(
  router: express.Router,
  deps: LeaderboardDeps,
): void {
  router.get('/leaderboard', (async (req, res) => {
    const { session } = hostLocals(res);
    // Members never reach here: the router keeps them to MEMBER_PATHS.
    let data: LeaderboardData;
    try {
      data = await loadLeaderboard(deps);
    } catch (error: unknown) {
      logger.warn(
        `Leaderboard read failed: ${error instanceof Error ? error.name : 'Error'}`,
      );
      hostPage(res, {
        title: 'Unavailable',
        current: 'leaderboard',
        status: 503,
        body: unavailableBody,
      });
      return;
    }
    if (!data.ready) {
      hostPage(res, {
        title: 'Leaderboard',
        current: 'leaderboard',
        body: notReadyBody,
      });
      return;
    }
    const ready = data;
    const byHost = eventsByHost(ready.events);
    const memo = new Map<string, HostStreaks>();
    const streaks = (id: string) => {
      const known = memo.get(id);
      if (known) {
        return known;
      }
      const computed = streaksOf(byHost.get(id) ?? [], ready.today);
      memo.set(id, computed);
      return computed;
    };
    const current = ready.today.slice(0, 7);
    const first =
      ready.events.length === 0
        ? current
        : pacificMonthOf(ready.events[0].dateTime);
    const body =
      req.query.view === 'all'
        ? hallOfFameBody(ready, session.userId, byHost, streaks)
        : monthBody(
            ready,
            leaderboardMonth(req.query.month, first, current),
            first,
            session.userId,
            streaks,
          );
    hostPage(res, { title: 'Leaderboard', current: 'leaderboard', body });
  }) as RequestHandler);
}
