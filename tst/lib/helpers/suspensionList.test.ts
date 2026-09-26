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
    expect(result).toContain('2026-10-31');
    expect(result).toContain('backfill');
  });

  it('includes a plain Meetup profile URL per record', () => {
    const result = formatSuspensionList([record({ memberId: '987' })], now);
    expect(result).toContain('https://www.meetup.com/members/987/');
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
