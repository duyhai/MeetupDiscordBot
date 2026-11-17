import { describe, expect, it } from 'vitest';

import { localUrl, safeHref } from '../../../src/web/html.js';
import { linkButton } from '../../../src/web/ui/linkButton.js';

describe('linkButton', () => {
  it('is a link with the button classes, ghost by default', () => {
    expect(
      linkButton({ href: localUrl('/dashboard/a'), label: 'Go' }).value,
    ).toBe('<a class="button ghost" href="/dashboard/a">Go</a>');
    expect(
      linkButton({
        href: localUrl('/dashboard/a'),
        label: 'Go',
        tone: 'primary',
      }).value,
    ).toBe('<a class="button" href="/dashboard/a">Go</a>');
  });

  it('external opens a new tab with noopener noreferrer', () => {
    const href = safeHref('https://www.meetup.com/members/2001/');
    expect(href).toBeDefined();
    if (!href) {
      return;
    }
    expect(
      linkButton({ href, label: 'Open on Meetup', external: true }).value,
    ).toBe(
      '<a class="button ghost" href="https://www.meetup.com/members/2001/" rel="noopener noreferrer" target="_blank">Open on Meetup</a>',
    );
  });

  it('escapes the label', () => {
    const out = linkButton({
      href: localUrl('/dashboard/a'),
      label: '<b>"x"</b>',
    }).value;
    expect(out).toContain('&lt;b&gt;&quot;x&quot;&lt;/b&gt;');
  });
});
