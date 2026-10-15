import crypto from 'crypto';
import { describe, expect, it } from 'vitest';

import {
  SESSION_TTL_SEC,
  SessionStore,
  safeEqual,
  signSessionId,
  verifySignedSessionId,
} from '../../src/web/session.js';
import { openOAuthCookie, sealOAuthCookie } from '../../src/web/oauthCookie.js';
import { FakeCache } from './fakeCache.js';

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
  it('creates a session with fresh random ids and a 12-hour TTL', async () => {
    const cache = new FakeCache();
    const store = new SessionStore(cache, () => 1_000);
    const a = await store.create({ userId: '1', username: 'A' });
    const b = await store.create({ userId: '1', username: 'A' });
    expect(a.sid).not.toBe(b.sid);
    expect(a.session.csrfToken).not.toBe(b.session.csrfToken);
    expect(a.session.csrfToken.length).toBeGreaterThanOrEqual(43);
    expect([...cache.ttls.values()]).toEqual([
      SESSION_TTL_SEC,
      SESSION_TTL_SEC,
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

  it('expires 12 hours after creation even if the cache still holds it', async () => {
    let now = 0;
    const cache = new FakeCache();
    const store = new SessionStore(cache, () => now);
    const { sid } = await store.create({ userId: '1', username: 'A' });
    now = SESSION_TTL_SEC * 1000;
    await expect(store.get(sid)).resolves.toBeUndefined();
    expect(cache.values.size).toBe(0);
  });

  it('marks the role check without extending the lifetime', async () => {
    let now = 0;
    const cache = new FakeCache();
    const store = new SessionStore(cache, () => now);
    const { sid, session } = await store.create({ userId: '1', username: 'A' });
    now = 60 * 60 * 1000;
    await store.markRoleChecked(sid, session);
    expect((await store.get(sid))?.roleCheckedAt).toBe(now);
    expect([...cache.ttls.values()]).toEqual([SESSION_TTL_SEC - 3600]);
  });

  it('does not resurrect a session destroyed during the re-check', async () => {
    const cache = new FakeCache();
    const store = new SessionStore(cache);
    const { sid, session } = await store.create({ userId: '1', username: 'A' });
    await store.destroy(sid);
    await expect(store.markRoleChecked(sid, session)).resolves.toBe(false);
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
