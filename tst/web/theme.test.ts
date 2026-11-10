import { describe, expect, it } from 'vitest';

import { staticHtml } from '../../src/web/html.js';
import { hostLayout } from '../../src/web/host/hostLayout.js';
import { layout } from '../../src/web/pages.js';
import { PALETTES, THEME_SCRIPT } from '../../src/web/theme.js';

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
      expect(header).toMatch(
        /<label\s+class="palette-pick"\s+data-palette-pick\s+hidden\s*>/,
      );
      for (const { id } of PALETTES) {
        expect(header).toContain(`<option value="${id}">`);
      }
    },
  );
});

/** THEME_SCRIPT run against a fake page: <html>, the toggle, storage. */
function runTheme(storage: {
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
  removeItem: (k: string) => void;
}) {
  const attrs = new Map<string, string>();
  const root = {
    setAttribute: (k: string, v: string) => attrs.set(k, v),
    removeAttribute: (k: string) => attrs.delete(k),
  };
  const buttons = ['auto', 'light', 'dark'].map((choice) => {
    const own = new Map<string, string>([['data-choice', choice]]);
    let onClick: (() => void) | undefined;
    return {
      getAttribute: (k: string) => own.get(k) ?? null,
      setAttribute: (k: string, v: string) => own.set(k, v),
      addEventListener: (_type: string, fn: () => void) => {
        onClick = fn;
      },
      click: () => onClick?.(),
      pressed: () => own.get('aria-pressed'),
    };
  });
  const group = { hidden: true, querySelectorAll: () => buttons };
  let onChange: (() => void) | undefined;
  const select = {
    value: '',
    addEventListener: (_type: string, fn: () => void) => {
      onChange = fn;
    },
  };
  const pick = { hidden: true, querySelector: () => select };
  let onStorage: ((e: { key: string | null }) => void) | undefined;
  const document = {
    documentElement: root,
    readyState: 'complete',
    querySelector: (selector: string) => {
      if (selector === '[data-theme-toggle]') {
        return group;
      }
      return selector === '[data-palette-pick]' ? pick : null;
    },
    addEventListener: () => undefined,
  };
  const window = {
    addEventListener: (
      _type: string,
      fn: (e: { key: string | null }) => void,
    ) => {
      onStorage = fn;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const run = new Function(
    'document',
    'window',
    'localStorage',
    THEME_SCRIPT.value,
  ) as (d: unknown, w: unknown, l: unknown) => void;
  run(document, window, storage);
  const [auto, light, dark] = buttons;
  return {
    theme: () => attrs.get('data-theme'),
    palette: () => attrs.get('data-palette'),
    group,
    pick,
    select,
    choosePalette: (v: string) => {
      select.value = v;
      onChange?.();
    },
    auto,
    light,
    dark,
    storageEvent: (key: string | null) => onStorage?.({ key }),
  };
}

const memoryStorage = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
    removeItem: (k: string) => {
      data.delete(k);
    },
  };
};

describe('THEME_SCRIPT behaviour', () => {
  it('starts on the saved choice, shows the toggle, and marks the pressed button', () => {
    const page = runTheme(memoryStorage({ 'dashboard-theme': 'dark' }));
    expect(page.theme()).toBe('dark');
    expect(page.group.hidden).toBe(false);
    expect(page.dark.pressed()).toBe('true');
    expect(page.auto.pressed()).toBe('false');
  });

  it('Auto with nothing saved leaves the theme to the device', () => {
    const page = runTheme(memoryStorage());
    expect(page.theme()).toBeUndefined();
    expect(page.auto.pressed()).toBe('true');
  });

  it('a click saves the choice and updates aria-pressed', () => {
    const storage = memoryStorage();
    const page = runTheme(storage);
    page.light.click();
    expect(page.theme()).toBe('light');
    expect(storage.data.get('dashboard-theme')).toBe('light');
    expect(page.light.pressed()).toBe('true');
    expect(page.auto.pressed()).toBe('false');
    page.auto.click();
    expect(page.theme()).toBeUndefined();
    expect(storage.data.has('dashboard-theme')).toBe(false);
  });

  it('Auto wins in this tab even when the stale choice cannot be removed', () => {
    const storage = memoryStorage({ 'dashboard-theme': 'dark' });
    storage.removeItem = () => {
      throw new Error('storage blocked');
    };
    const page = runTheme(storage);
    page.auto.click();
    expect(page.theme()).toBeUndefined();
    expect(page.auto.pressed()).toBe('true');
  });

  it('a choice that cannot be saved still applies in this tab', () => {
    const storage = memoryStorage();
    storage.setItem = () => {
      throw new Error('quota');
    };
    const page = runTheme(storage);
    page.dark.click();
    expect(page.theme()).toBe('dark');
    expect(page.dark.pressed()).toBe('true');
  });

  it('follows another tab, including one that cleared storage', () => {
    const storage = memoryStorage();
    const page = runTheme(storage);
    page.light.click();
    // Another tab picks Dark.
    storage.data.set('dashboard-theme', 'dark');
    page.storageEvent('dashboard-theme');
    expect(page.theme()).toBe('dark');
    expect(page.dark.pressed()).toBe('true');
    // Another tab clears storage: Auto.
    storage.data.clear();
    page.storageEvent(null);
    expect(page.theme()).toBeUndefined();
    expect(page.auto.pressed()).toBe('true');
    // Some other key: ignored.
    storage.data.set('dashboard-theme', 'light');
    page.storageEvent('other');
    expect(page.theme()).toBeUndefined();
  });
});

describe('THEME_SCRIPT palettes', () => {
  it('the default palette sets no attribute and shows the picker on Night market', () => {
    const page = runTheme(memoryStorage());
    expect(page.palette()).toBeUndefined();
    expect(page.pick.hidden).toBe(false);
    expect(page.select.value).toBe('night');
  });

  it('starts on the saved palette', () => {
    const page = runTheme(memoryStorage({ 'dashboard-palette': 'paper' }));
    expect(page.palette()).toBe('paper');
    expect(page.select.value).toBe('paper');
  });

  it('ignores a saved palette the stylesheet does not define', () => {
    const page = runTheme(memoryStorage({ 'dashboard-palette': 'neon' }));
    expect(page.palette()).toBeUndefined();
    expect(page.select.value).toBe('night');
  });

  it('a pick saves the palette, and Night market clears it', () => {
    const storage = memoryStorage();
    const page = runTheme(storage);
    page.choosePalette('quiet');
    expect(page.palette()).toBe('quiet');
    expect(storage.data.get('dashboard-palette')).toBe('quiet');
    page.choosePalette('night');
    expect(page.palette()).toBeUndefined();
    expect(storage.data.has('dashboard-palette')).toBe(false);
  });

  it('palette and theme are independent', () => {
    const storage = memoryStorage();
    const page = runTheme(storage);
    page.choosePalette('potluck');
    page.dark.click();
    expect(page.palette()).toBe('potluck');
    expect(page.theme()).toBe('dark');
    page.auto.click();
    expect(page.palette()).toBe('potluck');
    expect(page.theme()).toBeUndefined();
  });

  it('follows another tab, and a cleared storage returns to Night market', () => {
    const storage = memoryStorage();
    const page = runTheme(storage);
    storage.data.set('dashboard-palette', 'paper');
    page.storageEvent('dashboard-palette');
    expect(page.palette()).toBe('paper');
    storage.data.clear();
    page.storageEvent(null);
    expect(page.palette()).toBeUndefined();
    expect(page.select.value).toBe('night');
  });
});
