import pg from 'pg';
import { describe, expect, it } from 'vitest';

import {
  DASHBOARD_LOCK_CLASS,
  DASHBOARD_SCHEMA_SQL,
  dashboardPoolSize,
  ensureDashboardSchema,
  SCHEMA_LOCK_KEY,
} from '../../../src/lib/repositories/dashboardPool.js';

describe('dashboardPoolSize', () => {
  it('PG_POOL_MAX overrides the pool size', () => {
    expect(dashboardPoolSize({})).toBe(3);
    expect(dashboardPoolSize({ PG_POOL_MAX: '2' })).toBe(2);
    expect(dashboardPoolSize({ PG_POOL_MAX: '1' })).toBe(1);
    expect(dashboardPoolSize({ PG_POOL_MAX: '10' })).toBe(10);
    for (const bad of ['0', '11', 'abc', '2.5', '', '-1']) {
      expect(dashboardPoolSize({ PG_POOL_MAX: bad })).toBe(3);
    }
  });
});

interface Call {
  text: string;
  values?: unknown[];
}

/** A pool whose one client records every query; COMMIT answers `commitCommand`. */
function fakePool(commitCommand = 'COMMIT', failOn?: string) {
  const calls: Call[] = [];
  let released = 0;
  const client = {
    query: (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      if (failOn !== undefined && text === failOn) {
        return Promise.reject(new Error('boom'));
      }
      return Promise.resolve({
        command: text === 'COMMIT' ? commitCommand : 'SELECT',
        rows: [],
      });
    },
    release: () => {
      released += 1;
    },
  };
  const pool = { connect: () => Promise.resolve(client) } as unknown as pg.Pool;
  return { pool, calls, released: () => released };
}

describe('ensureDashboardSchema', () => {
  it('creates the schema inside a transaction that holds the schema advisory lock', async () => {
    const { pool, calls, released } = fakePool();
    await ensureDashboardSchema(pool);
    expect(calls.map((c) => c.text)).toEqual([
      'BEGIN',
      'SELECT pg_advisory_xact_lock($1, $2)',
      DASHBOARD_SCHEMA_SQL,
      'COMMIT',
    ]);
    expect(calls[1].values).toEqual([DASHBOARD_LOCK_CLASS, SCHEMA_LOCK_KEY]);
    expect(DASHBOARD_LOCK_CLASS).toBe(52061);
    expect(SCHEMA_LOCK_KEY).toBe(0);
    expect(released()).toBe(1);
  });

  it('rejects when COMMIT reports a rollback', async () => {
    const { pool, released } = fakePool('ROLLBACK');
    await expect(ensureDashboardSchema(pool)).rejects.toThrow(
      'dashboard schema transaction rolled back',
    );
    expect(released()).toBe(1);
  });

  it('rolls back and rethrows when the schema statement fails', async () => {
    const { pool, calls, released } = fakePool('COMMIT', DASHBOARD_SCHEMA_SQL);
    await expect(ensureDashboardSchema(pool)).rejects.toThrow('boom');
    expect(calls.map((c) => c.text).at(-1)).toBe('ROLLBACK');
    expect(released()).toBe(1);
  });

  it('defines the three dashboard tables and the one-current-row index', () => {
    for (const fragment of [
      'CREATE TABLE IF NOT EXISTS report_snapshots',
      'CREATE UNIQUE INDEX IF NOT EXISTS report_snapshots_current_idx',
      'WHERE superseded_by IS NULL',
      'DEFERRABLE INITIALLY DEFERRED',
      'CREATE TABLE IF NOT EXISTS link_progress_daily',
      'CREATE TABLE IF NOT EXISTS dashboard_notices',
    ]) {
      expect(DASHBOARD_SCHEMA_SQL).toContain(fragment);
    }
  });
});
