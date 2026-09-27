import { describe, expect, it } from 'vitest';

import {
  VoidRepository,
  voidSuspension,
} from '../../../src/lib/helpers/voidSuspension.js';
import { VoidedSuspensionRecord } from '../../../src/lib/repositories/types.js';

function fakeRepo(record: VoidedSuspensionRecord | undefined) {
  const calls: [number, string, string][] = [];
  const repo: VoidRepository = {
    async void(id, voidedBy, reason) {
      calls.push([id, voidedBy, reason]);
      return record;
    },
  };
  return { repo, calls };
}

const voided: VoidedSuspensionRecord = {
  id: 12,
  memberId: '987',
  memberName: 'Alice',
  suspendedAt: new Date('2026-09-01T00:00:00Z'),
  durationDays: 60,
  notes: null,
  createdAt: new Date('2026-09-01T00:00:00Z'),
  voidedAt: new Date('2026-09-26T00:00:00Z'),
  voidedBy: 'mod-1',
  voidReason: 'wrong member',
};

describe('voidSuspension', () => {
  it('voids the record and echoes member, date, and duration', async () => {
    const { repo, calls } = fakeRepo(voided);

    const result = await voidSuspension(repo, 12, 'mod-1', '  wrong member ');

    expect(calls).toEqual([[12, 'mod-1', 'wrong member']]);
    expect(result.record).toBe(voided);
    expect(result.reply).toContain('#12');
    expect(result.reply).toContain('987 (Alice)');
    expect(result.reply).toContain('2026-09-01');
    expect(result.reply).toContain('60 days');
    expect(result.reply).toMatch(/re-record the corrected entry/i);
  });

  it('refuses a blank reason without touching the record', async () => {
    const { repo, calls } = fakeRepo(voided);

    await expect(voidSuspension(repo, 12, 'mod-1', '   ')).rejects.toThrow(
      /reason/i,
    );
    expect(calls).toEqual([]);
  });

  it('reports a record that is missing or already voided', async () => {
    const { repo } = fakeRepo(undefined);

    await expect(
      voidSuspension(repo, 99, 'mod-1', 'wrong member'),
    ).rejects.toThrow(/#99.*not found or already voided/);
  });
});
