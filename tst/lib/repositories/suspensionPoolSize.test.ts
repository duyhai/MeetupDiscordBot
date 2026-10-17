import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const poolOptions = vi.hoisted(() => [] as { max?: number }[]);

// No database: the repository only needs a pool it can call query on, and
// a client for the schema transaction.
vi.mock('pg', () => {
  const answer = () => Promise.resolve({ rows: [], command: 'COMMIT' });
  class Pool {
    constructor(options: { max?: number }) {
      poolOptions.push(options);
    }

    on() {
      return this;
    }

    query() {
      return answer();
    }

    connect() {
      return Promise.resolve({
        query: answer,
        on() {},
        removeListener() {},
        release() {},
      });
    }
  }
  return { default: { Pool } };
});

type RepoModule =
  typeof import('../../../src/lib/repositories/postgresSuspensionRepository.js');

/** A fresh module, so the singleton (and its pool) is created again. */
async function freshModule(): Promise<RepoModule> {
  vi.resetModules();
  return import('../../../src/lib/repositories/postgresSuspensionRepository.js');
}

describe('suspensionPoolSize', () => {
  it('follows PG_POOL_MAX (1-10), else 5', async () => {
    const { suspensionPoolSize } = await freshModule();
    expect(suspensionPoolSize({})).toBe(5);
    expect(suspensionPoolSize({ PG_POOL_MAX: '1' })).toBe(1);
    expect(suspensionPoolSize({ PG_POOL_MAX: '10' })).toBe(10);
    for (const bad of ['0', '11', '2.5', 'abc', '', '-1']) {
      expect(suspensionPoolSize({ PG_POOL_MAX: bad })).toBe(5);
    }
  });
});

describe('the suspension pool', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    poolOptions.length = 0;
    process.env.DATABASE_URL = 'postgres://postgres:pw@127.0.0.1:1/none';
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('stays at 5 when PG_POOL_MAX is unset (the web dyno)', async () => {
    delete process.env.PG_POOL_MAX;
    const { PostgresSuspensionRepository } = await freshModule();
    await PostgresSuspensionRepository.instance();
    expect(poolOptions.map((o) => o.max)).toEqual([5]);
  });

  it('honours PG_POOL_MAX=1 (the backfill dyno)', async () => {
    process.env.PG_POOL_MAX = '1';
    const { PostgresSuspensionRepository } = await freshModule();
    await PostgresSuspensionRepository.instance();
    expect(poolOptions.map((o) => o.max)).toEqual([1]);
  });
});
