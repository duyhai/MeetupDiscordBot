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
import { Medal, Standing, rank } from '../../lib/leaderboard/standings.js';
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
import { archiveSection, awardsSection, ordinal } from './hallOfFameAwards.js';
import { monthRows } from '../../lib/leaderboard/monthRows.js';
import { AWARD_MAX_ROWS } from '../../lib/leaderboard/awards.js';
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
  // Only a host with counted events has a profile page; a medalist whose
  // events were all cancelled since would link to a 404.
  const href = data.byHost.has(memberId) ? profileUrl(memberId) : undefined;
  const shown = href ? html`<a href="${href}">${text}</a>` : text;
  return memberId === selfId
    ? html`<strong>${shown}</strong> <span class="badge info">You</span>`
    : shown;
}

export { monthRows } from '../../lib/leaderboard/monthRows.js';

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
    ${namesNote(
      data.names,
      monthRows(data, month).map((r) => r.memberId),
    )}
    ${medalsNote(data)} ${monthStatus(data, month, current)}
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
/** On a phone (Hai): the top 5 for a viewer placed there, else 1 either side. */
export const PHONE_SHORT_LIST_TOP_PLACES = 5;
export const PHONE_SHORT_LIST_NEIGHBOURS = 1;

export interface ShortListGap {
  /** Rows skipped. */
  count: number;
  /**
   * The first place among them that no shown row above already has;
   * undefined when every skipped row is tied with the row above.
   */
  from?: number;
  /** The last skipped row's place. */
  to: number;
}

/**
 * What follows one width's last shown row: rows tied past its row cap
 * ("and N more tied at Xth"), then every other host ("and N more hosts").
 */
export interface ShortListMore {
  tied?: { count: number; place: number };
  /** Hosts after the list that are not tied into it. */
  rest: number;
}

/**
 * One rendered row of the lifetime table. A row carries which widths show
 * it; a gap or a "more tied" line carries its text for each width it
 * appears on (a gap can be phone-only, or differ between the widths).
 */
export type ShortListItem =
  | {
      kind: 'row';
      standing: Standing;
      you: boolean;
      desktop: boolean;
      phone: boolean;
    }
  | { kind: 'gap'; desktop?: ShortListGap; phone?: ShortListGap }
  | { kind: 'more'; desktop?: ShortListMore; phone?: ShortListMore };

/** At most this many rows of a top-places list (as the award boards)… */
export const SHORT_LIST_MAX_ROWS = AWARD_MAX_ROWS;
/** …and on a phone, where 25 is far too long. */
export const PHONE_SHORT_LIST_MAX_ROWS = 10;

/**
 * The row indices one width keeps, and where its top-places list ends
 * (for "and N more tied" when the cap cut it).
 */
function keptRows(
  standings: Standing[],
  youAt: number,
  topPlaces: number,
  neighbours: number,
  maxRows: number,
): { keep: Set<number>; end: number } {
  const keep = new Set<number>();
  if (youAt < 0 || standings[youAt].place <= topPlaces) {
    // Every row placed `topPlaces` or better, at most `maxRows` of them
    // (rows past the cap are all tied with the last kept one), and always
    // the viewer's own row.
    let end = -1;
    standings.forEach((s, i) => {
      if (s.place <= topPlaces) {
        end = i;
        if (i < maxRows) {
          keep.add(i);
        }
      }
    });
    if (youAt >= 0) {
      keep.add(youAt);
    }
    return { keep, end };
  }
  const head = Math.min(SHORT_LIST_HEAD_ROWS, standings.length);
  for (let i = 0; i < head; i += 1) {
    keep.add(i);
  }
  const last = Math.min(standings.length - 1, youAt + neighbours);
  for (let i = Math.max(0, youAt - neighbours); i <= last; i += 1) {
    keep.add(i);
  }
  return { keep, end: last };
}

/**
 * Which lifetime rows to show. Desktop (Hai: "the first 5, and then three
 * dots …, and then the 3 people before you and 3 people after you with your
 * current rank. If you're in the top 10, then just simply show the top
 * 10."): a viewer placed 10th or better, or not on the board, sees every
 * row placed 10th or better (at most 25, then "and N more tied", the viewer
 * always shown); anyone else rows 1 to 5 and 3 either side of them. Phone
 * (Hai: "just show one before and after, and only show top five if you are
 * in the top five"): the same with 5th, at most 10 rows, and 1 either side.
 * Windows go by row order in the ranked list; places stay the true
 * competition places; runs that touch merge, and each skipped run is one
 * gap per width. Hosts after a width's last row get a closing line. `full`
 * shows every row on both widths.
 */
export function shortList(
  standings: Standing[],
  selfId: string,
  full = false,
): ShortListItem[] {
  const youAt = standings.findIndex((s) => s.memberId === selfId);
  const all = {
    keep: new Set(standings.map((_s, i) => i)),
    end: standings.length - 1,
  };
  const desktop = full
    ? all
    : keptRows(
        standings,
        youAt,
        SHORT_LIST_TOP_PLACES,
        SHORT_LIST_NEIGHBOURS,
        SHORT_LIST_MAX_ROWS,
      );
  const phone = full
    ? all
    : keptRows(
        standings,
        youAt,
        PHONE_SHORT_LIST_TOP_PLACES,
        PHONE_SHORT_LIST_NEIGHBOURS,
        PHONE_SHORT_LIST_MAX_ROWS,
      );
  function gapBefore(
    keep: Set<number>,
    i: number,
    previous: number,
  ): ShortListGap | undefined {
    if (!keep.has(i) || previous < 0 || i <= previous + 1) {
      return undefined;
    }
    // A skipped row tied with the row above is not a new place: the range
    // starts at the first skipped place the rows above do not show.
    const shownPlace = standings[previous].place;
    let from: number | undefined;
    for (let k = previous + 1; k < i && from === undefined; k += 1) {
      if (standings[k].place > shownPlace) {
        from = standings[k].place;
      }
    }
    return {
      count: i - previous - 1,
      ...(from === undefined ? {} : { from }),
      to: standings[i - 1].place,
    };
  }
  function moreAfter(
    width: { keep: Set<number>; end: number },
    last: number,
  ): ShortListMore | undefined {
    // `end` is never before the last kept row: the viewer, when kept past
    // the cap, is placed within the list.
    const end = Math.max(width.end, last);
    const rest = standings.length - 1 - end;
    if (end === last && rest === 0) {
      return undefined;
    }
    return {
      ...(end > last
        ? { tied: { count: end - last, place: standings[end].place } }
        : {}),
      rest,
    };
  }
  const items: ShortListItem[] = [];
  let lastDesktop = -1;
  let lastPhone = -1;
  [...new Set([...desktop.keep, ...phone.keep])]
    .sort((a, b) => a - b)
    .forEach((i) => {
      const desktopGap = gapBefore(desktop.keep, i, lastDesktop);
      const phoneGap = gapBefore(phone.keep, i, lastPhone);
      if (desktopGap || phoneGap) {
        items.push({
          kind: 'gap',
          ...(desktopGap ? { desktop: desktopGap } : {}),
          ...(phoneGap ? { phone: phoneGap } : {}),
        });
      }
      items.push({
        kind: 'row',
        standing: standings[i],
        you: i === youAt,
        desktop: desktop.keep.has(i),
        phone: phone.keep.has(i),
      });
      if (desktop.keep.has(i)) {
        lastDesktop = i;
      }
      if (phone.keep.has(i)) {
        lastPhone = i;
      }
    });
  const desktopMore = moreAfter(desktop, lastDesktop);
  const phoneMore = moreAfter(phone, lastPhone);
  if (desktopMore || phoneMore) {
    items.push({
      kind: 'more',
      ...(desktopMore ? { desktop: desktopMore } : {}),
      ...(phoneMore ? { phone: phoneMore } : {}),
    });
  }
  return items;
}

function gapText(gap: ShortListGap): string {
  const hosts = `${plural(gap.count, 'host')} not shown`;
  if (gap.from === undefined) {
    return hosts;
  }
  return gap.from === gap.to
    ? `${hosts} (place ${gap.from})`
    : `${hosts} (places ${gap.from} to ${gap.to})`;
}

function moreText(more: ShortListMore): string {
  const others = `${plural(more.rest, 'more host')}`;
  if (!more.tied) {
    return `and ${others}`;
  }
  const tied = `and ${more.tied.count} more tied at ${ordinal(more.tied.place)}`;
  return more.rest > 0 ? `${tied}, then ${others}` : tied;
}

/** Which widths show a row: a class only when one width hides it. */
function widthClass(desktop: boolean, phone: boolean): string {
  if (desktop && !phone) {
    return 'desktop-only';
  }
  return phone && !desktop ? 'phone-only' : '';
}

function gapRow(text: string, cls: string): SafeHtml {
  return html`<tr class="${`gap-row ${cls}`.trim()}">
    <td colspan="5" class="gap-cell">
      <span aria-hidden="true">⋯</span> ${text}
    </td>
  </tr>`;
}

/**
 * A gap or "more" line: one row when both widths read the same, otherwise
 * one per width, the other hidden (display:none, so it is not read out).
 */
function widthRows(desktop?: string, phone?: string): SafeHtml {
  if (desktop !== undefined && desktop === phone) {
    return gapRow(desktop, '');
  }
  return html`${desktop === undefined ? '' : gapRow(desktop, 'desktop-only')}${
    phone === undefined ? '' : gapRow(phone, 'phone-only')
  }`;
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
      return widthRows(
        item.desktop && gapText(item.desktop),
        item.phone && gapText(item.phone),
      );
    }
    if (item.kind === 'more') {
      return widthRows(
        item.desktop && moreText(item.desktop),
        item.phone && moreText(item.phone),
      );
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
    const cls = [
      item.you ? 'you-row' : '',
      widthClass(item.desktop, item.phone),
    ]
      .filter(Boolean)
      .join(' ');
    return cls === ''
      ? html`<tr>
          ${cells}
        </tr>`
      : html`<tr class="${cls}">
          ${cells}
        </tr>`;
  });
  // Whether the short list leaves anyone out on either width: only then are
  // the links between the two views worth showing.
  const shortItems = full ? shortList(standings, selfId) : items;
  const shortRows = shortItems.filter(
    (i): i is Extract<ShortListItem, { kind: 'row' }> => i.kind === 'row',
  );
  const desktopHides =
    shortRows.filter((i) => i.desktop).length < standings.length;
  const phoneHides = shortRows.filter((i) => i.phone).length < standings.length;
  let toggle: SafeHtml | '' = '';
  if (desktopHides || phoneHides) {
    // Only on the widths whose short list leaves someone out.
    const cls = `table-toggle ${widthClass(desktopHides, phoneHides)}`.trim();
    toggle = full
      ? html`<p class="${cls}">
          <a href="${pageLink(LEADERBOARD_PATH, { view: 'all' })}"
            >Show the short list</a
          >
        </p>`
      : html`<p class="${cls}">
          <a href="${pageLink(LEADERBOARD_PATH, { view: 'all', hosts: 'all' })}"
            >${`Show all ${plural(standings.length, 'host')}`}</a
          >
        </p>`;
  }
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
      ${viewNav('all', data.today.slice(0, 7))}
      ${namesNote(data.names, [
        ...data.byHost.keys(),
        ...data.medals.map((m) => m.memberId),
      ])}
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
    ${archiveSection(data, nameOfHost)}`;
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
