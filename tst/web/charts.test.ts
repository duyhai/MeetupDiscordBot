import { describe, expect, it } from 'vitest';

import { CHART_COLORS, ChartInput, chart } from '../../src/web/charts.js';
import { html } from '../../src/web/html.js';

const base: ChartInput = {
  title: 'No-shows per month',
  kind: 'bar',
  categories: ['2026-08', '2026-09'],
  series: [{ label: 'No-shows', values: [3, 5] }],
};

const render = (input: Partial<ChartInput> = {}) =>
  chart({ ...base, ...input }).value;

describe('chart', () => {
  it('escapes labels', () => {
    for (const kind of ['bar', 'line'] as const) {
      const out = render({
        kind,
        title: '<b>"title"</b>',
        categories: ['</text><script>alert(1)</script>', '2026-09'],
        series: [{ label: '<img onerror=x>', values: [1, 2] }],
      });
      expect(out).not.toContain('<script');
      expect(out).not.toContain('<img');
      expect(out).not.toContain('<b>');
      expect(out).toContain(
        '&lt;/text&gt;&lt;script&gt;alert(1)&lt;/script&gt;',
      );
      expect(out).toContain('&lt;img onerror=x&gt;');
      expect(out).toContain(
        'aria-label="&lt;b&gt;&quot;title&quot;&lt;/b&gt;"',
      );
    }
  });

  it('uses no style attributes', () => {
    for (const kind of ['bar', 'line'] as const) {
      expect(render({ kind })).not.toMatch(/style\s*=/i);
    }
  });

  it('emits no script or event handlers', () => {
    for (const kind of ['bar', 'line'] as const) {
      const out = render({ kind });
      expect(out).not.toMatch(/<script/i);
      expect(out).not.toMatch(/\son[a-z]+=/i);
    }
  });

  it('draws one svg with a viewBox, an aria-label and per-bar titles', () => {
    const out = render();
    expect(out.match(/<svg\s+class="chart"/g)).toHaveLength(1);
    expect(out).toContain('viewBox="0 0 720 260"');
    expect(out).toMatch(/role="img"\s+aria-label="No-shows per month"/);
    expect(out.match(/<rect\s/g)).toHaveLength(2);
    expect(out).toMatch(/<title>2026-09: 5<\/title>\s*<\/rect\s*>/);
  });

  it('can be placed in an html template', () => {
    const out = html`<div>${chart(base)}</div>`.value;
    expect(out).toMatch(/<svg\s+class="chart"/);
  });

  it('handles a single point', () => {
    const out = render({
      kind: 'line',
      categories: ['2026-09'],
      series: [{ label: 'Linked', values: [4] }],
    });
    expect(out).toContain('<circle');
    expect(out).not.toContain('<polyline');
    expect(out).not.toMatch(/NaN|Infinity/);
  });

  it('handles all-zero series', () => {
    for (const kind of ['bar', 'line'] as const) {
      const out = render({
        kind,
        series: [
          { label: 'A', values: [0, 0] },
          { label: 'B', values: [0, 0] },
        ],
      });
      expect(out).not.toMatch(/NaN|Infinity/);
      if (kind === 'bar') {
        const heights = [
          ...out.matchAll(/<rect\s[^>]*\sheight="([^"]+)"/g),
        ].map((m) => m[1]);
        expect(heights).toHaveLength(4);
        expect(new Set(heights)).toEqual(new Set(['0.0']));
        // Zero-height bars sit on the baseline (260 - 40 bottom padding).
        const ys = [...out.matchAll(/<rect\s[^>]*\sy="([^"]+)"/g)].map(
          (m) => m[1],
        );
        expect(new Set(ys)).toEqual(new Set(['220.0']));
      }
    }
  });

  it('negative and NaN values draw as zero', () => {
    const out = render({
      series: [{ label: 'A', values: [-5, Number.NaN] }],
    });
    expect(out).not.toMatch(/NaN|Infinity|-5/);
    const heights = [...out.matchAll(/<rect\s[^>]*\sheight="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(heights).toEqual(['0.0', '0.0']);
    expect(out).toContain('<td>0</td>');
  });

  it('keeps an infinite value and a bad size out of the attributes', () => {
    const out = render({
      width: Number.NaN,
      height: Number.POSITIVE_INFINITY,
      series: [{ label: 'A', values: [Number.POSITIVE_INFINITY, 2] }],
    });
    expect(out).not.toMatch(/NaN|Infinity/);
    expect(out).toContain('viewBox="0 0 720 260"');
  });

  it('refuses a colour that is not a hex constant', () => {
    const out = render({
      series: [{ label: 'A', values: [1, 2], color: 'red" onload="x' }],
    });
    expect(out).not.toContain('onload');
    expect(out).toContain(`fill="${CHART_COLORS[0]}"`);
    const ok = render({
      series: [{ label: 'A', values: [1, 2], color: '#123abc' }],
    });
    expect(ok).toContain('fill="#123abc"');
  });

  it('gives each line series its own literal dash pattern', () => {
    const out = render({
      kind: 'line',
      series: ['A', 'B', 'C', 'D', 'E'].map((label) => ({
        label,
        values: [1, 2],
      })),
    });
    const lines = [...out.matchAll(/<polyline\s[^>]*>/g)].map((m) => m[0]);
    expect(lines).toHaveLength(5);
    const dash = (tag: string) =>
      /\sstroke-dasharray="([^"]+)"/.exec(tag)?.[1] ?? 'solid';
    const patterns = lines.map(dash);
    expect(patterns[0]).toBe('solid');
    expect(new Set(patterns.slice(0, 4)).size).toBe(4);
    // Patterns repeat with the colours.
    expect(patterns[4]).toBe(patterns[0]);
  });

  it('empty input says no data', () => {
    expect(render({ categories: [] })).toContain(
      'No data yet for No-shows per month.',
    );
    expect(render({ series: [] })).not.toContain('<svg');
  });

  it('labels the data table column', () => {
    expect(render()).toContain('<th>Month</th>');
    expect(render({ categoryLabel: 'Day' })).toContain('<th>Day</th>');
  });
  const months = (count: number) =>
    Array.from({ length: count }, (_, i) => `m${i}`);
  const threeSeries = (count: number) =>
    ['A', 'B', 'C'].map((label) => ({
      label,
      values: Array.from({ length: count }, (_, i) => i + 1),
    }));
  const rects = (out: string) =>
    [...out.matchAll(/<rect\s[^>]*?\sx="([^"]+)"[^>]*?\swidth="([^"]+)"/g)].map(
      (m) => ({ x: Number(m[1]), width: Number(m[2]) }),
    );

  it('keeps every bar group inside its own slot at 240 months', () => {
    const n = 240;
    const out = render({ categories: months(n), series: threeSeries(n) });
    const bars = rects(out);
    expect(bars).toHaveLength(n * 3);
    // Default 720 wide, 40 left and 12 right padding.
    const slot = (720 - 40 - 12) / n;
    bars.forEach((bar, k) => {
      const i = k % n;
      const slotStart = 40 + slot * i;
      expect(bar.width).toBeGreaterThan(0);
      expect(bar.x).toBeGreaterThanOrEqual(slotStart);
      expect(bar.x + bar.width).toBeLessThanOrEqual(slotStart + slot);
    });
  });

  it('skips per-bar tooltips above 60 categories', () => {
    const at60 = render({ categories: months(60), series: threeSeries(60) });
    expect(at60.match(/<\/title>\s*<\/rect/g)).toHaveLength(180);
    const at61 = render({ categories: months(61), series: threeSeries(61) });
    expect(at61).not.toMatch(/<\/title>\s*<\/rect/);
    expect(rects(at61)).toHaveLength(183);
    // The chart's own title and the data table remain.
    expect(at61).toContain('<title>No-shows per month</title>');
    expect(at61).toContain('<td>m60</td>');
  });
});
