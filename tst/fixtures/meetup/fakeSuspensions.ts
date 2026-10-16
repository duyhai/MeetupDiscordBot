import { SuspensionRecord } from '../../../src/lib/repositories/types.js';

export interface FakeSuspension {
  memberId: string;
  /** YYYY-MM-DD */
  suspendedDay: string;
  durationDays: number;
  voided?: boolean;
}

/**
 * In-memory stand-in for PostgresSuspensionRepository. Voided entries are
 * invisible, as in the real queries. `listByMemberIds` is the batched read the
 * report services call; it is here so goldens never need to change when they
 * start using it.
 */
export function fakeSuspensionRepository(records: FakeSuspension[]) {
  const calls: {
    method: 'listByMemberId' | 'listByMemberIds';
    args: unknown[];
  }[] = [];
  const live: SuspensionRecord[] = records
    .filter((r) => !r.voided)
    .map((r, index) => ({
      id: index + 1,
      memberId: r.memberId,
      memberName: null,
      suspendedAt: new Date(`${r.suspendedDay}T00:00:00.000Z`),
      durationDays: r.durationDays,
      notes: null,
      createdAt: new Date(`${r.suspendedDay}T00:00:00.000Z`),
    }));
  const newestFirst = (a: SuspensionRecord, b: SuspensionRecord) =>
    b.suspendedAt.getTime() - a.suspendedAt.getTime();

  return {
    async listByMemberId(memberId: string): Promise<SuspensionRecord[]> {
      calls.push({ method: 'listByMemberId', args: [memberId] });
      return live.filter((r) => r.memberId === memberId).sort(newestFirst);
    },
    async listByMemberIds(
      memberIds: string[],
      before?: Date,
    ): Promise<SuspensionRecord[]> {
      calls.push({ method: 'listByMemberIds', args: [memberIds, before] });
      return live
        .filter(
          (r) =>
            memberIds.includes(r.memberId) &&
            (before === undefined || r.suspendedAt < before),
        )
        .sort(newestFirst);
    },
    calls,
  };
}
