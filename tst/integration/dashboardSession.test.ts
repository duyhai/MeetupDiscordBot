import { describe, expect, it } from 'vitest';

import { RedisCache } from '../../src/lib/cache/redisCache.js';
import {
  SESSION_IDLE_SEC,
  SESSION_MAX_SEC,
  SessionStore,
  sessionKey,
} from '../../src/web/session.js';

const REDIS_AVAILABLE = Boolean(process.env.REDISCLOUD_URL);
const DAY_MS = 24 * 60 * 60 * 1000;

interface RawClient {
  ttl(k: string): Promise<number>;
  exists(k: string): Promise<number>;
}

// RedisCache has no TTL getter; reach the client for the assertions only.
const rawClient = (cache: RedisCache) =>
  (cache as unknown as { client: RawClient }).client;

(REDIS_AVAILABLE ? describe : describe.skip)('SessionStore on Redis', () => {
  it('round-trips a session and destroys it', async () => {
    const store = new SessionStore(await RedisCache.instance());
    const { sid, session } = await store.create({ userId: '1', username: 'A' });
    await expect(store.get(sid)).resolves.toEqual(session);
    await store.destroy(sid);
    await expect(store.get(sid)).resolves.toBeUndefined();
  });

  it('creates the key with the 7-day idle TTL', async () => {
    const cache = await RedisCache.instance();
    const { sid } = await new SessionStore(cache).create({
      userId: '2',
      username: 'B',
    });
    const ttl = await rawClient(cache).ttl(sessionKey(sid));
    expect(ttl).toBeGreaterThan(SESSION_IDLE_SEC - 5);
    expect(ttl).toBeLessThanOrEqual(SESSION_IDLE_SEC);
    await new SessionStore(cache).destroy(sid);
  });

  it('the role-check write slides the TTL, capped at 30 days from sign-in', async () => {
    const cache = await RedisCache.instance();
    const client = rawClient(cache);
    let now = Date.now();
    const store = new SessionStore(cache, () => now);
    const { sid, session } = await store.create({ userId: '3', username: 'C' });
    const key = sessionKey(sid);

    // Day 29: one day of the absolute lifetime left, less than the idle window.
    now = session.createdAt + 29 * DAY_MS;
    await expect(store.markRoleChecked(sid, session)).resolves.toBe(true);
    let ttl = await client.ttl(key);
    expect(ttl).toBeGreaterThan(SESSION_MAX_SEC - 29 * 86_400 - 5);
    expect(ttl).toBeLessThanOrEqual(SESSION_MAX_SEC - 29 * 86_400);

    // Day 1: a full idle window again.
    now = session.createdAt + DAY_MS;
    await expect(store.markRoleChecked(sid, session)).resolves.toBe(true);
    ttl = await client.ttl(key);
    expect(ttl).toBeGreaterThan(SESSION_IDLE_SEC - 5);
    expect(ttl).toBeLessThanOrEqual(SESSION_IDLE_SEC);
    await store.destroy(sid);
  });

  it('the role-check write never recreates a deleted session (XX)', async () => {
    const cache = await RedisCache.instance();
    const store = new SessionStore(cache);
    const { sid, session } = await store.create({ userId: '4', username: 'D' });
    await store.destroy(sid);
    await expect(store.markRoleChecked(sid, session)).resolves.toBe(false);
    await expect(rawClient(cache).exists(sessionKey(sid))).resolves.toBe(0);
  });
});
