import { describe, expect, it } from 'vitest';

import {
  MAX_PAGE,
  PAGE_SIZE,
  pageNav,
  parsePage,
} from '../../src/web/paging.js';

describe('paging', () => {
  it('pages at 50', () => {
    expect(PAGE_SIZE).toBe(50);
  });

  it('clamps page', () => {
    expect(parsePage('0')).toBe(1);
    expect(parsePage('99999')).toBe(MAX_PAGE);
    expect(MAX_PAGE).toBe(10_000);
    expect(parsePage('7')).toBe(7);
  });

  it.each([
    ['-1'],
    ['1e3'],
    ['2.5'],
    ['abc'],
    [undefined],
    [['2']],
    [''],
    ['123456'],
  ])('ignores junk: %j', (value) => {
    expect(parsePage(value)).toBe(1);
  });

  it('pageNav escapes params and omits Previous on page 1', () => {
    const out = pageNav('/dashboard/identity', 1, true, {
      member: '"><x',
      platform: undefined,
      from: '',
    }).value;
    expect(out).not.toContain('Previous');
    expect(out).toContain('Next');
    expect(out).not.toContain('"><x');
    expect(out).toContain('member=%22%3E%3Cx');
    expect(out).toContain(
      'href="/dashboard/identity?member=%22%3E%3Cx&amp;page=2"',
    );
    expect(out).not.toContain('platform');
    expect(out).not.toContain('from=');
  });

  it('pageNav links both ways in the middle and stops at the last page', () => {
    const mid = pageNav('/dashboard/suspensions', 3, true, {
      state: 'past',
    }).value;
    expect(mid).toContain(
      'href="/dashboard/suspensions?state=past&amp;page=2">Previous',
    );
    expect(mid).toContain(
      'href="/dashboard/suspensions?state=past&amp;page=4">Next',
    );
    expect(pageNav('/dashboard/suspensions', 3, false).value).not.toContain(
      'Next',
    );
    expect(
      pageNav('/dashboard/suspensions', MAX_PAGE, true).value,
    ).not.toContain('Next');
  });
});

describe('pageNav paths', () => {
  it('refuses a path outside the dashboard', () => {
    expect(() => pageNav('https://evil.example/x', 2, true)).toThrow(
      RangeError,
    );
    expect(() => pageNav('/dashboard/../x', 2, true)).toThrow(RangeError);
  });

  it('encodes * so the link stays inside the local-path charset', () => {
    expect(
      pageNav('/dashboard/identity', 1, true, { member: 'a*b' }).value,
    ).toContain('href="/dashboard/identity?member=a%2Ab&amp;page=2"');
  });
});
