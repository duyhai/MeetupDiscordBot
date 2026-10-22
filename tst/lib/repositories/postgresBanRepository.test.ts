import type pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';

import { PostgresBanRepository } from '../../../src/lib/repositories/postgresBanRepository.js';

/** Every SQL text the stub pool or its clients were sent, in order. */
let calls: string[] = [];

const answer = (text: string) => ({
  rows: [],
  rowCount: 0,
  command: text.trim().split(/\s+/)[0].toUpperCase(),
});

/** No database: the pool and its clients only record what they are sent. */
const stubPool = {
  query(text: string) {
    calls.push(text);
    return Promise.resolve(answer(text));
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
    repo = new PostgresBanRepository(stubPool);
  });

  it('list reads never select the photo bytes', async () => {
    await repo.listPage({ state: 'active', offset: 0, limit: 50 });
    await repo.listPage({ state: 'lifted', offset: 0, limit: 50 });
    await repo.countByState();
    await repo.activeMemberIds(['1']);
    await repo.listPhotoFillCandidates(5);
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const sql of calls) {
      expect(sql.replace(/photo IS (NOT )?NULL/g, '')).not.toMatch(
        /\bphoto\b(?!_)/,
      );
      expect(sql).not.toMatch(/SELECT \*/i);
    }
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

  it('activeMemberIds refuses more than 1000 distinct valid ids before any query', async () => {
    const ids = Array.from({ length: 1001 }, (_, i) => String(i + 1));
    await expect(repo.activeMemberIds(ids)).rejects.toBeInstanceOf(RangeError);
    expect(calls).toEqual([]);
  });
});
