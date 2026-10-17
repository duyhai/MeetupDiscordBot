/* eslint-disable no-await-in-loop -- each case runs alone on the fake clock */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { KeyValueCache } from '../../src/lib/cache/base.js';
import { BUILD_LEASE_KEY } from '../../src/lib/reports/buildLease.js';
import {
  CacheTimeoutError,
  DASHBOARD_CACHE_TIMEOUT_MS,
  releaseLateBuildLease,
  timedCache,
  timedCacheFactory,
} from '../../src/web/timedCache.js';
import { FakeCache } from './fakeCache.js';

const never = <T>() => new Promise<T>(() => undefined);

/** Every call hangs forever. */
const hangingCache = (): KeyValueCache => ({
  get: () => never(),
  set: () => never(),
  exclusive_set: () => never(),
  set_existing: () => never(),
  remove: () => never(),
});

/** exclusive_set answers only when the test settles it. */
function deferredExclusive() {
  let settle: { resolve: (won: boolean) => void; reject: (e: Error) => void };
  const inner = new FakeCache();
  const exclusive = vi.fn(
    () =>
      new Promise<boolean>((resolve, reject) => {
        settle = { resolve, reject };
      }),
  );
  inner.exclusive_set = exclusive;
  return {
    inner,
    exclusive,
    win: () => settle.resolve(true),
    lose: () => settle.resolve(false),
    fail: () => settle.reject(new Error('late failure')),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('timedCache', () => {
  it('times out after two seconds by default', () => {
    expect(DASHBOARD_CACHE_TIMEOUT_MS).toBe(2_000);
  });

  it('rejects with CacheTimeoutError after the deadline', async () => {
    vi.useFakeTimers();
    const cache = timedCache(hangingCache(), 2_000);
    for (const call of [
      () => cache.get('k'),
      () => cache.set('k', 'v', 1),
      () => cache.exclusive_set('k', 'v', 1),
      () => cache.set_existing('k', 'v', 1),
      () => cache.remove('k'),
    ]) {
      const pending = call();
      const settled = vi.fn();
      pending.catch(settled);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).rejects.toBeInstanceOf(CacheTimeoutError);
    }
  });

  it('passes values and errors through and clears its timer', async () => {
    vi.useFakeTimers();
    const inner = new FakeCache();
    const cache = timedCache(inner, 2_000);
    await cache.set('k', 'v', 60);
    expect(inner.ttls.get('k')).toBe(60);
    await expect(cache.get('k')).resolves.toBe('v');
    await expect(cache.exclusive_set('k', 'w')).resolves.toBe(false);
    await expect(cache.set_existing('k', 'x', 5)).resolves.toBe(true);
    await expect(cache.get('k')).resolves.toBe('x');
    await cache.remove('k');
    await expect(cache.get('k')).resolves.toBeUndefined();
    inner.get = () => Promise.reject(new Error('inner failure'));
    await expect(cache.get('k')).rejects.toThrow('inner failure');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the deadline timer does not keep the process alive', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const pending = timedCache(hangingCache(), 60_000).get('k');
      pending.catch(() => undefined);
      const timer = spy.mock.results.at(-1)?.value as NodeJS.Timeout;
      expect(timer.hasRef()).toBe(false);
      clearTimeout(timer);
    } finally {
      spy.mockRestore();
    }
  });

  it('the factory times out a connect that never finishes', async () => {
    vi.useFakeTimers();
    const factory = timedCacheFactory(() => never<KeyValueCache>(), 50);
    const pending = factory();
    pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).rejects.toBeInstanceOf(CacheTimeoutError);
  });

  it('the factory wraps what it obtains', async () => {
    vi.useFakeTimers();
    const factory = timedCacheFactory(async () => hangingCache(), 50);
    const cache = await factory();
    const pending = cache.get('k');
    pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).rejects.toBeInstanceOf(CacheTimeoutError);
  });

  it('a late exclusive_set win calls onLateExclusiveSet once; a late loss or a late error does not', async () => {
    vi.useFakeTimers();
    for (const outcome of ['win', 'lose', 'fail'] as const) {
      const d = deferredExclusive();
      const onLateExclusiveSet = vi.fn();
      const cache = timedCache(d.inner, 50, { onLateExclusiveSet });
      const pending = cache.exclusive_set('lease', 'mine', 60);
      pending.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(50);
      await expect(pending).rejects.toBeInstanceOf(CacheTimeoutError);
      d[outcome]();
      await vi.advanceTimersByTimeAsync(0);
      if (outcome === 'win') {
        expect(onLateExclusiveSet).toHaveBeenCalledTimes(1);
        expect(onLateExclusiveSet).toHaveBeenCalledWith('lease', 'mine');
      } else {
        expect(onLateExclusiveSet, outcome).not.toHaveBeenCalled();
      }
    }
  });

  it('onLateExclusiveSet is not called when exclusive_set answers in time', async () => {
    vi.useFakeTimers();
    const d = deferredExclusive();
    const onLateExclusiveSet = vi.fn();
    const cache = timedCache(d.inner, 50, { onLateExclusiveSet });
    const pending = cache.exclusive_set('lease', 'mine', 60);
    d.win();
    await expect(pending).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(onLateExclusiveSet).not.toHaveBeenCalled();
    // A rejection in time is passed through, not treated as late.
    const d2 = deferredExclusive();
    const cache2 = timedCache(d2.inner, 50, { onLateExclusiveSet });
    const failing = cache2.exclusive_set('lease', 'mine', 60);
    d2.fail();
    await expect(failing).rejects.toThrow('late failure');
    expect(onLateExclusiveSet).not.toHaveBeenCalled();
  });
});

describe('releaseLateBuildLease', () => {
  const log = () => ({ warn: vi.fn(), error: vi.fn() });

  it('releases only the build lease, by value', async () => {
    const inner = new FakeCache();
    const remove = vi.spyOn(inner, 'remove');
    const l = log();
    const { onLateExclusiveSet } = releaseLateBuildLease(async () => inner, l);

    // Not the lease: nothing is touched.
    await inner.set('report-rebuild-cooldown-2026-09', 'someone');
    onLateExclusiveSet('report-rebuild-cooldown-2026-09', 'someone');
    await vi.waitFor(() => expect(l.warn).not.toHaveBeenCalled());
    expect(inner.values.has('report-rebuild-cooldown-2026-09')).toBe(true);
    expect(remove).not.toHaveBeenCalled();

    // Our late lease: released.
    await inner.set(BUILD_LEASE_KEY, 'late-value');
    onLateExclusiveSet(BUILD_LEASE_KEY, 'late-value');
    await vi.waitFor(() =>
      expect(inner.values.has(BUILD_LEASE_KEY)).toBe(false),
    );
    expect(l.warn).toHaveBeenCalledTimes(1);

    // Another build holds it now: left in place.
    await inner.set(BUILD_LEASE_KEY, 'another-build');
    onLateExclusiveSet(BUILD_LEASE_KEY, 'late-value');
    await vi.waitFor(() => expect(l.warn).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(inner.values.get(BUILD_LEASE_KEY)).toBe('another-build');
  });

  it('logs and never throws when the inner cache cannot be obtained', async () => {
    const l = log();
    const { onLateExclusiveSet } = releaseLateBuildLease(
      () => Promise.reject(new Error('no redis')),
      l,
    );
    expect(() => onLateExclusiveSet(BUILD_LEASE_KEY, 'v')).not.toThrow();
    await vi.waitFor(() => expect(l.error).toHaveBeenCalledTimes(1));
  });
});
