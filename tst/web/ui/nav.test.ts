import { describe, expect, it } from 'vitest';

import { localUrl } from '../../../src/web/html.js';
import { accordionNav } from '../../../src/web/ui/nav.js';

const link = (key: string, label: string) => ({
  key,
  href: localUrl(`/dashboard/x/${key}`),
  label,
});

const ENTRIES = [
  link('home', 'Home'),
  { group: 'Group A', links: [link('a1', 'A one'), link('a2', 'A two')] },
  { group: 'Group B & co', links: [link('b1', 'B one')] },
];

/** Whitespace collapsed between tags, for structure checks. */
const collapse = (body: string) =>
  body.replace(/\s+/g, ' ').replace(/> /g, '>').replace(/ </g, '<');

describe('accordionNav', () => {
  it('top-level links, then a details group per section, each a summary and its links', () => {
    const out = collapse(
      accordionNav({ label: 'Pages', entries: ENTRIES, current: undefined })
        .value,
    );
    expect(out).toBe(
      '<nav class="site" aria-label="Pages" data-accordion><div class="tabs">' +
        '<a href="/dashboard/x/home">Home</a>' +
        '<details class="nav-group" data-nav-group><summary>Group A</summary>' +
        '<div class="nav-sub"><a href="/dashboard/x/a1">A one</a><a href="/dashboard/x/a2">A two</a></div></details>' +
        '<details class="nav-group" data-nav-group><summary>Group B &amp; co</summary>' +
        '<div class="nav-sub"><a href="/dashboard/x/b1">B one</a></div></details>' +
        '</div></nav>',
    );
  });

  it('the current page carries aria-current and its group renders open, its summary marked', () => {
    const out = collapse(
      accordionNav({ label: 'Pages', entries: ENTRIES, current: 'a2' }).value,
    );
    expect(out).toContain(
      '<details class="nav-group" data-nav-group open><summary class="here">Group A</summary>',
    );
    expect(out).toContain(
      '<a href="/dashboard/x/a2" aria-current="page">A two</a>',
    );
    expect(out.match(/aria-current/g)).toHaveLength(1);
    expect(out.match(/\sopen>/g)).toHaveLength(1);
    expect(out).toContain(
      '<details class="nav-group" data-nav-group><summary>Group B &amp; co</summary>',
    );
  });

  it('a current top-level link opens no group', () => {
    const out = accordionNav({
      label: 'Pages',
      entries: ENTRIES,
      current: 'home',
    }).value;
    expect(out).toContain(
      '<a href="/dashboard/x/home" aria-current="page">Home</a>',
    );
    expect(out).not.toMatch(/\sopen[\s>]/);
    expect(out).not.toContain('class="here"');
  });

  it('works without JavaScript: plain details and summary, no buttons, no hidden links', () => {
    const out = accordionNav({
      label: 'Pages',
      entries: ENTRIES,
      current: undefined,
    }).value;
    expect(out).not.toContain('<button');
    expect(out).not.toContain('hidden');
    expect(out).not.toContain('tabindex');
    // Every page is a real link in the markup.
    expect(out.match(/<a href=/g)).toHaveLength(4);
  });

  it('the stylesheet lays the open group out as a second row only with scripting on', async () => {
    const { STYLE } = await import('../../../src/web/pages.js');
    const css = STYLE.value;
    expect(css).toContain('@media (scripting:enabled){');
    expect(css).toContain('nav.site:has(details[open])');
    // Without scripting the open group takes its own row, links in place.
    expect(css).toContain('nav.site details[open]{flex-basis:100%}');
  });
});
