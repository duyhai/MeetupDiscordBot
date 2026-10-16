import { EventEmitter } from 'node:events';

import pg from 'pg';
import { describe, expect, it } from 'vitest';

import {
  DASHBOARD_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  DASHBOARD_LOCK_CLASS,
  DASHBOARD_LOCK_TIMEOUT_MS,
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

interface FakeOptions {
  commitCommand?: string;
  /** This statement rejects with 'boom'. */
  failOn?: string;
  /** This statement emits a client 'error' (connection lost), then rejects. */
  dieOn?: string;
  /** ROLLBACK itself rejects. */
  rollbackFails?: boolean;
}

/** A pool whose one client records every query and how it was released. */
function fakePool(options: FakeOptions = {}) {
  const calls: Call[] = [];
  const releases: unknown[] = [];
  const client = Object.assign(new EventEmitter(), {
    query: (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      if (text === options.dieOn) {
        client.emit('error', new Error('terminating connection'));
        return Promise.reject(new Error('Connection terminated'));
      }
      if (text === options.failOn) {
        return Promise.reject(new Error('boom'));
      }
      if (text === 'ROLLBACK' && options.rollbackFails) {
        return Promise.reject(new Error('rollback failed'));
      }
      return Promise.resolve({
        command:
          text === 'COMMIT' ? (options.commitCommand ?? 'COMMIT') : 'SELECT',
        rows: [],
      });
    },
    release: (destroy?: unknown) => {
      releases.push(destroy);
    },
  });
  const pool = { connect: () => Promise.resolve(client) } as unknown as pg.Pool;
  return { pool, client, calls, releases };
}

const SET_TIMEOUTS = `SELECT set_config('lock_timeout', $1, true),
              set_config('idle_in_transaction_session_timeout', $2, true)`;

describe('ensureDashboardSchema', () => {
  it('creates the schema inside a transaction that holds the schema advisory lock', async () => {
    const { pool, client, calls, releases } = fakePool();
    await ensureDashboardSchema(pool);
    expect(calls.map((c) => c.text)).toEqual([
      'BEGIN',
      SET_TIMEOUTS,
      'SELECT pg_advisory_xact_lock($1, $2)',
      DASHBOARD_SCHEMA_SQL,
      'COMMIT',
    ]);
    expect(calls[1].values).toEqual([
      `${DASHBOARD_LOCK_TIMEOUT_MS}ms`,
      `${DASHBOARD_IDLE_IN_TRANSACTION_TIMEOUT_MS}ms`,
    ]);
    expect(calls[2].values).toEqual([DASHBOARD_LOCK_CLASS, SCHEMA_LOCK_KEY]);
    expect(DASHBOARD_LOCK_CLASS).toBe(52061);
    expect(SCHEMA_LOCK_KEY).toBe(0);
    expect(releases).toEqual([false]);
    expect(client.listenerCount('error')).toBe(0);
  });

  it('passes a test lock timeout through', async () => {
    const { pool, calls } = fakePool();
    await ensureDashboardSchema(pool, { lockTimeoutMs: 250 });
    expect(calls[1].values[0]).toBe('250ms');
  });

  it('rejects when COMMIT reports a rollback', async () => {
    const { pool, releases } = fakePool({ commitCommand: 'ROLLBACK' });
    await expect(ensureDashboardSchema(pool)).rejects.toThrow(
      'dashboard schema transaction rolled back',
    );
    expect(releases).toEqual([false]);
  });

  it('rolls back and rethrows when the schema statement fails', async () => {
    const { pool, calls, releases } = fakePool({
      failOn: DASHBOARD_SCHEMA_SQL,
    });
    await expect(ensureDashboardSchema(pool)).rejects.toThrow('boom');
    expect(calls.map((c) => c.text).at(-1)).toBe('ROLLBACK');
    expect(releases).toEqual([false]);
  });

  it('destroys a client whose connection died, without a ROLLBACK or an unhandled error', async () => {
    const { pool, client, calls, releases } = fakePool({
      dieOn: DASHBOARD_SCHEMA_SQL,
    });
    // An EventEmitter with no 'error' listener throws from emit(): if the
    // helper attached none, this rejects with the emitted error instead.
    await expect(ensureDashboardSchema(pool)).rejects.toThrow(
      'Connection terminated',
    );
    expect(calls.map((c) => c.text)).not.toContain('ROLLBACK');
    expect(releases).toEqual([true]);
    expect(client.listenerCount('error')).toBe(0);
  });

  it('destroys a client whose ROLLBACK failed', async () => {
    const { pool, releases } = fakePool({
      failOn: DASHBOARD_SCHEMA_SQL,
      rollbackFails: true,
    });
    await expect(ensureDashboardSchema(pool)).rejects.toThrow('boom');
    expect(releases).toEqual([true]);
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
