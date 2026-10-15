import { describe, expect, it } from 'vitest';

import {
  SafeHtml,
  escapeHtml,
  html,
  memberText,
  safeHref,
} from '../../src/web/html.js';

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
    expect(html`x`).toBeInstanceOf(SafeHtml);
  });
});

describe('safeHref', () => {
  it('allows Meetup pages and Discord user profiles over https', () => {
    expect(safeHref('https://www.meetup.com/members/123/')).toBe(
      'https://www.meetup.com/members/123/',
    );
    expect(safeHref('https://www.meetup.com/1-5genasians/events/9/')).toBe(
      'https://www.meetup.com/1-5genasians/events/9/',
    );
    expect(safeHref('https://discord.com/users/123456789012345678')).toBe(
      'https://discord.com/users/123456789012345678',
    );
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
    ].forEach((url) => expect(safeHref(url)).toBeUndefined());
  });
});

describe('memberText', () => {
  it('escapes and isolates direction', () => {
    expect(memberText('‮evil<b>').value).toBe('<bdi>‮evil&lt;b&gt;</bdi>');
  });
});
