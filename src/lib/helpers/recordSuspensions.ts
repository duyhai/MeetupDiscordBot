/**
 * The recording logic behind /meetup_record_suspension, kept out of the
 * Discord handler so the rules that decide a member's penalty are testable:
 * who is recorded, for how long, and which rows are skipped and why.
 */
import { SuspensionRepository } from '../repositories/types.js';
import { recommendedSuspensionDays } from './noShowReport.js';
import { ParsedSuspensionRow } from './suspensionCsv.js';
import { coversDay, lastSuspendedDay, utcDateOnly } from './suspensionList.js';

export type RecorderRepository = Pick<
  SuspensionRepository,
  'countSuspensionsBefore' | 'insert' | 'insertMany' | 'listByMemberId'
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
  /** CSV duplicates only: the duration the row asked for. */
  durationDays?: number;
  /** CSV duplicates only: the live record the row collided with. */
  existing?: { id: number; durationDays: number };
}

export interface AlreadySuspended {
  memberId: string;
  memberName: string;
  suspendedAt: Date;
  /** The live suspension covering the recording date. */
  recordId: number;
  /** Its last suspended day, YYYY-MM-DD. */
  lastDay: string;
}

export interface RecordOutcome {
  recorded: RecordedSuspension[];
  /** Already on file for that member and date. */
  duplicates: SkippedSuspension[];
  /** Not a current member of the group; nothing recorded. */
  unknown: SkippedSuspension[];
  /** Bulk mode only: serving a suspension on that date; nothing recorded. */
  alreadySuspended: AlreadySuspended[];
}

/**
 * Bulk mode. Each member's duration doubles per suspension they had *before*
 * this date. Sequential on purpose: a duration depends on the rows before it.
 *
 * A member already serving a suspension on this date is skipped, not
 * recorded: re-running yesterday's bulk record today would otherwise add a
 * second, doubled penalty on top of the first. The same date is left to the
 * insert, which reports it as a duplicate.
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
  const outcome: RecordOutcome = {
    recorded: [],
    duplicates: [],
    unknown: [],
    alreadySuspended: [],
  };
  for (const memberId of memberIds) {
    const memberName = knownMembers.get(memberId);
    if (memberName === undefined) {
      outcome.unknown.push({ memberId });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const active = (await repo.listByMemberId(memberId)).find(
      (record) =>
        record.suspendedAt.getTime() !== suspendedAt.getTime() &&
        coversDay(record, suspendedAt),
    );
    if (active !== undefined) {
      outcome.alreadySuspended.push({
        memberId,
        memberName,
        suspendedAt,
        recordId: active.id,
        lastDay: lastSuspendedDay(active),
      });
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
  const outcome: RecordOutcome = {
    recorded: [],
    duplicates: [],
    unknown: [],
    alreadySuspended: [],
  };
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
  const duplicateRows = withNames.filter((row) => {
    if (unclaimed.delete(rowKey(row.memberId, row.suspendedAt))) {
      outcome.recorded.push(row);
      return false;
    }
    return true;
  });
  // Look up what a duplicate collided with, so a row whose duration differs
  // from the stored one -- a correction, not a re-import -- isn't dropped
  // silently.
  const onFile = new Map<string, { id: number; durationDays: number }>();
  for (const memberId of new Set(duplicateRows.map((row) => row.memberId))) {
    // eslint-disable-next-line no-await-in-loop
    for (const record of await repo.listByMemberId(memberId)) {
      onFile.set(rowKey(record.memberId, record.suspendedAt), {
        id: record.id,
        durationDays: record.durationDays,
      });
    }
  }
  for (const row of duplicateRows) {
    outcome.duplicates.push({
      memberId: row.memberId,
      memberName: row.memberName,
      suspendedAt: row.suspendedAt,
      rowNumber: row.rowNumber,
      durationDays: row.durationDays,
      existing: onFile.get(rowKey(row.memberId, row.suspendedAt)),
    });
  }
  return outcome;
}

function nameSuffix(name: string | null | undefined): string {
  return name ? ` (${name})` : '';
}

function rowSuffix(rowNumber: number | undefined): string {
  return rowNumber === undefined ? '' : ` [row ${rowNumber}]`;
}

function differsFromFile(skipped: SkippedSuspension): boolean {
  return (
    skipped.existing !== undefined &&
    skipped.durationDays !== undefined &&
    skipped.existing.durationDays !== skipped.durationDays
  );
}

function differenceSuffix(skipped: SkippedSuspension): string {
  if (!differsFromFile(skipped)) {
    return '';
  }
  const { id, durationDays } = skipped.existing;
  return ` — on file #${id} has ${durationDays} days, this row has ${skipped.durationDays}; void #${id} and re-import to correct`;
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
  const { recorded, duplicates, unknown, alreadySuspended } = outcome;
  const differing = duplicates.filter(differsFromFile).length;
  const counts = [
    duplicates.length ? `${duplicates.length} already on file` : '',
    differing ? `${differing} differ from the record on file` : '',
    alreadySuspended.length
      ? `${alreadySuspended.length} already suspended`
      : '',
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
          }${rowSuffix(d.rowNumber)}${differenceSuffix(d)}`,
      ),
    );
  }
  if (alreadySuspended.length) {
    sections.push(
      '',
      `Already suspended on that date, skipped (${alreadySuspended.length}):`,
      ...alreadySuspended.map(
        (a) =>
          `- ${a.memberId}${nameSuffix(a.memberName)}: already suspended until ${
            a.lastDay
          } (#${a.recordId})`,
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
