import { describe, expect, it } from 'vitest';

import {
  BAN_CSV_ERROR_TEXT,
  BAN_CSV_HEADER,
  BanCsvError,
  parseBanCsv,
} from '../../../src/lib/bans/banCsv.js';

const TODAY = '2026-10-22';

const csv = (...lines: string[]) => [BAN_CSV_HEADER, ...lines].join('\n');

const errorsOf = (text: string): BanCsvError[] => {
  const result = parseBanCsv(text, TODAY);
  if (result.ok === true) {
    throw new Error('expected errors');
  }
  return result.errors;
};

describe('parseBanCsv', () => {
  it('reads a valid file with a blank date and a quoted multi-line note', () => {
    const result = parseBanCsv(
      csv(
        '111,Ann,2026-02-28,Harassment',
        '222,Bo,,"first line',
        'second line, with a comma"',
        '333,"Cy, Jr.",2013-03-01,',
      ),
      TODAY,
    );
    expect(result).toEqual({
      ok: true,
      rows: [
        {
          rowNumber: 2,
          memberId: '111',
          memberName: 'Ann',
          bannedOn: '2026-02-28',
          notes: 'Harassment',
        },
        {
          rowNumber: 3,
          memberId: '222',
          memberName: 'Bo',
          bannedOn: null,
          notes: 'first line\nsecond line, with a comma',
        },
        {
          rowNumber: 5,
          memberId: '333',
          memberName: 'Cy, Jr.',
          bannedOn: '2013-03-01',
          notes: '',
        },
      ],
    });
  });

  it('accepts a BOM and a header in another case with spaces', () => {
    const result = parseBanCsv(
      '﻿Member_ID, member_name ,BANNED_ON,notes\n111,Ann,,',
      TODAY,
    );
    expect(result.ok).toBe(true);
  });

  it('rejoins extra fields into notes, as the suspension parser does', () => {
    const result = parseBanCsv(csv('111,Ann,,late, again'), TODAY);
    expect(result.ok && result.rows[0].notes).toBe('late, again');
  });

  it('Review Focus 2: member ids that are not ASCII digits are refused with their rows; padding is trimmed', () => {
    const errors = errorsOf(
      csv(
        '12a4,A,,',
        '+123,B,,',
        ' 123 ,C,,',
        `${'1'.repeat(21)},D,,`,
        '١٢٣,E,,',
        ',F,,',
      ),
    );
    expect(errors).toEqual([
      { row: 2, code: 'member-id' },
      { row: 3, code: 'member-id' },
      { row: 5, code: 'member-id' },
      { row: 6, code: 'member-id' },
      { row: 7, code: 'member-id' },
    ]);
    const padded = parseBanCsv(csv(' 123 ,C,,'), TODAY);
    expect(padded.ok && padded.rows[0].memberId).toBe('123');
  });

  it('dates: not a real day, another format, before the group, after today', () => {
    expect(errorsOf(csv('1,A,2026-02-30,', '2,B,10/3/2026,'))).toEqual([
      { row: 2, code: 'date' },
      { row: 3, code: 'date' },
    ]);
    expect(errorsOf(csv('1,A,2013-02-28,', '2,B,2026-10-23,'))).toEqual([
      { row: 2, code: 'date-out-of-range' },
      { row: 3, code: 'date-out-of-range' },
    ]);
    const today = parseBanCsv(csv(`1,A,${TODAY},`), TODAY);
    expect(today.ok).toBe(true);
  });

  it('names over 500 and notes over 2000 code points', () => {
    const emoji500 = '😀'.repeat(500);
    expect(parseBanCsv(csv(`1,${emoji500},,`), TODAY).ok).toBe(true);
    expect(
      errorsOf(csv(`1,${'n'.repeat(501)},,`, `2,B,,${'x'.repeat(2001)}`)),
    ).toEqual([
      { row: 2, code: 'name-too-long' },
      { row: 3, code: 'notes-too-long' },
    ]);
    expect(parseBanCsv(csv(`2,B,,${'😀'.repeat(2000)}`), TODAY).ok).toBe(true);
  });

  it('201 rows is one too-many-rows error with no row', () => {
    const lines = Array.from({ length: 201 }, (_, i) => `${i + 1},M,,`);
    expect(errorsOf(csv(...lines))).toEqual([
      { row: null, code: 'too-many-rows' },
    ]);
    expect(parseBanCsv(csv(...lines.slice(0, 200)), TODAY).ok).toBe(true);
  });

  it('Review Focus 3: a member twice is duplicate-member on the later row', () => {
    expect(errorsOf(csv('111,A,,', '222,B,,', '111,C,,'))).toEqual([
      { row: 4, code: 'duplicate-member' },
    ]);
  });

  it('unbalanced quote, wrong header, header only', () => {
    expect(errorsOf(csv('111,"Ann,,'))).toEqual([
      { row: null, code: 'unreadable' },
    ]);
    expect(errorsOf('member_id,member_name,notes\n111,A,')).toEqual([
      { row: 1, code: 'header' },
    ]);
    expect(errorsOf(BAN_CSV_HEADER)).toEqual([{ row: null, code: 'no-rows' }]);
    expect(errorsOf('')).toEqual([{ row: 1, code: 'header' }]);
  });

  it('collects every error in row order', () => {
    expect(
      errorsOf(csv('x,A,2026-02-30,', '1,B,,', '1,C,1999-01-01,')),
    ).toEqual([
      { row: 2, code: 'member-id' },
      { row: 2, code: 'date' },
      { row: 4, code: 'date-out-of-range' },
      { row: 4, code: 'duplicate-member' },
    ]);
  });

  it('errors carry only row and code, and the texts are fixed', () => {
    const errors = errorsOf(
      csv('<script>,<b>,2026-02-30,', `1,${'n'.repeat(501)},,`),
    );
    for (const error of errors) {
      expect(Object.keys(error)).toEqual(['row', 'code']);
    }
    for (const text of Object.values(BAN_CSV_ERROR_TEXT)) {
      expect(text).not.toMatch(/\$\{|%s|<|>/);
      expect(text.length).toBeGreaterThan(10);
    }
    expect(BAN_CSV_ERROR_TEXT.header).toBe(
      'The first line must be exactly: member_id,member_name,banned_on,notes',
    );
    expect(BAN_CSV_ERROR_TEXT['member-id']).toBe(
      'member_id must be the Meetup member number, digits only.',
    );
  });
});
