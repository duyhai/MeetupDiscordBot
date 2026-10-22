import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Every query any fake pool or client was sent, in order. */
const calls = vi.hoisted(
  () =>
    [] as { via: 'pool' | 'client' | 'tx'; text: string; values?: unknown[] }[],
);

const RECORD_ROW = {
  id: 7,
  member_id: '111',
  member_name: 'Ann',
  suspended_at: new Date('2026-10-03T00:00:00.000Z'),
  duration_days: 60,
  notes: 'n',
  created_at: new Date('2026-10-03T12:00:00.000Z'),
  voided_at: null,
  voided_by: null,
  void_reason: null,
};

const answer = (text: string) => {
  // insertMany's member lock keys, ban-table probe and active-ban read.
  if (text.includes("hashtext('suspension:' || m)")) {
    return { rows: [{ k: -5 }, { k: 3 }], rowCount: 2, command: 'SELECT' };
  }
  if (text.includes("to_regclass('member_bans')")) {
    return { rows: [{ present: true }], rowCount: 1, command: 'SELECT' };
  }
  if (text.includes('FROM member_bans')) {
    return { rows: [{ member_id: '222' }], rowCount: 1, command: 'SELECT' };
  }
  if (text.includes('COUNT(*)')) {
    return { rows: [{ count: '2' }], rowCount: 1, command: 'SELECT' };
  }
  if (text.startsWith('INSERT') || text.startsWith('UPDATE')) {
    return { rows: [RECORD_ROW], rowCount: 1, command: 'INSERT' };
  }
  return { rows: [], rowCount: 0, command: text.split(' ')[0] };
};

// No database: the repository's pool and its clients only record what they are sent.
vi.mock('pg', () => {
  class Pool {
    on() {
      return this;
    }

    query(text: string, values?: unknown[]) {
      calls.push({ via: 'pool', text, values });
      return Promise.resolve(answer(text));
    }

    connect() {
      return Promise.resolve({
        query: (text: string, values?: unknown[]) => {
          calls.push({ via: 'client', text, values });
          return Promise.resolve(answer(text));
        },
        on() {},
        removeListener() {},
        release() {},
      });
    }
  }
  return { default: { Pool } };
});

type Queryable =
  import('../../../src/lib/repositories/postgresSuspensionRepository.js').Queryable;
type Repo =
  import('../../../src/lib/repositories/postgresSuspensionRepository.js').PostgresSuspensionRepository;

type RepoModule =
  typeof import('../../../src/lib/repositories/postgresSuspensionRepository.js');

const fakeTx = (): Queryable =>
  ({
    query: vi.fn((text: string, values?: unknown[]) => {
      calls.push({ via: 'tx', text, values });
      return Promise.resolve(answer(text));
    }),
  }) as unknown as Queryable;

const record = {
  memberId: '111',
  memberName: 'Ann',
  suspendedAt: new Date('2026-10-03T00:00:00.000Z'),
  durationDays: 60,
  notes: 'n',
};

const only = (via: 'pool' | 'client' | 'tx', starts: string) =>
  calls
    .filter((c) => c.via === via && c.text.trimStart().startsWith(starts))
    .map(({ text, values }) => ({ text, values }));

describe('suspension SQL shared by the commands and the workspace', () => {
  const saved = { ...process.env };
  let mod: RepoModule;
  let repo: Repo;

  beforeEach(async () => {
    process.env.DATABASE_URL = 'postgres://postgres:pw@127.0.0.1:1/none';
    vi.resetModules();
    mod =
      await import('../../../src/lib/repositories/postgresSuspensionRepository.js');
    repo = await mod.PostgresSuspensionRepository.instance();
    calls.length = 0;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('insertMany locks each member in sorted key order, then reads active bans, then inserts only the unbanned (M5)', async () => {
    const result = await repo.insertMany([
      record,
      { ...record, memberId: '222' },
      record,
    ]);
    expect(result.banned).toEqual(['222']);
    expect(mod.MEMBER_LOCK_KEYS_SQL).toMatch(
      /SELECT DISTINCT hashtext\('suspension:' \|\| m\) AS k[\s\S]*ORDER BY k$/,
    );
    expect(mod.ACTIVE_BANNED_SQL).toContain('lifted_at IS NULL');
    expect(
      calls
        .filter((c) => c.via === 'client')
        .map(({ text, values }) => [text, values]),
    ).toEqual([
      ['BEGIN', undefined],
      [mod.MEMBER_LOCK_KEYS_SQL, [['111', '222']]],
      ['SELECT pg_advisory_xact_lock($1, $2)', [52062, -5]],
      ['SELECT pg_advisory_xact_lock($1, $2)', [52062, 3]],
      [mod.BANS_TABLE_PRESENT_SQL, undefined],
      [mod.ACTIVE_BANNED_SQL, [['111', '222']]],
      [mod.INSERT_SQL, ['111', 'Ann', record.suspendedAt, 60, 'n']],
      [mod.INSERT_SQL, ['111', 'Ann', record.suspendedAt, 60, 'n']],
      ['COMMIT', undefined],
    ]);
  });

  it('insert, insertMany and insertSuspensionInTx send the same SQL and parameters', async () => {
    await repo.insert(record);
    await repo.insertMany([record]);
    const inTx = await mod.insertSuspensionInTx(fakeTx(), record);
    const expected = {
      text: mod.INSERT_SQL,
      values: ['111', 'Ann', record.suspendedAt, 60, 'n'],
    };
    expect(only('pool', 'INSERT')).toEqual([expected]);
    expect(only('client', 'INSERT')).toEqual([expected]);
    expect(only('tx', 'INSERT')).toEqual([expected]);
    expect(mod.INSERT_SQL).toContain(
      'ON CONFLICT (member_id, suspended_at) WHERE voided_at IS NULL DO NOTHING',
    );
    expect(inTx).toEqual({
      id: 7,
      memberId: '111',
      memberName: 'Ann',
      suspendedAt: record.suspendedAt,
      durationDays: 60,
      notes: 'n',
      createdAt: RECORD_ROW.created_at,
    });
  });

  it('void and voidSuspensionInTx send the same SQL', async () => {
    await repo.void(7, '123456789012345678', 'wrong member');
    const inTx = await mod.voidSuspensionInTx(
      fakeTx(),
      7,
      '123456789012345678',
      'wrong member',
    );
    const expected = {
      text: mod.VOID_SQL,
      values: [7, '123456789012345678', 'wrong member'],
    };
    expect(only('pool', 'UPDATE')).toEqual([expected]);
    expect(only('tx', 'UPDATE')).toEqual([expected]);
    expect(mod.VOID_SQL).toContain('WHERE id = $1 AND voided_at IS NULL');
    expect(inTx).toMatchObject({ id: 7, memberId: '111' });
  });

  it('countSuspensionsBefore and countSuspensionsBeforeInTx send the same SQL', async () => {
    const before = new Date('2026-10-03T00:00:00.000Z');
    expect(await repo.countSuspensionsBefore('111', before)).toBe(2);
    expect(await mod.countSuspensionsBeforeInTx(fakeTx(), '111', before)).toBe(
      2,
    );
    const expected = { text: mod.COUNT_BEFORE_SQL, values: ['111', before] };
    expect(only('pool', 'SELECT COUNT')).toEqual([expected]);
    expect(only('tx', 'SELECT COUNT')).toEqual([expected]);
    expect(mod.COUNT_BEFORE_SQL).toContain(
      'member_id = $1 AND suspended_at < $2 AND voided_at IS NULL',
    );
  });

  it('a miss gives undefined, not a record', async () => {
    const miss = {
      query: vi.fn(() => Promise.resolve({ rows: [] })),
    } as unknown as Queryable;
    expect(await mod.insertSuspensionInTx(miss, record)).toBeUndefined();
    expect(
      await mod.voidSuspensionInTx(miss, 7, '123456789012345678', 'r'),
    ).toBeUndefined();
  });

  it('listByIds runs no query for no usable ids and refuses more than 50', async () => {
    expect(await repo.listByIds([])).toEqual([]);
    expect(await repo.listByIds([0, -1, 1.5, Number.NaN, 2 ** 31])).toEqual([]);
    expect(calls).toEqual([]);
    await expect(
      repo.listByIds(Array.from({ length: 51 }, (_, i) => i + 1)),
    ).rejects.toThrow(RangeError);
    expect(calls).toEqual([]);
  });
});
