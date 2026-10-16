import { describe, expect, it } from 'vitest';

import {
  SafeHtml,
  SafeUrl,
  UnsafeUrlError,
  escapeHtml,
  html,
  isSafeHtml,
  isSafeUrl,
  localUrl,
  memberText,
  pageLink,
  safeHref,
  staticHtml,
} from '../../src/web/html.js';

/** safeHref's result as text, for comparisons. */
const hrefOf = (url: string) => safeHref(url)?.href;

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });
});

describe('html', () => {
  it('escapes interpolated strings and numbers', () => {
    expect(html`<p>${'<script>'} ${3}</p>`.value).toBe(
      '<p>&lt;script&gt; 3</p>',
    );
  });

  it('inserts SafeHtml unescaped and flattens arrays', () => {
    const items = ['<a>', 'b'].map((x) => html`<li>${x}</li>`);
    // prettier-ignore
    const list = html`<ul>${items}</ul>`;
    expect(list.value).toBe('<ul><li>&lt;a&gt;</li><li>b</li></ul>');
  });

  it('renders null, undefined and false as nothing', () => {
    expect(html`a${null}b${undefined}c${false}d`.value).toBe('abcd');
  });

  it('returns a SafeHtml', () => {
    expect(isSafeHtml(html`x`)).toBe(true);
    expect(isSafeUrl(html`x`)).toBe(false);
  });
});

describe('safeHref', () => {
  it('allows Meetup pages and Discord user profiles over https', () => {
    expect(hrefOf('https://www.meetup.com/members/123/')).toBe(
      'https://www.meetup.com/members/123/',
    );
    expect(hrefOf('https://www.meetup.com/1-5genasians/events/9/')).toBe(
      'https://www.meetup.com/1-5genasians/events/9/',
    );
    expect(hrefOf('https://discord.com/users/123456789012345678')).toBe(
      'https://discord.com/users/123456789012345678',
    );
  });

  it('allows exactly the Meetup OAuth authorize endpoint, with its query', () => {
    const url =
      'https://secure.meetup.com/oauth2/authorize?response_type=code&client_id=k&state=s&redirect_uri=https%3A%2F%2Fx';
    expect(hrefOf(url)).toBe(url);
    expect(hrefOf('https://secure.meetup.com/oauth2/authorize')).toBe(
      'https://secure.meetup.com/oauth2/authorize',
    );
  });

  it('refuses other secure.meetup.com paths', () => {
    [
      'https://secure.meetup.com/',
      'https://secure.meetup.com/oauth2/access',
      'https://secure.meetup.com/oauth2/authorize/',
      'https://secure.meetup.com/oauth2/authorize/../access',
      'https://secure.meetup.com/oauth2/authorizex',
      'https://secure.meetup.com/login/',
      'http://secure.meetup.com/oauth2/authorize',
      'https://secure.meetup.com:444/oauth2/authorize',
      'https://secure.meetup.com.evil.example/oauth2/authorize',
    ].forEach((url) => expect(hrefOf(url)).toBeUndefined());
  });

  it('refuses everything else', () => {
    [
      'javascript:alert(1)',
      'http://www.meetup.com/members/1/',
      'https://www.meetup.com.evil.example/',
      'https://www.meetup.com@evil.example/',
      'https://user:pw@www.meetup.com/',
      'https://www.meetup.com:8443/',
      'https://discord.com/invite/abc',
      'https://evil.example/',
      '/dashboard',
      'not a url',
    ].forEach((url) => expect(hrefOf(url)).toBeUndefined());
  });
});

describe('memberText', () => {
  it('escapes and isolates direction', () => {
    expect(memberText('‮evil<b>').value).toBe('<bdi>‮evil&lt;b&gt;</bdi>');
  });
});

describe('safeHref brand', () => {
  it('safeHref returns a SafeUrl', () => {
    const url = safeHref('https://discord.com/users/1');
    expect(isSafeUrl(url)).toBe(true);
    expect(url?.href).toBe('https://discord.com/users/1');
    expect(String(url)).toBe('https://discord.com/users/1');
  });
});

describe('URL attributes', () => {
  const plain = 'https://www.meetup.com/x';

  it('a plain string in href is refused', () => {
    expect(() => html`<a href="${plain}">x</a>`).toThrow(UnsafeUrlError);
    expect(() => html`<img src="${'javascript:alert(1)'}" />`).toThrow(
      UnsafeUrlError,
    );
    expect(() => html`<form action="${'javascript:alert(1)'}"></form>`).toThrow(
      UnsafeUrlError,
    );
    expect(
      () => html`<button formaction="${'javascript:alert(1)'}"></button>`,
    ).toThrow(UnsafeUrlError);
    expect(() => html`<a href="${undefined}">x</a>`).toThrow(UnsafeUrlError);
    // prettier-ignore
    expect(() => html`<a HREF = "${plain}">x</a>`).toThrow(UnsafeUrlError);
    // prettier-ignore
    expect(() => html`<a href='${plain}'>x</a>`).toThrow(UnsafeUrlError);
  });

  it('a partial or unquoted URL attribute is refused', () => {
    expect(
      () => html`<img src="/dashboard/x/${localUrl('/dashboard/y')}" />`,
    ).toThrow(UnsafeUrlError);
    expect(() => html`<a href=${localUrl('/dashboard')}>x</a>`).toThrow(
      UnsafeUrlError,
    );
    expect(() => html`<a href="${localUrl('/dashboard')}/x">x</a>`).toThrow(
      UnsafeUrlError,
    );
    expect(
      () =>
        html`<a href="${localUrl('/dashboard')}${localUrl('/dashboard')}"></a>`,
    ).toThrow(UnsafeUrlError);
  });

  it('SafeHtml in a URL attribute is refused', () => {
    expect(() => html`<a href="${html`/dashboard`}">x</a>`).toThrow(
      UnsafeUrlError,
    );
  });

  it('a SafeUrl fills a quoted URL attribute, escaped', () => {
    expect(
      html`<a href="${localUrl('/dashboard/a?x=1&y=2')}">x</a>`.value,
    ).toBe('<a href="/dashboard/a?x=1&amp;y=2">x</a>');
    // prettier-ignore
    expect(html`<a href='${localUrl('/dashboard')}'>x</a>`.value).toBe(
      "<a href='/dashboard'>x</a>",
    );
    const external = safeHref('https://www.meetup.com/members/1/');
    expect(html`<a href="${external}">x</a>`.value).toBe(
      '<a href="https://www.meetup.com/members/1/">x</a>',
    );
  });

  it('a SafeUrl outside a URL attribute renders as escaped text', () => {
    expect(html`<p>${localUrl('/dashboard?a=1&b=2')}</p>`.value).toBe(
      '<p>/dashboard?a=1&amp;b=2</p>',
    );
  });

  it('URL attributes without interpolation are untouched', () => {
    expect(html`<a href="/dashboard">x</a>`.value).toBe(
      '<a href="/dashboard">x</a>',
    );
  });

  it('other attributes still take plain strings', () => {
    expect(html`<a title="${'a"b'}" data-href="${'x'}">y</a>`.value).toBe(
      '<a title="a&quot;b" data-href="x">y</a>',
    );
  });
});

describe('localUrl', () => {
  it('accepts dashboard paths', () => {
    for (const ok of [
      '/dashboard',
      '/dashboard/',
      '/dashboard/hall-of-fame/2026-09',
      '/dashboard/identity?platform=meetup&member=a+b',
      '/dashboard/x?y=%22',
    ]) {
      expect(localUrl(ok).href).toBe(ok);
    }
  });

  it('localUrl refuses anything but dashboard paths', () => {
    for (const bad of [
      'https://x',
      '//evil',
      '/dashboard/../x',
      '/dashboard/./x',
      '/dashboard/..',
      '/dashboard//x',
      '/dashboardx',
      '/dashboard/"x',
      '/dashboard/x?y="',
      "/dashboard/x'",
      '/dashboard/x?y=<',
      'javascript:1',
      '/Dashboard',
      '/dashboard\\x',
      '/dashboard/x#y',
      ' /dashboard',
      '',
      7 as unknown as string,
    ]) {
      expect(() => localUrl(bad)).toThrow(RangeError);
    }
  });
});

describe('pageLink', () => {
  it('builds the query with URLSearchParams and drops empty values', () => {
    expect(
      pageLink('/dashboard/identity', {
        member: '"><x *',
        platform: undefined,
        from: '',
      }).href,
    ).toBe('/dashboard/identity?member=%22%3E%3Cx+%2A');
    expect(pageLink('/dashboard/trends').href).toBe('/dashboard/trends');
  });

  it('refuses a path that is not ours', () => {
    expect(() => pageLink('https://evil.example', { a: '1' })).toThrow(
      RangeError,
    );
  });
});

describe('forgery', () => {
  it('a forged look-alike is rendered as text', () => {
    const forged = {
      value: '<b>x</b>',
      toString: () => '<b>x</b>',
    } as unknown as SafeHtml;
    expect(html`<p>${forged}</p>`.value).toBe('<p>&lt;b&gt;x&lt;/b&gt;</p>');
    expect(isSafeHtml(forged)).toBe(false);
    const forgedUrl = {
      href: 'javascript:1',
      toString: () => 'javascript:1',
    } as unknown as SafeUrl;
    expect(isSafeUrl(forgedUrl)).toBe(false);
    expect(() => html`<a href="${forgedUrl}">x</a>`).toThrow(UnsafeUrlError);
  });

  it('minted values are frozen', () => {
    const out = html`x`;
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(localUrl('/dashboard'))).toBe(true);
  });
});

describe('staticHtml', () => {
  it('returns its text as SafeHtml', () => {
    const out = staticHtml`<b>fixed</b>`;
    expect(isSafeHtml(out)).toBe(true);
    expect(out.value).toBe('<b>fixed</b>');
  });

  it('staticHtml refuses interpolation', () => {
    const strings = Object.freeze(
      Object.assign(['a', 'b'], { raw: ['a', 'b'] }),
    ) as unknown as TemplateStringsArray;
    expect(() => staticHtml(strings)).toThrow(TypeError);
    expect(() => staticHtml(['a'] as unknown as TemplateStringsArray)).toThrow(
      TypeError,
    );
  });
});
