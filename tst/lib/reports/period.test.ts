import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildAsOf,
  comparePeriods,
  GROUP_TIMEZONE,
  isFinished,
  monthLabel,
  nextPeriod,
  parsePeriodKey,
  periodDate,
  periodEnd,
  periodKey,
  periodOf,
  periodStart,
  previousPeriod,
  suspensionCutoff,
  utcDay,
} from '../../../src/lib/reports/period.js';

const iso = (d: Date) => d.toISOString();

describe('period', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the group timezone', () => {
    expect(GROUP_TIMEZONE).toBe('America/Los_Angeles');
  });

  it('bounds are Pacific midnights across DST', () => {
    expect(iso(periodStart({ year: 2026, month: 3 }))).toBe(
      '2026-03-01T08:00:00.000Z',
    );
    expect(iso(periodEnd({ year: 2026, month: 3 }))).toBe(
      '2026-04-01T07:00:00.000Z',
    );
    expect(iso(periodStart({ year: 2026, month: 11 }))).toBe(
      '2026-11-01T07:00:00.000Z',
    );
    expect(iso(periodEnd({ year: 2026, month: 11 }))).toBe(
      '2026-12-01T08:00:00.000Z',
    );
    expect(iso(periodEnd({ year: 2025, month: 12 }))).toBe(
      '2026-01-01T08:00:00.000Z',
    );
    expect(iso(periodStart({ year: 2026, month: 1 }))).toBe(
      '2026-01-01T08:00:00.000Z',
    );
  });

  it('bounds do not depend on the clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-31T12:00:00Z'));
    expect(iso(periodStart({ year: 2026, month: 2 }))).toBe(
      '2026-02-01T08:00:00.000Z',
    );
    expect(iso(periodEnd({ year: 2026, month: 2 }))).toBe(
      '2026-03-01T08:00:00.000Z',
    );
  });

  it('periodKey and periodDate are zero padded', () => {
    expect(periodKey({ year: 2026, month: 9 })).toBe('2026-09');
    expect(periodDate({ year: 2026, month: 9 })).toBe('2026-09-01');
  });

  it('previousPeriod wraps January', () => {
    expect(previousPeriod({ year: 2026, month: 1 })).toEqual({
      year: 2025,
      month: 12,
    });
    expect(previousPeriod({ year: 2026, month: 5 })).toEqual({
      year: 2026,
      month: 4,
    });
    expect(nextPeriod({ year: 2025, month: 12 })).toEqual({
      year: 2026,
      month: 1,
    });
    expect(nextPeriod({ year: 2026, month: 5 })).toEqual({
      year: 2026,
      month: 6,
    });
  });

  it('comparePeriods orders by year then month', () => {
    expect(
      comparePeriods({ year: 2025, month: 12 }, { year: 2026, month: 1 }),
    ).toBeLessThan(0);
    expect(
      comparePeriods({ year: 2026, month: 2 }, { year: 2026, month: 1 }),
    ).toBeGreaterThan(0);
    expect(
      comparePeriods({ year: 2026, month: 2 }, { year: 2026, month: 2 }),
    ).toBe(0);
  });

  it('parsePeriodKey rejects 2026-13, 2026-1, 26-01, ../', () => {
    for (const bad of [
      '2026-13',
      '2026-1',
      '26-01',
      '../',
      '2026-00',
      ' 2026-09',
      '2026-09\n',
      '1999-12',
      '2101-01',
      '',
    ]) {
      expect(parsePeriodKey(bad), JSON.stringify(bad)).toBeUndefined();
    }
    expect(parsePeriodKey('2026-09')).toEqual({ year: 2026, month: 9 });
    expect(periodKey(parsePeriodKey('2026-09'))).toBe('2026-09');
    expect(parsePeriodKey('2000-01')).toEqual({ year: 2000, month: 1 });
    expect(parsePeriodKey('2100-12')).toEqual({ year: 2100, month: 12 });
  });

  it('isFinished flips at Pacific month start', () => {
    const sep = { year: 2026, month: 9 };
    expect(isFinished(sep, new Date('2026-10-01T06:59:59.999Z'))).toBe(false);
    expect(isFinished(sep, new Date('2026-10-01T07:00:00.000Z'))).toBe(true);
    const dec = { year: 2026, month: 12 };
    expect(isFinished(dec, new Date('2027-01-01T07:59:59.999Z'))).toBe(false);
    expect(isFinished(dec, new Date('2027-01-01T08:00:00.000Z'))).toBe(true);
    const mar = { year: 2026, month: 3 };
    expect(isFinished(mar, new Date('2026-04-01T06:59:59.999Z'))).toBe(false);
    expect(isFinished(mar, new Date('2026-04-01T07:00:00.000Z'))).toBe(true);
    const nov = { year: 2026, month: 11 };
    expect(isFinished(nov, new Date('2026-12-01T07:59:59.999Z'))).toBe(false);
    expect(isFinished(nov, new Date('2026-12-01T08:00:00.000Z'))).toBe(true);
  });

  it('periodOf uses the Pacific calendar', () => {
    expect(periodOf(new Date('2026-10-01T06:30:00Z'))).toEqual({
      year: 2026,
      month: 9,
    });
    expect(periodOf(new Date('2026-10-01T07:30:00Z'))).toEqual({
      year: 2026,
      month: 10,
    });
    expect(periodOf(new Date('2027-01-01T07:59:59Z'))).toEqual({
      year: 2026,
      month: 12,
    });
    expect(periodOf(new Date('2027-01-01T08:00:00Z'))).toEqual({
      year: 2027,
      month: 1,
    });
    expect(periodOf(new Date('2026-12-01T07:59:59Z'))).toEqual({
      year: 2026,
      month: 11,
    });
    expect(periodOf(new Date('2026-04-01T06:59:59Z'))).toEqual({
      year: 2026,
      month: 3,
    });
  });

  it('buildAsOf is the month end once finished and now while open', () => {
    const sep = { year: 2026, month: 9 };
    const later = new Date('2026-10-20T12:00:00Z');
    expect(buildAsOf(sep, later)).toEqual(periodEnd(sep));
    expect(buildAsOf(sep, new Date('2026-10-25T00:00:00Z'))).toEqual(
      periodEnd(sep),
    );
    const open = new Date('2026-09-15T12:00:00Z');
    expect(buildAsOf(sep, open)).toEqual(open);
    const exactly = periodEnd(sep);
    expect(buildAsOf(sep, exactly)).toEqual(exactly);
    const justBefore = new Date(exactly.getTime() - 1);
    expect(buildAsOf(sep, justBefore)).toEqual(justBefore);
  });

  it("suspensionCutoff is the next month's first day at 00:00 UTC", () => {
    expect(iso(suspensionCutoff({ year: 2026, month: 9 }))).toBe(
      '2026-10-01T00:00:00.000Z',
    );
    expect(iso(suspensionCutoff({ year: 2026, month: 12 }))).toBe(
      '2027-01-01T00:00:00.000Z',
    );
    expect(iso(suspensionCutoff({ year: 2026, month: 3 }))).toBe(
      '2026-04-01T00:00:00.000Z',
    );
  });

  it('monthLabel names the month', () => {
    expect(monthLabel({ year: 2026, month: 9 })).toBe('September 2026');
    expect(monthLabel({ year: 2026, month: 1 })).toBe('January 2026');
    expect(monthLabel({ year: 2026, month: 12 })).toBe('December 2026');
  });

  it('monthLabel is correct when the clock is on the 31st', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-31T12:00:00Z'));
    expect(monthLabel({ year: 2026, month: 9 })).toBe('September 2026');
    expect(monthLabel({ year: 2026, month: 2 })).toBe('February 2026');
    expect(monthLabel({ year: 2026, month: 11 })).toBe('November 2026');
    vi.setSystemTime(new Date('2026-03-31T12:00:00Z'));
    expect(monthLabel({ year: 2026, month: 2 })).toBe('February 2026');
    expect(monthLabel({ year: 2025, month: 4 })).toBe('April 2025');
  });

  it('utcDay is the UTC calendar date', () => {
    expect(utcDay(new Date('2026-10-05T23:59:59Z'))).toBe('2026-10-05');
    expect(utcDay(new Date('2026-10-06T00:00:00Z'))).toBe('2026-10-06');
  });
});
