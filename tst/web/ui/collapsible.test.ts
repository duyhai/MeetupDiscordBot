import { describe, expect, it } from 'vitest';

import { html } from '../../../src/web/html.js';
import { collapsible } from '../../../src/web/ui/collapsible.js';

const HOSTILE = '<script>alert(1)</script>"\'&';
const ESCAPED = '&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;';

/** Whitespace collapsed between tags, for structure checks. */
const collapse = (body: string) =>
  body.replace(/\s+/g, ' ').replace(/> /g, '>').replace(/ </g, '<');

describe('collapsible', () => {
  it('is a details.ui-collapsible: the summary line, then the body', () => {
    const out = collapse(
      collapsible({
        summary: 'October 2026',
        meta: '3 to do',
        body: html`<p>Body</p>`,
      }).value,
    );
    expect(out).toBe(
      '<details class="ui-collapsible"><summary>' +
        '<span class="ui-collapsible-title">October 2026</span>' +
        '<span class="ui-collapsible-meta">3 to do</span></summary>' +
        '<div class="ui-collapsible-body"><p>Body</p></div></details>',
    );
  });

  it('open starts it open; otherwise there is no open attribute', () => {
    const opened = collapsible({ summary: 'a', body: html``, open: true });
    expect(opened.value).toMatch(/^<details class="ui-collapsible" open>/);
    const shut = collapsible({ summary: 'a', body: html`` });
    expect(shut.value).not.toMatch(/\sopen[\s>=]/);
  });

  it('leaves out an empty meta', () => {
    for (const meta of [undefined, '']) {
      expect(
        collapsible({ summary: 'a', meta, body: html`` }).value,
      ).not.toContain('ui-collapsible-meta');
    }
  });

  it('escapes the summary and meta text', () => {
    const out = collapsible({
      summary: HOSTILE,
      meta: HOSTILE,
      body: html``,
    }).value;
    expect(out).not.toContain('<script>');
    expect(out.split(ESCAPED)).toHaveLength(3);
  });

  it('the stylesheet styles it (chevron, open state), on the shared tokens', async () => {
    const { STYLE } = await import('../../../src/web/pages.js');
    expect(STYLE.value).toContain('details.ui-collapsible>summary::before');
    expect(STYLE.value).toContain(
      'details.ui-collapsible[open]>summary::before',
    );
  });
});
