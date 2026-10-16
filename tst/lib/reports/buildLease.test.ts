import { describe, expect, it } from 'vitest';

import {
  acquireBuildLease,
  BUILD_LEASE_KEY,
  BUILD_LEASE_TTL_SEC,
  identityDigestInProgress,
  releaseBuildLease,
} from '../../../src/lib/reports/buildLease.js';
import { FakeCache } from '../../web/fakeCache.js';

class FailingGetCache extends FakeCache {
  override async get(): Promise<string | undefined> {
    throw new Error('redis down');
  }
}

describe('buildLease', () => {
  it('uses the fixed key and a 30-minute TTL', () => {
    expect(BUILD_LEASE_KEY).toBe('report-build-claim');
    expect(BUILD_LEASE_TTL_SEC).toBe(1800);
  });

  it("the lease holds the caller's value with a 30-minute TTL", async () => {
    const cache = new FakeCache();
    expect(await acquireBuildLease(cache, 'a')).toBe(true);
    expect(cache.values.get('report-build-claim')).toBe('a');
    expect(cache.ttls.get('report-build-claim')).toBe(1800);
    expect(await acquireBuildLease(cache, 'b')).toBe(false);
    expect(cache.values.get('report-build-claim')).toBe('a');
  });

  it('lease release only removes its own claim', async () => {
    const cache = new FakeCache();
    expect(await acquireBuildLease(cache, 'a')).toBe(true);
    // Our lease expired and another build took it.
    cache.values.set('report-build-claim', 'b');
    expect(await releaseBuildLease(cache, 'a')).toBe(false);
    expect(cache.values.get('report-build-claim')).toBe('b');
    expect(await releaseBuildLease(cache, 'b')).toBe(true);
    expect(cache.values.has('report-build-claim')).toBe(false);
  });

  it('release of an absent lease reports false', async () => {
    const cache = new FakeCache();
    expect(await releaseBuildLease(cache, 'a')).toBe(false);
  });

  it('release never throws', async () => {
    const cache = new FailingGetCache();
    await expect(releaseBuildLease(cache, 'a')).resolves.toBe(false);
  });

  it('defers while the identity digest claim is held without its done marker', async () => {
    // Literal key strings, not the digest.ts builders: a rename there must
    // break this test rather than silently follow along.
    const now = new Date('2026-10-05T17:30:00.000Z');
    const cases: [string, Record<string, string>, boolean][] = [
      ['no claim', {}, false],
      ['claim only', { 'identity-digest-2026-10-05': 'x' }, true],
      [
        'claim and done',
        {
          'identity-digest-2026-10-05': 'x',
          'identity-digest-done-2026-10-05': '1',
        },
        false,
      ],
      ['done only', { 'identity-digest-done-2026-10-05': '1' }, false],
      ["yesterday's claim only", { 'identity-digest-2026-10-04': 'x' }, false],
      [
        "today's claim with yesterday's done",
        {
          'identity-digest-2026-10-05': 'x',
          'identity-digest-done-2026-10-04': '1',
        },
        true,
      ],
    ];
    for (const [label, entries, expected] of cases) {
      const cache = new FakeCache();
      for (const [key, value] of Object.entries(entries)) {
        cache.values.set(key, value);
      }
      // eslint-disable-next-line no-await-in-loop -- one small case at a time
      expect(await identityDigestInProgress(cache, now), label).toBe(expected);
    }
  });

  it('the guard uses the UTC date, not the Pacific date', async () => {
    // 2026-10-06T02:00Z is still October 5th in Los Angeles.
    const cache = new FakeCache();
    cache.values.set('identity-digest-2026-10-06', 'x');
    expect(
      await identityDigestInProgress(
        cache,
        new Date('2026-10-06T02:00:00.000Z'),
      ),
    ).toBe(true);
    const pacificDay = new FakeCache();
    pacificDay.values.set('identity-digest-2026-10-05', 'x');
    expect(
      await identityDigestInProgress(
        pacificDay,
        new Date('2026-10-06T02:00:00.000Z'),
      ),
    ).toBe(false);
  });

  it('a cache failure in the guard propagates', async () => {
    await expect(
      identityDigestInProgress(new FailingGetCache(), new Date()),
    ).rejects.toThrow('redis down');
  });
});
