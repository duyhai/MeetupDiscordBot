import dayjs from 'dayjs';

import { HostEvent } from '../../lib/hosts/hostEvents.js';
import { SafeHtml, SafeUrl, html } from '../html.js';
import { timeLabel } from './hostPageKit.js';

const CELL = 12;
const GAP = 3;
const LEFT = 28;
const TOP = 16;

const DAY_LABELS: [number, string][] = [
  [1, 'Mon'],
  [3, 'Wed'],
  [5, 'Fri'],
];

/**
 * One cell's rect. The class is one of five literals (the html guard admits
 * no interpolated class): 0, 1, 2, 3-4 and 5+ events that day.
 */
function rect(x: number, y: number, count: number, label: string): SafeHtml {
  const at = { x: String(x), y: String(y) };
  if (count <= 0) {
    // No title: screen readers would otherwise walk ~300 "no events" cells.
    return html`<rect
      class="hm0"
      x="${at.x}"
      y="${at.y}"
      width="12"
      height="12"
      rx="2"
    />`;
  }
  if (count === 1) {
    return html`<rect
      class="hm1"
      x="${at.x}"
      y="${at.y}"
      width="12"
      height="12"
      rx="2"
      ><title>${label}</title></rect
    >`;
  }
  if (count === 2) {
    return html`<rect
      class="hm2"
      x="${at.x}"
      y="${at.y}"
      width="12"
      height="12"
      rx="2"
      ><title>${label}</title></rect
    >`;
  }
  if (count <= 4) {
    return html`<rect
      class="hm3"
      x="${at.x}"
      y="${at.y}"
      width="12"
      height="12"
      rx="2"
      ><title>${label}</title></rect
    >`;
  }
  return html`<rect
    class="hm4"
    x="${at.x}"
    y="${at.y}"
    width="12"
    height="12"
    rx="2"
    ><title>${label}</title></rect
  >`;
}

/** "Sat, Mar 7, 2026", then one "7:00 PM · Title" line per event. */
function tipLines(day: string, events: HostEvent[]): string[] {
  return [
    dayjs(day).format('ddd, MMM D, YYYY'),
    ...events.map((e) => `${timeLabel(e.dateTime)} · ${e.title}`),
  ];
}

export interface HeatYear {
  /** The host's events by Pacific day (YYYY-MM-DD). */
  byDay: Map<string, HostEvent[]>;
  year: number;
  /** Today, Pacific: the current year's map stops here. */
  today: string;
  /** The day filter's link for a day with events. */
  dayLink: (day: string) => SafeUrl;
}

/**
 * One calendar year, GitHub-contribution style: Sunday-first week columns
 * from the week of Jan 1 to Dec 31 (or today, this year). A day with
 * events is a link to the day filter; its aria-label and title list each
 * event's time and title, and HISTORY_SCRIPT shows the same lines as a
 * tooltip. Empty days are plain cells, so the map adds one tab stop per
 * hosted day, not 365. The total is also text.
 */
export function heatMapYear({
  byDay,
  year,
  today,
  dayLink,
}: HeatYear): SafeHtml {
  const first = dayjs(`${year}-01-01`);
  const yearEnd = dayjs(`${year}-12-31`);
  const end = today < yearEnd.format('YYYY-MM-DD') ? dayjs(today) : yearEnd;
  const firstSunday = first.subtract(first.day(), 'day');
  const weeks = Math.ceil((end.diff(firstSunday, 'day') + 1) / 7);
  const cells: SafeHtml[] = [];
  const months: SafeHtml[] = [];
  let total = 0;
  let lastMonth = -1;
  for (let week = 0; week < weeks; week += 1) {
    const weekStart = firstSunday.add(week * 7, 'day');
    const labelDay = week === 0 ? first : weekStart;
    if (labelDay.month() !== lastMonth) {
      lastMonth = labelDay.month();
      // Skip a label too close to the right edge to fit ("Nov" needs two
      // columns).
      if (week < weeks - 1) {
        months.push(
          html`<text
            x="${String(LEFT + week * (CELL + GAP))}"
            y="10"
            font-size="10"
            >${labelDay.format('MMM')}</text
          >`,
        );
      }
    }
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const date = weekStart.add(weekday, 'day');
      if (date.isBefore(first, 'day')) {
        continue;
      }
      if (date.isAfter(end, 'day')) {
        break;
      }
      const day = date.format('YYYY-MM-DD');
      const events = byDay.get(day) ?? [];
      total += events.length;
      const x = LEFT + week * (CELL + GAP);
      const y = TOP + weekday * (CELL + GAP);
      if (events.length === 0) {
        cells.push(rect(x, y, 0, ''));
        continue;
      }
      const lines = tipLines(day, events);
      const label = `${lines[0]}: ${lines.slice(1).join('; ')}`;
      cells.push(
        html`<a
          class="hm-link"
          href="${dayLink(day)}"
          aria-label="${label}"
          data-tip="${lines.join('\n')}"
          >${rect(x, y, events.length, label)}</a
        >`,
      );
    }
  }
  const labels = DAY_LABELS.map(
    ([weekday, text]) =>
      html`<text
        x="0"
        y="${String(TOP + weekday * (CELL + GAP) + 10)}"
        font-size="10"
        >${text}</text
      >`,
  );
  const width = LEFT + weeks * (CELL + GAP);
  const height = TOP + 7 * (CELL + GAP);
  return html`<div class="table-scroll heat-wrap">
      <svg
        class="heat"
        role="group"
        aria-label="Events hosted per day in ${String(year)}: ${total} in total"
        viewBox="0 0 ${String(width)} ${String(height)}"
        width="${String(width)}"
        height="${String(height)}"
      >
        ${months}${labels}${cells}
      </svg>
    </div>
    <p class="muted">
      ${total} ${total === 1 ? 'event' : 'events'} in ${String(year)}. Point at
      or tap a coloured day to see its events; open it to list them below.
    </p>`;
}
