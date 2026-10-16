// tst/web/pages.test.ts
import { describe, expect, it } from 'vitest';

import { errorPage, homePage, loginPage } from '../../src/web/pages.js';

describe('dashboard pages', () => {
  it('escapes and isolates the signed-in username', () => {
    const page = homePage({ username: '<img src=x>', csrfToken: 't' }, 'n');
    expect(page).toContain('<bdi>&lt;img src=x&gt;</bdi>');
    expect(page).not.toContain('<img src=x>');
  });

  it('puts the CSRF token in the logout form', () => {
    const page = homePage({ username: 'A', csrfToken: 'tok"en' }, 'n');
    expect(page).toContain('action="/dashboard/logout"');
    expect(page).toContain('name="_csrf" value="tok&quot;en"');
  });

  it('applies the nonce to the inline style and marks the page noindex', () => {
    const page = loginPage('abc');
    expect(page).toContain('<style nonce="abc">');
    expect(page).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(page).toContain('href="/dashboard/auth/start"');
  });

  it('shows a generic message per status and nothing else', () => {
    expect(errorPage(500, 'n')).toContain('Something went wrong');
    expect(errorPage(403, 'n')).toContain(
      'only for Moderators and the 1.5 Leadership Team',
    );
    expect(errorPage(503, 'n')).toContain('try again in a minute');
  });
  describe('home organizer login card', () => {
    const user = { username: 'A', csrfToken: 't' };

    it('home links to the organizer login page', () => {
      const page = homePage(user, 'n', { kind: 'ok' });
      expect(page).toContain('Organizer login');
      expect(page).toContain('<a href="/dashboard/organizer-login">');
      expect(page).toContain('Welcome');
    });

    it('home without an organizer status still links to the page', () => {
      const page = homePage(user, 'n');
      expect(page).toContain('<a href="/dashboard/organizer-login">');
      expect(page).not.toContain('Not set up');
      expect(page).not.toContain('Status unavailable');
    });

    it('shows OK when no failure is on record', () => {
      expect(homePage(user, 'n', { kind: 'ok' })).toContain(
        'OK (no failure on record)',
      );
    });

    it('shows the failing-since time in Pacific time', () => {
      const page = homePage(user, 'n', {
        kind: 'failing',
        since: new Date('2026-10-15T20:30:00Z'),
      });
      expect(page).toContain('Failing since Oct 15, 2026 1:30 PM Pacific time');
    });

    it('shows Not set up', () => {
      expect(homePage(user, 'n', { kind: 'not-set-up' })).toContain(
        'Not set up',
      );
    });

    it('shows Status unavailable', () => {
      expect(homePage(user, 'n', { kind: 'unavailable' })).toContain(
        'Status unavailable',
      );
    });
  });
});
