import { SafeHtml, html } from './html.js';

/**
 * Fixed series colours. A series colour is used only when it is a hex
 * constant like these. Each meets 3:1 on both --surface values (#ffffff
 * and #20212b), and the green sits well apart in lightness from the
 * blurple and the coral, so the first three still differ under common
 * colour-vision deficiencies. Line series also get a dash pattern each
 * (see `line`).
 */
export const CHART_COLORS: readonly string[] = [
  '#5462ec', // blurple
  '#d42c3a', // coral
  '#1ea666', // green
  '#986600', // amber
  '#a070f2', // violet
];

export interface ChartSeries {
  label: string;
  values: readonly number[];
  color?: string;
}

export interface ChartInput {
  title: string;
  kind: 'line' | 'bar';
  /** x labels, e.g. '2026-09'. */
  categories: readonly string[];
  series: readonly ChartSeries[];
  /** Default 720 × 260. */
  width?: number;
  height?: number;
  /** The data table's first column heading. Default 'Month'. */
  categoryLabel?: string;
}

const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 260;
const HEX = /^#[0-9a-f]{6}$/i;
/** Per-bar <title> tooltips only up to this many categories. */
export const MAX_TOOLTIP_CATEGORIES = 60;

/** One decimal, and never NaN or Infinity in an attribute. */
function fmt(n: number): string {
  return (Number.isFinite(n) ? n : 0).toFixed(1);
}

/** A drawable value: finite and positive, else 0. */
function clean(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** A size: a finite whole number from 100 to 2000, else the default. */
function size(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 100 && v <= 2000
    ? Math.round(v)
    : fallback;
}

/**
 * A line series. The dash pattern goes with the series index, four
 * patterns repeating like the colours; each is a literal, since the html
 * subset takes no data in stroke-dasharray.
 */
function line(si: number, points: string, color: string): SafeHtml {
  switch (si % 4) {
    case 1:
      return html`<polyline
        points="${points}"
        fill="none"
        stroke="${color}"
        stroke-width="2"
        stroke-dasharray="8 4"
      />`;
    case 2:
      return html`<polyline
        points="${points}"
        fill="none"
        stroke="${color}"
        stroke-width="2"
        stroke-dasharray="2 3"
      />`;
    case 3:
      return html`<polyline
        points="${points}"
        fill="none"
        stroke="${color}"
        stroke-width="2"
        stroke-dasharray="10 3 2 3"
      />`;
    default:
      return html`<polyline
        points="${points}"
        fill="none"
        stroke="${color}"
        stroke-width="2"
      />`;
  }
}

/**
 * Server-drawn SVG under the strict html subset: drawing elements and
 * presentation attributes only (never style=), every label escaped text,
 * no script. Charts hold counts only.
 */
export function chart(input: ChartInput): SafeHtml {
  const width = size(input.width, DEFAULT_WIDTH);
  const height = size(input.height, DEFAULT_HEIGHT);
  if (input.categories.length === 0 || input.series.length === 0) {
    return html`<p class="muted">No data yet for ${input.title}.</p>`;
  }
  const pad = { left: 40, right: 12, top: 12, bottom: 40 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const baseline = pad.top + plotH;
  const n = input.categories.length;
  const yMax = Math.max(
    1,
    ...input.series.flatMap((s) => s.values.slice(0, n).map(clean)),
  );
  const y = (v: number) => baseline - (clean(v) / yMax) * plotH;
  const slot = plotW / n;
  const x = (i: number) => pad.left + slot * (i + 0.5);
  const colorOf = (s: ChartSeries, i: number): string => {
    if (s.color && HEX.test(s.color)) {
      return s.color;
    }
    return CHART_COLORS[i % CHART_COLORS.length];
  };
  // No minimum width: each group stays inside the middle 80% of its slot,
  // so groups never overlap, even at 240 months.
  const barW = (slot * 0.8) / input.series.length;
  // Above this many categories the per-bar tooltips are left out to keep
  // the page small; the data table holds the exact numbers.
  const tooltips = n <= MAX_TOOLTIP_CATEGORIES;

  const marks = input.series.map((s, si) => {
    const color = colorOf(s, si);
    const values = s.values.slice(0, n);
    if (input.kind === 'bar') {
      return values.map((v, i) => {
        const bx = fmt(pad.left + slot * i + slot * 0.1 + barW * si);
        if (!tooltips) {
          return html`<rect
            x="${bx}"
            y="${fmt(y(v))}"
            width="${fmt(barW)}"
            height="${fmt(baseline - y(v))}"
            fill="${color}"
          />`;
        }
        return html`<rect
          x="${bx}"
          y="${fmt(y(v))}"
          width="${fmt(barW)}"
          height="${fmt(baseline - y(v))}"
          fill="${color}"
          ><title>${input.categories[i]}: ${clean(v)}</title></rect
        >`;
      });
    }
    if (values.length === 1) {
      return html`<circle
        cx="${fmt(x(0))}"
        cy="${fmt(y(values[0]))}"
        r="3"
        fill="${color}"
        ><title>${input.categories[0]}: ${clean(values[0])}</title></circle
      >`;
    }
    const points = values.map((v, i) => `${fmt(x(i))},${fmt(y(v))}`).join(' ');
    return line(si, points, color);
  });

  const step = Math.max(1, Math.ceil(n / 12));
  const xLabels = input.categories.map((c, i) => {
    if (i % step !== 0) {
      return '';
    }
    return html`<text
      x="${fmt(x(i))}"
      y="${fmt(baseline + 16)}"
      font-size="11"
      text-anchor="middle"
      >${c}</text
    >`;
  });
  const ticks = [...new Set([0, Math.round(yMax / 2), Math.round(yMax)])];
  const yLabels = ticks.map(
    (v) =>
      html`<text
        x="${fmt(pad.left - 6)}"
        y="${fmt(y(v) + 4)}"
        font-size="11"
        text-anchor="end"
        >${v}</text
      >`,
  );
  // The first swatch sits at the text's x; later ones get a gap. dx is a
  // literal: the html subset takes no data there.
  const legend = input.series.map((s, si) => {
    const color = colorOf(s, si);
    const swatch =
      si === 0
        ? html`<tspan fill="${color}">■</tspan>`
        : html`<tspan dx="12" fill="${color}">■</tspan>`;
    return html`${swatch}<tspan dx="4">${s.label}</tspan>`;
  });

  return html`<figure>
    <svg
      class="chart"
      viewBox="0 0 ${width} ${height}"
      role="img"
      aria-label="${input.title}"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>${input.title}</title>
      <line
        x1="${pad.left}"
        y1="${fmt(baseline)}"
        x2="${width - pad.right}"
        y2="${fmt(baseline)}"
        stroke="#8c959f"
      />
      ${yLabels}${xLabels}${marks}
      <text x="${pad.left}" y="${height - 6}" font-size="11">${legend}</text>
    </svg>
    <details>
      <summary>Data</summary>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>${input.categoryLabel ?? 'Month'}</th>
              ${input.series.map((s) => html`<th>${s.label}</th>`)}
            </tr>
          </thead>
          <tbody>
            ${input.categories.map(
              (c, i) =>
                html`<tr>
                  <td>${c}</td>
                  ${input.series.map(
                    (s) => html`<td>${clean(s.values[i] ?? 0)}</td>`,
                  )}
                </tr>`,
            )}
          </tbody>
        </table>
      </div>
    </details>
  </figure>`;
}
