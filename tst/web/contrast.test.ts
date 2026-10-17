import { describe, expect, it } from 'vitest';

import { STYLE } from '../../src/web/pages.js';

/**
 * WCAG 2.x contrast for the dashboard's colour tokens, read out of the one
 * stylesheet, so a token changed below AA fails here.
 */

type Tokens = Record<string, string>;

function parseTokens(block: string): Tokens {
  const tokens: Tokens = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g)) {
    tokens[m[1]] = m[2].toLowerCase();
  }
  return tokens;
}

/** The light tokens (the first :root block) and the dark ones (the :root inside the dark media query). */
export function themeTokens(css: string): { light: Tokens; dark: Tokens } {
  const light = /(?:^|\})\s*:root\{([^}]*)\}/.exec(css)?.[1];
  const dark = /@media \(prefers-color-scheme:\s*dark\)\{:root\{([^}]*)\}/.exec(
    css,
  )?.[1];
  if (!light || !dark) {
    throw new Error('STYLE has no light :root block or no dark one');
  }
  return { light: parseTokens(light), dark: parseTokens(dark) };
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Text on a background: 4.5:1 (normal-size text). */
const TEXT_PAIRS: [string, string][] = [
  ...['bg', 'surface', 'raised', 'sel'].map((bg): [string, string] => [
    'fg',
    bg,
  ]),
  ...['bg', 'surface', 'raised'].map((bg): [string, string] => ['muted', bg]),
  // Links and ghost buttons, at rest, on hover and as the current tab.
  ...['bg', 'surface', 'raised', 'sel', 'accent-soft'].map(
    (bg): [string, string] => ['accent', bg],
  ),
  ...['bg', 'surface', 'raised'].map((bg): [string, string] => [
    'accent-ink',
    bg,
  ]),
  // Primary buttons.
  ['btn-fg', 'btn'],
  ['btn-fg', 'btn-hover'],
  // Coral text: destructive ghost buttons and to-do counts.
  ...['bg', 'surface', 'raised', 'sel'].map((bg): [string, string] => [
    'attn',
    bg,
  ]),
  // Home stat tiles (on --raised): the done number. The to-do number is
  // --attn on --raised, above; the labels are --muted on --raised.
  ['ok-ink', 'raised'],
  // Stacked table rows are --raised cards: badges inside keep their own
  // backgrounds; links are --accent on --raised, above.
  // Badges and notices.
  ['attn-ink', 'attn-soft'],
  ['accent-ink', 'accent-soft'],
  ['ok-ink', 'ok-soft'],
];

/** Non-text that carries meaning: 3:1 (WCAG 1.4.11). */
const UI_PAIRS: [string, string][] = [
  // The focus ring, wherever a control can sit.
  ...['bg', 'surface', 'raised', 'sel', 'attn-soft', 'accent-soft'].map(
    (bg): [string, string] => ['focus', bg],
  ),
  // Form field borders.
  ...['bg', 'surface', 'raised'].map((bg): [string, string] => ['field', bg]),
  // The current tab's marker.
  ['accent', 'surface'],
];

const THEMES = themeTokens(STYLE.value);

describe('colour tokens', () => {
  it('parses the known reference pair (#777 on white is 4.48:1)', () => {
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
  });

  it('defines the same tokens in light and dark', () => {
    expect(Object.keys(THEMES.dark).sort()).toEqual(
      Object.keys(THEMES.light).sort(),
    );
    expect(Object.keys(THEMES.light).length).toBeGreaterThan(15);
  });

  it('switches to the dark scheme with color-scheme: dark', () => {
    expect(STYLE.value).toMatch(
      /@media \(prefers-color-scheme:\s*dark\)\{:root\{[^}]*color-scheme:\s*dark/,
    );
  });

  describe('charts', () => {
    /** The token a stylesheet rule on `selector` sets `prop` to. */
    const ruleToken = (selector: string, prop: string) => {
      const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rule = new RegExp(`(?:^|[}\\s])${esc}\\{([^}]*)\\}`).exec(
        STYLE.value,
      )?.[1];
      return new RegExp(`${prop}:var\\(--([a-z0-9-]+)\\)`).exec(
        rule ?? '',
      )?.[1];
    };

    it.each(['light', 'dark'] as const)(
      '%s: chart text is themed and meets 4.5:1 on --surface and --bg',
      (mode) => {
        const token = ruleToken('svg.chart text', 'fill');
        expect(token, 'svg.chart text{fill:var(--…)}').toBeDefined();
        const t = THEMES[mode];
        expect(contrast(t[token ?? ''], t.surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t[token ?? ''], t.bg)).toBeGreaterThanOrEqual(4.5);
      },
    );

    it.each(['light', 'dark'] as const)(
      '%s: the chart axis is themed and meets 3:1 on --surface',
      (mode) => {
        const token = ruleToken('svg.chart line', 'stroke');
        expect(token, 'svg.chart line{stroke:var(--…)}').toBeDefined();
        const t = THEMES[mode];
        expect(contrast(t[token ?? ''], t.surface)).toBeGreaterThanOrEqual(3);
      },
    );
  });

  describe.each(['light', 'dark'] as const)('%s', (mode) => {
    const t = THEMES[mode];
    it.each(TEXT_PAIRS)('text --%s on --%s meets 4.5:1', (fg, bg) => {
      expect(t[fg], `--${fg}`).toBeDefined();
      expect(t[bg], `--${bg}`).toBeDefined();
      expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(4.5);
    });
    it.each(UI_PAIRS)('--%s against --%s meets 3:1', (fg, bg) => {
      expect(t[fg], `--${fg}`).toBeDefined();
      expect(t[bg], `--${bg}`).toBeDefined();
      expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(3);
    });
  });
});
