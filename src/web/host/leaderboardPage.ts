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
  LeaderboardView,
  createLeaderboardLoader,
  streaksFor,
} from '../../lib/leaderboard/leaderboard.js';
import {
  Medal,
  MedalPlace,
  Standing,
  rank,
} from '../../lib/leaderboard/standings.js';
import { SafeHtml, html, memberText, pageLink } from '../html.js';
import { hostPage } from './hostPageKit.js';
import { hostLocals } from './hostRouter.js';
import { HostProfileDeps, registerHostProfile } from './hostProfilePage.js';
import {
  HALL_OF_FAME_PLACE_RULE,
  MAP_PAGE,
  hostMap,
  registerMapAssets,
} from './hostMap.js';
import { eventPlaces } from '../../lib/leaderboard/places.js';
import { archiveSection, awardsSection } from './hallOfFameAwards.js';
import {
  LEADERBOARD_PATH,
  bestStreaks,
  medalBadge,
  medalTally,
  monthName,
  namesNote,
  plural,
  profileUrl,
  streakBadges,
  streakNote,
  updatedLine,
} from './leaderboardKit.js';

const logger = new Logger({ name: 'hostDashboard' });

type Ready = LeaderboardView;

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

function nameCell(data: Ready, memberId: string, selfId: string): SafeHtml {
  const name = data.names.get(memberId);
  const text = name
    ? memberText(name)
    : html`<span class="muted">Unnamed host</span>`;
  const href = profileUrl(memberId);
  const shown = href ? html`<a href="${href}">${text}</a>` : text;
  return memberId === selfId
    ? html`<strong>${shown}</strong> <span class="badge info">You</span>`
    : shown;
}

interface MonthRow {
  memberId: string;
  events: number;
  place: number;
  medal?: MedalPlace;
}

/**
 * The month's rows. For an awarded month the stored medalists come first,
 * with the place and count they were awarded on (medals are kept whatever
 * later corrections do); everyone else follows, ranked live from the place
 * after them. Otherwise, the live standings.
 */
export function monthRows(data: Ready, month: string): MonthRow[] {
  const nameOf = (id: string) => data.names.get(id) ?? '';
  const live = rank(
    data.byMonth.get(month) ?? new Map<string, number>(),
    nameOf,
  );
  if (!data.awarded.has(month)) {
    return live;
  }
  const stored = data.medals
    .filter((m) => m.month === month)
    .sort(
      (a, b) =>
        a.place - b.place ||
        nameOf(a.memberId).localeCompare(nameOf(b.memberId)) ||
        a.memberId.localeCompare(b.memberId),
    );
  const medalists = new Set(stored.map((m) => m.memberId));
  const rest = rank(
    new Map(
      live
        .filter((s) => !medalists.has(s.memberId))
        .map((s) => [s.memberId, s.events]),
    ),
    nameOf,
  );
  return [
    ...stored.map((m) => ({
      memberId: m.memberId,
      events: m.events,
      place: m.place,
      medal: m.place,
    })),
    ...rest.map((s) => ({ ...s, place: s.place + stored.length })),
  ];
}

function monthStatus(data: Ready, month: string, current: string): SafeHtml {
  if (data.awarded.has(month)) {
    return html`<p>
      Final standings. Medals went to the top three places when the month
      closed, and are kept.
    </p>`;
  }
  if (data.medalsUnavailable) {
    return html`<p>Standings for ${monthName(month)}.</p>`;
  }
  if (month === current) {
    return html`<p>
      Standings so far. Medals go to the top three places once the month is
      over.
    </p>`;
  }
  return data.awardFailed
    ? html`<p>
        The month is over, but its medals could not be awarded just now. The
        leaderboard tries again in a few minutes.
      </p>`
    : html`<p>
        The month is over. Its medals are awarded once a complete update from
        Meetup at least two days after the month ended is in.
      </p>`;
}

function monthBody(
  data: Ready,
  month: string,
  first: string,
  selfId: string,
): SafeHtml {
  const current = data.today.slice(0, 7);
  const awarded = data.awarded.has(month);
  const rows = monthRows(data, month).map((row) => {
    const hostStreaks = streaksFor(data, row.memberId);
    return html`<tr>
      <td data-label="Place">${row.place}</td>
      ${medalCell(awarded, row.medal ? medalBadge(row.medal, month) : '')}
      <td class="event" data-label="Host">
        ${nameCell(data, row.memberId, selfId)}
      </td>
      <td data-label="Events">${row.events}</td>
      <td data-label="Streaks">
        ${streakBadges(hostStreaks)}
        <span class="muted streak-best">${bestStreaks(hostStreaks)}</span>
      </td>
    </tr>`;
  });
  return html`<div class="card">
    <h1>Leaderboard</h1>
    ${viewNav('month', month)} ${monthNav(month, first, current)}
    ${namesNote(data.names)} ${medalsNote(data)}
    ${monthStatus(data, month, current)}
    ${
      rows.length === 0
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
                <th>Streaks</th>
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

/** Hai's short list (2026-11-18): the top 10 for a viewer placed there… */
export const SHORT_LIST_TOP_PLACES = 10;
/** …otherwise the first 5 rows, a gap, and 3 rows either side of the viewer. */
export const SHORT_LIST_HEAD_ROWS = 5;
export const SHORT_LIST_NEIGHBOURS = 3;

export type ShortListItem =
  | { kind: 'row'; standing: Standing; you: boolean }
  | {
      kind: 'gap';
      /** Rows skipped, and the first and last place among them. */
      count: number;
      from: number;
      to: number;
    };

/**
 * Which lifetime rows to show (Hai: "the first 5, and then three dots …,
 * and then the 3 people before you and 3 people after you with your
 * current rank. If you're in the top 10, then just simply show the top
 * 10."). Windows go by row order in the ranked list; places stay the true
 * competition places. A viewer placed 10th or better, or not on the board,
 * sees every row placed 10th or better. Otherwise: rows 1 to 5, then the
 * viewer's row with 3 either side; where the two runs touch or overlap they
 * merge, and each skipped run becomes one gap. `full` shows every row.
 */
export function shortList(
  standings: Standing[],
  selfId: string,
  full = false,
): ShortListItem[] {
  const youAt = standings.findIndex((s) => s.memberId === selfId);
  const keep = new Set<number>();
  if (full) {
    standings.forEach((_s, i) => keep.add(i));
  } else if (youAt < 0 || standings[youAt].place <= SHORT_LIST_TOP_PLACES) {
    standings.forEach((s, i) => {
      if (s.place <= SHORT_LIST_TOP_PLACES) {
        keep.add(i);
      }
    });
  } else {
    for (
      let i = 0;
      i < Math.min(SHORT_LIST_HEAD_ROWS, standings.length);
      i += 1
    ) {
      keep.add(i);
    }
    const last = Math.min(standings.length - 1, youAt + SHORT_LIST_NEIGHBOURS);
    for (
      let i = Math.max(0, youAt - SHORT_LIST_NEIGHBOURS);
      i <= last;
      i += 1
    ) {
      keep.add(i);
    }
  }
  const items: ShortListItem[] = [];
  let previous = -1;
  [...keep]
    .sort((a, b) => a - b)
    .forEach((i) => {
      if (i > previous + 1 && previous >= 0) {
        items.push({
          kind: 'gap',
          count: i - previous - 1,
          from: standings[previous + 1].place,
          to: standings[i - 1].place,
        });
      }
      items.push({ kind: 'row', standing: standings[i], you: i === youAt });
      previous = i;
    });
  return items;
}

function gapText(gap: { count: number; from: number; to: number }): string {
  const places =
    gap.from === gap.to
      ? `place ${gap.from}`
      : `places ${gap.from} to ${gap.to}`;
  return `${plural(gap.count, 'host')} not shown (${places})`;
}

/**
 * The lifetime table: the short list, or every host with `full`, with a
 * link to switch between them.
 */
export function lifetimeTable(
  data: Ready,
  selfId: string,
  full = false,
): SafeHtml {
  const nameOf = (id: string) => data.names.get(id) ?? '';
  const counts = new Map(
    [...data.byHost].map(([id, events]) => [id, events.length]),
  );
  const standings = rank(counts, nameOf);
  const items = shortList(standings, selfId, full);
  const medalsByHost = new Map<string, Medal[]>();
  data.medals.forEach((m) => {
    medalsByHost.set(m.memberId, [...(medalsByHost.get(m.memberId) ?? []), m]);
  });
  const rows = items.map((item) => {
    if (item.kind === 'gap') {
      return html`<tr class="gap-row">
        <td colspan="5" class="gap-cell">
          <span aria-hidden="true">⋯</span> ${gapText(item)}
        </td>
      </tr>`;
    }
    const s = item.standing;
    const hostStreaks = streaksFor(data, s.memberId);
    const cells = html`<td data-label="Place">${s.place}</td>
      <td class="event" data-label="Host">
        ${nameCell(data, s.memberId, selfId)}
      </td>
      <td data-label="Events">${s.events}</td>
      <td data-label="Medals">
        ${medalTally(medalsByHost.get(s.memberId) ?? [])}
      </td>
      <td data-label="Streaks">
        ${streakBadges(hostStreaks)}
        <span class="muted streak-best">${bestStreaks(hostStreaks)}</span>
      </td>`;
    // The class is a literal: two templates.
    return item.you
      ? html`<tr class="you-row">
          ${cells}
        </tr>`
      : html`<tr>
          ${cells}
        </tr>`;
  });
  const shownRows = items.filter((i) => i.kind === 'row').length;
  const toggle = full
    ? html`<p>
        <a href="${pageLink(LEADERBOARD_PATH, { view: 'all' })}"
          >Show the short list</a
        >
      </p>`
    : shownRows < standings.length
      ? html`<p>
          <a href="${pageLink(LEADERBOARD_PATH, { view: 'all', hosts: 'all' })}"
            >${`Show all ${plural(standings.length, 'host')}`}</a
          >
        </p>`
      : '';
  return html`<p>
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
    ${toggle}`;
}

function hallOfFameBody(
  data: Ready,
  selfId: string,
  allHosts: boolean,
): SafeHtml {
  const nameOfHost = (id: string) => nameCell(data, id, selfId);
  return html`<div class="card">
      <h1>Leaderboard</h1>
      ${viewNav('all', data.today.slice(0, 7))} ${namesNote(data.names)}
      ${medalsNote(data)} ${lifetimeTable(data, selfId, allHosts)}
      ${streakNote()} ${updatedLine(data)}
    </div>
    ${awardsSection(data, nameOfHost)}
    <div class="card">
      <h2>Where we've hosted</h2>
      ${hostMap(
        eventPlaces(data.events, HALL_OF_FAME_PLACE_RULE),
        'the group has',
      )}
    </div>
    ${archiveSection(data, (month) => monthRows(data, month), nameOfHost)}`;
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
  deps: LeaderboardDeps & { profiles?: HostProfileDeps },
): void {
  // One loader: its cache and award back-off are shared by every request,
  // the profiles' included.
  const loader = createLeaderboardLoader(deps);
  registerMapAssets(router);
  if (deps.profiles) {
    registerHostProfile(router, () => loader.load(), deps.profiles);
  }
  router.get('/leaderboard', (async (req, res) => {
    const { session } = hostLocals(res);
    // Members never reach here: the router keeps them to MEMBER_PATHS.
    let data: LeaderboardData;
    try {
      data = await loader.load();
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
    const current = data.today.slice(0, 7);
    const first = data.firstMonth ?? current;
    if (req.query.view === 'all') {
      hostPage(res, {
        title: 'Hall of fame',
        current: 'leaderboard',
        body: hallOfFameBody(data, session.userId, req.query.hosts === 'all'),
        ...MAP_PAGE,
      });
      return;
    }
    hostPage(res, {
      title: 'Leaderboard',
      current: 'leaderboard',
      body: monthBody(
        data,
        leaderboardMonth(req.query.month, first, current),
        first,
        session.userId,
      ),
    });
  }) as RequestHandler);
}
