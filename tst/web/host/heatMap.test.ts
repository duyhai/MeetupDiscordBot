import { describe, expect, it } from 'vitest';

import { HEAT_WEEKS, heatMap } from '../../../src/web/host/heatMap.js';

describe('heatMap', () => {
  it('draws 53 Sunday-first weeks ending on the given day', () => {
    // 2026-11-07 is a Saturday: every week is full.
    const out = heatMap(new Map(), '2026-11-07').value;
    expect(out.match(/<rect\b/g)).toHaveLength(HEAT_WEEKS * 7);
    expect(out).toContain('<title>2026-11-07: 0 events</title>');
    expect(out).not.toContain('2026-11-08');
  });

  it('stops the last week at the end day', () => {
    // A Tuesday: the last column has Sun, Mon, Tue.
    const out = heatMap(new Map(), '2026-11-03').value;
    expect(out.match(/<rect\b/g)).toHaveLength((HEAT_WEEKS - 1) * 7 + 3);
  });

  it('maps counts to the five literal levels and totals them as text', () => {
    const counts = new Map([
      ['2026-11-01', 1],
      ['2026-11-02', 2],
      ['2026-11-03', 3],
      ['2026-11-04', 4],
      ['2026-11-05', 7],
    ]);
    const out = heatMap(counts, '2026-11-07').value;
    expect(out).toMatch(/class="hm1"[^>]*><title>2026-11-01: 1 event</);
    expect(out).toMatch(/class="hm2"[^>]*><title>2026-11-02: 2 events</);
    expect(out).toMatch(/class="hm3"[^>]*><title>2026-11-03/);
    expect(out).toMatch(/class="hm3"[^>]*><title>2026-11-04/);
    expect(out).toMatch(/class="hm4"[^>]*><title>2026-11-05: 7 events</);
    expect(out).toContain('17 events in the last 12 months.');
    expect(out).not.toContain('style=');
  });
});
