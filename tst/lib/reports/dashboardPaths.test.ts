import { describe, expect, it } from 'vitest';

import {
  DASHBOARD_PATHS,
  dashboardPath,
  memberHistoryPath,
  MonthBeforeGroupError,
  linkableMonthPath,
  monthPageUrls,
  monthPath,
} from '../../../src/lib/reports/dashboardPaths.js';
import { Period } from '../../../src/lib/reports/period.js';

describe('dashboardPaths', () => {
  it('monthPageUrls builds exact URLs from PUBLIC_APP_ORIGIN and the month key', () => {
    expect(monthPageUrls({ year: 2026, month: 9 })).toEqual({
      hallOfFame:
        'https://meetup-discord-bot.herokuapp.com/dashboard/hall-of-fame/2026-09',
      noShowHistory:
        'https://meetup-discord-bot.herokuapp.com/dashboard/no-show-history/2026-09',
    });
  });

  it('pads January', () => {
    expect(monthPageUrls({ year: 2027, month: 1 }).hallOfFame).toBe(
      'https://meetup-discord-bot.herokuapp.com/dashboard/hall-of-fame/2027-01',
    );
    expect(
      monthPath(DASHBOARD_PATHS.noShowHistoryMonth, { year: 2027, month: 1 }),
    ).toBe('/dashboard/no-show-history/2027-01');
  });

  it.each<[string, Period]>([
    ['month 13', { year: 2026, month: 13 }],
    ['month 0', { year: 2026, month: 0 }],
    ['fractional month', { year: 2026, month: 9.5 }],
    ['year before 2000', { year: 1999, month: 9 }],
    ['path text as year', { year: '../x' as unknown as number, month: 9 }],
  ])('refuses a month parsePeriodKey would reject: %s', (_name, period) => {
    expect(() => monthPath(DASHBOARD_PATHS.hallOfFameMonth, period)).toThrow(
      RangeError,
    );
    expect(() => monthPageUrls(period)).toThrow(RangeError);
  });

  it('refuses a month before the group began (2013-02) and accepts its first (2013-03)', () => {
    const before: Period = { year: 2013, month: 2 };
    for (const template of [
      DASHBOARD_PATHS.hallOfFameMonth,
      DASHBOARD_PATHS.noShowHistoryMonth,
      DASHBOARD_PATHS.refresh,
    ] as const) {
      expect(() => monthPath(template, before)).toThrow(MonthBeforeGroupError);
    }
    expect(() => monthPageUrls(before)).toThrow(MonthBeforeGroupError);
    expect(() => monthPageUrls({ year: 2012, month: 12 })).toThrow(
      MonthBeforeGroupError,
    );
    expect(new MonthBeforeGroupError()).toBeInstanceOf(RangeError);
    expect(monthPageUrls({ year: 2013, month: 3 })).toEqual({
      hallOfFame:
        'https://meetup-discord-bot.herokuapp.com/dashboard/hall-of-fame/2013-03',
      noShowHistory:
        'https://meetup-discord-bot.herokuapp.com/dashboard/no-show-history/2013-03',
    });
    expect(monthPath(DASHBOARD_PATHS.refresh, { year: 2013, month: 3 })).toBe(
      '/dashboard/reports/2013-03/refresh',
    );
  });

  it('linkableMonthPath gives the path, or undefined where monthPath refuses', () => {
    const t = DASHBOARD_PATHS.noShowHistoryMonth;
    expect(linkableMonthPath(t, { year: 2026, month: 9 })).toBe(
      '/dashboard/no-show-history/2026-09',
    );
    expect(linkableMonthPath(t, { year: 2013, month: 3 })).toBe(
      '/dashboard/no-show-history/2013-03',
    );
    expect(linkableMonthPath(t, { year: 2013, month: 2 })).toBeUndefined();
    expect(linkableMonthPath(t, { year: 2026, month: 13 })).toBeUndefined();
  });

  it('memberHistoryPath builds only from 1-20 digits', () => {
    expect(memberHistoryPath('123')).toBe(
      '/dashboard/no-show-history/members/123',
    );
    expect(memberHistoryPath('1'.repeat(20))).toBe(
      `/dashboard/no-show-history/members/${'1'.repeat(20)}`,
    );
    for (const bad of ['12a', '', '1'.repeat(21), '../1', ' 1']) {
      expect(memberHistoryPath(bad)).toBeUndefined();
    }
    expect(memberHistoryPath(123 as unknown as string)).toBeUndefined();
  });

  it('dashboardPath refuses a parameterised path', () => {
    expect(dashboardPath(DASHBOARD_PATHS.trends)).toBe('/dashboard/trends');
    // The sessions pages are in the shared table too (nav, forms, redirects).
    expect(dashboardPath(DASHBOARD_PATHS.sessions)).toBe('/dashboard/sessions');
    expect(dashboardPath(DASHBOARD_PATHS.revokeSessions)).toBe(
      '/dashboard/sessions/revoke',
    );
    // The type refuses a parameterised template (tsc checks the directive);
    // the runtime check still throws if a cast slips one through.
    // @ts-expect-error a template with a parameter is not a dashboardPath
    expect(() => dashboardPath(DASHBOARD_PATHS.hallOfFameMonth)).toThrow(
      RangeError,
    );
    expect(() => dashboardPath(DASHBOARD_PATHS.identityThumb as never)).toThrow(
      RangeError,
    );
  });
});
