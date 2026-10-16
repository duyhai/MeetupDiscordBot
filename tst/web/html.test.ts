import { describe, expect, it } from 'vitest';

import {
  SafeHtml,
  SafeUrl,
  UnsafeAttributeError,
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

  /* eslint-disable no-restricted-syntax -- forged calls on purpose */
  it('staticHtml refuses interpolation', () => {
    const strings = Object.freeze(
      Object.assign(['a', 'b'], { raw: ['a', 'b'] }),
    ) as unknown as TemplateStringsArray;
    expect(() => staticHtml(strings)).toThrow(TypeError);
    expect(() => staticHtml(['a'] as unknown as TemplateStringsArray)).toThrow(
      TypeError,
    );
  });
  /* eslint-enable no-restricted-syntax */
});

/* eslint-disable no-restricted-syntax -- these tests call the tags as plain functions on purpose */
describe('calling the tags as plain functions', () => {
  const evil = '<img src=x onerror=alert(1)>';

  it('html refuses a forged strings array', () => {
    expect(() =>
      html(
        Object.assign([evil], {
          raw: [evil],
        }) as unknown as TemplateStringsArray,
      ),
    ).toThrow(TypeError);
  });

  it('staticHtml refuses a frozen forged strings array', () => {
    expect(() =>
      staticHtml(
        Object.freeze(
          Object.assign([evil], { raw: [evil] }),
        ) as unknown as TemplateStringsArray,
      ),
    ).toThrow(TypeError);
  });

  it('refuses a forgery whose raw is frozen too', () => {
    const forged = Object.freeze(
      Object.assign([evil], { raw: Object.freeze([evil]) }),
    ) as unknown as TemplateStringsArray;
    expect(() => staticHtml(forged)).toThrow(TypeError);
    expect(() => html(forged)).toThrow(TypeError);
  });

  it('refuses a forgery with a non-enumerable raw that was never frozen', () => {
    const arr = [evil];
    Object.defineProperty(arr, 'raw', { value: [evil] });
    expect(() => html(arr as unknown as TemplateStringsArray)).toThrow(
      TypeError,
    );
  });

  it('still accepts real template literals, including a reused call site', () => {
    const page = (x: string) => html`<p>${x}</p>`;
    expect(page('a').value).toBe('<p>a</p>');
    expect(page('b').value).toBe('<p>b</p>');
    expect(String.raw`x` && staticHtml`<i>ok</i>`.value).toBe('<i>ok</i>');
  });
});
/* eslint-enable no-restricted-syntax */

describe('URL attributes, widened', () => {
  const plain = 'javascript:alert(1)';
  const url = localUrl('/dashboard');

  it('finds a URL attribute after a slash or a closing quote', () => {
    // prettier-ignore
    expect(() => html`<a/href="${plain}">x</a>`).toThrow(UnsafeUrlError);
    // prettier-ignore
    expect(() => html`<a title="x"href="${plain}">x</a>`).toThrow(UnsafeUrlError);
    // prettier-ignore
    expect(() => html`<a title='x'href="${plain}">x</a>`).toThrow(UnsafeUrlError);
    // prettier-ignore
    expect(() => html`<svg><use xlink:href="${plain}"/></svg>`).toThrow(UnsafeUrlError);
  });

  it('covers srcset, poster, data, ping, background and cite', () => {
    for (const make of [
      () => html`<img srcset="${plain}" />`,
      () => html`<video poster="${plain}"></video>`,
      () => html`<object data="${plain}"></object>`,
      () => html`<a ping="${plain}">x</a>`,
      () => html`<td background="${plain}"></td>`,
      () => html`<q cite="${plain}">x</q>`,
    ]) {
      expect(make).toThrow(UnsafeUrlError);
    }
    expect(html`<img srcset="${url}" />`.value).toBe(
      '<img srcset="/dashboard" />',
    );
  });

  it('data-* attributes are not URL attributes', () => {
    expect(html`<b data-x="${'y'}">z</b>`.value).toBe('<b data-x="y">z</b>');
  });

  it('refuses an interpolation in attribute-name position', () => {
    // prettier-ignore
    expect(() => html`<a ${'href'}="${url}">x</a>`).toThrow(UnsafeAttributeError);
    // prettier-ignore
    expect(() => html`<a title="x" ${'onclick=alert(1)'}>x</a>`).toThrow(UnsafeAttributeError);
    // prettier-ignore
    expect(() => html`<input ${'checked'}>`).toThrow(UnsafeAttributeError);
    // prettier-ignore
    expect(() => html`<a${'x'}>`).toThrow(UnsafeAttributeError);
  });

  it('refuses an unquoted value for any attribute', () => {
    // prettier-ignore
    expect(() => html`<b title=${'x onmouseover=alert(1)'}>z</b>`).toThrow(UnsafeAttributeError);
  });

  it('a quoted > does not end the tag', () => {
    // prettier-ignore
    expect(() => html`<a title="a > b" href="${plain}">x</a>`).toThrow(UnsafeUrlError);
  });

  it('text and quoted non-URL values still take strings', () => {
    expect(html`<p class="${'a'}">${'<b>'}</p>`.value).toBe(
      '<p class="a">&lt;b&gt;</p>',
    );
    expect(html`<p>a > b ${'x'}</p>`.value).toBe('<p>a > b x</p>');
  });

  it('a fragment cannot leave a URL attribute open', () => {
    // prettier-ignore
    expect(() => staticHtml`<a href="`).toThrow(UnsafeUrlError);
    // prettier-ignore
    expect(() => html`<a class="b" href="${url}`).toThrow(UnsafeUrlError);
    // prettier-ignore
    expect(() => html`<img srcset='`).toThrow(UnsafeUrlError);
  });

  it('a fragment cannot end inside a tag, so it cannot open one for a later plain string', () => {
    // prettier-ignore
    expect(() => staticHtml`<a `).toThrow(UnsafeAttributeError);
    // prettier-ignore
    expect(() => html`<a title="${'x'}`).toThrow(UnsafeAttributeError);
  });
});

describe('brand checks survive prototype pollution', () => {
  it('a SafeUrl never passes as SafeHtml, and a SafeHtml never as SafeUrl', () => {
    const proto = Object.prototype as Record<string, unknown>;
    const url = localUrl('/dashboard');
    const markup = html`<b>x</b>`;
    // Read everything while polluted, assert after restoring: the test
    // runner itself misbehaves while Object.prototype.value is set.
    let seen: Record<string, unknown> = {};
    try {
      proto.value = '<img src=x onerror=alert(1)>';
      proto.href = 'javascript:alert(1)';
      let urlInHref: unknown;
      try {
        // prettier-ignore
        urlInHref = html`<a href="${markup}">x</a>`.value;
      } catch (error) {
        urlInHref = error instanceof UnsafeUrlError ? 'refused' : error;
      }
      seen = {
        urlAsHtml: isSafeHtml(url),
        htmlAsUrl: isSafeUrl(markup),
        rendered: html`<p>${url}</p>`.value,
        urlInHref,
      };
    } finally {
      delete proto.value;
      delete proto.href;
    }
    expect(seen).toEqual({
      urlAsHtml: false,
      htmlAsUrl: false,
      rendered: '<p>/dashboard</p>',
      urlInHref: 'refused',
    });
    expect(isSafeHtml(markup)).toBe(true);
    expect(isSafeUrl(url)).toBe(true);
  });
});

describe('the forward tokenizer', () => {
  const plain = 'javascript:alert(1)';
  const url = localUrl('/dashboard');

  it('a quoted < in an earlier value does not hide a later URL attribute (review probe)', () => {
    // The reviewer's probes. Both are now refused at the title: no SafeHtml
    // goes into an attribute value. Values are never fed to the scanner, so
    // their `<` could not restart it anyway.
    // prettier-ignore
    expect(() => html`<a title="${memberText('bob')}" href="${plain}">x</a>`).toThrow(UnsafeAttributeError);
    // prettier-ignore
    expect(() => html`<a title="${html`<b>x</b>`}" href="${plain}">x</a>`).toThrow(UnsafeAttributeError);
    // The same shape with the `<` written in the template: only the
    // quoted-value state keeps the href checked.
    // prettier-ignore
    expect(() => html`<a title="</bdi>" href="${plain}">x</a>`).toThrow(UnsafeUrlError);
    // With a string title the href is what is refused.
    // prettier-ignore
    expect(() => html`<a title="${'bob'}" href="${plain}">x</a>`).toThrow(UnsafeUrlError);
  });

  it('a literal < or comment opener inside a quoted value is just text', () => {
    // prettier-ignore
    expect(() => html`<a title="a<b>c" href="${plain}">x</a>`).toThrow(UnsafeUrlError);
    // prettier-ignore
    expect(() => html`<a title="<!-->" href="${plain}">x</a>`).toThrow(UnsafeUrlError);
    // prettier-ignore
    expect(html`<a title="a<b>c" href="${url}">x</a>`.value).toBe('<a title="a<b>c" href="/dashboard">x</a>');
  });

  it('SafeHtml is refused in any attribute value; strings are escaped there', () => {
    // prettier-ignore
    expect(() => html`<b title="${html`x`}">y</b>`).toThrow(UnsafeAttributeError);
    // prettier-ignore
    expect(() => html`<b title="${memberText('x')}">y</b>`).toThrow(UnsafeAttributeError);
    expect(html`<b title="${'<"x">'}">y</b>`.value).toBe(
      '<b title="&lt;&quot;x&quot;&gt;">y</b>',
    );
  });

  it('nothing is interpolated into script or style raw text', () => {
    // prettier-ignore
    expect(() => html`<script>var s="${'x'}"</script>`).toThrow(UnsafeAttributeError);
    // prettier-ignore
    expect(() => html`<script>${html`x`}</script>`).toThrow(UnsafeAttributeError);
    // prettier-ignore
    expect(() => html`<style>a{color:${'red'}}</style>`).toThrow(UnsafeAttributeError);
    // prettier-ignore
    expect(() => html`<SCRIPT >${'x'}</SCRIPT>`).toThrow(UnsafeAttributeError);
  });

  it('a constant staticHtml body may fill script or style, unless it could close the element', () => {
    const css = staticHtml`a>b{color:red}`;
    // prettier-ignore
    expect(html`<style nonce="${'n'}">${css}</style>`.value).toBe('<style nonce="n">a>b{color:red}</style>');
    const closing = staticHtml`x</style><b>y</b>`;
    // prettier-ignore
    expect(() => html`<style>${closing}</style>`).toThrow(UnsafeAttributeError);
  });

  it('text after a script element is text again', () => {
    // prettier-ignore
    expect(html`<script>if (a<b) {}</script><p>${'<x>'}</p>`.value).toBe('<script>if (a<b) {}</script><p>&lt;x&gt;</p>');
    // prettier-ignore
    expect(() => html`<script>"</script><a href="${plain}">x</a>`).toThrow(UnsafeUrlError);
  });

  it('textarea and title take escaped text but no markup', () => {
    // prettier-ignore
    const copy = html`<textarea readonly class="copy">${'<b>&'}</textarea>`;
    expect(copy.value).toBe(
      '<textarea readonly class="copy">&lt;b&gt;&amp;</textarea>',
    );
    // prettier-ignore
    expect(html`<title>${'a<b'}</title>`.value).toBe('<title>a&lt;b</title>');
    // prettier-ignore
    expect(() => html`<textarea>${html`</textarea><b>x</b>`}</textarea>`).toThrow(UnsafeAttributeError);
  });

  it('nothing is interpolated inside a comment or an end tag', () => {
    // prettier-ignore
    expect(() => html`<!-- ${'x'} -->`).toThrow(UnsafeAttributeError);
    // prettier-ignore
    expect(() => html`</p ${'x'}>`).toThrow(UnsafeAttributeError);
    // prettier-ignore
    expect(html`<!-- a > b --><p>${'x'}</p>`.value).toBe('<!-- a > b --><p>x</p>');
    // prettier-ignore
    expect(html`<!--><p>${'x'}</p>`.value).toBe('<!--><p>x</p>');
  });

  it('keeps the legitimate forms', () => {
    // prettier-ignore
    expect(html`<svg><use xlink:href="${url}"/></svg>`.value).toBe('<svg><use xlink:href="/dashboard"/></svg>');
    // prettier-ignore
    const form = html`<form method="post" action="${url}"><input type="hidden" name="_csrf" value="${'t'}" /></form>`;
    expect(form.value).toContain('action="/dashboard"');
    const label = 'a "b"';
    const tip = 't<';
    // prettier-ignore
    const chart = html`<svg viewBox="0 0 ${100} ${50}" aria-label="${label}"><rect x="${1}" y="${2}"><title>${tip}</title></rect></svg>`;
    expect(chart.value).toBe(
      '<svg viewBox="0 0 100 50" aria-label="a &quot;b&quot;"><rect x="1" y="2"><title>t&lt;</title></rect></svg>',
    );
    // prettier-ignore
    expect(html`<img src="${url}" width="${48}" alt="${'x'}" />`.value).toBe('<img src="/dashboard" width="48" alt="x" />');
    // prettier-ignore
    expect(html`<!doctype html><html lang="en"><p>${'x'}</p></html>`.value).toContain('<p>x</p>');
  });

  it('an invalid escape (undefined cooked string) is a clear error', () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const build = new Function('tag', 'return tag`<p>\\unicode ${1}</p>`;') as (
      tag: unknown,
    ) => SafeHtml;
    expect(() => build(html)).toThrow(UnsafeAttributeError);
    expect(() => build(html)).toThrow(/invalid escape/);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const plainStatic = new Function('tag', 'return tag`\\xZZ`;') as (
      tag: unknown,
    ) => SafeHtml;
    expect(() => plainStatic(staticHtml)).toThrow(/invalid escape/);
  });

  it('runs in linear time: 5,000 interpolations stay fast', () => {
    const v = 'x'.repeat(200);
    for (const body of [
      '<p>' + '${v}'.repeat(5000) + '</p>',
      '<p title="' + '${v}'.repeat(5000) + '">x</p>',
      '<p>' + '<b class="${v}">${v}</b>'.repeat(2500) + '</p>',
    ]) {
      // A real tagged template, built at runtime so it can hold 5,000 holes.
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const build = new Function('html', 'v', `return html\`${body}\`;`) as (
        tag: typeof html,
        value: string,
      ) => SafeHtml;
      const started = performance.now();
      const out = build(html, v);
      // Generous: a guard against going quadratic again, not a benchmark.
      expect(performance.now() - started).toBeLessThan(300);
      expect(out.value.length).toBeGreaterThan(5000 * 200);
    }
  });
});
