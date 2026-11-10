import { SafeHtml, html } from './html.js';

/**
 * Fallback series colours, written into fill/stroke attributes. On a styled
 * page the stylesheet's per-palette tokens (--chart-1 to --chart-5, via the
 * literal series classes s1 to s5 set by `seriesGroup` and `legendSwatch`)
 * override them, light and dark; the attributes still colour the SVG when
 * it is viewed on its own. A series colour given by the caller is used only
 * when it is a hex constant like these, and then no class is set, so the
 * caller's colour stands. Line series also get a dash pattern each (see
 * `line`).
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

/** Legend glyphs for line series, matching `line`'s dash per index: solid, 8 4, 2 3, 10 3 2 3. */
const LINE_GLYPHS: readonly string[] = ['━', '╍', '┅', '─·'];

/**
 * A series' marks in a <g> carrying its literal class (the html subset
 * takes no data in class), so the stylesheet can colour them per palette;
 * a caller-coloured series gets a plain <g>.
 */
function seriesGroup(
  si: number,
  own: boolean,
  marks: SafeHtml | SafeHtml[],
): SafeHtml {
  if (own) {
    return html`<g>${marks}</g>`;
  }
  switch (si % 5) {
    case 1:
      return html`<g class="s2">${marks}</g>`;
    case 2:
      return html`<g class="s3">${marks}</g>`;
    case 3:
      return html`<g class="s4">${marks}</g>`;
    case 4:
      return html`<g class="s5">${marks}</g>`;
    default:
      return html`<g class="s1">${marks}</g>`;
  }
}

/** The legend's swatch glyph, classed like its series (see `seriesGroup`). */
function legendSwatch(
  si: number,
  own: boolean,
  color: string,
  glyph: string,
): SafeHtml {
  if (si === 0) {
    return own
      ? html`<tspan fill="${color}">${glyph}</tspan>`
      : html`<tspan class="s1" fill="${color}">${glyph}</tspan>`;
  }
  if (own) {
    return html`<tspan dx="12" fill="${color}">${glyph}</tspan>`;
  }
  switch (si % 5) {
    case 1:
      return html`<tspan class="s2" dx="12" fill="${color}">${glyph}</tspan>`;
    case 2:
      return html`<tspan class="s3" dx="12" fill="${color}">${glyph}</tspan>`;
    case 3:
      return html`<tspan class="s4" dx="12" fill="${color}">${glyph}</tspan>`;
    case 4:
      return html`<tspan class="s5" dx="12" fill="${color}">${glyph}</tspan>`;
    default:
      return html`<tspan class="s1" dx="12" fill="${color}">${glyph}</tspan>`;
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
  const colorOf = (
    s: ChartSeries,
    i: number,
  ): { color: string; own: boolean } => {
    if (s.color && HEX.test(s.color)) {
      return { color: s.color, own: true };
    }
    return { color: CHART_COLORS[i % CHART_COLORS.length], own: false };
  };
  // No minimum width: each group stays inside the middle 80% of its slot,
  // so groups never overlap, even at 240 months.
  const barW = (slot * 0.8) / input.series.length;
  // Above this many categories the per-bar tooltips are left out to keep
  // the page small; the data table holds the exact numbers.
  const tooltips = n <= MAX_TOOLTIP_CATEGORIES;

  const marks = input.series.map((s, si) => {
    const { color, own } = colorOf(s, si);
    const values = s.values.slice(0, n);
    if (input.kind === 'bar') {
      const bars = values.map((v, i) => {
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
      return seriesGroup(si, own, bars);
    }
    if (values.length === 1) {
      return seriesGroup(
        si,
        own,
        html`<circle
          cx="${fmt(x(0))}"
          cy="${fmt(y(values[0]))}"
          r="3"
          fill="${color}"
          ><title>${input.categories[0]}: ${clean(values[0])}</title></circle
        >`,
      );
    }
    const points = values.map((v, i) => `${fmt(x(i))},${fmt(y(v))}`).join(' ');
    return seriesGroup(si, own, line(si, points, color));
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
  // A line's swatch draws its dash (see `line`); a bar's is a square. The
  // glyph is escaped text, not an attribute.
  const legend = input.series.map((s, si) => {
    const { color, own } = colorOf(s, si);
    const glyph = input.kind === 'line' ? LINE_GLYPHS[si % 4] : '■';
    const swatch = legendSwatch(si, own, color, glyph);
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
