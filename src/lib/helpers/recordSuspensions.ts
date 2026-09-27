/**
 * The recording logic behind /meetup_record_suspension, kept out of the
 * Discord handler so the rules that decide a member's penalty are testable:
 * who is recorded, for how long, and which rows are skipped and why.
 */
import { SuspensionRepository } from '../repositories/types.js';
import { recommendedSuspensionDays } from './noShowReport.js';
import { ParsedSuspensionRow } from './suspensionCsv.js';
import { utcDateOnly } from './suspensionList.js';

export type RecorderRepository = Pick<
  SuspensionRepository,
  'countSuspensionsBefore' | 'insert' | 'insertMany'
>;

export interface RecordedSuspension {
  memberId: string;
  memberName: string | null;
  suspendedAt: Date;
  durationDays: number;
  notes: string | null;
  /** Bulk mode only: the prior suspensions the duration was doubled for. */
  priorCount?: number;
  /** CSV mode only. */
  rowNumber?: number;
}

export interface SkippedSuspension {
  memberId: string;
  memberName?: string | null;
  suspendedAt?: Date;
  /** CSV mode only. */
  rowNumber?: number;
}

export interface RecordOutcome {
  recorded: RecordedSuspension[];
  /** Already on file for that member and date. */
  duplicates: SkippedSuspension[];
  /** Not a current member of the group; nothing recorded. */
  unknown: SkippedSuspension[];
}

/**
 * Bulk mode. Each member's duration doubles per suspension they had *before*
 * this date. Sequential on purpose: a duration depends on the rows before it.
 *
 * `knownMembers` is the group-membership lookup (id -> name). Members missing
 * from it are skipped rather than recorded against an ID nobody can resolve.
 */
export async function recordBulk(
  repo: RecorderRepository,
  memberIds: string[],
  knownMembers: Map<string, string>,
  suspendedAt: Date,
): Promise<RecordOutcome> {
  const outcome: RecordOutcome = { recorded: [], duplicates: [], unknown: [] };
  for (const memberId of memberIds) {
    const memberName = knownMembers.get(memberId);
    if (memberName === undefined) {
      outcome.unknown.push({ memberId });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const priorCount = await repo.countSuspensionsBefore(memberId, suspendedAt);
    const durationDays = recommendedSuspensionDays(priorCount);
    // eslint-disable-next-line no-await-in-loop
    const inserted = await repo.insert({
      memberId,
      memberName,
      suspendedAt,
      durationDays,
      notes: null,
    });
    if (inserted === undefined) {
      outcome.duplicates.push({ memberId, memberName, suspendedAt });
    } else {
      outcome.recorded.push({
        memberId,
        memberName,
        suspendedAt,
        durationDays,
        notes: null,
        priorCount,
      });
    }
  }
  return outcome;
}

const rowKey = (memberId: string, suspendedAt: Date) =>
  `${memberId}|${suspendedAt.getTime()}`;

/**
 * CSV mode. Durations are explicit per row (the backfill and exceptions), so
 * nothing is recomputed. Known rows are written in one transaction; each row
 * is then accounted for as recorded or as a duplicate.
 */
export async function recordCsvRows(
  repo: RecorderRepository,
  rows: ParsedSuspensionRow[],
  knownMembers: Map<string, string>,
): Promise<RecordOutcome> {
  const outcome: RecordOutcome = { recorded: [], duplicates: [], unknown: [] };
  const known = rows.filter((row) => {
    if (knownMembers.has(row.memberId)) {
      return true;
    }
    outcome.unknown.push({ memberId: row.memberId, rowNumber: row.rowNumber });
    return false;
  });
  const withNames = known.map((row) => ({
    ...row,
    memberName: row.memberName ?? knownMembers.get(row.memberId) ?? null,
  }));

  const inserted = await repo.insertMany(withNames);
  // Each inserted key accounts for exactly one row, so a row repeated within
  // the file is reported as a duplicate rather than recorded twice.
  const unclaimed = new Set(
    inserted.map((record) => rowKey(record.memberId, record.suspendedAt)),
  );
  for (const row of withNames) {
    const key = rowKey(row.memberId, row.suspendedAt);
    if (unclaimed.delete(key)) {
      outcome.recorded.push(row);
    } else {
      outcome.duplicates.push({
        memberId: row.memberId,
        memberName: row.memberName,
        suspendedAt: row.suspendedAt,
        rowNumber: row.rowNumber,
      });
    }
  }
  return outcome;
}

function nameSuffix(name: string | null | undefined): string {
  return name ? ` (${name})` : '';
}

function rowSuffix(rowNumber: number | undefined): string {
  return rowNumber === undefined ? '' : ` [row ${rowNumber}]`;
}

/**
 * The short reply plus the full detail, which goes out as an attachment so a
 * large backfill can't exceed Discord's 2000-character message cap after
 * the rows are already committed.
 */
export function formatRecordSummary(
  outcome: RecordOutcome,
  repeatedIdsIgnored: number,
): { content: string; body: string } {
  const { recorded, duplicates, unknown } = outcome;
  const counts = [
    duplicates.length ? `${duplicates.length} already on file` : '',
    unknown.length ? `${unknown.length} not in the group` : '',
    repeatedIdsIgnored ? `${repeatedIdsIgnored} repeated ID(s) ignored` : '',
  ].filter(Boolean);
  const content = `Recorded ${recorded.length} suspension(s)${
    counts.length ? ` (${counts.join(', ')})` : ''
  }. Details in the attachment.`;

  const sections = [
    `Recorded (${recorded.length}):`,
    ...recorded.map(
      (r) =>
        `- ${r.memberId}${nameSuffix(r.memberName)}: ${
          r.durationDays
        } days from ${utcDateOnly(r.suspendedAt)}${
          r.priorCount === undefined
            ? ''
            : ` — prior suspensions ${r.priorCount}`
        }${r.notes ? ` (${r.notes})` : ''}${rowSuffix(r.rowNumber)}`,
    ),
  ];
  if (duplicates.length) {
    sections.push(
      '',
      `Already on file for that date, skipped (${duplicates.length}):`,
      ...duplicates.map(
        (d) =>
          `- ${d.memberId}${nameSuffix(d.memberName)}${
            d.suspendedAt ? `: ${utcDateOnly(d.suspendedAt)}` : ''
          }${rowSuffix(d.rowNumber)}`,
      ),
    );
  }
  if (unknown.length) {
    sections.push(
      '',
      `Not a current member of the group, skipped (${unknown.length}):`,
      ...unknown.map((u) => `- ${u.memberId}${rowSuffix(u.rowNumber)}`),
    );
  }
  return { content, body: sections.join('\n') };
}
