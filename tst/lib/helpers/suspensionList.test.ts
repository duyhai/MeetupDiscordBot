import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';

import { SuspensionRecord } from '../../../src/lib/repositories/types.js';
import { formatSuspensionList } from '../../../src/lib/helpers/suspensionList.js';

let nextId = 0;
function record(overrides: Partial<SuspensionRecord> = {}): SuspensionRecord {
  nextId += 1;
  return {
    id: nextId,
    memberId: `m${nextId}`,
    memberName: null,
    suspendedAt: new Date('2026-09-01T00:00:00Z'),
    durationDays: 30,
    notes: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  };
}

const now = dayjs('2026-09-26T00:00:00Z');

describe('formatSuspensionList', () => {
  it('splits records into currently active and past', () => {
    const active = record({ memberId: 'act', durationDays: 60 }); // ends Oct 31
    const past = record({
      memberId: 'old',
      suspendedAt: new Date('2026-01-01T00:00:00Z'),
    }); // ended Jan 31
    const result = formatSuspensionList([active, past], now);
    expect(result).toMatch(/Currently active \(1\)[\s\S]*act/);
    expect(result).toMatch(/Past \(1\)[\s\S]*old/);
    expect(result.indexOf('act')).toBeLessThan(result.indexOf('old'));
  });

  it('shows the computed end date, duration, name, and notes', () => {
    const result = formatSuspensionList(
      [
        record({
          memberId: '123',
          memberName: 'Alice',
          durationDays: 60,
          notes: 'backfill',
        }),
      ],
      now,
    );
    expect(result).toContain('Alice');
    expect(result).toContain('123');
    expect(result).toContain('60 days');
    expect(result).toContain('2026-09-01');
    // 60 days from Sept 1 covers Sept 1 - Oct 30 inclusive; "through" names
    // the last suspended day so nobody has to guess whether "until" is
    // inclusive.
    expect(result).toContain('through 2026-10-30');
    expect(result).toContain('backfill');
  });

  describe('active/past boundary, in Pacific calendar days', () => {
    // 30 days from Sept 1: the last suspended day is Sept 30.
    const lastDaySuspension = record({ memberId: 'edge', durationDays: 30 });

    it('is still active on the evening of its last day, though UTC has rolled over', () => {
      // 11:30pm PDT on Sept 30 is already 06:30 on Oct 1 in UTC.
      const lateLastDay = dayjs('2026-10-01T06:30:00Z');
      expect(formatSuspensionList([lastDaySuspension], lateLastDay)).toMatch(
        /Currently active \(1\)/,
      );
    });

    it('is past from the first minute of the next Pacific day', () => {
      // 12:30am PDT on Oct 1.
      const nextDay = dayjs('2026-10-01T07:30:00Z');
      expect(formatSuspensionList([lastDaySuspension], nextDay)).toMatch(
        /Past \(1\)/,
      );
    });
  });

  it('includes a plain Meetup profile URL per record', () => {
    const result = formatSuspensionList([record({ memberId: '987' })], now);
    expect(result).toContain('https://www.meetup.com/members/987/');
  });

  it('prefixes each record with its ID so moderators can reference it', () => {
    const result = formatSuspensionList(
      [record({ id: 12, memberId: '987', memberName: 'Alice' })],
      now,
    );
    expect(result).toContain('- #12 987 (Alice): 30 days from 2026-09-01');
  });

  it('reports an empty table plainly', () => {
    expect(formatSuspensionList([], now)).toContain('No suspensions recorded');
  });
});

describe('formatSuspensionList name fallback', () => {
  it('uses the fallback name map when the record has none', () => {
    const result = formatSuspensionList(
      [record({ memberId: '55', memberName: null })],
      now,
      new Map([['55', 'Linked Larry']]),
    );
    expect(result).toContain('55 (Linked Larry)');
  });

  it('prefers the recorded name over the fallback', () => {
    const result = formatSuspensionList(
      [record({ memberId: '55', memberName: 'Snapshot Sam' })],
      now,
      new Map([['55', 'Linked Larry']]),
    );
    expect(result).toContain('55 (Snapshot Sam)');
    expect(result).not.toContain('Linked Larry');
  });
});
