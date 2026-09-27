/**
 * The recording logic behind /meetup_record_suspension, kept out of the
 * Discord handler so the rules are testable: which rows are recorded, which
 * are skipped, and which are recorded but flagged for a moderator to check.
 */
import { SuspensionRepository } from '../repositories/types.js';
import { recommendedSuspensionDays } from './noShowReport.js';
import { ParsedSuspensionRow } from './suspensionCsv.js';
import { utcDateOnly } from './suspensionList.js';

export type RecorderRepository = Pick<
  SuspensionRepository,
  'countSuspensionsBefore' | 'insertMany' | 'listByMemberId'
>;

export type RecordedSuspension = ParsedSuspensionRow;

export interface SkippedSuspension {
  memberId: string;
  memberName: string | null;
  suspendedAt: Date;
  rowNumber: number;
  /** The duration the row asked for. */
  durationDays: number;
  /** The live record the row collided with, when it's on file. */
  existing?: { id: number; durationDays: number };
}

export interface FlaggedMember {
  memberId: string;
  memberName: string | null;
  rowNumber: number;
}

/** A recorded row whose duration isn't 30 days × 2^(prior suspensions). */
export type DurationMismatch = RecordedSuspension & {
  expectedDays: number;
  priorCount: number;
};

export interface RecordOutcome {
  recorded: RecordedSuspension[];
  /** Already on file for that member and date; not recorded again. */
  duplicates: SkippedSuspension[];
  /**
   * Recorded, but not a current member of the group: either a member who
   * has since left (backfill) or a mistyped ID.
   */
  notInGroup: FlaggedMember[];
  /** Recorded as written, but the duration doesn't follow the policy. */
  durationMismatches: DurationMismatch[];
}

const rowKey = (memberId: string, suspendedAt: Date) =>
  `${memberId}|${suspendedAt.getTime()}`;

/**
 * Records every row in one transaction, as written. `knownMembers` is the
 * group-membership lookup (id -> name): it fills in missing names and flags
 * IDs that aren't current members, but never blocks a row.
 *
 * Durations are checked against the policy only after inserting, so prior
 * suspensions from earlier-dated rows in the same file count too.
 */
export async function recordCsvRows(
  repo: RecorderRepository,
  rows: ParsedSuspensionRow[],
  knownMembers: Map<string, string>,
): Promise<RecordOutcome> {
  const outcome: RecordOutcome = {
    recorded: [],
    duplicates: [],
    notInGroup: [],
    durationMismatches: [],
  };
  const withNames = rows.map((row) => ({
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
    if (!unclaimed.delete(rowKey(row.memberId, row.suspendedAt))) {
      outcome.duplicates.push({
        memberId: row.memberId,
        memberName: row.memberName,
        suspendedAt: row.suspendedAt,
        rowNumber: row.rowNumber,
        durationDays: row.durationDays,
      });
      continue;
    }
    outcome.recorded.push(row);
    if (!knownMembers.has(row.memberId)) {
      outcome.notInGroup.push({
        memberId: row.memberId,
        memberName: row.memberName,
        rowNumber: row.rowNumber,
      });
    }
    // eslint-disable-next-line no-await-in-loop
    const priorCount = await repo.countSuspensionsBefore(
      row.memberId,
      row.suspendedAt,
    );
    const expectedDays = recommendedSuspensionDays(priorCount);
    if (row.durationDays !== expectedDays) {
      outcome.durationMismatches.push({ ...row, expectedDays, priorCount });
    }
  }
  // Look up what each duplicate collided with, so a row whose duration
  // differs from the stored one -- a correction, not a re-import -- isn't
  // dropped silently.
  const onFile = new Map<string, { id: number; durationDays: number }>();
  const duplicateIds = new Set(outcome.duplicates.map((d) => d.memberId));
  for (const memberId of duplicateIds) {
    // eslint-disable-next-line no-await-in-loop
    for (const record of await repo.listByMemberId(memberId)) {
      onFile.set(rowKey(record.memberId, record.suspendedAt), {
        id: record.id,
        durationDays: record.durationDays,
      });
    }
  }
  for (const duplicate of outcome.duplicates) {
    duplicate.existing = onFile.get(
      rowKey(duplicate.memberId, duplicate.suspendedAt),
    );
  }
  return outcome;
}

function nameSuffix(name: string | null): string {
  return name ? ` (${name})` : '';
}

function rowSuffix(rowNumber: number): string {
  return ` [row ${rowNumber}]`;
}

/** The file disagrees with the record on file -- not the policy check. */
function differsFromFile(skipped: SkippedSuspension): boolean {
  return (
    skipped.existing !== undefined &&
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
export function formatRecordSummary(outcome: RecordOutcome): {
  content: string;
  body: string;
} {
  const { recorded, duplicates, notInGroup, durationMismatches } = outcome;
  const differing = duplicates.filter(differsFromFile).length;
  const counts = [
    duplicates.length ? `${duplicates.length} already on file` : '',
    differing ? `${differing} differ from the record on file` : '',
    notInGroup.length ? `${notInGroup.length} not a current member` : '',
    durationMismatches.length
      ? `${durationMismatches.length} duration${
          durationMismatches.length === 1 ? '' : 's'
        } to check`
      : '',
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
          r.notes ? ` (${r.notes})` : ''
        }${rowSuffix(r.rowNumber)}`,
    ),
  ];
  if (durationMismatches.length) {
    sections.push(
      '',
      `Recorded, but the duration isn't 30 days × 2^(prior suspensions) — check these (${durationMismatches.length}):`,
      ...durationMismatches.map(
        (m) =>
          `- ${m.memberId}${nameSuffix(m.memberName)}: ${
            m.durationDays
          } days recorded, ${m.expectedDays} expected (prior suspensions ${
            m.priorCount
          })${rowSuffix(m.rowNumber)}`,
      ),
    );
  }
  if (notInGroup.length) {
    sections.push(
      '',
      `Recorded, but not a current member of the group — left, or a mistyped ID? (${notInGroup.length}):`,
      ...notInGroup.map(
        (u) =>
          `- ${u.memberId}${nameSuffix(u.memberName)}${rowSuffix(u.rowNumber)}`,
      ),
    );
  }
  if (duplicates.length) {
    sections.push(
      '',
      `Already on file for that date, skipped (${duplicates.length}):`,
      ...duplicates.map(
        (d) =>
          `- ${d.memberId}${nameSuffix(d.memberName)}: ${utcDateOnly(
            d.suspendedAt,
          )}${rowSuffix(d.rowNumber)}${differenceSuffix(d)}`,
      ),
    );
  }
  return { content, body: sections.join('\n') };
}
