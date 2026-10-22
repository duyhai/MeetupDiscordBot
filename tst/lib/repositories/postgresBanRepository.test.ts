import type pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  FILL_PHOTO_SQL,
  PostgresBanRepository,
} from '../../../src/lib/repositories/postgresBanRepository.js';

/** Every SQL text the stub pool or its clients were sent, in order. */
let calls: string[] = [];
/** The parameters of each pool query, in the same order. */
let params: unknown[][] = [];
/** Rows the stub pool answers SELECTs with (activeMemberIds' chunks). */
let selectRows: (params: unknown[]) => unknown[] = () => [];

const answer = (text: string) => ({
  rows: [],
  rowCount: 0,
  command: text.trim().split(/\s+/)[0].toUpperCase(),
});

/** No database: the pool and its clients only record what they are sent. */
const stubPool = {
  query(text: string, values: unknown[] = []) {
    calls.push(text);
    params.push(values);
    const rows = text.trim().startsWith('SELECT') ? selectRows(values) : [];
    return Promise.resolve({ ...answer(text), rows, rowCount: rows.length });
  },
  connect() {
    return Promise.resolve({
      query(text: string) {
        calls.push(text);
        return Promise.resolve(answer(text));
      },
      on() {},
      removeListener() {},
      release() {},
    });
  },
} as unknown as pg.Pool;

describe('PostgresBanRepository SQL', () => {
  let repo: PostgresBanRepository;

  beforeEach(() => {
    calls = [];
    params = [];
    selectRows = () => [];
    repo = new PostgresBanRepository(stubPool);
  });

  it('list reads never select the photo bytes', async () => {
    await repo.listPage({ state: 'active', offset: 0, limit: 50 });
    await repo.listPage({ state: 'lifted', offset: 0, limit: 50 });
    await repo.countByState();
    await repo.activeMemberIds(['1']);
    await repo.listPhotoFillCandidates(5, '2026-10-22');
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const sql of calls) {
      expect(sql.replace(/photo IS (NOT )?NULL/g, '')).not.toMatch(
        /\bphoto\b(?!_)/,
      );
      expect(sql).not.toMatch(/SELECT \*/i);
    }
  });

  it('the sweep fill never replaces a photo: FILL_PHOTO_SQL needs photo IS NULL, and fillProfilePhoto sends it', async () => {
    expect(FILL_PHOTO_SQL).toMatch(/\bphoto IS NULL\b/);
    expect(FILL_PHOTO_SQL).toMatch(/WHERE[\s\S]*\bphoto IS NULL\b/);
    await repo.fillProfilePhoto(1, Buffer.from([1]));
    expect(calls).toEqual([FILL_PHOTO_SQL]);
  });

  it('listPage refuses a bad state before any query', async () => {
    await expect(
      repo.listPage({
        state: 'voided' as unknown as 'active',
        offset: 0,
        limit: 50,
      }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(calls).toEqual([]);
  });

  it('getPhoto skips the query for id 0, -1, 2**31 and 1.5', async () => {
    for (const id of [0, -1, 2 ** 31, 1.5]) {
      // eslint-disable-next-line no-await-in-loop
      expect(await repo.getPhoto(id)).toBeUndefined();
    }
    expect(calls).toEqual([]);
  });

  it('activeMemberIds runs no query when no valid id is left', async () => {
    expect(await repo.activeMemberIds(['12a4', ' 123', '+123', '١٢٣'])).toEqual(
      new Set(),
    );
    expect(calls).toEqual([]);
  });

  it('activeMemberIds reads more than 1000 distinct ids in chunks of 1000 and returns the union (PR review M7)', async () => {
    const ids = Array.from({ length: 2001 }, (_, i) => String(i + 1));
    // Every 500th id is banned, so each chunk contributes.
    selectRows = (values) =>
      (values[0] as string[])
        .filter((id) => Number(id) % 500 === 0 || id === '2001')
        .map((member_id) => ({ member_id }));
    const found = await repo.activeMemberIds([...ids, '1', '12a4', '0123']);
    expect(params.map((p) => (p[0] as string[]).length)).toEqual([
      1000, 1000, 1,
    ]);
    expect(new Set(params.flatMap((p) => p[0] as string[]))).toEqual(
      new Set(ids),
    );
    expect(found).toEqual(new Set(['500', '1000', '1500', '2000', '2001']));
  });
});
