import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  STAFF_FALLBACK,
  STAFF_NAMES_BACKOFF_MS,
  STAFF_NAMES_BUDGET_MS,
  StaffNameBackoff,
  STAFF_NAMES_MAX,
  loadStaffNames,
  staffLink,
} from '../../src/web/staffNames.js';

const A = '123456789012345678';
const B = '223456789012345678';

afterEach(() => {
  vi.useRealTimers();
});

describe('loadStaffNames', () => {
  it('asks once, for the distinct Discord ids only', async () => {
    const lookup = vi.fn(async () => ({ [A]: 'Hai', [B]: 'Stacey' }));
    const names = await loadStaffNames(lookup, [
      A,
      A,
      B,
      'sync',
      null,
      undefined,
      42,
      '1234',
    ]);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith([A, B]);
    expect(names).toEqual({ [A]: 'Hai', [B]: 'Stacey' });
  });

  it('asks nothing without a lookup or without ids', async () => {
    const lookup = vi.fn(async () => ({}));
    expect(await loadStaffNames(undefined, [A])).toEqual({});
    expect(await loadStaffNames(lookup, ['sync', null])).toEqual({});
    expect(lookup).not.toHaveBeenCalled();
  });

  it('keeps only non-empty names for ids it asked about', async () => {
    const names = await loadStaffNames(
      async () =>
        ({
          [A]: '  ',
          [B]: 7,
          '999999999999999999': 'not asked',
        }) as unknown as Record<string, string>,
      [A, B],
    );
    expect(names).toEqual({});
  });

  it('a rejecting lookup is no names', async () => {
    expect(
      await loadStaffNames(async () => {
        throw new Error('discord down');
      }, [A]),
    ).toEqual({});
  });

  it('gives up at the budget, so a slow lookup never holds the page', async () => {
    vi.useFakeTimers();
    const pending = loadStaffNames(
      () => new Promise<Record<string, string>>(() => {}),
      [A],
    );
    await vi.advanceTimersByTimeAsync(STAFF_NAMES_BUDGET_MS);
    expect(await pending).toEqual({});
    expect(vi.getTimerCount()).toBe(0);
  });

  it(`asks about at most ${STAFF_NAMES_MAX} ids`, async () => {
    const ids = Array.from(
      { length: STAFF_NAMES_MAX + 5 },
      (_, i) => `1${String(i).padStart(17, '0')}`,
    );
    const lookup = vi.fn(async (_ids: string[]) => ({}));
    await loadStaffNames(lookup, ids);
    expect(lookup.mock.calls[0][0]).toHaveLength(STAFF_NAMES_MAX);
  });
});

describe('staffLink', () => {
  it('names the profile link, escaped and isolated', () => {
    expect(staffLink(A, { [A]: '<b>Hai</b>‮' }).value).toBe(
      `<a href="https://discord.com/users/${A}" rel="noopener noreferrer" target="_blank"
        ><bdi>&lt;b&gt;Hai&lt;/b&gt;‮</bdi></a
      >`,
    );
  });

  it('falls back to "staff member" when the name is not known', () => {
    expect(staffLink(A, {}).value).toBe(
      `<a href="https://discord.com/users/${A}" rel="noopener noreferrer" target="_blank">${STAFF_FALLBACK}</a>`,
    );
  });

  it('a name never comes from a prototype key', () => {
    expect(staffLink('toString', {}).value).toBe(STAFF_FALLBACK);
  });
});

describe('staff name backoff (lead review of #162)', () => {
  it('after a timeout, pages skip the lookup for the backoff, then try again', async () => {
    vi.useFakeTimers();
    let clock = 0;
    const backoff = new StaffNameBackoff(() => clock);
    const slow = vi.fn(() => new Promise<Record<string, string>>(() => {}));
    const pending = loadStaffNames(slow, [A], STAFF_NAMES_BUDGET_MS, backoff);
    await vi.advanceTimersByTimeAsync(STAFF_NAMES_BUDGET_MS);
    expect(await pending).toEqual({});
    expect(backoff.open).toBe(false);
    // The next page answers at once, without asking.
    expect(
      await loadStaffNames(slow, [A], STAFF_NAMES_BUDGET_MS, backoff),
    ).toEqual({});
    expect(slow).toHaveBeenCalledTimes(1);
    clock += STAFF_NAMES_BACKOFF_MS;
    expect(backoff.open).toBe(true);
  });

  it('a failing lookup trips it too; a working one does not', async () => {
    const backoff = new StaffNameBackoff(() => 0);
    await loadStaffNames(async () => ({ [A]: 'Hai' }), [A], 100, backoff);
    expect(backoff.open).toBe(true);
    await loadStaffNames(
      async () => {
        throw new Error('discord down');
      },
      [A],
      100,
      backoff,
    );
    expect(backoff.open).toBe(false);
  });

  it('each lookup function has its own backoff by default', async () => {
    const failing = vi.fn(async (): Promise<Record<string, string>> => {
      throw new Error('down');
    });
    await loadStaffNames(failing, [A]);
    // Another lookup is unaffected.
    const working = vi.fn(async () => ({ [A]: 'Hai' }));
    expect(await loadStaffNames(working, [A])).toEqual({ [A]: 'Hai' });
    // The failing one is skipped until its backoff runs out.
    await loadStaffNames(failing, [A]);
    expect(failing).toHaveBeenCalledTimes(1);
  });
});
