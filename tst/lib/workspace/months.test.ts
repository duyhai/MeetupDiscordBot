import { describe, expect, it } from 'vitest';

import { periodKey } from '../../../src/lib/reports/period.js';
import {
  isWorkspaceMonth,
  linkWindow,
  WORKSPACE_FIRST_PERIOD,
  workspaceMonths,
} from '../../../src/lib/workspace/months.js';

describe('workspace months', () => {
  it('workspace months run from the current Pacific month back to 2026-09', () => {
    // 07:59 UTC on 1 December is still 30 November in Pacific time.
    const now = new Date('2026-12-01T07:59:00Z');
    expect(workspaceMonths(now).map(periodKey)).toEqual([
      '2026-11',
      '2026-10',
      '2026-09',
    ]);
    expect(periodKey(WORKSPACE_FIRST_PERIOD)).toBe('2026-09');
  });

  it('is empty before the first workspace month', () => {
    expect(workspaceMonths(new Date('2026-08-15T12:00:00Z'))).toEqual([]);
  });

  it('isWorkspaceMonth refuses 2026-08, next month and junk', () => {
    const now = new Date('2026-10-16T12:00:00Z');
    expect(isWorkspaceMonth({ year: 2026, month: 9 }, now)).toBe(true);
    expect(isWorkspaceMonth({ year: 2026, month: 10 }, now)).toBe(true);
    expect(isWorkspaceMonth({ year: 2026, month: 8 }, now)).toBe(false);
    expect(isWorkspaceMonth({ year: 2026, month: 11 }, now)).toBe(false);
    expect(isWorkspaceMonth({ year: 2026, month: 13 }, now)).toBe(false);
    expect(isWorkspaceMonth({ year: 2026, month: 0 }, now)).toBe(false);
    expect(isWorkspaceMonth({ year: 2026.5, month: 9 }, now)).toBe(false);
    expect(isWorkspaceMonth({ year: 2026, month: Number.NaN }, now)).toBe(
      false,
    );
    expect(isWorkspaceMonth(undefined, now)).toBe(false);
  });
});

describe('linkWindow', () => {
  it("runs from the case month's 1st to the 1st of the month after next, UTC midnights", () => {
    expect(linkWindow({ year: 2026, month: 9 })).toEqual({
      from: new Date('2026-09-01T00:00:00.000Z'),
      until: new Date('2026-11-01T00:00:00.000Z'),
    });
  });
  it('crosses the year', () => {
    expect(linkWindow({ year: 2026, month: 12 })).toEqual({
      from: new Date('2026-12-01T00:00:00.000Z'),
      until: new Date('2027-02-01T00:00:00.000Z'),
    });
  });
});
