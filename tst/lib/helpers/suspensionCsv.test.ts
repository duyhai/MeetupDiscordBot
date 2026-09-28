import { describe, expect, it } from 'vitest';

import {
  parseSuspensionCsv,
  parseUtcDateStrict,
} from '../../../src/lib/helpers/suspensionCsv.js';

const HEADER = 'member_id,duration_days,suspended_at,notes';
const NAMED_HEADER = 'member_id,member_name,duration_days,suspended_at,notes';

describe('parseSuspensionCsv', () => {
  it('parses named-format rows, blank names becoming null', () => {
    const rows = parseSuspensionCsv(
      `${NAMED_HEADER}\n123,Alice,30,2026-01-15,\n456,,60,2026-02-01,was warned twice`,
    );
    expect(rows).toEqual([
      {
        memberId: '123',
        memberName: 'Alice',
        durationDays: 30,
        suspendedAt: new Date('2026-01-15T00:00:00Z'),
        notes: null,
        rowNumber: 2,
      },
      {
        memberId: '456',
        memberName: null,
        durationDays: 60,
        suspendedAt: new Date('2026-02-01T00:00:00Z'),
        notes: 'was warned twice',
        rowNumber: 3,
      },
    ]);
  });

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
        rowNumber: 2,
      },
      {
        memberId: '456',
        memberName: null,
        durationDays: 60,
        suspendedAt: new Date('2026-02-01T00:00:00Z'),
        notes: 'was warned twice',
        rowNumber: 3,
      },
    ]);
  });

  describe('quoting (RFC 4180)', () => {
    it('keeps a line break inside a quoted note in its own row, never creating a phantom row', () => {
      // The old line-splitting parser turned the note's second line into a
      // real 60-day suspension for member 456.
      const rows = parseSuspensionCsv(
        `${HEADER}\n222,30,2026-01-01,"line1\n456,60,2026-02-01,x"`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].memberId).toBe('222');
      expect(rows[0].notes).toBe('line1\n456,60,2026-02-01,x');
    });

    it('unquotes a quoted member id, as spreadsheet exports produce', () => {
      // Stored with its quotes, "123" would never match a lookup for 123 and
      // the member's history would silently vanish.
      const rows = parseSuspensionCsv(`${HEADER}\n"123",30,2026-01-01,`);
      expect(rows[0].memberId).toBe('123');
    });

    it('preserves a quoted note containing a comma exactly', () => {
      const rows = parseSuspensionCsv(
        `${HEADER}\n333,30,2026-01-01,"late, again"`,
      );
      expect(rows[0].notes).toBe('late, again');
    });

    it('still accepts unquoted commas in the trailing notes column', () => {
      const rows = parseSuspensionCsv(
        `${HEADER}\n444,30,2026-01-01,late, again unquoted`,
      );
      expect(rows[0].notes).toBe('late, again unquoted');
    });

    it('handles CRLF line endings', () => {
      const rows = parseSuspensionCsv(`${HEADER}\r\n123,30,2026-01-01,x\r\n`);
      expect(rows).toHaveLength(1);
      expect(rows[0].notes).toBe('x');
    });
  });

  describe('field validation', () => {
    it('rejects a non-numeric member id with the row number', () => {
      expect(() => parseSuspensionCsv(`${HEADER}\nabc,30,2026-01-01,`)).toThrow(
        /row 2.*member_id/i,
      );
    });

    it('rejects a duration written in exponent form', () => {
      // Number('1e1') is 10, which would quietly record a 10-day suspension.
      expect(() =>
        parseSuspensionCsv(`${HEADER}\n123,1e1,2026-01-01,`),
      ).toThrow(/row 2/i);
    });

    it('reports the starting row of a record after blank lines and a multi-line note', () => {
      // Line 2: a record whose note spans lines 2-3. Line 4 is blank.
      // Line 5: the bad record the moderator has to find.
      const text = `${HEADER}\n111,30,2026-01-01,"a\nb"\n\n222,30,not-a-date,`;
      expect(() => parseSuspensionCsv(text)).toThrow(/row 5\b/i);
    });
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

  it('strips a UTF-8 BOM before validating the header', () => {
    const bom = '﻿';
    const rows = parseSuspensionCsv(`${bom}${HEADER}\n123,30,2026-01-15,`);
    expect(rows).toHaveLength(1);
    expect(rows[0].memberId).toBe('123');
  });
});

describe('parseUtcDateStrict', () => {
  it('parses a valid calendar date as UTC midnight', () => {
    expect(parseUtcDateStrict('2026-01-15')).toEqual(
      new Date('2026-01-15T00:00:00Z'),
    );
  });

  it('rejects a calendar-invalid date instead of rolling it forward', () => {
    // Plain `new Date('2026-02-30')` silently rolls to March 2nd.
    expect(parseUtcDateStrict('2026-02-30')).toBeUndefined();
  });

  it('rejects a malformed date string', () => {
    expect(parseUtcDateStrict('Jan 15 2026')).toBeUndefined();
    expect(parseUtcDateStrict('2026/01/15')).toBeUndefined();
  });
});
