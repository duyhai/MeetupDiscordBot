import { describe, expect, it } from 'vitest';

import {
  clearCookie,
  parseCookieValues,
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

describe('parseCookieValues', () => {
  it('returns every value for the name, in order, decoded', () => {
    expect(parseCookieValues('a=1; b=2; a=x%20y; a=3', 'a')).toEqual([
      '1',
      'x y',
      '3',
    ]);
  });
  it('returns nothing for an absent name or header', () => {
    expect(parseCookieValues('b=2', 'a')).toEqual([]);
    expect(parseCookieValues(undefined, 'a')).toEqual([]);
  });
  it('matches the name exactly', () => {
    expect(parseCookieValues('aa=1; A=2; a =3', 'a')).toEqual(['3']);
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
