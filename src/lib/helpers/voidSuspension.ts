/**
 * The logic behind /meetup_void_suspension, kept out of the Discord handler
 * so what gets voided and what the moderator is told are testable.
 */
import {
  SuspensionRepository,
  VoidedSuspensionRecord,
} from '../repositories/types.js';
import { utcDateOnly } from './suspensionList.js';

export type VoidRepository = Pick<SuspensionRepository, 'void'>;

export async function voidSuspension(
  repo: VoidRepository,
  id: number,
  voidedBy: string,
  reason: string,
): Promise<{ record: VoidedSuspensionRecord; reply: string }> {
  const trimmedReason = reason.trim();
  if (trimmedReason.length === 0) {
    throw new Error('`reason` must not be blank.');
  }
  const record = await repo.void(id, voidedBy, trimmedReason);
  if (record === undefined) {
    throw new Error(
      `Suspension #${id} not found or already voided. Check the ID with /meetup_list_suspensions.`,
    );
  }
  const name = record.memberName ? ` (${record.memberName})` : '';
  const reply = [
    `Voided suspension #${record.id}: ${record.memberId}${name}, ${
      record.durationDays
    } days from ${utcDateOnly(record.suspendedAt)}.`,
    'If the record was wrong rather than unwarranted, re-record the corrected ' +
      'entry with /meetup_record_suspension; the same date can be reused.',
  ].join('\n');
  return { record, reply };
}
