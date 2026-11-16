import { describe, expect, it, vi } from 'vitest';

import {
  DISPLAY_NAME_TTL_SEC,
  displayNameKey,
  resolveDisplayNames,
} from '../../../src/lib/wrapped/displayNames.js';
import { FakeCache } from '../../web/fakeCache.js';

const known =
  (names: Record<string, string>) =>
  async (ids: string[]): Promise<Record<string, string>> =>
    Object.fromEntries(
      ids.filter((id) => id in names).map((id) => [id, names[id]]),
    );

describe('resolveDisplayNames', () => {
  it('serves cached names, asks the bot once for the rest, and caches only names for a day', async () => {
    const cache = new FakeCache();
    await cache.set(displayNameKey('a'), 'Ann');
    const lookup = vi.fn(known({ a: 'Not asked', b: 'Bao' }));
    const resolved = await resolveDisplayNames(
      cache,
      ['a', 'b', 'c', 'b'],
      lookup,
    );
    expect(resolved).toEqual({
      names: { a: 'Ann', b: 'Bao' },
      cached: 1,
      looked: 2,
    });
    // One call, each id once, and never one the cache had.
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith(['b', 'c']);
    expect(cache.values.get(displayNameKey('b'))).toBe('Bao');
    expect(cache.ttls.get(displayNameKey('b'))).toBe(DISPLAY_NAME_TTL_SEC);
    // No name: not cached, so it is asked again next time.
    expect(cache.values.has(displayNameKey('c'))).toBe(false);
  });

  it('a second render asks the bot for nobody it named', async () => {
    const cache = new FakeCache();
    const lookup = vi.fn(known({ x: 'Pal x', y: 'Pal y' }));
    await resolveDisplayNames(cache, ['x', 'y'], lookup);
    lookup.mockClear();
    const again = await resolveDisplayNames(cache, ['x', 'y'], lookup);
    expect(again.names).toEqual({ x: 'Pal x', y: 'Pal y' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('a failing Redis only costs the lookup, and a failing lookup only the names', async () => {
    const cache = new FakeCache();
    cache.get = async () => {
      throw new Error('redis down');
    };
    cache.set = async () => {
      throw new Error('redis down');
    };
    expect(
      (await resolveDisplayNames(cache, ['x'], known({ x: 'Xan' }))).names,
    ).toEqual({ x: 'Xan' });
    expect(
      (
        await resolveDisplayNames(cache, ['x'], async () => {
          throw new Error('discord down');
        })
      ).names,
    ).toEqual({});
  });

  it('names nothing and asks nothing for no ids', async () => {
    const lookup = vi.fn(known({}));
    expect(await resolveDisplayNames(new FakeCache(), [], lookup)).toEqual({
      names: {},
      cached: 0,
      looked: 0,
    });
    expect(lookup).not.toHaveBeenCalled();
  });
});
