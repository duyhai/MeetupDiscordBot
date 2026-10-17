import { describe, expect, it } from 'vitest';

import {
  BUILD_UTC_HOUR,
  canStartLinkProgress,
  canStartMonthBuild,
  DueItem,
  dueTimeToday,
  isQuietHour,
  planDueWork,
  PREVIOUS_MONTH_LAST_DAILY_DAY,
  snapshotKey,
} from '../../../src/lib/reports/buildSchedule.js';
import { Period } from '../../../src/lib/reports/period.js';
import { ReportType } from '../../../src/lib/reports/types.js';

const SEPT: Period = { year: 2026, month: 9 };
const OCT: Period = { year: 2026, month: 10 };

function built(entries: [ReportType, Period, string][]): Map<string, Date> {
  return new Map(
    entries.map(([type, period, iso]) => [
      snapshotKey(type, period),
      new Date(iso),
    ]),
  );
}

function both(period: Period, iso: string): [ReportType, Period, string][] {
  return [
    ['hall_of_fame', period, iso],
    ['no_show', period, iso],
  ];
}

function plan(
  now: string,
  entries: [ReportType, Period, string][] = [],
  linkProgressWrittenToday = true,
): DueItem[] {
  return planDueWork({
    now: new Date(now),
    builtAt: built(entries),
    linkProgressWrittenToday,
  });
}

const previousItems = (items: DueItem[]) =>
  items.filter(
    (item) =>
      item.kind === 'month' &&
      item.period.year === SEPT.year &&
      item.period.month === SEPT.month,
  );

describe('buildSchedule', () => {
  it('exposes the fixed constants and snapshot keys', () => {
    expect(BUILD_UTC_HOUR).toBe(16);
    expect(PREVIOUS_MONTH_LAST_DAILY_DAY).toBe(7);
    expect(snapshotKey('no_show', SEPT)).toBe('no_show:2026-09');
    expect(
      dueTimeToday(new Date('2026-10-05T23:59:59.999Z')).toISOString(),
    ).toBe('2026-10-05T16:00:00.000Z');
    expect(
      dueTimeToday(new Date('2026-10-05T00:00:00.000Z')).toISOString(),
    ).toBe('2026-10-05T16:00:00.000Z');
  });

  it('never starts 18:00–19:00 UTC', () => {
    // Everything due (nothing built, no link progress) -- still nothing.
    expect(plan('2026-10-05T18:00:00.000Z', [], false)).toEqual([]);
    expect(plan('2026-10-05T18:59:59.999Z', [], false)).toEqual([]);
    expect(isQuietHour(new Date('2026-10-05T18:00:00.000Z'))).toBe(true);
    expect(isQuietHour(new Date('2026-10-05T18:59:59.999Z'))).toBe(true);
    expect(isQuietHour(new Date('2026-10-05T17:59:59.999Z'))).toBe(false);
    expect(isQuietHour(new Date('2026-10-05T19:00:00.000Z'))).toBe(false);
    // 19:00 plans normally again; the hour before is covered by the
    // sweep-lead rules tested below.
    expect(plan('2026-10-05T19:00:00.000Z', [], false)).not.toEqual([]);
  });

  it('link progress may start 16:00–17:45 and 19:00–24:00 UTC, like a month', () => {
    // Hour 17 is open now that the unlinked digest is gone; 17:45 is the
    // identity sweep's lead, the same as for a month.
    expect(plan('2026-10-05T17:00:00.000Z', [], false)).toEqual([
      { kind: 'month', period: SEPT, reason: 'previous-daily' },
      { kind: 'month', period: OCT, reason: 'current' },
      { kind: 'link-progress', day: '2026-10-05' },
    ]);
    expect(plan('2026-10-05T17:44:59.999Z', [], false)).toContainEqual({
      kind: 'link-progress',
      day: '2026-10-05',
    });
    for (const [iso, allowed] of [
      ['2026-10-05T15:59:59.999Z', false],
      ['2026-10-05T16:00:00.000Z', true],
      ['2026-10-05T16:59:59.999Z', true],
      ['2026-10-05T17:00:00.000Z', true],
      ['2026-10-05T17:30:00.000Z', true],
      ['2026-10-05T17:44:59.999Z', true],
      ['2026-10-05T17:45:00.000Z', false],
      ['2026-10-05T17:59:59.999Z', false],
      ['2026-10-05T18:00:00.000Z', false],
      ['2026-10-05T18:30:00.000Z', false],
      ['2026-10-05T18:59:59.999Z', false],
      ['2026-10-05T19:00:00.000Z', true],
      ['2026-10-05T23:59:59.999Z', true],
    ] as const) {
      expect(canStartLinkProgress(new Date(iso)), iso).toBe(allowed);
      // Link progress never starts when a month may not.
      expect(canStartMonthBuild(new Date(iso)) || !allowed, iso).toBe(true);
    }
  });

  it('link progress is allowed in exactly the hours 16, 17 (to :45) and 19–23 UTC', () => {
    const open: number[] = [];
    for (let hour = 0; hour < 24; hour += 1) {
      const at = new Date(Date.UTC(2026, 9, 5, hour, 0));
      if (canStartLinkProgress(at)) {
        open.push(hour);
      }
    }
    expect(open).toEqual([16, 17, 19, 20, 21, 22, 23]);
  });

  it('17:44 can start a month and 17:45 cannot', () => {
    expect(canStartMonthBuild(new Date('2026-10-05T17:44:59.999Z'))).toBe(true);
    expect(canStartMonthBuild(new Date('2026-10-05T17:45:00.000Z'))).toBe(
      false,
    );
    expect(canStartMonthBuild(new Date('2026-10-05T18:30:00.000Z'))).toBe(
      false,
    );
    expect(canStartMonthBuild(new Date('2026-10-05T18:59:59.999Z'))).toBe(
      false,
    );
    expect(plan('2026-10-05T17:44:59.999Z', [], false)).toEqual([
      { kind: 'month', period: SEPT, reason: 'previous-daily' },
      { kind: 'month', period: OCT, reason: 'current' },
      { kind: 'link-progress', day: '2026-10-05' },
    ]);
    expect(plan('2026-10-05T17:45:00.000Z', [], false)).toEqual([]);
  });

  it('19:00 can do both', () => {
    const at = new Date('2026-10-05T19:00:00.000Z');
    expect(canStartMonthBuild(at)).toBe(true);
    expect(canStartLinkProgress(at)).toBe(true);
    expect(canStartLinkProgress(new Date('2026-10-05T23:59:59.999Z'))).toBe(
      true,
    );
    expect(plan('2026-10-05T19:00:00.000Z', [], false)).toEqual([
      { kind: 'month', period: SEPT, reason: 'previous-daily' },
      { kind: 'month', period: OCT, reason: 'current' },
      { kind: 'link-progress', day: '2026-10-05' },
    ]);
  });

  it('nothing is due before 16:00 UTC', () => {
    expect(plan('2026-10-05T15:59:59.999Z', [], false)).toEqual([]);
    expect(plan('2026-10-05T00:00:00.000Z', [], false)).toEqual([]);
    expect(plan('2026-10-05T16:00:00.000Z', [], false)).not.toEqual([]);
  });

  it('previous month rebuilt daily from the 2nd to the 7th after 16:00 UTC', () => {
    expect(
      previousItems(
        plan(
          '2026-10-02T16:00:00.000Z',
          both(SEPT, '2026-10-01T17:00:00.000Z'),
        ),
      ),
    ).toEqual([{ kind: 'month', period: SEPT, reason: 'previous-daily' }]);
    expect(
      previousItems(
        plan(
          '2026-10-02T16:30:00.000Z',
          both(SEPT, '2026-10-02T16:05:00.000Z'),
        ),
      ),
    ).toEqual([]);
    expect(
      previousItems(
        plan(
          '2026-10-07T16:00:00.000Z',
          both(SEPT, '2026-10-06T16:10:00.000Z'),
        ),
      ),
    ).toEqual([{ kind: 'month', period: SEPT, reason: 'previous-daily' }]);
    expect(
      previousItems(
        plan(
          '2026-10-08T16:00:00.000Z',
          both(SEPT, '2026-10-07T16:10:00.000Z'),
        ),
      ),
    ).toEqual([]);
    // The 1st is the day of grace for late attendance: no rebuild at all,
    // not even a catch-up for a month with only an open build.
    expect(
      previousItems(
        plan(
          '2026-10-01T16:00:00.000Z',
          both(SEPT, '2026-09-30T16:10:00.000Z'),
        ),
      ),
    ).toEqual([]);
    expect(previousItems(plan('2026-10-01T23:59:59.999Z', []))).toEqual([]);
    // Either type stale is enough.
    expect(
      previousItems(
        plan('2026-10-03T16:30:00.000Z', [
          ['hall_of_fame', SEPT, '2026-10-03T16:05:00.000Z'],
          ['no_show', SEPT, '2026-10-02T16:05:00.000Z'],
        ]),
      ),
    ).toEqual([{ kind: 'month', period: SEPT, reason: 'previous-daily' }]);
    expect(
      previousItems(
        plan('2026-10-03T16:30:00.000Z', [
          ['hall_of_fame', SEPT, '2026-10-03T16:05:00.000Z'],
        ]),
      ),
    ).toEqual([{ kind: 'month', period: SEPT, reason: 'previous-daily' }]);
    expect(
      previousItems(
        plan('2026-10-03T16:30:00.000Z', [
          ['no_show', SEPT, '2026-10-03T16:05:00.000Z'],
        ]),
      ),
    ).toEqual([{ kind: 'month', period: SEPT, reason: 'previous-daily' }]);
  });

  it('the previous month catches up once when it has no finished build', () => {
    // Open build only (made before September ended in Pacific time).
    expect(
      previousItems(
        plan(
          '2026-10-16T16:00:00.000Z',
          both(SEPT, '2026-09-30T16:10:00.000Z'),
        ),
      ),
    ).toEqual([{ kind: 'month', period: SEPT, reason: 'previous-catch-up' }]);
    // Missing entirely.
    expect(previousItems(plan('2026-10-16T16:00:00.000Z', []))).toEqual([
      { kind: 'month', period: SEPT, reason: 'previous-catch-up' },
    ]);
    // Only one type finished.
    expect(
      previousItems(
        plan('2026-10-16T16:00:00.000Z', [
          ['hall_of_fame', SEPT, '2026-10-16T16:01:00.000Z'],
          ['no_show', SEPT, '2026-09-30T16:10:00.000Z'],
        ]),
      ),
    ).toEqual([{ kind: 'month', period: SEPT, reason: 'previous-catch-up' }]);
    // Finished build exists.
    expect(
      previousItems(
        plan(
          '2026-10-16T16:00:00.000Z',
          both(SEPT, '2026-10-16T16:01:00.000Z'),
        ),
      ),
    ).toEqual([]);
    // A build after the 7th that is still after the month ended is enough.
    expect(
      previousItems(
        plan(
          '2026-10-16T16:00:00.000Z',
          both(SEPT, '2026-10-07T16:10:00.000Z'),
        ),
      ),
    ).toEqual([]);
  });

  it('the catch-up boundary is the Pacific end of the month, not UTC', () => {
    // September ends at 2026-10-01T07:00Z (PDT, UTC-7).
    expect(
      previousItems(
        plan(
          '2026-10-16T16:00:00.000Z',
          both(SEPT, '2026-10-01T06:59:59.999Z'),
        ),
      ),
    ).toEqual([{ kind: 'month', period: SEPT, reason: 'previous-catch-up' }]);
    expect(
      previousItems(
        plan(
          '2026-10-16T16:00:00.000Z',
          both(SEPT, '2026-10-01T07:00:00.000Z'),
        ),
      ),
    ).toEqual([]);
    // October ends at 2026-11-01T07:00Z: still PDT; the DST change is on Nov 1.
    const nov = '2026-11-16T16:00:00.000Z';
    expect(plan(nov, both(OCT, '2026-11-01T06:59:59.999Z'))).toContainEqual({
      kind: 'month',
      period: OCT,
      reason: 'previous-catch-up',
    });
    expect(plan(nov, both(OCT, '2026-11-01T07:00:00.000Z'))).not.toContainEqual(
      expect.objectContaining({ period: OCT }),
    );
    // November ends at 2026-12-01T08:00Z (PST, UTC-8): after the DST change.
    const nov2025 = { year: 2025, month: 11 };
    expect(
      plan(
        '2025-12-16T16:00:00.000Z',
        both(nov2025, '2025-12-01T07:59:59.999Z'),
      ),
    ).toContainEqual({
      kind: 'month',
      period: nov2025,
      reason: 'previous-catch-up',
    });
    expect(
      plan(
        '2025-12-16T16:00:00.000Z',
        both(nov2025, '2025-12-01T08:00:00.000Z'),
      ),
    ).not.toContainEqual(expect.objectContaining({ period: nov2025 }));
  });

  it('current month due once per UTC day after 16:00', () => {
    const current = { kind: 'month', period: OCT, reason: 'current' };
    expect(
      plan('2026-10-05T16:00:00.000Z', both(OCT, '2026-10-04T16:10:00.000Z')),
    ).toContainEqual(current);
    expect(
      plan('2026-10-05T23:59:59.999Z', both(OCT, '2026-10-05T16:01:00.000Z')),
    ).not.toContainEqual(current);
    expect(
      plan('2026-10-06T16:00:00.000Z', both(OCT, '2026-10-05T16:01:00.000Z')),
    ).toContainEqual(current);
    // Missing either type is due.
    expect(
      plan('2026-10-05T16:30:00.000Z', [
        ['no_show', OCT, '2026-10-05T16:01:00.000Z'],
      ]),
    ).toContainEqual(current);
    expect(plan('2026-10-05T16:30:00.000Z', [])).toContainEqual(current);
  });

  it('pins periodOf (the Pacific month) as the current month, not the UTC month', () => {
    // 2026-10-01T16:00Z is 09:00 PDT on October 1st.
    const items = plan('2026-10-01T16:00:00.000Z', [], false);
    expect(items).toEqual([
      { kind: 'month', period: OCT, reason: 'current' },
      { kind: 'link-progress', day: '2026-10-01' },
    ]);
    // Late on the UTC 1st, Pacific is still the 1st: same plan.
    expect(plan('2026-10-01T23:59:59.999Z', [], false)).toEqual([
      { kind: 'month', period: OCT, reason: 'current' },
      { kind: 'link-progress', day: '2026-10-01' },
    ]);
    // 03:00Z on the UTC 1st is still September 30th in Pacific, and before
    // 16:00 UTC: nothing is planned.
    expect(plan('2026-10-01T03:00:00.000Z', [], false)).toEqual([]);
    // Early UTC 2nd is 17:00 PDT on the 1st (before 16:00 UTC: nothing).
    expect(plan('2026-10-02T00:00:00.000Z', [], false)).toEqual([]);
    // December 1st across the PST offset: still December in Pacific.
    expect(plan('2026-12-01T16:00:00.000Z', [], false)).toEqual([
      { kind: 'month', period: { year: 2026, month: 12 }, reason: 'current' },
      { kind: 'link-progress', day: '2026-12-01' },
    ]);
    // January's previous month is December of the prior year.
    expect(plan('2027-01-05T16:00:00.000Z', [], false)[0]).toEqual({
      kind: 'month',
      period: { year: 2026, month: 12 },
      reason: 'previous-daily',
    });
  });

  it('plans across the DST transitions without shifting the due time', () => {
    // US spring-forward (2026-03-08) and fall-back (2026-11-01): the due time
    // stays 16:00 UTC; only the Pacific wall clock moves.
    for (const day of [
      '2026-03-08',
      '2026-03-09',
      '2026-11-01',
      '2026-11-02',
    ]) {
      expect(plan(`${day}T15:59:59.999Z`, [], false)).toEqual([]);
      expect(plan(`${day}T16:00:00.000Z`, [], false)).toContainEqual({
        kind: 'link-progress',
        day,
      });
    }
  });

  it('link progress due once per day', () => {
    expect(
      plan(
        '2026-10-05T16:00:00.000Z',
        [
          ...both(SEPT, '2026-10-05T16:01:00.000Z'),
          ...both(OCT, '2026-10-05T16:01:00.000Z'),
        ],
        false,
      ),
    ).toEqual([{ kind: 'link-progress', day: '2026-10-05' }]);
    expect(
      plan(
        '2026-10-05T16:00:00.000Z',
        [
          ...both(SEPT, '2026-10-05T16:01:00.000Z'),
          ...both(OCT, '2026-10-05T16:01:00.000Z'),
        ],
        true,
      ),
    ).toEqual([]);
  });

  it('items come in order: previous, current, link progress', () => {
    expect(plan('2026-10-03T16:00:00.000Z', [], false)).toEqual([
      { kind: 'month', period: SEPT, reason: 'previous-daily' },
      { kind: 'month', period: OCT, reason: 'current' },
      { kind: 'link-progress', day: '2026-10-03' },
    ]);
    expect(plan('2026-10-20T16:00:00.000Z', [], false)).toEqual([
      { kind: 'month', period: SEPT, reason: 'previous-catch-up' },
      { kind: 'month', period: OCT, reason: 'current' },
      { kind: 'link-progress', day: '2026-10-20' },
    ]);
  });
});
