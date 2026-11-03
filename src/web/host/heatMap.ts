import dayjs from 'dayjs';

import { SafeHtml, html } from '../html.js';

export const HEAT_WEEKS = 53;
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
 * One cell. The class is one of five literals (the html guard admits no
 * interpolated class): 0, 1, 2, 3-4 and 5+ events that day.
 */
function cell(x: number, y: number, day: string, count: number): SafeHtml {
  const label = `${day}: ${count} ${count === 1 ? 'event' : 'events'}`;
  const at = { x: String(x), y: String(y) };
  if (count <= 0) {
    return html`<rect
      class="hm0"
      x="${at.x}"
      y="${at.y}"
      width="12"
      height="12"
      rx="2"
      ><title>${label}</title></rect
    >`;
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
 * GitHub-contribution style: 53 Sunday-first week columns ending with the
 * week of `endDay` (YYYY-MM-DD), one cell per day up to `endDay`. Counts
 * only, never names. The total is also written as text, so the picture is
 * never the only way to read it.
 */
export function heatMap(counts: Map<string, number>, endDay: string): SafeHtml {
  const end = dayjs(endDay);
  const firstSunday = end
    .subtract(end.day(), 'day')
    .subtract((HEAT_WEEKS - 1) * 7, 'day');
  const cells: SafeHtml[] = [];
  const months: SafeHtml[] = [];
  let total = 0;
  let lastMonth = -1;
  for (let week = 0; week < HEAT_WEEKS; week += 1) {
    const weekStart = firstSunday.add(week * 7, 'day');
    if (weekStart.month() !== lastMonth) {
      lastMonth = weekStart.month();
      // Skip a label too close to the right edge to fit.
      if (week < HEAT_WEEKS - 2) {
        months.push(
          html`<text
            x="${String(LEFT + week * (CELL + GAP))}"
            y="10"
            font-size="10"
            >${weekStart.format('MMM')}</text
          >`,
        );
      }
    }
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const date = weekStart.add(weekday, 'day');
      if (date.isAfter(end, 'day')) {
        break;
      }
      const day = date.format('YYYY-MM-DD');
      const count = counts.get(day) ?? 0;
      total += count;
      cells.push(
        cell(
          LEFT + week * (CELL + GAP),
          TOP + weekday * (CELL + GAP),
          day,
          count,
        ),
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
  const width = LEFT + HEAT_WEEKS * (CELL + GAP);
  const height = TOP + 7 * (CELL + GAP);
  return html`<div class="table-scroll heat-wrap">
      <svg
        class="heat"
        role="img"
        viewBox="0 0 ${String(width)} ${String(height)}"
        width="${String(width)}"
        height="${String(height)}"
      >
        <title>
          Events hosted per day over the past year: ${total} in total
        </title>
        ${months}${labels}${cells}
      </svg>
    </div>
    <p class="muted">
      ${total} ${total === 1 ? 'event' : 'events'} in the past year shown.
    </p>`;
}
