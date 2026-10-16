import { Client } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BUILD_TICK_MS,
  BuildJobDeps,
  runBuildTickSafely,
  startReportBuildScheduler,
} from '../../../src/lib/reports/buildJob.js';
import { makeDeps } from './buildJobFakes.js';

const client = {} as Client;
const DB_ENV = { DATABASE_URL: 'postgres://fake' };

const fakeLog = () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() });

/** Lets queued promise callbacks run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function captureInterval() {
  const calls: { fn: () => void; ms: number }[] = [];
  const setIntervalFn = vi.fn((fn: () => void, ms: number) => {
    calls.push({ fn, ms });
    return 0 as unknown as NodeJS.Timeout;
  }) as unknown as typeof setInterval;
  return { calls, setIntervalFn };
}

describe('runBuildTickSafely', () => {
  it('tick swallows and logs errors when making the deps fails', async () => {
    const log = fakeLog();
    const makeDepsFn = vi.fn(() => Promise.reject(new TypeError('no pool')));

    await expect(runBuildTickSafely(makeDepsFn, log)).resolves.toBeUndefined();

    expect(log.error).toHaveBeenCalledTimes(1);
    const message = String(log.error.mock.calls[0][0]);
    expect(message.startsWith('Report build tick failed')).toBe(true);
    expect(message).toBe('Report build tick failed: TypeError: no pool');
  });

  it('tick swallows and logs errors when the tick itself rejects', async () => {
    const log = fakeLog();
    const harness = makeDeps(); // clock at 16:15 UTC: inside the build window
    harness.cacheSpy.mockRejectedValue(new Error('redis down'));

    await expect(
      runBuildTickSafely(() => Promise.resolve(harness.deps), log),
    ).resolves.toBeUndefined();

    expect(harness.cacheSpy).toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
    const message = String(log.error.mock.calls[0][0]);
    expect(message).toBe('Report build tick failed: Error: redis down');
  });

  it('an infra error message reaches the process log', async () => {
    const log = fakeLog();
    const harness = makeDeps();
    harness.deps.linkProgress.hasDay = () =>
      Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5432'));

    await runBuildTickSafely(() => Promise.resolve(harness.deps), log);

    expect(log.error).toHaveBeenCalledTimes(1);
    expect(String(log.error.mock.calls[0][0])).toContain(
      'connect ECONNREFUSED 127.0.0.1:5432',
    );
  });
});

describe('startReportBuildScheduler', () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);

  afterEach(() => {
    process.off('unhandledRejection', onRejection);
    rejections.length = 0;
  });

  it('ticks every 15 minutes and once at start', () => {
    const { calls, setIntervalFn } = captureInterval();
    // Never resolves: nothing from this tick runs after the test ends.
    const makeDepsFn = vi.fn(() => new Promise<BuildJobDeps>(() => undefined));

    startReportBuildScheduler(client, {
      env: DB_ENV,
      makeDeps: makeDepsFn,
      setIntervalFn,
      log: fakeLog(),
    });

    expect(BUILD_TICK_MS).toBe(900_000);
    expect(calls).toHaveLength(1);
    expect(calls[0].ms).toBe(900_000);
    expect(makeDepsFn).toHaveBeenCalledTimes(1);
  });

  it('does not start without DATABASE_URL', () => {
    const { setIntervalFn } = captureInterval();
    const makeDepsFn = vi.fn(() => Promise.resolve(makeDeps().deps));
    const log = fakeLog();

    startReportBuildScheduler(client, {
      env: {},
      makeDeps: makeDepsFn,
      setIntervalFn,
      log,
    });

    expect(setIntervalFn).not.toHaveBeenCalled();
    expect(makeDepsFn).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'Report build job disabled: DATABASE_URL is not set',
    );
  });

  it('skips a tick while the previous one is still running', async () => {
    const { calls, setIntervalFn } = captureInterval();
    const log = fakeLog();
    // A build that never finishes.
    const makeDepsFn = vi.fn(() => new Promise<BuildJobDeps>(() => undefined));

    startReportBuildScheduler(client, {
      env: DB_ENV,
      makeDeps: makeDepsFn,
      setIntervalFn,
      log,
    });
    expect(makeDepsFn).toHaveBeenCalledTimes(1);

    calls[0].fn();
    calls[0].fn();
    await settle();

    expect(makeDepsFn).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(String(log.info.mock.calls[0][0])).toContain('still running');
  });

  it('warns once per streak when a tick has run longer than the lease TTL', async () => {
    const { calls, setIntervalFn } = captureInterval();
    const log = fakeLog();
    let nowMs = Date.parse('2026-10-05T16:00:00Z');
    let finish: () => void = () => undefined;
    let first = true;
    const makeDepsFn = vi.fn(() => {
      if (first) {
        first = false;
        // The first tick hangs until the test lets it finish (with a failure).
        return new Promise<BuildJobDeps>((_resolve, reject) => {
          finish = () => reject(new Error('released'));
        });
      }
      return new Promise<BuildJobDeps>(() => undefined);
    });

    startReportBuildScheduler(client, {
      env: DB_ENV,
      makeDeps: makeDepsFn,
      setIntervalFn,
      log,
      now: () => nowMs,
    });
    const WEDGED = 'Report build tick has been running for over 30 minutes';
    const wedgedWarnings = () =>
      log.warn.mock.calls.filter(([m]) => m === WEDGED).length;

    nowMs += 15 * 60 * 1000;
    calls[0].fn(); // 15 min: skipped, not wedged
    expect(wedgedWarnings()).toBe(0);
    nowMs += 15 * 60 * 1000;
    calls[0].fn(); // exactly 30 min: not over the TTL yet
    expect(wedgedWarnings()).toBe(0);
    nowMs += 1;
    calls[0].fn(); // over 30 min: one warning
    nowMs += 15 * 60 * 1000;
    calls[0].fn(); // same streak: no second warning
    expect(wedgedWarnings()).toBe(1);

    // The wedged tick finally ends; a new streak can warn again.
    finish();
    await settle();
    calls[0].fn(); // starts a new (hanging) tick
    expect(makeDepsFn).toHaveBeenCalledTimes(2);
    nowMs += 31 * 60 * 1000;
    calls[0].fn();
    expect(wedgedWarnings()).toBe(2);
  });

  it('runs the next tick once the previous one has finished, even after a failure', async () => {
    const { calls, setIntervalFn } = captureInterval();
    const log = fakeLog();
    const makeDepsFn = vi.fn(() => Promise.reject(new Error('boom')));

    startReportBuildScheduler(client, {
      env: DB_ENV,
      makeDeps: makeDepsFn,
      setIntervalFn,
      log,
    });
    await settle();
    calls[0].fn();
    await settle();

    expect(makeDepsFn).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledTimes(2);
  });

  it('never lets a tick rejection reach the process', async () => {
    process.on('unhandledRejection', onRejection);
    const { calls, setIntervalFn } = captureInterval();
    // Even the error logger failing must not surface as an unhandled rejection.
    const log = {
      ...fakeLog(),
      error: vi.fn(() => {
        throw new Error('logger broke');
      }),
    };
    const makeDepsFn = vi.fn(() => Promise.reject(new Error('boom')));

    startReportBuildScheduler(client, {
      env: DB_ENV,
      makeDeps: makeDepsFn,
      setIntervalFn,
      log,
    });
    await settle();
    calls[0].fn();
    await settle();
    await settle();

    expect(log.error).toHaveBeenCalledTimes(2);
    expect(makeDepsFn).toHaveBeenCalledTimes(2);
    expect(rejections).toEqual([]);
  });
});
