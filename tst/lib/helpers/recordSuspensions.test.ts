import { beforeEach, describe, expect, it } from 'vitest';

import {
  RecorderRepository,
  formatRecordSummary,
  recordCsvRows,
} from '../../../src/lib/helpers/recordSuspensions.js';
import { ParsedSuspensionRow } from '../../../src/lib/helpers/suspensionCsv.js';
import {
  SuspensionInsert,
  SuspensionRecord,
} from '../../../src/lib/repositories/types.js';

/** In-memory stand-in with Postgres's (member_id, suspended_at) uniqueness. */
class FakeSuspensionRepository implements RecorderRepository {
  records: SuspensionRecord[] = [];

  private nextId = 1;

  private exists(memberId: string, suspendedAt: Date): boolean {
    return this.records.some(
      (record) =>
        record.memberId === memberId &&
        record.suspendedAt.getTime() === suspendedAt.getTime(),
    );
  }

  async insert(
    insert: SuspensionInsert,
  ): Promise<SuspensionRecord | undefined> {
    if (this.exists(insert.memberId, insert.suspendedAt)) {
      return undefined;
    }
    const record = { ...insert, id: this.nextId, createdAt: new Date() };
    this.nextId += 1;
    this.records.push(record);
    return record;
  }

  async insertMany(inserts: SuspensionInsert[]): Promise<SuspensionRecord[]> {
    const inserted: SuspensionRecord[] = [];
    for (const insert of inserts) {
      // eslint-disable-next-line no-await-in-loop
      const record = await this.insert(insert);
      if (record) {
        inserted.push(record);
      }
    }
    return inserted;
  }

  async listByMemberId(memberId: string) {
    return this.records.filter((record) => record.memberId === memberId);
  }

  async countSuspensionsBefore(memberId: string, before: Date) {
    return this.records.filter(
      (record) =>
        record.memberId === memberId &&
        record.suspendedAt.getTime() < before.getTime(),
    ).length;
  }
}

const sept1 = new Date('2026-09-01T00:00:00Z');

function row(overrides: Partial<ParsedSuspensionRow>): ParsedSuspensionRow {
  return {
    memberId: '100',
    memberName: null,
    durationDays: 30,
    suspendedAt: sept1,
    notes: null,
    rowNumber: 2,
    ...overrides,
  };
}

describe('recordCsvRows', () => {
  let repo: FakeSuspensionRepository;

  beforeEach(() => {
    repo = new FakeSuspensionRepository();
  });

  it('records rows for members no longer in the group, flagging them', async () => {
    const outcome = await recordCsvRows(
      repo,
      [
        row({ memberId: '100', rowNumber: 2 }),
        row({ memberId: '999', memberName: 'Departed', rowNumber: 3 }),
      ],
      new Map([['100', 'Alice']]),
    );

    expect(outcome.recorded.map((r) => r.memberId)).toEqual(['100', '999']);
    expect(repo.records.map((r) => r.memberId)).toEqual(['100', '999']);
    expect(outcome.notInGroup).toEqual([
      expect.objectContaining({ memberId: '999', rowNumber: 3 }),
    ]);
  });

  it('flags a duration that differs from 30 days doubled per earlier suspension', async () => {
    await repo.insert(
      row({ memberId: '100', suspendedAt: new Date('2026-03-01T00:00:00Z') }),
    );

    const outcome = await recordCsvRows(
      repo,
      [
        row({ memberId: '100', durationDays: 30, rowNumber: 2 }), // expected 60
        row({ memberId: '200', durationDays: 30, rowNumber: 3 }), // matches
      ],
      new Map([
        ['100', 'Alice'],
        ['200', 'Bob'],
      ]),
    );

    expect(outcome.recorded.map((r) => r.memberId)).toEqual(['100', '200']);
    expect(outcome.durationMismatches).toEqual([
      expect.objectContaining({
        memberId: '100',
        rowNumber: 2,
        durationDays: 30,
        expectedDays: 60,
        priorCount: 1,
      }),
    ]);
  });

  it('counts earlier rows from the same file as prior suspensions', async () => {
    const outcome = await recordCsvRows(
      repo,
      [
        // Out of date order on purpose: the later row still doubles.
        row({
          memberId: '100',
          durationDays: 60,
          suspendedAt: new Date('2026-09-01T00:00:00Z'),
          rowNumber: 2,
        }),
        row({
          memberId: '100',
          durationDays: 30,
          suspendedAt: new Date('2026-03-01T00:00:00Z'),
          rowNumber: 3,
        }),
      ],
      new Map([['100', 'Alice']]),
    );

    expect(outcome.recorded).toHaveLength(2);
    expect(outcome.durationMismatches).toEqual([]);
  });

  it('reports rows already on file, and repeats within the file, as duplicates', async () => {
    await repo.insert(row({ memberId: '100', suspendedAt: sept1 }));
    const oct1 = new Date('2026-10-01T00:00:00Z');

    const outcome = await recordCsvRows(
      repo,
      [
        row({ memberId: '100', suspendedAt: sept1, rowNumber: 2 }), // on file
        row({ memberId: '200', suspendedAt: oct1, rowNumber: 3 }), // new
        row({ memberId: '200', suspendedAt: oct1, rowNumber: 4 }), // repeat
      ],
      new Map([
        ['100', 'Alice'],
        ['200', 'Bob'],
      ]),
    );

    expect(outcome.recorded.map((r) => r.rowNumber)).toEqual([3]);
    expect(outcome.duplicates.map((r) => r.rowNumber)).toEqual([2, 4]);
  });

  it('flags a row on file with a different duration, naming the record to void', async () => {
    const existing = await repo.insert(
      row({ memberId: '100', suspendedAt: sept1, durationDays: 30 }),
    );

    const outcome = await recordCsvRows(
      repo,
      [row({ memberId: '100', suspendedAt: sept1, durationDays: 60 })],
      new Map([['100', 'Alice']]),
    );

    expect(outcome.duplicates).toEqual([
      expect.objectContaining({
        memberId: '100',
        durationDays: 60,
        existing: { id: existing?.id, durationDays: 30 },
      }),
    ]);
    const summary = formatRecordSummary(outcome);
    expect(summary.body).toContain(
      `on file #${existing?.id} has 30 days, this row has 60`,
    );
    expect(summary.body).toContain(
      `void #${existing?.id} and re-import to correct`,
    );
    expect(summary.content).toContain('1 differ from the record on file');
    // Not the policy check: that one is only for rows actually recorded.
    expect(outcome.durationMismatches).toEqual([]);
  });

  it('leaves a matching duplicate unflagged', async () => {
    await repo.insert(row({ memberId: '100', suspendedAt: sept1 }));

    const outcome = await recordCsvRows(
      repo,
      [row({ memberId: '100', suspendedAt: sept1 })],
      new Map([['100', 'Alice']]),
    );

    const summary = formatRecordSummary(outcome);
    expect(summary.body).not.toContain('void #');
    expect(summary.content).not.toContain('differ');
  });

  it('fills a missing name from the group lookup', async () => {
    const outcome = await recordCsvRows(
      repo,
      [row({ memberId: '100', memberName: null })],
      new Map([['100', 'Alice']]),
    );

    expect(outcome.recorded[0].memberName).toBe('Alice');
  });
});

describe('formatRecordSummary', () => {
  const alice = {
    memberId: '100',
    memberName: 'Alice',
    suspendedAt: sept1,
    durationDays: 30,
    notes: null,
    rowNumber: 2,
  };

  it('counts each outcome and lists every flagged row', () => {
    const summary = formatRecordSummary({
      recorded: [
        alice,
        { ...alice, memberId: '999', memberName: null, rowNumber: 7 },
      ],
      duplicates: [
        {
          memberId: '200',
          memberName: 'Bob',
          suspendedAt: sept1,
          rowNumber: 4,
          durationDays: 30,
        },
      ],
      notInGroup: [{ memberId: '999', memberName: null, rowNumber: 7 }],
      durationMismatches: [{ ...alice, expectedDays: 60, priorCount: 1 }],
    });

    expect(summary.content).toBe(
      'Recorded 2 suspension(s) (1 already on file, 1 not a current member, 1 duration to check). Details in the attachment.',
    );
    expect(summary.body).toContain('100 (Alice): 30 days from 2026-09-01');
    expect(summary.body).toContain(
      '100 (Alice): 30 days recorded, 60 expected (prior suspensions 1) [row 2]',
    );
    expect(summary.body).toContain('200 (Bob): 2026-09-01 [row 4]');
    expect(summary.body).toContain('Recorded, but not a current member');
    expect(summary.body).toContain('999 [row 7]');
  });

  it('formats dates in UTC, never the previous day', () => {
    // A UTC-midnight date formatted in Pacific local time reads Aug 31.
    const summary = formatRecordSummary({
      recorded: [alice],
      duplicates: [],
      notInGroup: [],
      durationMismatches: [],
    });

    expect(summary.body).toContain('2026-09-01');
    expect(summary.body).not.toContain('2026-08-31');
  });
});
