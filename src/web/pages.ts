// src/web/pages.ts
import dayjs from 'dayjs';

import {
  DASHBOARD_BASE,
  DASHBOARD_PATHS,
  dashboardPath,
} from '../lib/reports/dashboardPaths.js';
import { tz } from '../util/timezone.js';
import { SafeHtml, html, localUrl, memberText, staticRaw } from './html.js';
import { THEME_SCRIPT, themeToggle } from './theme.js';

export interface PageUser {
  username: string;
  csrfToken: string;
}

/**
 * The one stylesheet (nonce'd; no other CSS, no web fonts). Night market: a
 * sand page and teal buttons by day, plum-black with tangerine and magenta by
 * night; the accent marks what you can act on, coral what needs a person,
 * green what is done.
 * Light tokens on :root, dark ones under prefers-color-scheme: dark unless
 * the page chose light (data-theme="light"), and again for data-theme="dark"
 * (the header's theme toggle sets either; see theme.ts). Three more palettes
 * follow under data-palette, which the header's Style picker sets. Every text/background pair is
 * checked against WCAG AA in contrast.test.ts, which also checks the two
 * dark blocks are the same.
 */
// prettier-ignore
export const STYLE = staticRaw`
:root{--bg:#f7efe6;--surface:#ffffff;--raised:#f1e5d6;--fg:#1d1527;--muted:#5e5468;--line:#e2d5c3;--field:#7d7186;
--sel:#ffe5d1;--accent:#a83a0c;--btn:#0c6b74;--btn-hover:#09525a;--btn-fg:#ffffff;--focus:#c2410c;--attn:#b4232c;
--attn-soft:#ffe0dc;--attn-ink:#8a1c24;--accent-soft:#ffe6d6;--accent-ink:#7a2a08;--ok-soft:#d8f3ea;--ok-ink:#135a4b;
--rule-a:#ff7a1a;--rule-b:#e5007d;--heat1:#ffe0c2;--heat2:#ffb27a;--heat3:#e0640c;--heat4:#a83a0c;
--font:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
--s1:4px;--s2:8px;--s3:12px;--s4:16px;--s5:24px;--s6:32px;--t-sm:.875rem;--t-base:1rem;--t-lg:1.125rem;--t-xl:1.375rem;
--t-2xl:1.75rem;
--radius:14px;--radius-ctl:8px;--radius-pill:999px;--tap:44px;--width:1040px;
--chart-1:#0c6b74;--chart-2:#cd581c;--chart-3:#0f5232;--chart-4:#845900;--chart-5:#9064d8;
--glow-a:rgb(255 122 26 / .22);--glow-b:rgb(229 0 125 / .16);--glow-c:rgb(12 107 116 / .18);color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0b0912;--surface:#15111f;--raised:#1f1a2c;
--fg:#f6efff;--muted:#bfb3d4;
--line:#2d2640;--field:#8c80a6;--sel:#2a1f3a;--accent:#ffa05c;--btn:#ff8a3d;--btn-hover:#ffa05c;--btn-fg:#1a0f05;
--focus:#4fe3d2;--attn:#ff6b9d;--attn-soft:#4a1a33;--attn-ink:#ffbcd6;--accent-soft:#4a2a1a;--accent-ink:#ffd0b0;
--ok-soft:#103a36;--ok-ink:#7fe6d6;--rule-a:#ff8a3d;--rule-b:#ff3f9e;--heat1:#3a2a1a;--heat2:#7a4520;--heat3:#d86a2a;
--heat4:#ffa05c;
--chart-1:#4fe3d2;--chart-2:#ff964a;--chart-3:#ff3f9e;--chart-4:#ffd166;--chart-5:#c2adff;
--glow-a:rgb(255 138 61 / .35);--glow-b:rgb(255 63 158 / .3);--glow-c:rgb(79 227 210 / .25);color-scheme:dark}}
:root[data-theme="dark"]{--bg:#0b0912;--surface:#15111f;--raised:#1f1a2c;
--fg:#f6efff;--muted:#bfb3d4;
--line:#2d2640;--field:#8c80a6;--sel:#2a1f3a;--accent:#ffa05c;--btn:#ff8a3d;--btn-hover:#ffa05c;--btn-fg:#1a0f05;
--focus:#4fe3d2;--attn:#ff6b9d;--attn-soft:#4a1a33;--attn-ink:#ffbcd6;--accent-soft:#4a2a1a;--accent-ink:#ffd0b0;
--ok-soft:#103a36;--ok-ink:#7fe6d6;--rule-a:#ff8a3d;--rule-b:#ff3f9e;--heat1:#3a2a1a;--heat2:#7a4520;--heat3:#d86a2a;
--heat4:#ffa05c;
--chart-1:#4fe3d2;--chart-2:#ff964a;--chart-3:#ff3f9e;--chart-4:#ffd166;--chart-5:#c2adff;
--glow-a:rgb(255 138 61 / .35);--glow-b:rgb(255 63 158 / .3);--glow-c:rgb(79 227 210 / .25);color-scheme:dark}
/* Palettes the header picker offers besides the default (Night market, above): one light block, then the same dark
   tokens twice, as for the default. Non-colour tokens sit in the light block and hold in both modes. */
:root[data-palette="paper"]{
--chart-1:#962d22;--chart-2:#9c6a14;--chart-3:#114135;--chart-4:#3f4f8a;--chart-5:#865d9a;
--bg:#f6efe4;--surface:#fffaf2;--raised:#f0e6d6;--fg:#2a221c;--muted:#665a4e;--line:#e3d6c2;--field:#8a7a68;
--sel:#f5e9d2;--accent:#962d22;--btn:#962d22;--btn-hover:#742118;--btn-fg:#ffffff;--focus:#9c6a14;--attn:#962d22;
--attn-soft:#f8dcd4;--attn-ink:#6a1c14;--accent-soft:#f3e2c8;--accent-ink:#6a1c14;--ok-soft:#e1ead6;--ok-ink:#3a5528;
--rule-a:#962d22;--rule-b:#b8893a;--heat1:#eedcb8;--heat2:#d9b36b;--heat3:#a67624;--heat4:#7a5418;--radius:6px;
--s4:20px;--s5:28px;--s6:40px}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"])[data-palette="paper"]{
--chart-1:#e8b86d;--chart-2:#ff7a6c;--chart-3:#cde8b0;--chart-4:#9fc4e8;--chart-5:#ecd8f3;
--bg:#1d1a17;--surface:#272320;--raised:#332e29;--fg:#f3eadc;--muted:#c6b9a7;--line:#443d36;--field:#8f8274;
--sel:#3d342c;--accent:#e8b86d;--btn:#c0453a;--btn-hover:#a8382e;--btn-fg:#ffffff;--focus:#e8b86d;--attn:#ff9a90;
--attn-soft:#4a2520;--attn-ink:#ffc9c2;--accent-soft:#4a3a22;--accent-ink:#f5d9a8;--ok-soft:#2c3a24;--ok-ink:#b5d9a0;
--rule-a:#c0453a;--rule-b:#e8b86d;--heat1:#4a3a22;--heat2:#7a5c2a;--heat3:#b8893a;--heat4:#e8b86d}}
:root[data-theme="dark"][data-palette="paper"]{
--chart-1:#e8b86d;--chart-2:#ff7a6c;--chart-3:#cde8b0;--chart-4:#9fc4e8;--chart-5:#ecd8f3;
--bg:#1d1a17;--surface:#272320;--raised:#332e29;--fg:#f3eadc;--muted:#c6b9a7;--line:#443d36;--field:#8f8274;
--sel:#3d342c;--accent:#e8b86d;--btn:#c0453a;--btn-hover:#a8382e;--btn-fg:#ffffff;--focus:#e8b86d;--attn:#ff9a90;
--attn-soft:#4a2520;--attn-ink:#ffc9c2;--accent-soft:#4a3a22;--accent-ink:#f5d9a8;--ok-soft:#2c3a24;--ok-ink:#b5d9a0;
--rule-a:#c0453a;--rule-b:#e8b86d;--heat1:#4a3a22;--heat2:#7a5c2a;--heat3:#b8893a;--heat4:#e8b86d}
:root[data-palette="potluck"]{
--radius-ctl:14px;--chart-1:#b83a0a;--chart-2:#26571d;--chart-3:#547be8;--chart-4:#9b5300;--chart-5:#9662f1;
--bg:#fff6e5;--surface:#ffffff;--raised:#fff0cc;--fg:#2b1d14;--muted:#6b5343;--line:#f0d9a8;--field:#8a6a52;
--sel:#ffe7b3;--accent:#b83a0a;--btn:#b83a0a;--btn-hover:#8f2c06;--btn-fg:#ffffff;--focus:#a85a00;--attn:#b4232c;
--attn-soft:#ffe1e0;--attn-ink:#8a1620;--accent-soft:#ffe3c2;--accent-ink:#7a2a08;--ok-soft:#dff3d0;--ok-ink:#2a6120;
--rule-a:#f59e0b;--rule-b:#ef4444;--heat1:#fde68a;--heat2:#fbbf24;--heat3:#e0640c;--heat4:#b83a0a;--radius:22px;
--font:ui-rounded,"SF Pro Rounded","Hiragino Maru Gothic ProN","Arial Rounded MT Bold",
system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"])[data-palette="potluck"]{
--chart-1:#ffa26b;--chart-2:#b7e8a3;--chart-3:#619aff;--chart-4:#ffd166;--chart-5:#dba3ff;
--bg:#221a1f;--surface:#2d2329;--raised:#3a2d33;--fg:#fff3e6;--muted:#d2c0b0;--line:#4e3e45;--field:#a08c7e;
--sel:#4a3338;--accent:#ffa26b;--btn:#ff8a4c;--btn-hover:#ffa26b;--btn-fg:#2b1d14;--focus:#ffd166;--attn:#ff8f8f;
--attn-soft:#5a2a2e;--attn-ink:#ffc6c6;--accent-soft:#5a3a2a;--accent-ink:#ffd3b8;--ok-soft:#2d4a2a;--ok-ink:#b7e8a3;
--rule-a:#ffb347;--rule-b:#ff6b6b;--heat1:#5a4120;--heat2:#8a5a1a;--heat3:#e08a3a;--heat4:#ffa26b}}
:root[data-theme="dark"][data-palette="potluck"]{
--chart-1:#ffa26b;--chart-2:#b7e8a3;--chart-3:#619aff;--chart-4:#ffd166;--chart-5:#dba3ff;
--bg:#221a1f;--surface:#2d2329;--raised:#3a2d33;--fg:#fff3e6;--muted:#d2c0b0;--line:#4e3e45;--field:#a08c7e;
--sel:#4a3338;--accent:#ffa26b;--btn:#ff8a4c;--btn-hover:#ffa26b;--btn-fg:#2b1d14;--focus:#ffd166;--attn:#ff8f8f;
--attn-soft:#5a2a2e;--attn-ink:#ffc6c6;--accent-soft:#5a3a2a;--accent-ink:#ffd3b8;--ok-soft:#2d4a2a;--ok-ink:#b7e8a3;
--rule-a:#ffb347;--rule-b:#ff6b6b;--heat1:#5a4120;--heat2:#8a5a1a;--heat3:#e08a3a;--heat4:#ffa26b}
:root[data-palette="quiet"]{
--radius-ctl:0px;--radius-pill:0px;--chart-1:#4f5e42;--chart-2:#b8604a;--chart-3:#2f425a;--chart-4:#8a7a3a;--chart-5:#6b4a7a;
--bg:#f4f1ec;--surface:#fbfaf7;--raised:#ebe7df;--fg:#2b2924;--muted:#66625a;--line:#dcd7cd;--field:#878278;
--sel:#e9e4da;--accent:#4f5e42;--btn:#2b2924;--btn-hover:#44413a;--btn-fg:#f8f6f2;--focus:#4f5e42;--attn:#954535;
--attn-soft:#f1dfd8;--attn-ink:#6b2f22;--accent-soft:#e6e9df;--accent-ink:#3a4530;--ok-soft:#e3e8dc;--ok-ink:#3a4530;
--rule-a:#dcd7cd;--rule-b:#dcd7cd;--heat1:#e3e0d6;--heat2:#c5c0b2;--heat3:#878278;--heat4:#4f5e42;--radius:0px;
--s5:32px;--s6:48px}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"])[data-palette="quiet"]{
--chart-1:#aab89a;--chart-2:#db7e68;--chart-3:#c3d3e7;--chart-4:#c9b35e;--chart-5:#dccbe5;
--bg:#1b1a18;--surface:#201f1c;--raised:#2a2825;--fg:#ebe7df;--muted:#aaa59b;--line:#35332f;--field:#807b72;
--sel:#2f2d29;--accent:#aab89a;--btn:#ebe7df;--btn-hover:#ffffff;--btn-fg:#1b1a18;--focus:#aab89a;--attn:#e0917f;
--attn-soft:#432a24;--attn-ink:#f2c3b8;--accent-soft:#2d3228;--accent-ink:#cdd7c2;--ok-soft:#2a3326;--ok-ink:#bfd0b0;
--rule-a:#35332f;--rule-b:#35332f;--heat1:#3d3b36;--heat2:#5e5b52;--heat3:#8f8a80;--heat4:#aab89a}}
:root[data-theme="dark"][data-palette="quiet"]{
--chart-1:#aab89a;--chart-2:#db7e68;--chart-3:#c3d3e7;--chart-4:#c9b35e;--chart-5:#dccbe5;
--bg:#1b1a18;--surface:#201f1c;--raised:#2a2825;--fg:#ebe7df;--muted:#aaa59b;--line:#35332f;--field:#807b72;
--sel:#2f2d29;--accent:#aab89a;--btn:#ebe7df;--btn-hover:#ffffff;--btn-fg:#1b1a18;--focus:#aab89a;--attn:#e0917f;
--attn-soft:#432a24;--attn-ink:#f2c3b8;--accent-soft:#2d3228;--accent-ink:#cdd7c2;--ok-soft:#2a3326;--ok-ink:#bfd0b0;
--rule-a:#35332f;--rule-b:#35332f;--heat1:#3d3b36;--heat2:#5e5b52;--heat3:#8f8a80;--heat4:#aab89a}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;font-family:var(--font);font-size:var(--t-base);line-height:1.5;color:var(--fg);background:var(--bg)}
h1,h2,h3,bdi{overflow-wrap:anywhere}
h1{font-size:var(--t-2xl);line-height:1.2;margin:0 0 var(--s3)}
h2{font-size:var(--t-xl);line-height:1.25;margin:0 0 var(--s3)}
h3{font-size:var(--t-lg);line-height:1.3;margin:0 0 var(--s2)}
p,ul,ol{margin:0 0 var(--s3)}
.card>form{margin:0 0 var(--s3)}
img{max-width:100%;height:auto}
a{color:var(--accent);text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:2px}
a:hover{color:var(--accent-ink);text-decoration-thickness:2px}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.skip{position:absolute;left:var(--s2);top:-200px;z-index:10;padding:var(--s3) var(--s4);background:var(--surface);
color:var(--fg);border:1px solid var(--line);border-radius:var(--radius)}
.skip:focus{top:var(--s2)}
header.site{background:var(--surface)}
header.site::after{content:"";display:block;height:4px;
background:linear-gradient(90deg,var(--rule-a) 0 60%,var(--rule-b) 60% 100%)}
header.site .bar{max-width:var(--width);margin:0 auto;padding:var(--s3) var(--s4);display:flex;flex-wrap:wrap;
gap:var(--s2) var(--s4);justify-content:space-between;align-items:center}
header.site .brand{font-size:var(--t-lg);font-weight:700}
header.site .account{display:flex;flex-wrap:wrap;gap:var(--s2) var(--s3);align-items:center;color:var(--muted);
font-size:var(--t-sm)}
header.site form{margin:0}
.theme-toggle{display:inline-flex;border:1px solid var(--line);border-radius:var(--radius-pill);padding:2px;gap:2px}
.theme-toggle[hidden]{display:none}
.theme-toggle button{min-height:32px;padding:0 var(--s3);border:0;border-radius:var(--radius-pill);
background:transparent;color:var(--muted);
  font:inherit;font-size:var(--t-sm);cursor:pointer}
.theme-toggle button:hover{color:var(--fg);background:var(--sel)}
.theme-toggle button[aria-pressed="true"]{color:var(--accent-ink);background:var(--accent-soft);font-weight:600}
.palette-pick{display:inline-flex;align-items:center;gap:var(--s2);font-size:var(--t-sm);color:var(--muted)}
.palette-pick[hidden]{display:none}
.palette-pick select{min-height:32px;padding:0 var(--s2);border-radius:var(--radius-pill);font-size:var(--t-sm);color:var(--fg)}
nav.site{background:var(--surface);border-bottom:1px solid var(--line);overflow-x:auto;scrollbar-width:thin}
nav.site .tabs{display:flex;gap:var(--s1);max-width:var(--width);margin:0 auto;padding:0 var(--s2)}
nav.site a{flex:0 0 auto;display:inline-flex;align-items:center;min-height:var(--tap);padding:0 var(--s3);
color:var(--muted);text-decoration:none;white-space:nowrap;font-weight:500;border-bottom:3px solid transparent}
nav.site a:hover{color:var(--fg);background:var(--raised)}
nav.site a[aria-current="page"]{color:var(--fg);font-weight:700;border-bottom-color:var(--accent)}
nav.site a:focus-visible{outline-offset:-3px}
main{display:block;max-width:var(--width);margin:0 auto;padding:var(--s5) var(--s4) var(--s6)}
main:focus{outline:none}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:var(--s4);
margin-bottom:var(--s4)}
.card>:last-child{margin-bottom:0}
@media (min-width:640px){.card{padding:var(--s5)}}
button,.button{display:inline-flex;align-items:center;justify-content:center;gap:var(--s2);min-height:var(--tap);
padding:var(--s2) var(--s4);font:inherit;font-weight:600;line-height:1.25;text-align:center;text-decoration:none;
color:var(--btn-fg);background:var(--btn);border:1px solid var(--btn);border-radius:var(--radius-ctl);cursor:pointer;
transition:transform 150ms ease,background-color 150ms ease}
button:hover,.button:hover{color:var(--btn-fg);background:var(--btn-hover);border-color:var(--btn-hover)}
button:active,.button:active{transform:scale(.97)}
button:disabled{opacity:.6;cursor:not-allowed;transform:none}
.ghost,.secondary,.danger{color:var(--accent);background:transparent;border-color:var(--line)}
.ghost:hover,.secondary:hover{color:var(--accent);background:var(--sel);border-color:var(--field)}
.danger{color:var(--attn)}
.danger:hover{color:var(--attn-ink);background:var(--attn-soft);border-color:var(--attn)}
input,select,textarea{font:inherit;color:var(--fg);background:var(--surface);border:1px solid var(--field);
border-radius:var(--radius-ctl);padding:var(--s2) var(--s3);max-width:100%}
input,select{min-height:var(--tap)}
textarea{display:block;width:100%;min-height:var(--tap);margin-top:var(--s1)}
label.field{display:block}
input[type="checkbox"],input[type="radio"]{min-height:0;width:20px;height:20px;accent-color:var(--btn)}
input:focus-visible,select:focus-visible,textarea:focus-visible{outline-offset:1px}
::placeholder{color:var(--muted);opacity:1}
summary{cursor:pointer;padding:10px 0;font-weight:600}
details{margin-top:var(--s2)}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:var(--s2) var(--s3);border-bottom:1px solid var(--line);vertical-align:top;
overflow-wrap:anywhere}
th{font-size:var(--t-sm);font-weight:600;color:var(--muted)}
td ul{margin:var(--s1) 0 0;padding-left:var(--s4)}
.rank-inline{display:none}
.table-scroll{overflow-x:auto;max-width:100%;margin:0 0 var(--s3);border:1px solid var(--line);border-radius:var(--radius-ctl)}
.table-scroll th,.table-scroll td{white-space:nowrap;overflow-wrap:normal}
.table-scroll tr:last-child td{border-bottom:0}
img.ban-photo{display:block;width:96px;max-width:100%;height:auto;aspect-ratio:1;object-fit:cover;border-radius:8px}
canvas.ban-preview{display:block;max-width:96px;height:auto;border-radius:8px}
td.ban-actions{width:15rem}
td.ban-actions form+form{margin-top:var(--s3);padding-top:var(--s3);border-top:1px solid var(--line)}
form[data-ban-photo] input[type="file"]{width:100%;min-width:0}
table.bans th{overflow-wrap:normal}
table.bans td.ban-date{white-space:nowrap;overflow-wrap:normal}
table.bans td.ban-fixed{overflow-wrap:normal}
/* Host event tables (Date / Event / Type / ...). With columns (640px up), Date and Type break only
between words, never mid-word. On desktop (1024px up, the page at its full width) the Type label keeps
to one line and the date and time stack on two. In the upcoming-events table a row's buttons also stay
on one line at their size, and Event (width:100%) is the one column that takes the rest and wraps; a
row with a note under its buttons (announce-early) still wraps, with the note at a readable width
rather than widening the column. (History's three buttons are too wide for that, so they keep wrapping.)
Below 640px the rows are stacked and none of this applies. */
@media (min-width:640px){td.type,td .when{overflow-wrap:normal}}
@media (min-width:1024px){td.type,td .when{white-space:nowrap}
table.stack td .when{display:block}
table.upcoming td.event{width:100%}
table.upcoming td .actions:not(:has(.note)){flex-wrap:nowrap}
table.upcoming td .actions:not(:has(.note))>*{flex:none;white-space:nowrap}
table.upcoming td .actions .note{max-width:20rem}}
form.ban-add label.field{margin:0 0 var(--s3)}
form.ban-add label.field input{display:block;width:100%;max-width:24rem;margin-top:var(--s1)}
code{overflow-wrap:anywhere}
[hidden]{display:none!important}
img.thumb{display:block;width:64px;max-width:100%;height:auto;aspect-ratio:1;object-fit:cover;border-radius:8px;
border:1px solid var(--line);background:var(--raised)}
figure{margin:0 0 var(--s5)}
.muted{color:var(--muted)}
.badge{display:inline-block;font-size:var(--t-sm);font-weight:600;line-height:1.4;padding:2px var(--s2);
border-radius:var(--radius-pill);color:var(--muted);background:var(--raised);vertical-align:middle;white-space:nowrap}
.badge.neutral{color:var(--muted);background:var(--raised)}
.badge.attn{color:var(--attn-ink);background:var(--attn-soft)}
.badge.info{color:var(--accent-ink);background:var(--accent-soft)}
.badge.ok{color:var(--ok-ink);background:var(--ok-soft)}
.note{color:var(--fg);background:var(--raised);border:1px solid var(--line);border-left:4px solid var(--field);
border-radius:var(--radius-ctl);padding:var(--s3) var(--s4);margin:0 0 var(--s3);animation:note-in 200ms ease-out both}
.note.attn{color:var(--attn-ink);background:var(--attn-soft);border-color:var(--attn-soft);
border-left-color:var(--attn)}
.note.info{color:var(--accent-ink);background:var(--accent-soft);border-color:var(--accent-soft);
border-left-color:var(--accent)}
.note a{color:inherit}
@keyframes note-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
textarea.copy{min-height:240px;font-family:var(--mono);font-size:var(--t-sm);line-height:1.5;background:var(--raised)}
svg.chart{max-width:100%;height:auto}
svg.chart text{fill:var(--muted)}
svg.chart line{stroke:var(--field)}
svg.chart g.s1 rect,svg.chart g.s1 circle,svg.chart tspan.s1{fill:var(--chart-1)}
svg.chart g.s1 polyline{stroke:var(--chart-1)}
svg.chart g.s2 rect,svg.chart g.s2 circle,svg.chart tspan.s2{fill:var(--chart-2)}
svg.chart g.s2 polyline{stroke:var(--chart-2)}
svg.chart g.s3 rect,svg.chart g.s3 circle,svg.chart tspan.s3{fill:var(--chart-3)}
svg.chart g.s3 polyline{stroke:var(--chart-3)}
svg.chart g.s4 rect,svg.chart g.s4 circle,svg.chart tspan.s4{fill:var(--chart-4)}
svg.chart g.s4 polyline{stroke:var(--chart-4)}
svg.chart g.s5 rect,svg.chart g.s5 circle,svg.chart tspan.s5{fill:var(--chart-5)}
svg.chart g.s5 polyline{stroke:var(--chart-5)}
nav.pager{display:flex;flex-wrap:wrap;gap:var(--s2);align-items:center;margin:var(--s4) 0}
nav.pager a,nav.pager strong,nav.pager span{display:inline-flex;align-items:center;min-height:var(--tap);
padding:0 var(--s3);border:1px solid transparent;border-radius:var(--radius-ctl)}
nav.pager a{font-weight:600;text-decoration:none;border-color:var(--line)}
nav.pager a:hover{color:var(--accent);background:var(--sel);border-color:var(--field)}
nav.pager span{color:var(--muted)}
nav.pager.choices{gap:var(--s1)}
nav.pager.choices strong{color:var(--accent-ink);background:var(--accent-soft);border-color:var(--accent)}
form.filters{display:flex;flex-wrap:wrap;gap:var(--s3);align-items:flex-end;margin:0 0 var(--s4);padding:var(--s3);
background:var(--raised);border-radius:var(--radius-ctl)}
form.filters label{display:flex;flex-direction:column;gap:var(--s1);font-size:var(--t-sm);font-weight:600;
color:var(--muted)}
form.filters input,form.filters select{font-size:var(--t-base);font-weight:400}
.ws-month{margin-top:var(--s4)}
dl.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--s2);margin:0}
.stat{background:var(--raised);border-radius:var(--radius-ctl);padding:var(--s3)}
.stat dt{font-size:var(--t-sm);font-weight:600;color:var(--muted)}
.stat dd{margin:0;font-size:var(--t-2xl);font-weight:700;line-height:1.2;color:var(--fg)}
.stat.todo dd{color:var(--attn)}
.stat.done dd{color:var(--ok-ink)}
.actions{display:flex;flex-wrap:wrap;gap:var(--s2);align-items:flex-start;margin:var(--s3) 0}
.actions form{margin:0}
.ws-card h2{display:flex;flex-wrap:wrap;align-items:center;gap:var(--s2)}
.ws-card details{border-top:1px solid var(--line);margin-top:var(--s4);padding-top:var(--s2)}
@media (max-width:1023.98px){table.stack.bans,table.stack.bans tbody{display:block;width:100%}
table.stack.bans thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
table.stack.bans tr{display:block;background:var(--raised);border:1px solid var(--line);border-radius:var(--radius-ctl);
padding:var(--s2) var(--s3);margin:0 0 var(--s3)}
table.stack.bans td{display:flow-root;border:0;padding:var(--s1) 0 var(--s1) 40%}
table.stack.bans td::before{content:attr(data-label);float:left;width:calc(66.667% - var(--s3));margin-left:-66.667%;
padding-right:var(--s3);box-sizing:content-box;font-size:var(--t-sm);font-weight:600;color:var(--muted)}
table.stack.bans td.ban-actions{width:auto}}
@media (min-width:640px) and (max-width:1023.98px){table.stack.bans td{padding-left:12rem}
table.stack.bans td::before{width:calc(12rem - var(--s3));margin-left:-12rem}}
@media (max-width:639.98px){h1{font-size:var(--t-xl)}
h2{font-size:var(--t-lg)}
h3{font-size:var(--t-base)}
table.stack,table.stack tbody{display:block;width:100%}
table.stack thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
table.stack tr{display:block;background:var(--raised);border:1px solid var(--line);border-radius:var(--radius-ctl);
padding:var(--s2) var(--s3);margin:0 0 var(--s3)}
table.stack td{display:flow-root;border:0;padding:var(--s1) 0 var(--s1) 40%}
/* The label floats in the cell's 40% left padding (2/3 of the 60% content box). It stays announced: no
alt text (attr(data-label) / ""), since the thead is hidden here and the label is the only column name readers get. */
table.stack td::before{content:attr(data-label);float:left;width:calc(66.667% - var(--s3));margin-left:-66.667%;
padding-right:var(--s3);box-sizing:content-box;font-size:var(--t-sm);font-weight:600;color:var(--muted)}
table.stack td.rank{display:none}
.rank-inline{display:inline}
.actions>form:has(textarea){flex:1 1 100%}
form.filters label{flex:1 1 100%}
form.filters input,form.filters select,form.filters button{width:100%}
table.stack td.ban-actions{width:auto}}
/* Host dashboard: the hosting heat map (literal level classes) and the busy/quiet calendar. */
/* row-reverse starts the scroller at its right end, so a phone shows the recent months first. */
.heat-wrap{margin:var(--s3) 0;display:flex;flex-direction:row-reverse}
/* margin-right:auto keeps it left-aligned when it fits; when it overflows there is no free space, so the
scroller still opens at the recent end and scrolls left. (justify-content:flex-end here makes it unscrollable.) */
.heat-wrap svg{flex:none;margin-right:auto}
svg.heat rect.hm0{fill:var(--raised);stroke:var(--line)}
svg.heat rect.hm1{fill:var(--heat1)}
svg.heat rect.hm2{fill:var(--heat2)}
svg.heat rect.hm3{fill:var(--heat3)}
svg.heat rect.hm4{fill:var(--heat4)}
svg.heat text{fill:var(--muted)}
svg.heat a.hm-link:focus{outline:none}
svg.heat a.hm-link:focus-visible rect{stroke:var(--fg);stroke-width:2px}
svg.heat a.hm-link rect{cursor:pointer}
.hm-tip{position:fixed;z-index:30;max-width:min(20rem,calc(100vw - 16px));padding:var(--s2) var(--s3);
  background:var(--fg);color:var(--bg);border-radius:8px;font-size:var(--t-sm);box-shadow:0 6px 18px rgb(0 0 0 / .25);
  overflow-wrap:anywhere;pointer-events:none}
.hm-tip strong,.hm-tip span{display:block}
nav.year-nav{display:flex;align-items:center;gap:var(--s3);flex-wrap:wrap;margin:var(--s3) 0 0}
nav.year-nav .disabled{opacity:.45;cursor:default}
@media (max-width:480px){nav.year-nav{justify-content:space-between}nav.year-nav strong{order:-1;flex-basis:100%}}
p.day-filter{font-weight:600}
dl.verify-summary{display:grid;grid-template-columns:max-content 1fr;gap:var(--s1) var(--s4);margin:var(--s3) 0}
dl.verify-summary dt{font-weight:600;color:var(--muted)}
dl.verify-summary dd{margin:0;overflow-wrap:anywhere}
table.cal-grid{table-layout:fixed;width:100%;min-width:560px}
table.cal-grid th{text-align:center}
td.cal{vertical-align:top;height:76px;padding:var(--s1) var(--s2);font-size:var(--t-sm);white-space:normal;
overflow-wrap:anywhere}
td.cal .cal-head span,details.cal-pop>summary>span{display:block}
.cal-day{font-weight:700}
.cal-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--s1)}
td.cal .cal-day{white-space:nowrap;overflow-wrap:normal}
a.cal-add{display:inline-flex;align-items:center;justify-content:center;min-width:28px;min-height:28px;flex:none;
  padding:0 var(--s1);border-radius:6px;color:var(--accent);font-size:1.25rem;font-weight:700;line-height:1;text-decoration:none}
a.cal-add:hover{background:var(--sel)}
details.cal-pop{margin:0}
details.cal-pop>summary{position:relative;display:block;list-style:none;min-height:40px;padding:var(--s1) 0;font-weight:400}
details.cal-pop>summary::-webkit-details-marker{display:none}
details.cal-pop>summary .cal-count{text-decoration:underline dotted;text-underline-offset:3px}
.cal-panel{margin-top:var(--s1);padding:var(--s2);border:1px solid var(--line);border-radius:var(--radius-ctl);background:var(--surface)}
.cal-panel ul{margin:0 0 var(--s2);padding-left:1.1rem}
.cal-panel li{margin:0 0 var(--s1)}
.cal-panel p{margin:0 0 var(--s1)}
.cal-panel-title{font-weight:700}
table.cal-js details.cal-pop[open]>.cal-panel{position:fixed;z-index:20;margin:0;width:min(22rem,calc(100vw - 32px));
  max-height:min(60vh,28rem);overflow:auto;box-shadow:0 8px 24px rgb(0 0 0 / .25)}
.cal-date{font-weight:600;font-style:italic}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
form.request-form label.field{margin:0 0 var(--s3)}
form.request-form label.field input,form.request-form label.field select{display:block;width:100%;max-width:24rem;margin-top:var(--s1)}
form.request-form details.more-options{margin:0 0 var(--s3);padding-bottom:var(--s1);
  border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
form.request-form details.more-options textarea{max-width:40rem}
.desc-text{white-space:pre-line;overflow-wrap:anywhere;max-height:24rem;overflow-y:auto;padding:var(--s2) var(--s3);
  background:var(--raised);border-radius:var(--radius-ctl);font-size:var(--t-sm)}
ul.copy-details{margin:0 0 var(--s2);padding-left:1.2rem;overflow-wrap:anywhere}
fieldset.review-checklist{border:1px solid var(--line);border-radius:var(--radius-ctl);padding:var(--s2) var(--s3);margin:0 0 var(--s3)}
fieldset.review-checklist legend{font-size:var(--t-sm);color:var(--muted);padding:0 var(--s1)}
fieldset.review-checklist label.check{display:flex;gap:var(--s2);align-items:center;min-height:44px}
details.announce-guidelines{margin:0 0 var(--s3);font-size:var(--t-sm)}
details.announce-guidelines ul{margin:var(--s1) 0 0;padding-left:1.2rem}
.announce-early{margin:0 0 var(--s2);font-size:var(--t-sm)}
.recreate-offer{margin:0}
tr.offer-row td{padding-top:0}
table.stack tr.offer-row td{padding-left:0}
table.stack tr.offer-row td::before{content:none}
.badge.wrap{white-space:normal;text-align:left}
.recreate-offer form{margin:var(--s2) 0 0}
.wrap-anywhere{overflow-wrap:anywhere}
.field-error{display:block;margin-top:var(--s1);color:var(--attn-ink);font-size:var(--t-sm);font-weight:600}
td.cal.past{color:var(--muted);background:var(--bg)}
td.cal.out{background:var(--bg)}
td.busy0,.swatch.busy0{background:var(--ok-soft)}
td.busy1,.swatch.busy1{background:var(--surface)}
td.busy2,.swatch.busy2{background:var(--attn-soft)}
td.busy3,.swatch.busy3{background:var(--attn-soft);box-shadow:inset 4px 0 0 var(--attn)}
.swatch{display:inline-block;width:14px;height:14px;border:1px solid var(--field);border-radius:3px;
vertical-align:middle;margin:0 var(--s1) 0 var(--s3)}
.cal-legend .swatch:first-child{margin-left:0}
ol.cal-list{list-style:none;padding:0;margin:0}
ol.cal-list>li{border-top:1px solid var(--line);padding:var(--s3) 0}
ol.cal-list>li:first-child{border-top:0;padding-top:0}
nav.type-filter,nav.status-filter{display:flex;flex-wrap:wrap;gap:0 var(--s4);margin:0 0 var(--s3)}
nav.type-filter a,nav.status-filter a{display:inline-flex;align-items:center;min-height:var(--tap)}
/* ---- Per-palette rules. The default (Night market) ones are scoped to :root:not([data-palette]) so no other
   palette inherits them; each other palette's sit under its data-palette. Tokens above do the colours. ---- */
/* Night market: lantern glows behind the header, a gradient hairline under it. Static, so nothing to reduce. */
:root:not([data-palette]) header.site{position:relative;overflow:hidden}
:root:not([data-palette]) header.site::before{content:"";position:absolute;left:0;right:0;top:-60px;height:180px;
  pointer-events:none;background:radial-gradient(240px 130px at 6% 30%,var(--glow-a),transparent 70%),
  radial-gradient(280px 130px at 50% 0,var(--glow-b),transparent 70%),
  radial-gradient(220px 130px at 94% 30%,var(--glow-c),transparent 70%)}
:root:not([data-palette]) header.site .bar{position:relative}
:root:not([data-palette]) header.site::after{height:2px;background:linear-gradient(90deg,var(--rule-a),var(--rule-b) 55%,var(--ok-ink))}
/* Potluck: hand-drawn feel. Thick outlines, paper-offset shadows, uneven corners, pill buttons and tabs. */
:root[data-palette="potluck"] .card{border:3px solid var(--fg);box-shadow:6px 6px 0 var(--line);
  border-radius:24px 20px 26px 18px/18px 26px 20px 24px}
:root[data-palette="potluck"] header.site{background:var(--raised)}
:root[data-palette="potluck"] header.site::after{height:6px;
  background:repeating-linear-gradient(90deg,var(--rule-a) 0 24px,var(--rule-b) 24px 48px,var(--ok-ink) 48px 72px,var(--accent) 72px 96px)}
:root[data-palette="potluck"] nav.site{border-bottom:0;padding:var(--s2) 0}
:root[data-palette="potluck"] nav.site a{border:2px solid transparent;border-radius:var(--radius-pill);min-height:var(--tap);margin:2px 0}
:root[data-palette="potluck"] nav.site a[aria-current="page"]{border-color:var(--fg);background:var(--sel);color:var(--fg)}
:root[data-palette="potluck"] nav.site a:hover{background:var(--sel)}
:root[data-palette="potluck"] button,:root[data-palette="potluck"] .button{border-radius:var(--radius-pill);border-width:2px;
  box-shadow:0 4px 0 var(--btn-hover)}
:root[data-palette="potluck"] button:active,:root[data-palette="potluck"] .button:active{transform:translateY(3px);
  box-shadow:0 1px 0 var(--btn-hover)}
:root[data-palette="potluck"] .ghost,:root[data-palette="potluck"] .secondary,:root[data-palette="potluck"] .danger{
  border:2px solid var(--fg);color:var(--fg);box-shadow:0 4px 0 var(--line)}
:root[data-palette="potluck"] .ghost:hover,:root[data-palette="potluck"] .secondary:hover{background:var(--sel);
  border-color:var(--fg);color:var(--fg)}
:root[data-palette="potluck"] .danger{color:var(--attn)}
:root[data-palette="potluck"] .danger:hover{color:var(--attn-ink);background:var(--attn-soft);border-color:var(--attn)}
:root[data-palette="potluck"] .theme-toggle button,:root[data-palette="potluck"] .palette-pick select{box-shadow:none}
:root[data-palette="potluck"] .theme-toggle button:active{transform:none}
:root[data-palette="potluck"] input,:root[data-palette="potluck"] select,:root[data-palette="potluck"] textarea{
  border:2px solid var(--fg);background:var(--surface)}
:root[data-palette="potluck"] .badge{border:2px solid currentColor;padding:2px 10px}
:root[data-palette="potluck"] .note{border:2px dashed var(--accent);border-radius:16px;background:var(--accent-soft);color:var(--fg)}
:root[data-palette="potluck"] .theme-toggle{border:2px solid var(--fg)}
:root[data-palette="potluck"] th{text-transform:uppercase;font-size:.75rem;letter-spacing:.06em}
:root[data-palette="potluck"] table.cal-grid{border-collapse:separate;border-spacing:4px}
:root[data-palette="potluck"] td.cal{border:2px solid var(--line);border-radius:14px;height:84px}
:root[data-palette="potluck"] td.cal.past,:root[data-palette="potluck"] td.cal.out{border-color:transparent}
:root[data-palette="potluck"] td.busy0{border-color:var(--ok-ink)}
:root[data-palette="potluck"] td.busy3{box-shadow:none;border-color:var(--attn)}
:root[data-palette="potluck"] .swatch{border-radius:50%;border:2px solid var(--fg)}
:root[data-palette="potluck"] a.cal-add{border:2px solid var(--fg);border-radius:50%;color:var(--fg);font-size:1rem;
  min-width:26px;min-height:26px}
:root[data-palette="potluck"] nav.type-filter a,
:root[data-palette="potluck"] nav.status-filter a{border:2px solid var(--line);border-radius:var(--radius-pill);padding:0 12px;
  min-height:var(--tap);text-decoration:none;color:var(--fg)}
:root[data-palette="potluck"] nav.type-filter a[aria-current="page"],
:root[data-palette="potluck"] nav.status-filter a[aria-current="page"]{border-color:var(--fg);background:var(--sel)}
@media (max-width:639.98px){:root[data-palette="potluck"] .card{box-shadow:4px 4px 0 var(--line)}
:root[data-palette="potluck"] table.stack tr{border:2px solid var(--line);border-radius:16px}}
/* Quiet: no cards. Hairlines and space do the grouping; badges are a dot and a word. */
:root[data-palette="quiet"] header.site{background:var(--bg)}
:root[data-palette="quiet"] header.site::after{height:1px;background:var(--line)}
:root[data-palette="quiet"] header.site .brand{font-weight:500;font-size:var(--t-base);letter-spacing:.02em}
:root[data-palette="quiet"] nav.site{background:var(--bg)}
:root[data-palette="quiet"] nav.site a{font-weight:400;border-bottom-width:1px}
:root[data-palette="quiet"] nav.site a:hover{background:transparent;color:var(--fg)}
:root[data-palette="quiet"] nav.site a[aria-current="page"]{font-weight:500;border-bottom-color:var(--fg)}
:root[data-palette="quiet"] .card{background:transparent;border:0;border-top:1px solid var(--line);padding:var(--s5) 0;margin:0}
:root[data-palette="quiet"] main>.card:first-child{border-top:0;padding-top:0}
:root[data-palette="quiet"] h1{font-size:1.6rem;font-weight:500;letter-spacing:.01em}
:root[data-palette="quiet"] h2{font-size:1.1rem;font-weight:500;letter-spacing:.01em}
:root[data-palette="quiet"] button,:root[data-palette="quiet"] .button{font-weight:500}
:root[data-palette="quiet"] .ghost,:root[data-palette="quiet"] .secondary{color:var(--fg);border-color:var(--line)}
:root[data-palette="quiet"] .ghost:hover,:root[data-palette="quiet"] .secondary:hover{color:var(--fg);background:var(--raised);
  border-color:var(--field)}
:root[data-palette="quiet"] .badge{background:transparent;color:var(--muted);padding:0;font-weight:500;font-size:.8rem}
:root[data-palette="quiet"] .badge::before{content:"·" / "";margin-right:6px}
:root[data-palette="quiet"] .badge.ok{color:var(--ok-ink)}
:root[data-palette="quiet"] .badge.attn{color:var(--attn-ink)}
:root[data-palette="quiet"] .badge.info{color:var(--accent-ink)}
:root[data-palette="quiet"] .note{background:transparent;border:0;border-left:1px solid var(--field);color:var(--muted);
  padding:var(--s1) var(--s4)}
:root[data-palette="quiet"] .note.attn{color:var(--attn-ink);border-left-color:var(--attn)}
:root[data-palette="quiet"] .note.info{color:var(--fg);border-left-color:var(--accent)}
:root[data-palette="quiet"] th{font-weight:500}
:root[data-palette="quiet"] .theme-toggle button[aria-pressed="true"]{background:transparent;color:var(--fg);
  text-decoration:underline;text-underline-offset:4px}
:root[data-palette="quiet"] .desc-text{background:transparent;border-left:1px solid var(--line)}
@media (max-width:639.98px){:root[data-palette="quiet"] table.stack tr{background:transparent;border:0;
  border-top:1px solid var(--line);padding:var(--s3) 0}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;
transition:none!important}button:active,.button:active{transform:none}}
`;

/** The site nav's pages, in order. Links and labels are fixed. */
const NAV_ITEMS = [
  { key: 'home', path: DASHBOARD_BASE, label: 'Home' },
  {
    key: 'workspace',
    path: dashboardPath(DASHBOARD_PATHS.workspace),
    label: 'No-show workspace',
  },
  {
    key: 'hostRequests',
    path: dashboardPath(DASHBOARD_PATHS.hostRequests),
    label: 'Host requests',
  },
  {
    key: 'hostPromotion',
    path: dashboardPath(DASHBOARD_PATHS.hostPromotion),
    label: 'Host promotion',
  },
  {
    key: 'hallOfFame',
    path: dashboardPath(DASHBOARD_PATHS.hallOfFame),
    label: 'Hall of Fame',
  },
  {
    key: 'noShowHistory',
    path: dashboardPath(DASHBOARD_PATHS.noShowHistory),
    label: 'No-show history',
  },
  {
    key: 'suspensions',
    path: dashboardPath(DASHBOARD_PATHS.suspensions),
    label: 'Suspensions',
  },
  {
    key: 'identity',
    path: dashboardPath(DASHBOARD_PATHS.identity),
    label: 'Identity changes',
  },
  {
    key: 'eventChanges',
    path: dashboardPath(DASHBOARD_PATHS.eventChanges),
    label: 'Event changes',
  },
  {
    key: 'linkProgress',
    path: dashboardPath(DASHBOARD_PATHS.linkProgress),
    label: 'Link progress',
  },
  {
    key: 'trends',
    path: dashboardPath(DASHBOARD_PATHS.trends),
    label: 'Trends',
  },
  {
    key: 'sessions',
    path: dashboardPath(DASHBOARD_PATHS.sessions),
    label: 'Sessions',
  },
] as const;

export type NavKey = (typeof NAV_ITEMS)[number]['key'];

/**
 * The nav item a request path belongs to, by comparing it with the fixed nav
 * paths: Home only for /dashboard itself, any other item for its path or a
 * path under it. undefined for pages outside the nav (organizer login).
 */
export function navKeyFor(requestPath: string | undefined): NavKey | undefined {
  if (typeof requestPath !== 'string') {
    return undefined;
  }
  // Express matches routes case-insensitively, so the comparison does too.
  let path = requestPath.split('?')[0].toLowerCase();
  // Trailing slashes, stripped in one linear pass (a /\/+$/ replace can go
  // quadratic on a long run of slashes followed by another character).
  let end = path.length;
  while (end > 0 && path[end - 1] === '/') {
    end -= 1;
  }
  path = path.slice(0, end);
  if (path === DASHBOARD_BASE) {
    return 'home';
  }
  return NAV_ITEMS.find(
    (item) =>
      item.key !== 'home' &&
      (path === item.path || path.startsWith(`${item.path}/`)),
  )?.key;
}

/** The tab bar; aria-current is a literal, on the item the caller named. */
function siteNav(current: NavKey | undefined): SafeHtml {
  // prettier-ignore
  const links = NAV_ITEMS.map((item) => {
    const href = localUrl(item.path);
    return item.key === current
      ? html`<a href="${href}" aria-current="page">${item.label}</a>`
      : html`<a href="${href}">${item.label}</a>`;
  });
  return html`<nav class="site" aria-label="Dashboard pages">
    <div class="tabs">${links}</div>
  </nav>`;
}

export function layout({
  title,
  nonce,
  user,
  current,
  body,
}: {
  title: string;
  nonce: string;
  /** Signed in: the account and the site nav are shown. */
  user?: PageUser;
  /** The nav item to mark as the current page. */
  current?: NavKey;
  body: SafeHtml;
}): string {
  const account = user
    ? html`<div class="account">
        <span>Signed in as ${memberText(user.username)}</span>
        <form method="post" action="/dashboard/logout">
          <input type="hidden" name="_csrf" value="${user.csrfToken}" />
          <button type="submit" class="ghost">Sign out</button>
        </form>
      </div>`
    : '';
  const nav = user ? siteNav(current) : '';
  // prettier-ignore
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title} · 1.5 Gen Asians staff</title>
<style nonce="${nonce}">${STYLE}</style>
<script nonce="${nonce}">${THEME_SCRIPT}</script>
</head>
<body>
<a class="skip" href="#main">Skip to main content</a>
<header class="site"><div class="bar"><strong class="brand">1.5 Gen Asians staff dashboard</strong>${themeToggle()}${account}</div></header>
${nav}
<main id="main" tabindex="-1">${body}</main>
</body>
</html>`.value;
}

/** What the home page says about the shared organizer login. No tokens or ids. */
export type HomeOrganizerStatus =
  | { kind: 'ok' }
  | { kind: 'failing'; since: Date }
  | { kind: 'not-set-up' }
  | { kind: 'unavailable' };

function organizerStatusText(status: HomeOrganizerStatus): string {
  switch (status.kind) {
    case 'ok':
      return 'OK (no failure on record)';
    case 'failing':
      return `Failing since ${tz(dayjs(status.since)).format('MMM D, YYYY h:mm A')} Pacific time`;
    case 'not-set-up':
      return 'Not set up';
    case 'unavailable':
      return 'Status unavailable';
  }
}

export function homePage(
  user: PageUser,
  nonce: string,
  organizer?: HomeOrganizerStatus,
  reports?: SafeHtml,
): string {
  return layout({
    title: 'Home',
    nonce,
    user,
    current: 'home',
    body: html`<div class="card">
        <h1>Welcome</h1>
        ${
          reports
            ? html`<p>Latest reports:</p>`
            : html`<p>
                Reports will appear here once the monthly build job is running.
              </p>`
        }
      </div>
      ${reports ?? ''}
      <div class="card">
        <h2>Organizer login</h2>
        ${organizer ? html`<p>${organizerStatusText(organizer)}</p>` : ''}
        <p><a href="/dashboard/organizer-login">Organizer login</a></p>
      </div>`,
  });
}

export function loginPage(nonce: string, notice?: string): string {
  return layout({
    title: 'Sign in',
    nonce,
    body: html`<div class="card">
      <h1>Staff sign-in</h1>
      <p>For Moderators and the 1.5 Leadership Team.</p>
      ${notice ? html`<p>${notice}</p>` : ''}
      <a class="button" href="/dashboard/auth/start">Sign in with Discord</a>
    </div>`,
  });
}

const ERROR_MESSAGES = {
  400: 'This sign-in link expired or was already used. Please sign in again.',
  403: 'This dashboard is only for Moderators and the 1.5 Leadership Team.',
  404: 'There is nothing at this address.',
  429: 'Too many requests. Please wait a minute and try again.',
  500: 'Something went wrong on our end. Please try again.',
  502: 'Discord did not complete the sign-in. Please try again.',
  503: 'The dashboard cannot check your access right now. Please try again in a minute.',
} as const;

/**
 * A logout whose server-side delete timed out: the cookie is cleared, but the
 * session may live on in Redis until it expires. Fixed text only.
 */
export function logoutUnconfirmedPage(nonce: string): string {
  return layout({
    title: 'Sign-out not confirmed',
    nonce,
    body: html`<div class="card">
      <h1>Sign-out not confirmed</h1>
      <p>
        This browser is signed out. The sign-out may not have completed on the
        server.
      </p>
      <p>
        To be sure, sign in again and use "Sign me out everywhere" on the
        Sessions page.
      </p>
      <p><a href="/dashboard/login">Sign in</a></p>
    </div>`,
  });
}

export function errorPage(
  status: keyof typeof ERROR_MESSAGES,
  nonce: string,
): string {
  return layout({
    title: 'Error',
    nonce,
    body: html`<div class="card">
      <h1>${status === 500 ? 'Something went wrong' : 'Unable to continue'}</h1>
      <p>${ERROR_MESSAGES[status]}</p>
      <p><a href="${localUrl(DASHBOARD_BASE)}">Back to the dashboard</a></p>
    </div>`,
  });
}
