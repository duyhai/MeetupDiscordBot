import { describe, expect, it } from 'vitest';

import {
  CachedWrapped,
  wrappedCacheKey,
  wrappedTtlSec,
} from '../../../src/lib/wrapped/cache.js';
import {
  HOT_TTL_SEC,
  readEntry,
  writeEntry,
} from '../../../src/lib/wrapped/store.js';
import { FakeCache } from '../../web/fakeCache.js';
import { FakeEntryStore } from './backfillFakes.js';

const USER = '100000000000000001';
/** 2026-12-10, 12:00 Pacific. */
const NOW = new Date('2026-12-10T20:00:00Z');

const copy = (year: number, meetupId = 'm1'): CachedWrapped => ({
  meetupId,
  stats: {
    year,
    firstEvent: null,
    attendedThisYear: 0,
    attendedAllTime: 0,
    topTypes: [],
    hosting: null,
    busiestMonth: null,
    longestStreakMonths: 0,
    activeYears: [],
  },
  companions: { named: [], otherCount: 0 },
  builtAt: NOW.toISOString(),
});

describe('writeEntry', () => {
  it('writes Postgres and a one-day hot copy in Redis for the current year', async () => {
    const cache = new FakeCache();
    const entries = new FakeEntryStore();

    await writeEntry({ cache, entries }, USER, 2026, copy(2026), NOW);

    expect(HOT_TTL_SEC).toBe(24 * 60 * 60);
    expect(await entries.get(USER, 2026)).toEqual(copy(2026));
    expect(cache.ttls.get(wrappedCacheKey(USER, 2026))).toBe(HOT_TTL_SEC);
  });

  it('writes a past year to Postgres only, clearing any Redis copy', async () => {
    const cache = new FakeCache();
    const entries = new FakeEntryStore();
    await cache.set(wrappedCacheKey(USER, 2025), 'stale');

    await writeEntry({ cache, entries }, USER, 2025, copy(2025), NOW);

    expect(await entries.get(USER, 2025)).toEqual(copy(2025));
    expect(cache.values.has(wrappedCacheKey(USER, 2025))).toBe(false);
  });

  it('without Postgres, Redis keeps the season TTL as before', async () => {
    const cache = new FakeCache();

    await writeEntry({ cache }, USER, 2025, copy(2025), NOW);

    expect(cache.ttls.get(wrappedCacheKey(USER, 2025))).toBe(
      wrappedTtlSec(2025, NOW),
    );
  });
});

describe('readEntry', () => {
  it('serves Redis first, then Postgres, warming Redis for the current year only', async () => {
    const cache = new FakeCache();
    const entries = new FakeEntryStore();
    await entries.put(USER, 2026, copy(2026), NOW);
    await entries.put(USER, 2025, copy(2025), NOW);

    expect(await readEntry({ cache, entries }, USER, 2026, 'm1', NOW)).toEqual(
      copy(2026),
    );
    expect(cache.ttls.get(wrappedCacheKey(USER, 2026))).toBe(HOT_TTL_SEC);
    expect(await readEntry({ cache, entries }, USER, 2025, 'm1', NOW)).toEqual(
      copy(2025),
    );
    expect(cache.values.has(wrappedCacheKey(USER, 2025))).toBe(false);
  });

  it('treats an entry for another Meetup account as a miss in both tiers', async () => {
    const cache = new FakeCache();
    const entries = new FakeEntryStore();
    await cache.set(
      wrappedCacheKey(USER, 2026),
      JSON.stringify(copy(2026, 'old')),
    );
    await entries.put(USER, 2025, copy(2025, 'old'), NOW);

    expect(
      await readEntry({ cache, entries }, USER, 2026, 'm1', NOW),
    ).toBeUndefined();
    expect(
      await readEntry({ cache, entries }, USER, 2025, 'm1', NOW),
    ).toBeUndefined();
  });

  it('a build for the current link removes the member’s rows for another account', async () => {
    const cache = new FakeCache();
    const entries = new FakeEntryStore();
    await entries.put(USER, 2024, copy(2024, 'old'), NOW);

    await writeEntry({ cache, entries }, USER, 2026, copy(2026, 'm1'), NOW);

    expect(await entries.get(USER, 2024)).toBeUndefined();
    expect(await entries.get(USER, 2026)).toEqual(copy(2026, 'm1'));
  });

  it('reads Redis alone without Postgres', async () => {
    const cache = new FakeCache();
    await cache.set(wrappedCacheKey(USER, 2026), JSON.stringify(copy(2026)));
    expect(await readEntry({ cache }, USER, 2026, 'm1', NOW)).toEqual(
      copy(2026),
    );
    expect(await readEntry({ cache }, USER, 2025, 'm1', NOW)).toBeUndefined();
  });
});
