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
