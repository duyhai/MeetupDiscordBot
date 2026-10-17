# Staff dashboard visual refresh: Two-Tone

Approved by Hai on 2026-10-17 ("Go with direction C, Two-Tone, for the dashboard polish"). He chose it from three mockups at https://claude.ai/artifact/5qzWnhwM1xmDBxuXoJQWCf.

Hai's brief: "Make the design an aesthetic blend of Meetup and Discord's colors and UI. Follow the latest UX best practices, make it responsive and polished, with some minimal animations."

## Intent

The dashboard is a work tool. Staff open it to check what needs doing, act on it, and leave, so the look should make that faster and not only prettier.

Two-Tone gives each brand colour one job:
- **Blurple** marks what you can act on: buttons, the current page in the nav, links.
- **Coral** marks what needs a person: to-do counts, warnings, no-show badges.
- **Green** marks done.

The neutrals are quiet slate greys in both light and dark mode.

## Goals

- **Brand blend.** A recognisable mix of Meetup's warm red and Discord's blurple and dark greys, through colour and feel only. No logos or trademarked marks.
- **Light and dark.** Both modes follow `prefers-color-scheme`.
- **Responsive.** Pages work from 360 px wide up to desktop. Tables become stacked cards on narrow screens.
- **Accessible.**
  - WCAG AA contrast in both modes.
  - Visible focus and full keyboard use.
  - Semantic landmarks (`header`, `nav`, `main`) and a skip link.
  - Touch targets of at least 44 px.
- **Minimal motion.** A 150 ms press on buttons and a short fade-in on result notices. Both are off under `prefers-reduced-motion`.

## Non-goals

- **No new features.** No new pages, data or behaviour. Copy changes only where a layout needs a label.
- **No theme toggle.** The page follows the device setting.
- **No web fonts.**

## Anti-goals (failures even if it "works")

- **Weaker security.** Anything that weakens the html guard, the CSP or a security header.
- **Styling through attributes.** Inline `style=` attributes, or interpolation into `class`, `id` or `style`.
- **Red primary buttons.** Primary is blurple, so coral never reads as "danger" on a normal action.
- **Failing contrast.** Text that fails contrast in either mode.
- **Sideways scrolling.** Any page that scrolls sideways at 360 px. Only an `overflow-x:auto` container around a wide chart or table may scroll.

## Constraints (unchanged from the dashboard's security model)

- **One stylesheet.** All CSS stays in the single nonce'd `staticRaw` `STYLE` constant in `src/web/pages.ts`. That means no other stylesheet, no CDN, and no CSP change. `font-src` stays unset, so only system fonts are used.
- **The html guard.** All markup still goes through `html`. Class names are literals. `data-*` attributes carry literals only, unless the guard's allow-list already admits them.
- **Chart colours.** SVG data colours stay fixed literals (`CHART_COLORS`), re-picked so they read on both the light and dark surfaces. Chart text and gridlines may take theme colours through stylesheet rules on `svg.chart` elements; those are CSS rules, not inline styles.
- **Existing tests.** Every existing access, security, html-guard and golden test keeps passing.

## Tokens (from mockup C)

The light values are defined on `:root`. The dark values sit under `@media (prefers-color-scheme: dark)`, together with `color-scheme: dark`.

| Token | Light | Dark |
|---|---|---|
| `--bg` | `#f5f5fa` | `#17181f` |
| `--surface` | `#ffffff` | `#20212b` |
| `--raised` | `#f1f1f8` | `#2a2b37` |
| `--fg` | `#191a24` | `#eeeef6` |
| `--muted` | `#555869` | `#a9abbd` |
| `--line` | `#dedfea` | `#363847` |
| `--field` (form borders, added) | `#7c7f93` | `#7a7d93` |
| `--sel` | `#ebecfb` | `#2f3150` |
| `--accent` | `#4f5bd5` (was `#5865f2`) | `#8d96ff` (was `#7984ff`) |
| `--btn` (white text) | `#4752c4` | `#5865f2` |
| `--btn-hover` (white text, added) | `#3940a0` | `#4752c4` |
| `--btn-fg` (added) | `#ffffff` | `#ffffff` |
| `--focus` | `#5865f2` | `#a3aaff` |
| `--attn` | `#c9283a` | `#ff7d88` |
| `--attn-soft` | `#fde3e6` | `#46252c` |
| `--attn-ink` | `#9c1c2c` | `#ffbac0` |
| `--accent-soft` | `#e8e9fd` | `#30335e` |
| `--accent-ink` | `#3940a0` | `#cbcffd` |
| `--ok-soft` | `#ddf2e5` | `#203a2b` |
| `--ok-ink` | `#1f693d` | `#8fd8ab` |
| Header rule | `#5865f2` for 60%, then `#e8414f` | `#7984ff`, then `#ff6b77` |

Verify every text/background pair against AA. If a pair fails, adjust that token and record the change here.

`tst/web/contrast.test.ts` parses these values out of `STYLE` and checks each pair: 4.5:1 for text, 3:1 for the focus ring, form-field borders and the current-tab marker.

Changes made in Task 1 (2026-10-17):
- **`--accent`.** As link text, `#5865f2` measured 4.24:1 on `--bg`, 4.10:1 on `--raised` and 3.93:1 on `--sel` in light mode. Dark `#7984ff` measured 4.37:1 on `--raised` and 3.91:1 on `--sel`. They are now `#4f5bd5` (light, at least 4.62:1 on every surface, including `--accent-soft`) and `#8d96ff` (dark, at least 4.51:1). The header rule and the focus ring keep `#5865f2` / `#7984ff` and `#a3aaff`, since they are not text and pass 3:1.
- **`--field`, added.** `--line` is about 1.3:1 on `--surface`, which is fine for decorative card borders but not for the border that shows where an input is (WCAG 1.4.11). Inputs, selects and textareas use `--field` (at least 3.51:1 light, 3.46:1 dark).
- **`--btn-hover` and `--btn-fg`, added.** They give primary buttons a hover colour that keeps white text at AA (light 8.70:1, dark 6.42:1). `--accent-ink` would fail with white text in dark mode.

Fonts are the system stack. Code and copy boxes use the `ui-monospace` stack.

## Decided layout (my calls, made in the approved mockup)

- **Header.** The product name on the left, the account on the right, and the two-tone rule underneath.
- **Nav.** A tab bar below the header.
  - The current page is bold, with a blurple marker and `aria-current="page"`.
  - On phones the bar scrolls horizontally.
- **Cards.** Surface background, 1 px line, 10 px radius, no shadow.
- **Tables.** Below about 640 px, rows become stacked cards with a label on each cell. Each column's label is literal text in the markup.
- **Badges and status pills.**

  | Style | Meaning |
  |---|---|
  | Coral soft | Needs attention (to do, warning to send) |
  | Blurple soft | In progress or suspension |
  | Green soft | Done |
  | Grey | Neutral |

- **Buttons.**
  - Primary is blurple.
  - Secondary is a ghost button with a line border.
  - Destructive actions, such as void, keep the ghost style with coral text.
  - Every button is at least 44 px tall.
- **Notices.** `.note` becomes a soft panel tinted coral or blurple by a literal modifier class.
- **Home stats.** To do, on hold and done appear as three tiles; the to-do number is coral.

## Left to the builder

- The exact spacing scale and type sizes, within a clear scale.
- Which literal modifier classes each page needs.
- How the identity-change photos and the trends charts sit in the new cards.
- The order of work, provided each step is reviewed.

## Verification

- **Real browser.** Check the pages below at 360 px, 768 px and 1280 px, in light and dark mode, rendered through the real router from fixtures with hostile text:
  - sign-in
  - Home
  - the workspace months list, a month and the confirm page
  - Hall of Fame
  - no-show history
  - suspensions
  - identity changes
  - link progress
  - trends
  - sessions
  - an error page
- **Screenshots** of those checks go in the PR.
- **Keyboard pass.** Tab through Home and a workspace month: focus must always be visible, and the skip link must work.
