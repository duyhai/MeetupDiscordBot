import crypto from 'crypto';
import { describe, expect, it } from 'vitest';

import {
  SESSION_IDLE_SEC,
  SESSION_MAX_SEC,
  SessionStore,
  VALID_AFTER_TTL_SEC,
  validAfterKey,
  safeEqual,
  signSessionId,
  verifySignedSessionId,
} from '../../src/web/session.js';
import { openOAuthCookie, sealOAuthCookie } from '../../src/web/oauthCookie.js';
import { KeyValueCache } from '../../src/lib/cache/base.js';
import { ClockedCache, FakeCache } from './fakeCache.js';

const SECRET = 'x'.repeat(48);

describe('signed session ids', () => {
  it('round-trips a signed id', () => {
    expect(verifySignedSessionId(signSessionId('abc', SECRET), SECRET)).toBe(
      'abc',
    );
  });
  it('rejects a tampered id, a tampered mac, another secret, and garbage', () => {
    const signed = signSessionId('abc', SECRET);
    const [, mac] = signed.split('.');
    expect(verifySignedSessionId(`abd.${mac}`, SECRET)).toBeUndefined();
    expect(verifySignedSessionId(`abc.${mac}x`, SECRET)).toBeUndefined();
    expect(verifySignedSessionId(signed, 'y'.repeat(48))).toBeUndefined();
    expect(verifySignedSessionId('no-dot', SECRET)).toBeUndefined();
    expect(verifySignedSessionId('.mac', SECRET)).toBeUndefined();
  });
});

const macOf = (input: string) =>
  crypto.createHmac('sha256', SECRET).update(input).digest('base64url');

describe('MAC domain separation', () => {
  it('rejects a session id whose MAC omits the sid: prefix', () => {
    const sid = 'abc';
    expect(
      verifySignedSessionId(`${sid}.${macOf(sid)}`, SECRET),
    ).toBeUndefined();
    // The prefixed MAC is what the source accepts, so the helper is faithful.
    expect(verifySignedSessionId(`${sid}.${macOf(`sid:${sid}`)}`, SECRET)).toBe(
      sid,
    );
  });

  it('rejects a session id MACed as an OAuth body', () => {
    const sid = 'abc';
    expect(
      verifySignedSessionId(`${sid}.${macOf(`oauth:${sid}`)}`, SECRET),
    ).toBeUndefined();
  });

  it('an OAuth cookie value does not verify as a session id', () => {
    const sealed = sealOAuthCookie(
      { state: 's', verifier: 'v', expiresAt: 10 },
      SECRET,
    );
    expect(verifySignedSessionId(sealed, SECRET)).toBeUndefined();
  });

  it('a signed session id does not open as an OAuth cookie', () => {
    const body = Buffer.from(
      JSON.stringify({ s: 's', v: 'v', e: 10 }),
    ).toString('base64url');
    expect(openOAuthCookie(signSessionId(body, SECRET), SECRET, 0)).toBe(
      undefined,
    );
  });
});

describe('safeEqual', () => {
  it('compares by value, including different lengths', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('SessionStore', () => {
  it('creates a session with fresh random ids and a 7-day idle TTL', async () => {
    const cache = new FakeCache();
    const store = new SessionStore(cache, () => 1_000);
    const a = await store.create({ userId: '1', username: 'A' });
    const b = await store.create({ userId: '1', username: 'A' });
    expect(a.sid).not.toBe(b.sid);
    expect(a.session.csrfToken).not.toBe(b.session.csrfToken);
    expect(a.session.csrfToken.length).toBeGreaterThanOrEqual(43);
    expect(SESSION_IDLE_SEC).toBe(7 * 24 * 60 * 60);
    expect([...cache.ttls.values()]).toEqual([
      SESSION_IDLE_SEC,
      SESSION_IDLE_SEC,
    ]);
    await expect(store.get(a.sid)).resolves.toEqual(a.session);
  });

  it('never stores the raw session id as the cache key', async () => {
    const cache = new FakeCache();
    const { sid } = await new SessionStore(cache).create({
      userId: '1',
      username: 'A',
    });
    expect([...cache.values.keys()].some((key) => key.includes(sid))).toBe(
      false,
    );
  });

  it('expires 30 days after creation even if the cache still holds it', async () => {
    let now = 0;
    const cache = new FakeCache();
    const store = new SessionStore(cache, () => now);
    const { sid } = await store.create({ userId: '1', username: 'A' });
    expect(SESSION_MAX_SEC).toBe(30 * 24 * 60 * 60);
    now = SESSION_MAX_SEC * 1000 - 1;
    await expect(store.get(sid)).resolves.toBeDefined();
    now = SESSION_MAX_SEC * 1000;
    await expect(store.get(sid)).resolves.toBeUndefined();
    expect(cache.values.size).toBe(0);
  });

  it('is gone after 7 days without a role-check write', async () => {
    let now = 0;
    const cache = new ClockedCache(() => now);
    const store = new SessionStore(cache, () => now);
    const { sid } = await store.create({ userId: '1', username: 'A' });
    now = SESSION_IDLE_SEC * 1000 - 1;
    await expect(store.get(sid)).resolves.toBeDefined();
    now = SESSION_IDLE_SEC * 1000;
    await expect(store.get(sid)).resolves.toBeUndefined();
  });

  it('the role-check write slides the idle window to a fresh 7 days', async () => {
    let now = 0;
    const cache = new ClockedCache(() => now);
    const store = new SessionStore(cache, () => now);
    const { sid, session } = await store.create({ userId: '1', username: 'A' });
    now = 6 * 24 * 60 * 60 * 1000;
    await expect(store.markRoleChecked(sid, session)).resolves.toBe(true);
    expect((await store.get(sid))?.roleCheckedAt).toBe(now);
    expect([...cache.ttls.values()]).toEqual([SESSION_IDLE_SEC]);
    // Past the first 7 days, inside the slid window.
    now = 12 * 24 * 60 * 60 * 1000;
    await expect(store.get(sid)).resolves.toBeDefined();
    now = 13 * 24 * 60 * 60 * 1000;
    await expect(store.get(sid)).resolves.toBeUndefined();
  });

  it('never slides the key past 30 days from sign-in', async () => {
    let now = 0;
    const cache = new ClockedCache(() => now);
    const store = new SessionStore(cache, () => now);
    const { sid } = await store.create({ userId: '1', username: 'A' });
    // Active every 6 days, then once more a day before the cap.
    for (const day of [6, 12, 18, 24, 29]) {
      now = day * 24 * 60 * 60 * 1000;
      // eslint-disable-next-line no-await-in-loop -- one request at a time
      const session = await store.get(sid);
      if (!session) {
        throw new Error(`session gone on day ${day}`);
      }
      // eslint-disable-next-line no-await-in-loop -- one request at a time
      await store.markRoleChecked(sid, session);
    }
    expect([...cache.ttls.values()]).toEqual([24 * 60 * 60]);
    now = SESSION_MAX_SEC * 1000 - 1;
    await expect(store.get(sid)).resolves.toBeDefined();
    // The key itself is gone at the cap, not just refused by the createdAt check.
    now = SESSION_MAX_SEC * 1000;
    expect(cache.values.size).toBe(1);
    await expect(cache.get([...cache.values.keys()][0])).resolves.toBe(
      undefined,
    );
  });

  it('a role-check write after the cap returns false even if the delete fails', async () => {
    let now = 0;
    const cache = new FakeCache();
    const store = new SessionStore(cache, () => now);
    const { sid, session } = await store.create({ userId: '1', username: 'A' });
    cache.remove = async () => {
      throw new Error('down');
    };
    now = SESSION_MAX_SEC * 1000;
    await expect(store.markRoleChecked(sid, session)).resolves.toBe(false);
  });

  it('a role-check write after the cap destroys the session', async () => {
    let now = 0;
    const cache = new FakeCache();
    const store = new SessionStore(cache, () => now);
    const { sid, session } = await store.create({ userId: '1', username: 'A' });
    now = SESSION_MAX_SEC * 1000;
    await expect(store.markRoleChecked(sid, session)).resolves.toBe(false);
    expect(cache.values.size).toBe(0);
  });

  it('does not resurrect a session destroyed during the re-check', async () => {
    const cache = new FakeCache();
    const store = new SessionStore(cache);
    const { sid, session } = await store.create({ userId: '1', username: 'A' });
    await store.destroy(sid);
    await expect(store.markRoleChecked(sid, session)).resolves.toBe(false);
    expect(cache.values.size).toBe(0);
  });

  it('markRoleChecked writes with SET XX only', async () => {
    const cache = new FakeCache();
    const store = new SessionStore(cache);
    const { sid, session } = await store.create({ userId: '1', username: 'A' });
    const calls: string[] = [];
    const spy: KeyValueCache = {
      get: async (key) => {
        calls.push('get');
        return cache.get(key);
      },
      set: async (key, value, ttl) => {
        calls.push('set');
        return cache.set(key, value, ttl);
      },
      exclusive_set: async (key, value, ttl) => {
        calls.push('exclusive_set');
        return cache.exclusive_set(key, value, ttl);
      },
      set_existing: async (key, value, ttl) => {
        calls.push('set_existing');
        return cache.set_existing(key, value, ttl);
      },
      remove: async (key) => {
        calls.push('remove');
        return cache.remove(key);
      },
    };
    await expect(
      new SessionStore(spy).markRoleChecked(sid, session),
    ).resolves.toBe(true);
    expect(calls).toEqual(['set_existing']);
  });

  it('a logout that lands before the write is not undone', async () => {
    const cache = new FakeCache();
    const store = new SessionStore(cache);
    const { sid, session } = await store.create({ userId: '1', username: 'A' });
    // The logout lands between the gate's decision and the write.
    const racing: KeyValueCache = {
      get: async (key) => cache.get(key),
      set: async (key, value, ttl) => cache.set(key, value, ttl),
      exclusive_set: async (key, value, ttl) =>
        cache.exclusive_set(key, value, ttl),
      set_existing: async (key, value, ttl) => {
        await store.destroy(sid);
        return cache.set_existing(key, value, ttl);
      },
      remove: async (key) => cache.remove(key),
    };
    await expect(
      new SessionStore(racing).markRoleChecked(sid, session),
    ).resolves.toBe(false);
    await expect(store.get(sid)).resolves.toBeUndefined();
    expect(cache.values.size).toBe(0);
  });

  it('ignores a corrupt or wrong-shaped record', async () => {
    const cache = new FakeCache();
    const store = new SessionStore(cache);
    const { sid } = await store.create({ userId: '1', username: 'A' });
    const [key] = cache.values.keys();
    await cache.set(key, '{"userId":5}');
    await expect(store.get(sid)).resolves.toBeUndefined();
    await cache.set(key, 'not json');
    await expect(store.get(sid)).resolves.toBeUndefined();
  });

  it('destroys a session', async () => {
    const cache = new FakeCache();
    const store = new SessionStore(cache);
    const { sid } = await store.create({ userId: '1', username: 'A' });
    await store.destroy(sid);
    await expect(store.get(sid)).resolves.toBeUndefined();
  });
});

describe('SessionStore revocation', () => {
  const ID = '123456789012345678';

  it('revokeUser marks the user with the longest session lifetime plus a minute', async () => {
    const cache = new FakeCache();
    await new SessionStore(cache, () => 5_000).revokeUser(ID);
    expect(VALID_AFTER_TTL_SEC).toBe(SESSION_MAX_SEC + 60);
    expect(validAfterKey(ID)).toBe(`dashboard-user-valid-after-${ID}`);
    expect(cache.values.get(validAfterKey(ID))).toBe('5000');
    expect(cache.ttls.get(validAfterKey(ID))).toBe(VALID_AFTER_TTL_SEC);
  });

  it('isRevoked: a session created at or before the mark is revoked, one created after is not', async () => {
    let now = 1_000;
    const cache = new FakeCache();
    const store = new SessionStore(cache, () => now);
    const before = await store.create({ userId: ID, username: 'A' });
    await expect(store.isRevoked(before.session)).resolves.toBe(false);
    now = 2_000;
    await store.revokeUser(ID);
    now = 2_001;
    const after = await store.create({ userId: ID, username: 'A' });
    await expect(store.isRevoked(before.session)).resolves.toBe(true);
    await expect(store.isRevoked(after.session)).resolves.toBe(false);
  });

  it('a session created in the same millisecond as the revocation is revoked', async () => {
    const cache = new FakeCache();
    const store = new SessionStore(cache, () => 3_000);
    await store.revokeUser(ID);
    const { session } = await store.create({ userId: ID, username: 'A' });
    await expect(store.isRevoked(session)).resolves.toBe(true);
  });

  it('isRevoked fails closed on a corrupt mark', async () => {
    const cache = new FakeCache();
    const store = new SessionStore(cache, () => 1_000);
    const { session } = await store.create({ userId: ID, username: 'A' });
    await cache.set(validAfterKey(ID), 'abc');
    await expect(store.isRevoked(session)).resolves.toBe(true);
    await cache.set(validAfterKey(ID), '');
    await expect(store.isRevoked(session)).resolves.toBe(true);
  });

  it('isRevoked fails closed on a session whose user id is not a Discord id', async () => {
    const store = new SessionStore(new FakeCache(), () => 1_000);
    const { session } = await store.create({ userId: '1', username: 'A' });
    await expect(store.isRevoked(session)).resolves.toBe(true);
  });

  it('the mark still ends a session left idle for 6 days after it was set', async () => {
    let now = 1_000;
    const cache = new ClockedCache(() => now);
    const store = new SessionStore(cache, () => now);
    const { sid, session } = await store.create({ userId: ID, username: 'A' });
    now += 1;
    await store.revokeUser(ID);
    now += 6 * 24 * 60 * 60 * 1000;
    await expect(store.get(sid)).resolves.toBeDefined();
    await expect(store.isRevoked(session)).resolves.toBe(true);
  });

  it('revoking one user leaves another alone', async () => {
    const cache = new FakeCache();
    const store = new SessionStore(cache, () => 1_000);
    const other = await store.create({
      userId: '999999999999999999',
      username: 'B',
    });
    await store.revokeUser(ID);
    await expect(store.isRevoked(other.session)).resolves.toBe(false);
  });

  it('revokeUser refuses a non-Discord id', async () => {
    const cache = new FakeCache();
    const store = new SessionStore(cache);
    for (const bad of ['123', '1'.repeat(21), `${ID} `, '', 'abc']) {
      // eslint-disable-next-line no-await-in-loop -- one case at a time
      await expect(store.revokeUser(bad)).rejects.toThrow(RangeError);
    }
    expect(cache.values.size).toBe(0);
  });
});
