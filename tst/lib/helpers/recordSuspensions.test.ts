import { beforeEach, describe, expect, it } from 'vitest';

import {
  RecorderRepository,
  formatRecordSummary,
  recordBulk,
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

describe('recordBulk', () => {
  let repo: FakeSuspensionRepository;

  beforeEach(() => {
    repo = new FakeSuspensionRepository();
  });

  it('doubles each duration per suspension the member had before this date', async () => {
    await repo.insert(
      row({ memberId: '100', suspendedAt: new Date('2026-03-01T00:00:00Z') }),
    );

    const outcome = await recordBulk(
      repo,
      ['100', '200'],
      new Map([
        ['100', 'Alice'],
        ['200', 'Bob'],
      ]),
      sept1,
    );

    expect(outcome.recorded.map((r) => [r.memberId, r.durationDays])).toEqual([
      ['100', 60],
      ['200', 30],
    ]);
  });

  it('does not treat a later-dated suspension as prior when back-dating', async () => {
    await repo.insert(
      row({ memberId: '100', suspendedAt: new Date('2026-10-01T00:00:00Z') }),
    );

    const outcome = await recordBulk(
      repo,
      ['100'],
      new Map([['100', 'Alice']]),
      sept1,
    );

    expect(outcome.recorded[0].durationDays).toBe(30);
  });

  it('skips members who are not in the group, recording nothing for them', async () => {
    const outcome = await recordBulk(
      repo,
      ['100', '999'],
      new Map([['100', 'Alice']]),
      sept1,
    );

    expect(outcome.recorded.map((r) => r.memberId)).toEqual(['100']);
    expect(outcome.unknown.map((r) => r.memberId)).toEqual(['999']);
    expect(repo.records.some((r) => r.memberId === '999')).toBe(false);
  });

  it('reports a member already suspended on this date as a duplicate', async () => {
    await repo.insert(row({ memberId: '100', suspendedAt: sept1 }));

    const outcome = await recordBulk(
      repo,
      ['100'],
      new Map([['100', 'Alice']]),
      sept1,
    );

    expect(outcome.recorded).toEqual([]);
    expect(outcome.duplicates.map((r) => r.memberId)).toEqual(['100']);
  });
});

describe('recordCsvRows', () => {
  let repo: FakeSuspensionRepository;

  beforeEach(() => {
    repo = new FakeSuspensionRepository();
  });

  it('skips rows for members who are not in the group, citing the row', async () => {
    const outcome = await recordCsvRows(
      repo,
      [
        row({ memberId: '100', rowNumber: 2 }),
        row({ memberId: '999', rowNumber: 3 }),
      ],
      new Map([['100', 'Alice']]),
    );

    expect(outcome.recorded.map((r) => r.memberId)).toEqual(['100']);
    expect(outcome.unknown).toEqual([
      expect.objectContaining({ memberId: '999', rowNumber: 3 }),
    ]);
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
  it('counts each outcome and lists every skipped row', () => {
    const summary = formatRecordSummary(
      {
        recorded: [
          {
            memberId: '100',
            memberName: 'Alice',
            suspendedAt: sept1,
            durationDays: 60,
            notes: null,
            priorCount: 1,
          },
        ],
        duplicates: [
          {
            memberId: '200',
            memberName: 'Bob',
            suspendedAt: sept1,
            rowNumber: 4,
          },
        ],
        unknown: [{ memberId: '999', rowNumber: 7 }],
      },
      2,
    );

    expect(summary.content).toBe(
      'Recorded 1 suspension(s) (1 already on file, 1 not in the group, 2 repeated ID(s) ignored). Details in the attachment.',
    );
    expect(summary.body).toContain('100 (Alice): 60 days from 2026-09-01');
    expect(summary.body).toContain('prior suspensions 1');
    expect(summary.body).toContain('row 4');
    expect(summary.body).toContain('999');
    expect(summary.body).toContain('row 7');
  });

  it('formats dates in UTC, never the previous day', () => {
    // A UTC-midnight date formatted in Pacific local time reads Aug 31.
    const summary = formatRecordSummary(
      {
        recorded: [
          {
            memberId: '100',
            memberName: null,
            suspendedAt: sept1,
            durationDays: 30,
            notes: null,
          },
        ],
        duplicates: [],
        unknown: [],
      },
      0,
    );

    expect(summary.body).toContain('2026-09-01');
    expect(summary.body).not.toContain('2026-08-31');
  });
});
