import { describe, expect, it } from 'vitest';

import { PUBLIC_APP_ORIGIN, debugRedirect } from '../../src/constants.js';
import { allowedRedirectTarget } from '../../src/util/redirectTarget.js';

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
      'https://meetup-discord-bot.herokuapp.com.evil.example/',
      'https://evil.example/meetup-discord-bot.herokuapp.com',
      'https://meetup-discord-bot.herokuapp.com@evil.example/',
      'https://x@meetup-discord-bot.herokuapp.com/',
      'https://meetup-discord-bot.herokuapp.com:8443/',
      'http://meetup-discord-bot.herokuapp.com/',
      'http://localhost.evil.example/',
      'http://localhost@evil.example/',
      'http://user:pw@localhost:5000/',
      'https://localhost:5000/',
      'http://[::1]:5000/',
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
});
