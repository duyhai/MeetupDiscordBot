import { describe, expect, it } from 'vitest';

import { HostEvent } from '../../../src/lib/hosts/hostEvents.js';
import { localUrl } from '../../../src/web/html.js';
import { heatMapYear } from '../../../src/web/host/heatMap.js';
import {
  CALENDAR_SCRIPT,
  HISTORY_SCRIPT,
} from '../../../src/web/host/hostScripts.js';

const ev = (id: string, dateTime: string, title: string): HostEvent => ({
  id,
  title,
  dateTime,
  eventUrl: `https://www.meetup.com/g/events/${id}/`,
  type: 'social',
  hosts: [],
});

const map = (
  byDay: Map<string, HostEvent[]>,
  year: number,
  today = '2026-11-03',
) =>
  heatMapYear({
    byDay,
    year,
    today,
    dayLink: (day) => localUrl(`/host/history?year=${year}&day=${day}`),
  }).value;

describe('heatMapYear', () => {
  it('draws a whole past year, Jan 1 to Dec 31, and nothing outside it', () => {
    const out = map(new Map(), 2025);
    expect(out.match(/<rect\b/g)).toHaveLength(365);
    expect(out).toContain('<title>2025-01-01: no events</title>');
    expect(out).toContain('<title>2025-12-31: no events</title>');
    expect(out).not.toContain('2024-12-31');
    expect(out).not.toContain('2026-01-01');
    expect(out).toContain('0 events in 2025.');
  });

  it('stops this year at today', () => {
    const out = map(new Map(), 2026, '2026-11-03');
    // Jan 1 to Nov 3, 2026: 307 days.
    expect(out.match(/<rect\b/g)).toHaveLength(307);
    expect(out).not.toContain('2026-11-04');
  });

  it('links only days with events, labelled with each event’s time and title, escaped', () => {
    const byDay = new Map([
      [
        '2026-03-07',
        [
          ev('1', '2026-03-07T10:00:00-08:00', 'Hike'),
          ev('2', '2026-03-07T19:00:00-08:00', '<script>x</script>'),
        ],
      ],
      ['2026-03-08', [ev('3', '2026-03-08T12:00:00-07:00', 'Brunch')]],
    ]);
    const out = map(byDay, 2026);
    expect(out.match(/<a\b/g)).toHaveLength(2);
    expect(out).toContain('href="/host/history?year=2026&amp;day=2026-03-07"');
    expect(out).toContain(
      'aria-label="Sat, Mar 7, 2026: 10:00 AM · Hike; 7:00 PM · &lt;script&gt;x&lt;/script&gt;"',
    );
    expect(out).toContain('data-tip="Sat, Mar 7, 2026\n10:00 AM · Hike\n');
    expect(out).toMatch(/<a\b[^>]*day=2026-03-07"[^>]*>\s*<rect\s+class="hm2"/);
    expect(out).toMatch(/<a\b[^>]*day=2026-03-08"[^>]*>\s*<rect\s+class="hm1"/);
    expect(out).not.toContain('<script>');
    expect(out).toContain('3 events in 2026.');
  });

  it('maps counts to the five literal levels', () => {
    const day = (d: string, n: number): [string, HostEvent[]] => [
      d,
      Array.from({ length: n }, (_, i) =>
        ev(`${d}${i}`, `${d}T12:00:00-07:00`, 'x'),
      ),
    ];
    const out = map(
      new Map([
        day('2026-06-01', 1),
        day('2026-06-02', 2),
        day('2026-06-03', 3),
        day('2026-06-04', 4),
        day('2026-06-05', 7),
      ]),
      2026,
    );
    for (const [d, level] of [
      ['01', 'hm1'],
      ['02', 'hm2'],
      ['03', 'hm3'],
      ['04', 'hm3'],
      ['05', 'hm4'],
    ]) {
      expect(out).toMatch(
        new RegExp(`day=2026-06-${d}"[^>]*>\\s*<rect\\s+class="${level}"`),
      );
    }
    expect(out).not.toContain('style=');
  });
});

describe('HISTORY_SCRIPT', () => {
  it('parses as JavaScript (its \\n escape survives the template)', () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    expect(() => new Function(HISTORY_SCRIPT.value)).not.toThrow();
    expect(HISTORY_SCRIPT.value).toContain("split('\\n')");
  });
});

describe('CALENDAR_SCRIPT', () => {
  it('parses as JavaScript', () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    expect(() => new Function(CALENDAR_SCRIPT.value)).not.toThrow();
  });
});
