import { describe, expect, it } from 'vitest';

import { RedisCache } from '../../src/lib/cache/redisCache.js';
import { SESSION_TTL_SEC, SessionStore } from '../../src/web/session.js';

const REDIS_AVAILABLE = Boolean(process.env.REDISCLOUD_URL);

(REDIS_AVAILABLE ? describe : describe.skip)('SessionStore on Redis', () => {
  it('round-trips a session and destroys it', async () => {
    const store = new SessionStore(await RedisCache.instance());
    const { sid, session } = await store.create({ userId: '1', username: 'A' });
    await expect(store.get(sid)).resolves.toEqual(session);
    await store.destroy(sid);
    await expect(store.get(sid)).resolves.toBeUndefined();
  });

  it('sets a TTL no longer than the session lifetime', async () => {
    const cache = await RedisCache.instance();
    const store = new SessionStore(cache);
    await store.create({ userId: '2', username: 'B' });
    // RedisCache has no TTL getter; reach the client for the assertion only.
    const client = (
      cache as unknown as {
        client: {
          keys(p: string): Promise<string[]>;
          ttl(k: string): Promise<number>;
        };
      }
    ).client;
    const [key] = await client.keys('dashboard-session-*');
    const ttl = await client.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(SESSION_TTL_SEC);
  });
});
