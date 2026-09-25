import { describe, expect, it } from 'vitest';

import { parseSuspensionCsv } from '../../../src/lib/helpers/suspensionCsv.js';

const HEADER = 'member_id,duration_days,suspended_at,notes';

describe('parseSuspensionCsv', () => {
  it('parses rows into inserts', () => {
    const rows = parseSuspensionCsv(
      `${HEADER}\n123,30,2026-01-15,\n456,60,2026-02-01,was warned twice`,
    );
    expect(rows).toEqual([
      {
        memberId: '123',
        memberName: null,
        durationDays: 30,
        suspendedAt: new Date('2026-01-15T00:00:00Z'),
        notes: null,
      },
      {
        memberId: '456',
        memberName: null,
        durationDays: 60,
        suspendedAt: new Date('2026-02-01T00:00:00Z'),
        notes: 'was warned twice',
      },
    ]);
  });

  it('skips blank lines and trims whitespace', () => {
    const rows = parseSuspensionCsv(`${HEADER}\n 123 , 30 ,2026-01-15,\n\n`);
    expect(rows).toHaveLength(1);
    expect(rows[0].memberId).toBe('123');
  });

  it('rejects a wrong header', () => {
    expect(() => parseSuspensionCsv('id,days\n1,30')).toThrow(/header/i);
  });

  it('rejects a bad duration with the row number', () => {
    expect(() =>
      parseSuspensionCsv(`${HEADER}\n123,thirty,2026-01-15,`),
    ).toThrow(/row 2/i);
  });

  it('rejects a bad date with the row number', () => {
    expect(() => parseSuspensionCsv(`${HEADER}\n123,30,Jan 15,`)).toThrow(
      /row 2/i,
    );
  });

  it('rejects a calendar-invalid date with the row number', () => {
    expect(() => parseSuspensionCsv(`${HEADER}\n123,30,2026-02-30,`)).toThrow(
      /row 2/i,
    );
  });
});
