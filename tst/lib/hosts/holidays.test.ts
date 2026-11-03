import { describe, expect, it } from 'vitest';

import { calendarDates } from '../../../src/lib/hosts/holidays.js';

const named = (from: string, to: string) =>
  Object.fromEntries(calendarDates(from, to).map((d) => [d.name, d.day]));

describe('calendarDates', () => {
  it('computes the moving US holidays for 2026', () => {
    const d = named('2026-01-01', '2026-12-31');
    expect(d['Martin Luther King Jr. Day']).toBe('2026-01-19');
    expect(d["Presidents' Day"]).toBe('2026-02-16');
    expect(d["Mother's Day"]).toBe('2026-05-10');
    expect(d['Memorial Day']).toBe('2026-05-25');
    expect(d["Father's Day"]).toBe('2026-06-21');
    expect(d['Labor Day']).toBe('2026-09-07');
    expect(d["Indigenous Peoples' Day"]).toBe('2026-10-12');
    expect(d.Thanksgiving).toBe('2026-11-26');
  });

  it('crosses a year boundary and keeps day order', () => {
    const days = calendarDates('2026-12-20', '2027-02-10');
    expect(days.map((d) => d.name)).toEqual([
      'Christmas Eve',
      'Christmas Day',
      "New Year's Eve",
      "New Year's Day",
      'Martin Luther King Jr. Day',
      'Lunar New Year',
    ]);
    expect(days.at(-1)).toEqual({
      day: '2027-02-06',
      name: 'Lunar New Year',
      kind: 'cultural',
    });
  });

  it('is inclusive at both ends', () => {
    expect(calendarDates('2026-07-04', '2026-07-04')).toHaveLength(1);
    expect(calendarDates('2026-07-05', '2026-07-05')).toHaveLength(0);
  });
});
