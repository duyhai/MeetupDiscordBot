import { describe, expect, it, vi } from 'vitest';

import {
  DateEditDeps,
  editSuspensionDate,
} from '../../../src/lib/suspensions/dateEdit.js';
import type { EditDateOutcome } from '../../../src/lib/repositories/postgresSuspensionRepository.js';

const LEAD = '223456789012345678';
// 10am Pacific on Nov 17.
const NOW = new Date('2026-11-17T18:00:00Z');

const record = (day: string, durationDays: number) => ({
  id: 12,
  memberId: '465124222',
  memberName: 'Alexis',
  suspendedAt: new Date(`${day}T00:00:00Z`),
  durationDays,
  notes: null,
  createdAt: NOW,
});

function setup(
  outcome: EditDateOutcome = {
    ok: true,
    before: record('2026-11-08', 30),
    after: record('2026-11-06', 60),
  },
) {
  const repo = { editDate: vi.fn(async () => outcome) };
  const deps = {
    now: () => NOW,
    repository: vi.fn(async () => repo),
    moderationLog: vi.fn(async () => true),
  } satisfies DateEditDeps;
  return { deps, repo };
}

const input = (overrides: Record<string, unknown> = {}) => ({
  actor: LEAD,
  id: 12,
  date: '2026-11-06',
  leadershipConfirmed: true as const,
  ...overrides,
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('editSuspensionDate', () => {
  it('moves the record to UTC midnight of the date, as the editor', async () => {
    const { deps, repo } = setup();
    expect(
      await editSuspensionDate(deps, input({ date: ' 2026-11-06 ' })),
    ).toEqual({
      code: 'date-changed',
    });
    expect(repo.editDate).toHaveBeenCalledWith({
      id: 12,
      suspendedAt: new Date('2026-11-06T00:00:00Z'),
      editedBy: LEAD,
    });
  });

  it('posts the record id, both dates and both lengths, never the name', async () => {
    const { deps } = setup();
    await editSuspensionDate(deps, input());
    await settle();
    const [entry] = deps.moderationLog.mock.calls[0] as unknown as [
      { title: string; description: string; fields: { value: string }[] },
    ];
    expect(entry.title).toBe('Suspension date changed');
    expect(entry.description).toContain(`<@${LEAD}>`);
    expect(entry.description).toContain('#12');
    expect(entry.fields.map((f) => f.value)).toEqual([
      '2026-11-08 → 2026-11-06',
      '30 → 60 days',
    ]);
    expect(JSON.stringify(entry)).not.toContain('Alexis');
  });

  it.each([
    ['', 'bad-date'],
    ['2026-02-30', 'bad-date'],
    ['2013-02-28', 'bad-date'],
    // Tomorrow, Pacific.
    ['2026-11-18', 'bad-date'],
    [['2026-11-06'], 'bad-date'],
    [undefined, 'bad-date'],
  ])('refuses date %j as %s without touching the store', async (date, code) => {
    const { deps, repo } = setup();
    expect(await editSuspensionDate(deps, input({ date }))).toEqual({ code });
    expect(repo.editDate).not.toHaveBeenCalled();
  });

  it('takes the first allowed day and Pacific today', async () => {
    for (const date of ['2013-03-01', '2026-11-17']) {
      const { deps } = setup();
      // eslint-disable-next-line no-await-in-loop -- one case at a time
      expect((await editSuspensionDate(deps, input({ date }))).code).toBe(
        'date-changed',
      );
    }
  });

  it('refuses a bad actor, id or a missing Leadership confirmation as invalid', async () => {
    for (const bad of [
      { actor: 'sync' },
      { id: 0 },
      { id: 2 ** 31 },
      { leadershipConfirmed: false },
    ]) {
      const { deps, repo } = setup();
      // eslint-disable-next-line no-await-in-loop -- one case at a time
      expect((await editSuspensionDate(deps, input(bad))).code).toBe('invalid');
      expect(repo.editDate).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['not-live', 'not-live'],
    ['unchanged', 'date-unchanged'],
    ['date-taken', 'date-taken'],
  ] as const)('maps %s to %s and posts nothing', async (reason, code) => {
    const { deps } = setup({ ok: false, reason });
    expect(await editSuspensionDate(deps, input())).toEqual({ code });
    await settle();
    expect(deps.moderationLog).not.toHaveBeenCalled();
  });
});
