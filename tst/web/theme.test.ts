import { describe, expect, it } from 'vitest';

import { staticHtml } from '../../src/web/html.js';
import { hostLayout } from '../../src/web/host/hostLayout.js';
import { layout } from '../../src/web/pages.js';
import { THEME_SCRIPT } from '../../src/web/theme.js';

const NONCE = 'bm9uY2Utbm9uY2Utbm9uY2U=';

describe('theme toggle', () => {
  it('the script parses, and Auto leaves the theme to the device', () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    expect(() => new Function(THEME_SCRIPT.value)).not.toThrow();
    // No clock: with no choice saved, data-theme is removed and the
    // stylesheet's prefers-color-scheme decides.
    expect(THEME_SCRIPT.value).not.toContain('getHours');
    expect(THEME_SCRIPT.value).toContain("root.removeAttribute('data-theme')");
  });

  it.each([
    [
      'staff',
      layout({ title: 'Home', nonce: NONCE, body: staticHtml`<p>x</p>` }),
    ],
    [
      'host',
      hostLayout({ title: 'Home', nonce: NONCE, body: staticHtml`<p>x</p>` }),
    ],
  ])(
    'the %s site runs it in <head> and has the hidden toggle',
    (_site, page) => {
      const head = page.slice(0, page.indexOf('</head>'));
      expect(head).toContain(
        `<script nonce="${NONCE}">${THEME_SCRIPT.value}</script>`,
      );
      const header = page.slice(
        page.indexOf('<header class="site">'),
        page.indexOf('</header>'),
      );
      expect(header).toMatch(
        /<div\s+class="theme-toggle"\s+role="group"\s+aria-label="Colour theme"\s+data-theme-toggle\s+hidden\s*>/,
      );
      for (const choice of ['auto', 'light', 'dark']) {
        expect(page).toContain(`data-choice="${choice}"`);
      }
    },
  );
});
