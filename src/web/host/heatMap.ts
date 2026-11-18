import dayjs from 'dayjs';

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

/**
 * A hosted day's mark: the whole cell green (`half` false) or its lower
 * right half (a day also attended, over the attended colour), with a dot
 * in the green either way, so hosting reads without the colour too.
 */
function hostedMark(x: number, y: number, half: boolean): SafeHtml {
  if (!half) {
    return html`<rect
        class="hh"
        x="${String(x)}"
        y="${String(y)}"
        width="12"
        height="12"
        rx="2"
      /><circle
        class="hm-dot"
        cx="${String(x + 6)}"
        cy="${String(y + 6)}"
        r="2"
      />`;
  }
  const d = `M${x + 12} ${y} V${y + 10} Q${x + 12} ${y + 12} ${x + 10} ${y + 12} H${x} Z`;
  return html`<path class="hh" d="${d}" /><circle
      class="hm-dot"
      cx="${String(x + 8.5)}"
      cy="${String(y + 8.5)}"
      r="1.5"
    />`;
}

const DAY_FORMAT = 'ddd, MMM D, YYYY';
const eventLine = (e: HeatEvent) => `${timeLabel(e.dateTime)} · ${e.title}`;

/** "Sat, Mar 7, 2026", then one "7:00 PM · Title" line per event. */
function tipLines(day: string, events: HeatEvent[]): string[] {
  return [dayjs(day).format(DAY_FORMAT), ...events.map(eventLine)];
}

/** As tipLines, each event marked hosted or attended, hosted first. */
function splitTipLines(
  day: string,
  attended: HeatEvent[],
  hosted: HeatEvent[],
): string[] {
  return [
    dayjs(day).format(DAY_FORMAT),
    ...hosted.map((e) => `Hosted: ${eventLine(e)}`),
    ...attended.map((e) => `Attended: ${eventLine(e)}`),
  ];
}

/** The two-colour map's key: the swatches are decoration, the words say it. */
function legend(): SafeHtml {
  const swatch = (inner: SafeHtml) =>
    html`<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      ${inner}
    </svg>`;
  return html`<ul class="heat-legend">
    <li>
      ${swatch(html`<rect class="hm3" x="0" y="0" width="12" height="12" rx="2" />`)}
      Attended
    </li>
    <li>${swatch(hostedMark(0, 0, false))} Hosted (with a dot)</li>
    <li>
      ${swatch(html`<rect class="hm3" x="0" y="0" width="12" height="12" rx="2" />${hostedMark(0, 0, true)}`)}
      Both that day
    </li>
  </ul>`;
}

/** What a cell needs of an event: when, and a title for its tooltip. */
export interface HeatEvent {
  dateTime: string;
  title: string;
}

export interface HeatYear {
  /** The events by Pacific day (YYYY-MM-DD). */
  byDay: Map<string, HeatEvent[]>;
  year: number;
  /** Today, Pacific: the current year's map stops here. */
  today: string;
  /** The day filter's link for a day with events. */
  dayLink: (day: string) => SafeUrl;
  /** What the events are to the member, for the map's label. */
  verb?: 'hosted' | 'attended';
  /**
   * The days hosted, by Pacific day, when `byDay` is the days attended: the
   * map is drawn in two colours (attended as the scale, hosted green, a day
   * with both split) with a key, and each day's label says which is which.
   */
  hostedByDay?: Map<string, HeatEvent[]>;
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
  verb = 'hosted',
  hostedByDay,
}: HeatYear): SafeHtml {
  const first = dayjs(`${year}-01-01`);
  const yearEnd = dayjs(`${year}-12-31`);
  const end = today < yearEnd.format('YYYY-MM-DD') ? dayjs(today) : yearEnd;
  const firstSunday = first.subtract(first.day(), 'day');
  const weeks = Math.ceil((end.diff(firstSunday, 'day') + 1) / 7);
  const cells: SafeHtml[] = [];
  const months: SafeHtml[] = [];
  let total = 0;
  let hostedTotal = 0;
  let lastMonth = -1;
  for (let week = 0; week < weeks; week += 1) {
    const weekStart = firstSunday.add(week * 7, 'day');
    const labelDay = week === 0 ? first : weekStart;
    if (labelDay.month() !== lastMonth) {
      lastMonth = labelDay.month();
      // Skip a label too close to the right edge to fit ("Nov" needs two
      // columns), except the first: early in January it is the only one.
      if (week < weeks - 1 || months.length === 0) {
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
      const hosted = hostedByDay?.get(day) ?? [];
      total += events.length;
      hostedTotal += hosted.length;
      const x = LEFT + week * (CELL + GAP);
      const y = TOP + weekday * (CELL + GAP);
      if (events.length === 0 && hosted.length === 0) {
        cells.push(rect(x, y, 0, ''));
        continue;
      }
      const lines = hostedByDay
        ? splitTipLines(day, events, hosted)
        : tipLines(day, events);
      const label = `${lines[0]}: ${lines.slice(1).join('; ')}`;
      let cell: SafeHtml;
      if (hosted.length === 0) {
        cell = rect(x, y, events.length, label);
      } else if (events.length === 0) {
        cell = html`<title>${label}</title>${hostedMark(x, y, false)}`;
      } else {
        cell = html`${rect(x, y, events.length, label)}${hostedMark(x, y, true)}`;
      }
      cells.push(
        html`<a
          class="hm-link"
          href="${dayLink(day)}"
          aria-label="${label}"
          data-tip="${lines.join('\n')}"
          >${cell}</a
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
  // At least two columns wide, so the first month's label always fits.
  const width = LEFT + Math.max(weeks, 2) * (CELL + GAP);
  const height = TOP + 7 * (CELL + GAP);
  const mapLabel = hostedByDay
    ? `Events attended and hosted per day in ${year}: ${total} attended, ${hostedTotal} hosted`
    : `Events ${verb} per day in ${year}: ${total} in total`;
  const totals = hostedByDay
    ? `${total} ${total === 1 ? 'event' : 'events'} attended and ${hostedTotal} hosted in ${year}.`
    : `${total} ${total === 1 ? 'event' : 'events'} in ${year}.`;
  return html`<div class="table-scroll heat-wrap">
      <svg
        class="heat"
        role="group"
        aria-label="${mapLabel}"
        viewBox="0 0 ${String(width)} ${String(height)}"
        width="${String(width)}"
        height="${String(height)}"
      >
        ${months}${labels}${cells}
      </svg>
    </div>
    ${hostedByDay ? legend() : ''}
    <p class="muted">
      ${totals} Point at or tap a coloured day to see its events; open it to
      list them below.
    </p>`;
}
