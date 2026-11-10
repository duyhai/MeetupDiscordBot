import { describe, expect, it } from 'vitest';

import { CHART_COLORS } from '../../src/web/charts.js';
import { STYLE } from '../../src/web/pages.js';
import { PALETTES as PALETTE_LIST } from '../../src/web/theme.js';

const PALETTE_IDS = PALETTE_LIST.map((p) => p.id);

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

/** The light tokens (the first :root block) and the dark ones (inside the dark media query, and the same again under data-theme="dark"). */
export function themeTokens(css: string): { light: Tokens; dark: Tokens } {
  const light = /(?:^|\})\s*:root\{([^}]*)\}/.exec(css)?.[1];
  const dark =
    /@media \(prefers-color-scheme:\s*dark\)\{:root:not\(\[data-theme="light"\]\)\{([^}]*)\}/.exec(
      css,
    )?.[1];
  // The same tokens again, for a page that chose dark (the theme toggle).
  const chosenDark = /:root\[data-theme="dark"\]\{([^}]*)\}/.exec(css)?.[1];
  if (!light || !dark || chosenDark !== dark) {
    throw new Error(
      'STYLE has no light :root block, no dark one, or two dark blocks that differ',
    );
  }
  return { light: parseTokens(light), dark: parseTokens(dark) };
}

/**
 * Every palette's light and dark tokens: the default (no data-palette) and
 * each `:root[data-palette="…"]` block, whose dark tokens must likewise
 * appear twice (the media query and data-theme="dark") and match.
 */
export function paletteTokens(
  css: string,
): Record<string, { light: Tokens; dark: Tokens }> {
  const out: Record<string, { light: Tokens; dark: Tokens }> = {
    night: themeTokens(css),
  };
  for (const m of css.matchAll(
    /:root\[data-palette="([a-z]+)"\]\{([^}]*)\}/g,
  )) {
    const name = m[1];
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const dark = new RegExp(
      `@media \\(prefers-color-scheme:\\s*dark\\)\\{:root:not\\(\\[data-theme="light"\\]\\)\\[data-palette="${esc}"\\]\\{([^}]*)\\}`,
    ).exec(css)?.[1];
    const chosenDark = new RegExp(
      `:root\\[data-theme="dark"\\]\\[data-palette="${esc}"\\]\\{([^}]*)\\}`,
    ).exec(css)?.[1];
    if (!dark || chosenDark !== dark) {
      throw new Error(
        `palette ${name} has no dark block, or two dark blocks that differ`,
      );
    }
    out[name] = { light: parseTokens(m[2]), dark: parseTokens(dark) };
  }
  return out;
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** CIE L* (0 to 100), the perceived lightness. */
function lightness(hex: string): number {
  const y = luminance(hex);
  return y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (24389 / 27) * y;
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
  // The calendar's plain + also sits on the busy shadings.
  ...[
    'bg',
    'surface',
    'raised',
    'sel',
    'accent-soft',
    'ok-soft',
    'attn-soft',
  ].map((bg): [string, string] => ['accent', bg]),
  ...['bg', 'surface', 'raised', 'accent-soft'].map((bg): [string, string] => [
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
  // Host calendar cells: day text on the quiet, busy and past shadings.
  ['fg', 'ok-soft'],
  ['fg', 'attn-soft'],
  ['muted', 'bg'],
  // Field errors (.field-error) sit on a card or a stacked row.
  ['attn-ink', 'surface'],
  ['attn-ink', 'raised'],
  // Muted text and links inside the hover, quiet-day and busy-day fills,
  // and the done colour on a plain card.
  ...['sel', 'ok-soft', 'attn-soft'].map((bg): [string, string] => [
    'muted',
    bg,
  ]),
  ...['sel', 'ok-soft', 'attn-soft'].map((bg): [string, string] => [
    'accent-ink',
    bg,
  ]),
  ['ok-ink', 'surface'],
  ['accent', 'ok-soft'],
];

/** Non-text that carries meaning: 3:1 (WCAG 1.4.11). */
const UI_PAIRS: [string, string][] = [
  // The focus ring, wherever a control can sit.
  ...[
    'bg',
    'surface',
    'raised',
    'sel',
    'attn-soft',
    'accent-soft',
    'ok-soft',
  ].map((bg): [string, string] => ['focus', bg]),
  // Form field borders.
  ...['bg', 'surface', 'raised'].map((bg): [string, string] => ['field', bg]),
  // The current tab's marker.
  ['accent', 'surface'],
  // Host heat map: the busiest level stands out from the card, and the
  // busiest calendar day's coral marker from its shading.
  ['heat4', 'surface'],
  ['heat3', 'surface'],
  ['attn', 'attn-soft'],
];

const PALETTES = paletteTokens(STYLE.value);
const THEMES = PALETTES.night;

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

  it('offers the four palettes the header picker lists, each with every colour token', () => {
    expect(Object.keys(PALETTES).sort()).toEqual([...PALETTE_IDS].sort());
    const keys = Object.keys(THEMES.light).sort();
    for (const [name, p] of Object.entries(PALETTES)) {
      expect(Object.keys(p.light).sort(), `${name} light`).toEqual(keys);
      expect(Object.keys(p.dark).sort(), `${name} dark`).toEqual(keys);
    }
  });

  it('switches to the dark scheme with color-scheme: dark, unless light was chosen', () => {
    expect(STYLE.value).toMatch(
      /@media \(prefers-color-scheme:\s*dark\)\{:root:not\(\[data-theme="light"\]\)\{[^}]*color-scheme:\s*dark/,
    );
    expect(STYLE.value).toMatch(
      /:root\[data-theme="dark"\]\{[^}]*color-scheme:\s*dark/,
    );
  });

  describe.each(Object.entries(PALETTES))('palette %s', (_name, THEMES) => {
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
          expect(contrast(t[token ?? ''], t.surface)).toBeGreaterThanOrEqual(
            4.5,
          );
          expect(contrast(t[token ?? ''], t.bg)).toBeGreaterThanOrEqual(4.5);
        },
      );

      describe.each(['light', 'dark'] as const)('%s', (mode) => {
        it.each(CHART_COLORS.map((c, i) => [i + 1, c] as const))(
          'series %i (%s) meets 3:1 on --surface',
          (_i, color) => {
            expect(
              contrast(color, THEMES[mode].surface),
            ).toBeGreaterThanOrEqual(3);
          },
        );
      });

      it('keeps series 3 (green) well apart in lightness from series 1 and 2', () => {
        // Red-green and blue-green deficiencies mostly leave lightness, so
        // the first three series must not share it.
        const [blurple, coral, green] = CHART_COLORS.map(lightness);
        expect(Math.abs(green - blurple)).toBeGreaterThanOrEqual(10);
        expect(Math.abs(green - coral)).toBeGreaterThanOrEqual(10);
      });

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
});
