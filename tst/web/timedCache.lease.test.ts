import { describe, expect, it } from 'vitest';

import { BUILD_LEASE_KEY } from '../../src/lib/reports/buildLease.js';
import { requestRebuild } from '../../src/lib/reports/buildJob.js';
import { Period } from '../../src/lib/reports/period.js';
import {
  CacheTimeoutError,
  releaseLateBuildLease,
  timedCacheFactory,
} from '../../src/web/timedCache.js';
import { makeDeps } from '../lib/reports/buildJobFakes.js';
import { FakeCache } from './fakeCache.js';

const SEPT: Period = { year: 2026, month: 9 };
const REQUESTER = '123456789012345678';
const TIMEOUT_MS = 50;
const LEASE_DELAY_MS = 150;

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** The build lease's SET NX lands only after LEASE_DELAY_MS, like Redis returning from an outage. */
class SlowLeaseCache extends FakeCache {
  slow = true;

  override async exclusive_set(key: string, value: string, ttlSec?: number) {
    if (this.slow && key === BUILD_LEASE_KEY) {
      await sleep(LEASE_DELAY_MS);
    }
    return super.exclusive_set(key, value, ttlSec);
  }
}

describe('a late build lease', () => {
  it('a lease granted after the refresh timed out is released, and the next refresh is not busy', async () => {
    const slowLease = new SlowLeaseCache();
    const h = makeDeps();
    const deps = {
      ...h.deps,
      cache: timedCacheFactory(
        async () => slowLease,
        TIMEOUT_MS,
        releaseLateBuildLease(async () => slowLease),
      ),
    };

    // Through the router this is a 503: the refresh route rethrows cache timeouts.
    await expect(requestRebuild(deps, SEPT, REQUESTER)).rejects.toBeInstanceOf(
      CacheTimeoutError,
    );
    await sleep(LEASE_DELAY_MS + 50);
    expect(slowLease.values.has(BUILD_LEASE_KEY)).toBe(false);
    // The first request failed before the cooldown step.
    expect(
      [...slowLease.values.keys()].some((k) => k.includes('cooldown')),
    ).toBe(false);

    slowLease.slow = false;
    const second = await requestRebuild(deps, SEPT, REQUESTER);
    expect(second.status).toBe('started');
    if (second.status === 'started') {
      await second.done;
    }
  });
});

/** Reads of the lease key stall, like Redis pausing just as the build ends. */
class StallingReleaseCache extends FakeCache {
  stall = false;

  override async get(key: string) {
    if (this.stall && key === BUILD_LEASE_KEY) {
      await sleep(LEASE_DELAY_MS);
    }
    return super.get(key);
  }
}

describe('the background build', () => {
  it('a stall longer than the deadline on the final release still releases the lease once Redis answers', async () => {
    const inner = new StallingReleaseCache();
    const h = makeDeps();
    let finishBuild: () => void = () => undefined;
    const building = new Promise<void>((resolve) => {
      finishBuild = resolve;
    });
    const { fetchMonthReports } = h;
    const deps = {
      ...h.deps,
      fetchMonthReports: async (
        ...args: Parameters<typeof fetchMonthReports>
      ) => {
        await building;
        return fetchMonthReports(...args);
      },
      // The request phase: timed, as in production.
      cache: timedCacheFactory(
        async () => inner,
        TIMEOUT_MS,
        releaseLateBuildLease(async () => inner),
      ),
      // The detached build: the untimed inner cache.
      backgroundCache: async () => inner,
    };

    const started = await requestRebuild(deps, SEPT, REQUESTER);
    expect(started.status).toBe('started');
    expect(inner.values.has(BUILD_LEASE_KEY)).toBe(true);
    // Redis stalls for longer than the dashboard deadline as the build ends.
    inner.stall = true;
    finishBuild();
    if (started.status === 'started') {
      await expect(started.done).resolves.toEqual({ ok: true });
    }
    expect(inner.values.has(BUILD_LEASE_KEY)).toBe(false);
  });
});
