/* eslint-disable @typescript-eslint/no-unsafe-assignment -- expect.any() matchers */
import { Client } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BUILD_TICK_MS,
  BuildJobDeps,
  runBuildTickSafely,
  startReportBuildScheduler,
  WEDGED_TICK_ALERT,
} from '../../../src/lib/reports/buildJob.js';
import { Clock, makeDeps } from './buildJobFakes.js';

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

    await expect(runBuildTickSafely(makeDepsFn, log)).resolves.toEqual({
      ok: false,
      error: expect.any(TypeError),
    });

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
    ).resolves.toEqual({ ok: false, error: expect.any(Error) });

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

  it('alerts once a day after four consecutive failed ticks', async () => {
    const { calls, setIntervalFn } = captureInterval();
    const log = fakeLog();
    const alert = vi.fn((_entry: { title: string; description?: string }) =>
      Promise.resolve(true),
    );
    let nowMs = Date.parse('2026-10-05T16:00:00Z');
    let failing = true;
    // A successful tick: the clock is before 16:00, so it returns at once.
    const quiet = makeDeps({ clock: new Clock('2026-10-05T15:00:00Z') });
    const makeDepsFn = vi.fn(() => {
      if (failing) {
        return Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5432'));
      }
      return Promise.resolve(quiet.deps);
    });
    startReportBuildScheduler(client, {
      env: DB_ENV,
      makeDeps: makeDepsFn,
      setIntervalFn,
      log,
      alert,
      now: () => nowMs,
    });
    const tickAgain = async () => {
      nowMs += 15 * 60 * 1000;
      calls[0].fn();
      await settle();
    };
    await settle(); // tick 1 (at start) failed
    await tickAgain();
    await tickAgain(); // 3 failures
    expect(alert).not.toHaveBeenCalled();
    await tickAgain(); // 4th
    expect(alert).toHaveBeenCalledTimes(1);
    const [entry] = alert.mock.calls[0];
    expect(entry.title).toBe('Report build job is failing');
    expect(entry.description).toContain('Error (details in the process log)');
    expect(entry.description).toContain('retrying every 15 minutes');
    expect(entry.description).not.toContain('ECONNREFUSED');

    await tickAgain();
    await tickAgain(); // more failures the same day
    expect(alert).toHaveBeenCalledTimes(1);

    failing = false;
    await tickAgain(); // success resets the count
    failing = true;
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- ticks are sequential
      await tickAgain();
    }
    expect(alert).toHaveBeenCalledTimes(1); // still the same UTC day

    failing = false;
    nowMs = Date.parse('2026-10-06T16:00:00Z');
    calls[0].fn();
    await settle(); // success on the next day
    failing = true;
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- ticks are sequential
      await tickAgain();
    }
    expect(alert).toHaveBeenCalledTimes(1); // 3 failures: not yet
    await tickAgain();
    expect(alert).toHaveBeenCalledTimes(2);
  });

  it('a failed infrastructure alert is only logged', async () => {
    process.on('unhandledRejection', onRejection);
    const { calls, setIntervalFn } = captureInterval();
    const log = fakeLog();
    const alert = vi.fn(() => Promise.reject(new Error('discord down')));
    const makeDepsFn = vi.fn(() => Promise.reject(new Error('boom')));
    startReportBuildScheduler(client, {
      env: DB_ENV,
      makeDeps: makeDepsFn,
      setIntervalFn,
      log,
      alert,
    });
    await settle();
    for (let i = 0; i < 3; i += 1) {
      calls[0].fn();
      // eslint-disable-next-line no-await-in-loop -- ticks are sequential
      await settle();
    }
    await settle();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(
      log.error.mock.calls.some(([m]) =>
        String(m).includes('Report build job failure alert'),
      ),
    ).toBe(true);
    expect(rejections).toEqual([]);
    // The ticks keep running.
    calls[0].fn();
    await settle();
    expect(makeDepsFn).toHaveBeenCalledTimes(5);
  });

  /** makeDeps whose ticks hang until `finish()` rejects the current one. */
  function hangingTicks() {
    let finish: () => void = () => undefined;
    const makeDepsFn = vi.fn(
      () =>
        new Promise<BuildJobDeps>((_resolve, reject) => {
          finish = () => reject(new Error('released'));
        }),
    );
    return { makeDepsFn, finish: () => finish() };
  }

  const THIRTY_MIN = 30 * 60 * 1000;
  const FAILING = 'Report build job is failing';

  it('the wedged-tick alert text is fixed and names no error', () => {
    expect(WEDGED_TICK_ALERT).toBe(
      'A report build tick has been running for over 30 minutes and has not finished. ' +
        'This usually means Redis or Postgres stopped answering (Redis queues commands while it is offline). ' +
        'No reports are built until it ends; details are in the process log.',
    );
  });

  it('a wedged tick sends the daily failure alert', async () => {
    const { calls, setIntervalFn } = captureInterval();
    const log = fakeLog();
    const alert = vi.fn((_entry: { title: string; description?: string }) =>
      Promise.resolve(true),
    );
    let nowMs = Date.parse('2026-10-05T16:00:00Z');
    const { makeDepsFn } = hangingTicks();
    startReportBuildScheduler(client, {
      env: DB_ENV,
      makeDeps: makeDepsFn,
      setIntervalFn,
      log,
      alert,
      now: () => nowMs,
    });

    nowMs += THIRTY_MIN;
    calls[0].fn(); // exactly 30 min: not yet
    await settle();
    expect(alert).not.toHaveBeenCalled();
    nowMs += 1;
    calls[0].fn();
    await settle();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith({
      title: FAILING,
      description: WEDGED_TICK_ALERT,
    });

    nowMs += 15 * 60 * 1000;
    calls[0].fn();
    await settle();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('wedge and failed ticks share one alert per UTC day', async () => {
    const { calls, setIntervalFn } = captureInterval();
    const log = fakeLog();
    const alert = vi.fn((_entry: { title: string; description?: string }) =>
      Promise.resolve(true),
    );
    let nowMs = Date.parse('2026-10-05T16:00:00Z');
    let failing = true;
    let finish: () => void = () => undefined;
    // A successful tick: the clock is before 16:00, so it returns at once.
    const quiet = makeDeps({ clock: new Clock('2026-10-05T15:00:00Z') });
    const makeDepsFn = vi.fn(() => {
      if (failing) {
        return Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5432'));
      }
      return new Promise<BuildJobDeps>((resolve) => {
        finish = () => resolve(quiet.deps);
      });
    });
    startReportBuildScheduler(client, {
      env: DB_ENV,
      makeDeps: makeDepsFn,
      setIntervalFn,
      log,
      alert,
      now: () => nowMs,
    });
    await settle(); // failure 1
    for (let i = 0; i < 3; i += 1) {
      nowMs += 15 * 60 * 1000;
      calls[0].fn();
      // eslint-disable-next-line no-await-in-loop -- ticks are sequential
      await settle();
    }
    expect(alert).toHaveBeenCalledTimes(1); // 4 failed ticks
    expect(alert.mock.calls[0][0].description).not.toBe(WEDGED_TICK_ALERT);

    // Same UTC day: a hanging tick passes 30 minutes.
    failing = false;
    nowMs += 15 * 60 * 1000;
    calls[0].fn(); // starts the hanging tick
    await settle();
    nowMs += THIRTY_MIN + 1;
    calls[0].fn();
    await settle();
    expect(alert).toHaveBeenCalledTimes(1);

    // Next UTC day: the hang ends (resetting the failure count), and a new
    // tick hangs 30 minutes: the wedge alone alerts that day.
    nowMs = Date.parse('2026-10-06T16:00:00Z');
    finish();
    await settle();
    expect(alert).toHaveBeenCalledTimes(1);
    calls[0].fn(); // new hanging tick
    await settle();
    nowMs += THIRTY_MIN + 1;
    calls[0].fn();
    await settle();
    expect(alert).toHaveBeenCalledTimes(2);
    expect(alert.mock.calls[1][0]).toEqual({
      title: FAILING,
      description: WEDGED_TICK_ALERT,
    });
  });

  it('a wedge alert on a new day comes before the failed-tick alert that day', async () => {
    const { calls, setIntervalFn } = captureInterval();
    const log = fakeLog();
    const alert = vi.fn((_entry: { title: string; description?: string }) =>
      Promise.resolve(true),
    );
    let nowMs = Date.parse('2026-10-05T16:00:00Z');
    let hang = true;
    let finish: () => void = () => undefined;
    const makeDepsFn = vi.fn(() => {
      if (hang) {
        return new Promise<BuildJobDeps>((_resolve, reject) => {
          finish = () => reject(new Error('released'));
        });
      }
      return Promise.reject(new Error('boom'));
    });
    startReportBuildScheduler(client, {
      env: DB_ENV,
      makeDeps: makeDepsFn,
      setIntervalFn,
      log,
      alert,
      now: () => nowMs,
    });
    nowMs += THIRTY_MIN + 1;
    calls[0].fn();
    await settle();
    expect(alert).toHaveBeenCalledTimes(1); // the wedge
    hang = false;
    finish(); // failed tick 1
    await settle();
    for (let i = 0; i < 4; i += 1) {
      nowMs += 15 * 60 * 1000;
      calls[0].fn();
      // eslint-disable-next-line no-await-in-loop -- ticks are sequential
      await settle();
    }
    expect(makeDepsFn).toHaveBeenCalledTimes(5);
    expect(alert).toHaveBeenCalledTimes(1); // same UTC day: shared
  });

  it('a failed wedge alert is only logged', async () => {
    process.on('unhandledRejection', onRejection);
    const { calls, setIntervalFn } = captureInterval();
    const log = fakeLog();
    const alert = vi.fn(() => Promise.reject(new Error('discord down')));
    let nowMs = Date.parse('2026-10-05T16:00:00Z');
    const { makeDepsFn } = hangingTicks();
    startReportBuildScheduler(client, {
      env: DB_ENV,
      makeDeps: makeDepsFn,
      setIntervalFn,
      log,
      alert,
      now: () => nowMs,
    });
    nowMs += THIRTY_MIN + 1;
    calls[0].fn();
    await settle();
    await settle();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(
      log.error.mock.calls.some(([m]) =>
        String(m).startsWith('Report build job failure alert failed'),
      ),
    ).toBe(true);
    expect(rejections).toEqual([]);
  });

  it('a wedge alert that was not posted is logged', async () => {
    const { calls, setIntervalFn } = captureInterval();
    const log = fakeLog();
    const alert = vi.fn(() => Promise.resolve(false));
    let nowMs = Date.parse('2026-10-05T16:00:00Z');
    const { makeDepsFn } = hangingTicks();
    startReportBuildScheduler(client, {
      env: DB_ENV,
      makeDeps: makeDepsFn,
      setIntervalFn,
      log,
      alert,
      now: () => nowMs,
    });
    nowMs += THIRTY_MIN + 1;
    calls[0].fn();
    await settle();
    expect(log.error).toHaveBeenCalledWith(
      'Report build job failure alert was not posted',
    );
  });

  it('a wedge alert whose logger also throws never reaches the process', async () => {
    process.on('unhandledRejection', onRejection);
    const { calls, setIntervalFn } = captureInterval();
    const log = {
      ...fakeLog(),
      error: vi.fn(() => {
        throw new Error('logger broke');
      }),
    };
    const alert = vi.fn(() => Promise.reject(new Error('discord down')));
    let nowMs = Date.parse('2026-10-05T16:00:00Z');
    const { makeDepsFn } = hangingTicks();
    startReportBuildScheduler(client, {
      env: DB_ENV,
      makeDeps: makeDepsFn,
      setIntervalFn,
      log,
      alert,
      now: () => nowMs,
    });
    nowMs += THIRTY_MIN + 1;
    calls[0].fn();
    await settle();
    await settle();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalled();
    expect(rejections).toEqual([]);
  });
});
