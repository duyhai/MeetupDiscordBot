import crypto from 'crypto';
import { describe, expect, it } from 'vitest';

import { openOAuthCookie, sealOAuthCookie } from '../../src/web/oauthCookie.js';
import { signSessionId, verifySignedSessionId } from '../../src/web/session.js';

const SECRET = 'x'.repeat(48);
const PAYLOAD = { state: 'st', verifier: 've', expiresAt: 1_000 };

/** Signs an arbitrary body the way sealOAuthCookie does. */
const signRaw = (body: string, secret = SECRET) => {
  const encoded = Buffer.from(body).toString('base64url');
  const mac = crypto
    .createHmac('sha256', secret)
    .update(`oauth:${encoded}`)
    .digest('base64url');
  return `${encoded}.${mac}`;
};

describe('OAuth cookie', () => {
  it('round-trips state and verifier before expiry', () => {
    const sealed = sealOAuthCookie(PAYLOAD, SECRET);
    expect(sealed).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(openOAuthCookie(sealed, SECRET, 999)).toEqual({
      state: 'st',
      verifier: 've',
    });
  });

  it('refuses it at and after expiry', () => {
    const sealed = sealOAuthCookie(PAYLOAD, SECRET);
    expect(openOAuthCookie(sealed, SECRET, 1_000)).toBeUndefined();
    expect(openOAuthCookie(sealed, SECRET, 5_000)).toBeUndefined();
  });

  it('refuses a tampered body, a tampered mac and another secret', () => {
    const sealed = sealOAuthCookie(PAYLOAD, SECRET);
    const dot = sealed.lastIndexOf('.');
    const body = sealed.slice(0, dot);
    const mac = sealed.slice(dot + 1);
    const forgedBody = Buffer.from(
      JSON.stringify({ s: 'st', v: 've', e: 9e15 }),
    ).toString('base64url');
    expect(openOAuthCookie(`${forgedBody}.${mac}`, SECRET, 0)).toBeUndefined();
    expect(openOAuthCookie(`${body}.${mac}x`, SECRET, 0)).toBeUndefined();
    expect(openOAuthCookie(`${body}.`, SECRET, 0)).toBeUndefined();
    expect(openOAuthCookie(sealed, 'y'.repeat(48), 0)).toBeUndefined();
  });

  it('refuses garbage and malformed JSON even when correctly signed', () => {
    expect(openOAuthCookie('', SECRET, 0)).toBeUndefined();
    expect(openOAuthCookie('no-dot', SECRET, 0)).toBeUndefined();
    expect(openOAuthCookie('.mac', SECRET, 0)).toBeUndefined();
    expect(openOAuthCookie(signRaw('{not json'), SECRET, 0)).toBeUndefined();
    expect(openOAuthCookie(signRaw('null'), SECRET, 0)).toBeUndefined();
    expect(openOAuthCookie(signRaw('"st"'), SECRET, 0)).toBeUndefined();
  });

  it('refuses a signed payload with missing or mistyped fields', () => {
    const cases = [
      { v: 've', e: 1_000 },
      { s: 'st', e: 1_000 },
      { s: 'st', v: 've' },
      { s: 1, v: 've', e: 1_000 },
      { s: 'st', v: ['ve'], e: 1_000 },
      { s: 'st', v: 've', e: '1000' },
      { s: '', v: 've', e: 1_000 },
      { s: 'st', v: '', e: 1_000 },
    ];
    for (const body of cases) {
      expect(
        openOAuthCookie(signRaw(JSON.stringify(body)), SECRET, 0),
      ).toBeUndefined();
    }
  });

  it('does not open a signed session id, nor verify as one', () => {
    const body = Buffer.from(
      JSON.stringify({ s: 'st', v: 've', e: 1_000 }),
    ).toString('base64url');
    expect(openOAuthCookie(signSessionId(body, SECRET), SECRET, 0)).toBe(
      undefined,
    );
    expect(
      verifySignedSessionId(sealOAuthCookie(PAYLOAD, SECRET), SECRET),
    ).toBeUndefined();
  });
});
