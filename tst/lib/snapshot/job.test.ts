import { Client } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import {
  SNAPSHOT_TICK_MS,
  SnapshotDeps,
  SnapshotTickOutcome,
} from '../../../src/lib/snapshot/ingest.js';
import { startGroupSnapshotScheduler } from '../../../src/lib/snapshot/job.js';

const client = {} as Client;
const env = { DATABASE_URL: 'postgres://x' };

function logs() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('startGroupSnapshotScheduler', () => {
  it('without DATABASE_URL warns and never ticks', () => {
    const log = logs();
    const makeDeps = vi.fn();
    const setIntervalFn = vi.fn();
    startGroupSnapshotScheduler(client, makeDeps, {
      env: {},
      log,
      setIntervalFn: setIntervalFn as never,
    });
    expect(log.warn).toHaveBeenCalledOnce();
    expect(makeDeps).not.toHaveBeenCalled();
    expect(setIntervalFn).not.toHaveBeenCalled();
  });

  it('ticks now and every 5 minutes, skipping a tick while one runs', async () => {
    let fire: (() => void) | undefined;
    const setIntervalFn = vi.fn((fn: () => void, ms: number) => {
      expect(ms).toBe(SNAPSHOT_TICK_MS);
      fire = fn;
    });
    let release: (() => void) | undefined;
    const runTick = vi.fn(
      () =>
        new Promise<SnapshotTickOutcome>((resolve) => {
          release = () => resolve({ kind: 'skipped', reason: 'not-due' });
        }),
    );
    startGroupSnapshotScheduler(client, async () => ({}) as SnapshotDeps, {
      env,
      log: logs(),
      setIntervalFn: setIntervalFn as never,
      runTick,
    });
    await vi.waitFor(() => expect(runTick).toHaveBeenCalledTimes(1));
    fire?.();
    await Promise.resolve();
    expect(runTick).toHaveBeenCalledTimes(1);
    release?.();
    await vi.waitFor(async () => {
      fire?.();
      await Promise.resolve();
      expect(runTick).toHaveBeenCalledTimes(2);
    });
  });

  it('a failing makeDeps is logged, never thrown', async () => {
    const log = logs();
    startGroupSnapshotScheduler(
      client,
      async () => {
        throw new Error('pg down');
      },
      { env, log, setIntervalFn: vi.fn() as never },
    );
    await vi.waitFor(() => expect(log.error).toHaveBeenCalledOnce());
  });
});
