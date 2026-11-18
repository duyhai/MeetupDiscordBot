/**
 * The Hall of fame's lower half (design note, PR 4, "Layout 2"): nine
 * all-time award boards under the lifetime table, and the archive of closed
 * months' final standings. The boards come computed from the loader
 * (src/lib/leaderboard/awards.ts); this only renders them.
 */
import dayjs from 'dayjs';

import {
  AwardBoard,
  AwardKey,
  AwardRow,
} from '../../lib/leaderboard/awards.js';
import type { LeaderboardView } from '../../lib/leaderboard/leaderboard.js';
import { MedalPlace } from '../../lib/leaderboard/standings.js';
import { SafeHtml, html, memberText, pageLink } from '../html.js';
import { eventLink } from '../links.js';
import { collapsible } from '../ui/collapsible.js';
import {
  DAILY_STREAK_ICON,
  LEADERBOARD_PATH,
  MEDAL_ICON,
  WEEKLY_STREAK_ICON,
  emoji,
  medalBadge,
  monthName,
  plural,
} from './leaderboardKit.js';

/** "1,234 attendees": counts with thousands separators. */
function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th, 21st. */
export function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen
    ? 'th'
    : (({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ??
      'th');
  return `${n}${suffix}`;
}

interface BoardText {
  title: string;
  /** An emoji and its words, before the title. */
  icon?: [string, string];
  value: (n: number) => string;
  /** The board ranks events, not hosts. */
  events?: boolean;
  /** Uses stored medals. */
  medals?: boolean;
}

const BOARDS: Record<AwardKey, BoardText> = {
  attendees: {
    title: 'Most attendees hosted',
    value: (n) => count(n, 'attendee'),
  },
  weeklyStreak: {
    title: 'Longest weekly streak',
    icon: [WEEKLY_STREAK_ICON, 'Weekly streak'],
    value: (n) => `${plural(n, 'week')} in a row`,
  },
  dailyStreak: {
    title: 'Longest daily streak',
    icon: [DAILY_STREAK_ICON, 'Daily streak'],
    value: (n) => `${plural(n, 'day')} in a row`,
  },
  golds: {
    title: 'Most gold medals',
    icon: [MEDAL_ICON[1], 'Gold medal'],
    value: (n) => plural(n, 'gold medal'),
    medals: true,
  },
  medals: {
    title: 'Most medals',
    value: (n) => plural(n, 'medal'),
    medals: true,
  },
  bestMonth: {
    title: 'Most events in one month',
    value: (n) => plural(n, 'event'),
  },
  biggestEvent: {
    title: 'Biggest single event',
    value: (n) => count(n, 'attendee'),
    events: true,
  },
  variety: {
    title: 'Widest variety',
    value: (n) => plural(n, 'event type'),
  },
  monthsActive: {
    title: 'Most months active',
    value: (n) => plural(n, 'month'),
  },
};

/** Renders a host's name (linked to their profile, "You" marked). */
export type NameHtml = (memberId: string) => SafeHtml;

function who(row: AwardRow, nameHtml: NameHtml, key: AwardKey): SafeHtml {
  if (row.event) {
    const hosts = row.memberIds.map((id, i) => {
      return i === 0 ? nameHtml(id) : html`, ${nameHtml(id)}`;
    });
    return html`${eventLink({ title: row.event.title, eventUrl: row.event.eventUrl })}
      <span class="muted award-detail"
        >${dayjs(row.event.day).format('MMM D, YYYY')} · hosted by
        ${hosts}</span
      >`;
  }
  const detail =
    row.detail === undefined || row.detail === ''
      ? ''
      : key === 'bestMonth'
        ? html`<span class="muted award-detail">${monthName(row.detail)}</span>`
        : html`<span class="muted award-detail">${row.detail}</span>`;
  return html`${nameHtml(row.memberIds[0])} ${detail}`;
}

function boardTable(
  board: AwardBoard,
  text: BoardText,
  nameHtml: NameHtml,
): SafeHtml {
  const rows = board.rows.map(
    (row) =>
      html`<tr>
        <td data-label="Place">${row.place}</td>
        ${
          text.events
            ? html`<td class="event" data-label="Event">
                ${who(row, nameHtml, board.key)}
              </td>`
            : html`<td class="event" data-label="Host">
                ${who(row, nameHtml, board.key)}
              </td>`
        }
        <td data-label="Count">${text.value(row.value)}</td>
      </tr>`,
  );
  return html`<table class="stack leaderboard award-board">
      <thead>
        <tr>
          <th>Place</th>
          <th>${text.events ? 'Event' : 'Host'}</th>
          <th>Count</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
    ${
      board.moreTied > 0 && board.morePlace !== undefined
        ? html`<p class="muted">
            ${`and ${board.moreTied} more tied at ${ordinal(board.morePlace)}`}
          </p>`
        : ''
    }`;
}

/**
 * The summary line's leader, as plain text (a link inside a summary would
 * take the click that opens it): "Bea, 1,234 attendees", or "3 tied at …".
 */
function leader(
  board: AwardBoard,
  text: BoardText,
  names: Map<string, string>,
): SafeHtml | '' {
  const first = board.rows.filter((r) => r.place === 1);
  if (first.length === 0) {
    return '';
  }
  if (first.length > 1 || board.moreTied > 0) {
    const n = first.length + (board.morePlace === 1 ? board.moreTied : 0);
    return html`${`${n} tied at ${text.value(first[0].value)}`}`;
  }
  const row = first[0];
  const label =
    text.events && row.event
      ? Array.from(row.event.title).slice(0, 40).join('') +
        (Array.from(row.event.title).length > 40 ? '…' : '')
      : (names.get(row.memberIds[0]) ?? 'Unnamed host');
  return html`${memberText(label)}, ${text.value(row.value)}`;
}

/** The nine boards, each collapsible; the first starts open. */
export function awardsSection(
  data: LeaderboardView,
  nameHtml: NameHtml,
): SafeHtml {
  const boards = data.awards.map((board, i) => {
    const text = BOARDS[board.key];
    const icon = text.icon ? html`${emoji(text.icon[0], text.icon[1])} ` : '';
    const notes: SafeHtml[] = [];
    if (board.key === 'attendees') {
      notes.push(
        html`<p class="muted">
          A co-hosted event counts in full for each of its hosts.
        </p>`,
      );
    }
    if (board.unknownAttendance) {
      notes.push(
        html`<p class="muted">
          ${`${plural(board.unknownAttendance, 'event')} without attendance data ${board.unknownAttendance === 1 ? 'is' : 'are'} left out.`}
        </p>`,
      );
    }
    if (text.medals && data.medalsUnavailable) {
      notes.push(
        html`<p class="note attn">Medals cannot be loaded right now.</p>`,
      );
    }
    const body =
      board.rows.length === 0
        ? html`<p class="muted">No one yet.</p>
            ${notes}`
        : html`${boardTable(board, text, nameHtml)} ${notes}`;
    return collapsible({
      summary: html`${icon}${text.title}`,
      meta: leader(board, text, data.names),
      body,
      open: i === 0,
    });
  });
  return html`<div class="card">
    <h2>All-time awards</h2>
    <p class="muted">
      The top 10 on each board; tied hosts share a place, so a tie for 10th
      shows everyone tied.
    </p>
    <div class="award-boards">${boards}</div>
  </div>`;
}

export interface ArchiveRow {
  memberId: string;
  events: number;
  place: number;
  medal?: MedalPlace;
}

/**
 * Every closed month, newest first, grouped by year (the latest year
 * open; older years are sent collapsed). An awarded month lists its
 * medalists exactly as its ?month= page does (the loader's precomputed
 * `archive`, built with the same monthRows).
 */
export function archiveSection(
  data: LeaderboardView,
  nameHtml: NameHtml,
): SafeHtml {
  const current = data.today.slice(0, 7);
  if (data.firstMonth === undefined || data.firstMonth >= current) {
    return html``;
  }
  const months: string[] = [];
  for (
    let m = dayjs(`${current}-01`).subtract(1, 'month');
    m.format('YYYY-MM') >= data.firstMonth;
    m = m.subtract(1, 'month')
  ) {
    months.push(m.format('YYYY-MM'));
  }
  const byYear = new Map<string, string[]>();
  months.forEach((m) => {
    const y = m.slice(0, 4);
    byYear.set(y, [...(byYear.get(y) ?? []), m]);
  });
  const years = [...byYear].map(([year, list], i) => {
    const items = list.map((month) => {
      const link = html`<a href="${pageLink(LEADERBOARD_PATH, { month })}"
        >${monthName(month)}</a
      >`;
      if (data.medalsUnavailable) {
        // The card's note says medals cannot be loaded: no per-month claim.
        return html`<li>${link}</li>`;
      }
      if (!data.awarded.has(month)) {
        return html`<li>
          ${link}
          <span class="muted">· medals not awarded yet</span>
        </li>`;
      }
      const medalists = (data.archive.get(month) ?? []).filter(
        (r): r is ArchiveRow & { medal: MedalPlace } => r.medal !== undefined,
      );
      if (medalists.length === 0) {
        return html`<li>
          ${link} <span class="muted">· no hosted events</span>
        </li>`;
      }
      const podium = medalists.map(
        (r) =>
          html`<span class="archive-medalist"
            >${medalBadge(r.medal, month)} ${nameHtml(r.memberId)}
            <span class="muted">(${plural(r.events, 'event')})</span></span
          >`,
      );
      return html`<li>${link}: ${podium}</li>`;
    });
    return collapsible({
      summary: year,
      meta: plural(list.length, 'month'),
      body: html`<ul class="archive-months">
        ${items}
      </ul>`,
      open: i === 0,
    });
  });
  return html`<div class="card">
    <h2>Archive</h2>
    <p class="muted">
      Every closed month's medalists. Open a month for its full standings.
    </p>
    ${
      data.medalsUnavailable
        ? html`<p class="note attn">Medals cannot be loaded right now.</p>`
        : ''
    }
    ${years}
  </div>`;
}
