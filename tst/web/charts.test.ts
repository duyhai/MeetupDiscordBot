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
});
