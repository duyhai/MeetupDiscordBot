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
});
