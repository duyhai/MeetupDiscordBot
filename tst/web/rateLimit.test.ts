import { describe, expect, it } from 'vitest';

import { FixedWindowLimiter } from '../../src/web/rateLimit.js';

describe('FixedWindowLimiter', () => {
  it('allows up to the limit per key per window', () => {
    let now = 0;
    const limiter = new FixedWindowLimiter(2, 1000, () => now);
    expect([limiter.take('a'), limiter.take('a'), limiter.take('a')]).toEqual([
      true,
      true,
      false,
    ]);
    expect(limiter.take('b')).toBe(true);
    now = 1000;
    expect(limiter.take('a')).toBe(true);
  });

  it('reports seconds until the window resets', () => {
    let now = 0;
    const limiter = new FixedWindowLimiter(1, 10_000, () => now);
    limiter.take('a');
    now = 2_500;
    expect(limiter.retryAfterSec('a')).toBe(8);
  });

  it('stays bounded under many distinct keys', () => {
    const limiter = new FixedWindowLimiter(1, 60_000, () => 0, 3);
    ['a', 'b', 'c', 'd', 'e'].forEach((key) => limiter.take(key));
    expect(limiter.size).toBeLessThanOrEqual(3);
  });
});

describe('FixedWindowLimiter eviction', () => {
  it('keeps an over-limit key limited when a flood of new keys fills the map', () => {
    const limiter = new FixedWindowLimiter(1, 60_000, () => 0, 3);
    limiter.take('b');
    limiter.take('c');
    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('a')).toBe(false);
    limiter.take('d');
    expect(limiter.size).toBeLessThanOrEqual(3);
    expect(limiter.take('a')).toBe(false);
  });

  it('keeps an over-limit key limited even when it is the oldest', () => {
    const limiter = new FixedWindowLimiter(1, 60_000, () => 0, 3);
    limiter.take('a');
    expect(limiter.take('a')).toBe(false);
    limiter.take('b');
    limiter.take('c');
    for (let i = 0; i < 50; i += 1) {
      limiter.take(`flood-${i}`);
    }
    expect(limiter.size).toBeLessThanOrEqual(3);
    expect(limiter.take('a')).toBe(false);
  });

  it('evicts the oldest key only when every key is over the limit', () => {
    const limiter = new FixedWindowLimiter(1, 60_000, () => 0, 2);
    ['a', 'a', 'b', 'b'].forEach((key) => limiter.take(key));
    limiter.take('c');
    expect(limiter.size).toBe(2);
    // 'a' was oldest and went; 'b' is still limited.
    expect(limiter.take('b')).toBe(false);
  });

  it('drops expired windows before evicting live ones', () => {
    let now = 0;
    const limiter = new FixedWindowLimiter(1, 1000, () => now, 2);
    limiter.take('old');
    now = 1500;
    limiter.take('live');
    now = 1600;
    limiter.take('new');
    expect(limiter.size).toBe(2);
    expect(limiter.take('live')).toBe(false);
  });
});
