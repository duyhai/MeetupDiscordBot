import { describe, expect, it } from 'vitest';

import { PUBLIC_APP_ORIGIN, debugRedirect } from '../../src/constants.js';
import { allowedRedirectTarget } from '../../src/util/redirectTarget.js';

const host = new URL(PUBLIC_APP_ORIGIN).host;

describe('allowedRedirectTarget', () => {
  it('allows the app origin, including the production Meetup callback', () => {
    const target = `${PUBLIC_APP_ORIGIN}/connect/meetup/callback`;
    expect(allowedRedirectTarget(target)?.toString()).toBe(target);
    expect(
      allowedRedirectTarget(`${PUBLIC_APP_ORIGIN}:443/x`)?.toString(),
    ).toBe(`${PUBLIC_APP_ORIGIN}/x`);
  });

  it('allows plain-HTTP loopback on any port', () => {
    [
      'http://localhost:5000/connect/meetup/callback',
      'http://127.0.0.1:5055/x',
      'http://localhost/x',
    ].forEach((target) => expect(allowedRedirectTarget(target)).toBeDefined());
  });

  it('refuses everything else', () => {
    [
      'https://evil.example/',
      `https://${host}.evil.example/`,
      `https://evil.example/${host}`,
      `https://${host}@evil.example/`,
      `https://x@${host}/`,
      `https://${host}:8443/`,
      `http://${host}/`,
      'http://localhost.evil.example/',
      'http://localhost@evil.example/',
      'http://user:pw@localhost:5000/',
      'https://localhost:5000/',
      'http://[::1]:5000/',
      `https://${host}./`,
      `blob:${PUBLIC_APP_ORIGIN}/x`,
      'javascript:alert(1)',
      'data:text/html,hi',
      '//evil.example/',
      '/connect/meetup/callback',
      '',
      'not a url',
    ].forEach((target) =>
      expect(allowedRedirectTarget(target), target).toBeUndefined(),
    );
  });

  it('pins how the parser normalises tricky targets', () => {
    // A backslash is a path separator, so `@evil.example/` is path, not host.
    const backslash = allowedRedirectTarget('http://localhost\\@evil.example/');
    expect(backslash).toBeDefined();
    expect(backslash?.host).toBe('localhost');
    // A trailing dot makes a different host name.
    expect(allowedRedirectTarget('http://localhost./')).toBeUndefined();
    expect(
      allowedRedirectTarget('https://meetup-discord-bot.herokuapp.com./'),
    ).toBeUndefined();
    // The decimal form of 127.0.0.1 is normalised to the loopback address.
    expect(allowedRedirectTarget('http://2130706433/')?.toString()).toBe(
      'http://127.0.0.1/',
    );
  });

  it('accepts what debugRedirect builds for the dev bot and for production', () => {
    for (const target of [
      'http://localhost:5000/connect/meetup/callback',
      `${PUBLIC_APP_ORIGIN}/connect/meetup/callback`,
    ]) {
      const encoded = debugRedirect(target).split('/redirect/')[1];
      const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
      expect(allowedRedirectTarget(decoded)?.toString()).toBe(target);
    }
  });

  it("allows the dev bot's sign-in start through the trampoline", () => {
    const target = allowedRedirectTarget(
      'http://localhost:5000/connect/meetup?state=s',
    );
    expect(target?.pathname).toBe('/connect/meetup');
    expect(target?.search).toBe('?state=s');
  });
});
