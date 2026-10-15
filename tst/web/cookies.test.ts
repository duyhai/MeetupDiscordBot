import { describe, expect, it } from 'vitest';

import {
  clearCookie,
  parseCookies,
  serializeCookie,
} from '../../src/web/cookies.js';

describe('parseCookies', () => {
  it('parses name=value pairs and keeps the first of duplicates', () => {
    const cookies = parseCookies('a=1; b=two%20words; a=3');
    expect(cookies.get('a')).toBe('1');
    expect(cookies.get('b')).toBe('two words');
  });
  it('tolerates a missing header and malformed encoding', () => {
    expect(parseCookies(undefined).size).toBe(0);
    expect(parseCookies('x=%E0%A4%A').get('x')).toBe('%E0%A4%A');
  });
});

describe('serializeCookie', () => {
  it('always sets HttpOnly, Secure and SameSite=Lax', () => {
    expect(
      serializeCookie('s', 'v', { path: '/dashboard', maxAgeSec: 60 }),
    ).toBe('s=v; Path=/dashboard; HttpOnly; Secure; SameSite=Lax; Max-Age=60');
  });
  it('clears with Max-Age=0', () => {
    expect(clearCookie('s', '/dashboard')).toBe(
      's=; Path=/dashboard; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
    );
  });
});
