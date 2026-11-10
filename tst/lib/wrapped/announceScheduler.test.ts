import { Client } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  startWrappedAnnounceScheduler,
  WRAPPED_ANNOUNCE_TICK_MS,
  WrappedAnnounceDeps,
} from '../../../src/lib/wrapped/announce.js';

const client = {} as Client;
const CHANNEL = '123456789012345678';
const ENV = { DATABASE_URL: 'postgres://fake' };
const CONFIG = { date: '2026-12-01', hour: 17, channelId: CHANNEL };
const config = () => CONFIG;

const fakeLog = () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() });
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function captureInterval() {
  const calls: { fn: () => void; ms: number }[] = [];
  const setIntervalFn = vi.fn((fn: () => void, ms: number) => {
    calls.push({ fn, ms });
    return 0 as unknown as NodeJS.Timeout;
  }) as unknown as typeof setInterval;
  return { calls, setIntervalFn };
}

const neverDue: WrappedAnnounceDeps = {
  now: () => new Date('2026-06-01T00:00:00Z'),
  config,
  store: () => Promise.reject(new Error('not reached')),
  cache: () => Promise.reject(new Error('not reached')),
  post: () => Promise.reject(new Error('not reached')),
  recentTitles: () => Promise.resolve(undefined),
  alert: () => Promise.resolve(true),
};

describe('startWrappedAnnounceScheduler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ticks once at start and every 15 minutes', async () => {
    const { calls, setIntervalFn } = captureInterval();
    const makeDeps = vi.fn(() => neverDue);
    startWrappedAnnounceScheduler(client, makeDeps, {
      env: ENV,
      config,
      setIntervalFn,
      log: fakeLog(),
    });
    expect(WRAPPED_ANNOUNCE_TICK_MS).toBe(900_000);
    expect(calls).toHaveLength(1);
    expect(calls[0].ms).toBe(WRAPPED_ANNOUNCE_TICK_MS);
    expect(makeDeps).toHaveBeenCalledTimes(1);
    await settle(); // the first tick is over
    calls[0].fn();
    await settle();
    expect(makeDeps).toHaveBeenCalledTimes(2);
  });

  it('does not start without DATABASE_URL', () => {
    const { setIntervalFn } = captureInterval();
    const makeDeps = vi.fn(() => neverDue);
    const log = fakeLog();
    startWrappedAnnounceScheduler(client, makeDeps, {
      env: {},
      config,
      setIntervalFn,
      log,
    });
    expect(setIntervalFn).not.toHaveBeenCalled();
    expect(makeDeps).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'Wrapped announcement disabled: DATABASE_URL is not set',
    );
  });

  it.each([
    ['channel', { ...CONFIG, channelId: undefined }],
    ['date', { ...CONFIG, date: undefined }],
  ])(
    'does not start without a %s: the config already warned, so one info line and no ticks',
    (_what, disabled) => {
      const { setIntervalFn } = captureInterval();
      const makeDeps = vi.fn(() => neverDue);
      const log = fakeLog();
      startWrappedAnnounceScheduler(client, makeDeps, {
        env: ENV,
        config: () => disabled,
        setIntervalFn,
        log,
      });
      expect(setIntervalFn).not.toHaveBeenCalled();
      expect(makeDeps).not.toHaveBeenCalled();
      expect(log.warn).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledTimes(1);
      expect(String(log.info.mock.calls[0][0])).toContain('disabled');
    },
  );

  it('without an injected config, reads process.env once at boot and warns through its log', async () => {
    const { setIntervalFn } = captureInterval();
    const log = fakeLog();
    const { loadWrappedAnnounceConfig } =
      await import('../../../src/lib/wrapped/announce.js');
    // process.env has no WRAPPED_ANNOUNCE_* in tests: the channel warning is
    // the boot warning, and the memoized config never warns again.
    startWrappedAnnounceScheduler(client, () => neverDue, {
      env: ENV,
      setIntervalFn,
      log,
    });
    expect(setIntervalFn).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(String(log.warn.mock.calls[0][0])).toContain(
      'WRAPPED_ANNOUNCE_CHANNEL_ID',
    );
    const again = vi.fn();
    expect(loadWrappedAnnounceConfig(again).channelId).toBeUndefined();
    expect(again).not.toHaveBeenCalled();
  });

  it('a failing tick is logged, never thrown, and the next tick still runs', async () => {
    const { calls, setIntervalFn } = captureInterval();
    const log = fakeLog();
    const makeDeps = vi.fn(() => ({
      ...neverDue,
      now: () => new Date('2026-12-02T02:00:00Z'),
      store: () => Promise.reject(new Error('no pool')),
    }));
    startWrappedAnnounceScheduler(client, makeDeps, {
      env: ENV,
      config,
      setIntervalFn,
      log,
    });
    await settle();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(String(log.error.mock.calls[0][0])).toContain('no pool');
    calls[0].fn();
    await settle();
    expect(makeDeps).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledTimes(2);
  });

  it('skips a tick while the previous one is still running', async () => {
    const { calls, setIntervalFn } = captureInterval();
    const makeDeps = vi.fn(() => ({
      ...neverDue,
      now: () => new Date('2026-12-02T02:00:00Z'),
      store: () => new Promise<never>(() => undefined),
    }));
    startWrappedAnnounceScheduler(client, makeDeps, {
      env: ENV,
      config,
      setIntervalFn,
      log: fakeLog(),
    });
    calls[0].fn();
    calls[0].fn();
    await settle();
    expect(makeDeps).toHaveBeenCalledTimes(1);
  });

  it('logs a posted outcome', async () => {
    const { setIntervalFn } = captureInterval();
    const log = fakeLog();
    const makeDeps = vi.fn(() => ({
      ...neverDue,
      now: () => new Date('2026-12-02T02:00:00Z'),
      store: async () => ({
        claim: async () => 'fresh' as const,
        markPosted: async () => true,
        release: async () => undefined,
        get: async () => undefined,
      }),
      post: async () => ({ messageId: '987654321098765432' }),
    }));
    startWrappedAnnounceScheduler(client, makeDeps, {
      env: ENV,
      config,
      setIntervalFn,
      log,
    });
    await settle();
    expect(log.info).toHaveBeenCalledWith('Wrapped announcement: posted');
  });
});
