// src/web/pages.ts
import dayjs from 'dayjs';

import {
  DASHBOARD_BASE,
  DASHBOARD_PATHS,
  dashboardPath,
} from '../lib/reports/dashboardPaths.js';
import { tz } from '../util/timezone.js';
import { SafeHtml, html, localUrl, memberText, staticRaw } from './html.js';

export interface PageUser {
  username: string;
  csrfToken: string;
}

/**
 * The one stylesheet (nonce'd; no other CSS, no web fonts). Two-Tone: blurple
 * marks what you can act on, coral what needs a person, green what is done.
 * Light tokens on :root, dark ones under prefers-color-scheme: dark; every
 * text/background pair is checked against WCAG AA in contrast.test.ts.
 */
// prettier-ignore
export const STYLE = staticRaw`
:root{--bg:#f5f5fa;--surface:#ffffff;--raised:#f1f1f8;--fg:#191a24;--muted:#555869;--line:#dedfea;--field:#7c7f93;
--sel:#ebecfb;--accent:#4f5bd5;--btn:#4752c4;--btn-hover:#3940a0;--btn-fg:#ffffff;--focus:#5865f2;--attn:#c9283a;
--attn-soft:#fde3e6;--attn-ink:#9c1c2c;--accent-soft:#e8e9fd;--accent-ink:#3940a0;--ok-soft:#ddf2e5;--ok-ink:#1f693d;
--rule-a:#5865f2;--rule-b:#e8414f;
--font:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
--s1:4px;--s2:8px;--s3:12px;--s4:16px;--s5:24px;--s6:32px;--t-sm:.875rem;--t-base:1rem;--t-lg:1.125rem;--t-xl:1.375rem;
--t-2xl:1.75rem;
--radius:10px;--tap:44px;--width:1040px;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#17181f;--surface:#20212b;--raised:#2a2b37;--fg:#eeeef6;--muted:#a9abbd;
--line:#363847;--field:#7a7d93;--sel:#2f3150;--accent:#8d96ff;--btn:#5865f2;--btn-hover:#4752c4;--btn-fg:#ffffff;
--focus:#a3aaff;--attn:#ff7d88;--attn-soft:#46252c;--attn-ink:#ffbac0;--accent-soft:#30335e;--accent-ink:#cbcffd;
--ok-soft:#203a2b;--ok-ink:#8fd8ab;--rule-a:#7984ff;--rule-b:#ff6b77;color-scheme:dark}}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;font-family:var(--font);font-size:var(--t-base);line-height:1.5;color:var(--fg);background:var(--bg)}
h1{font-size:var(--t-2xl);line-height:1.2;margin:0 0 var(--s3)}
h2{font-size:var(--t-xl);line-height:1.25;margin:0 0 var(--s3)}
h3{font-size:var(--t-lg);line-height:1.3;margin:0 0 var(--s2)}
p,ul,ol{margin:0 0 var(--s3)}
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
color:var(--btn-fg);background:var(--btn);border:1px solid var(--btn);border-radius:8px;cursor:pointer;
transition:transform 150ms ease,background-color 150ms ease}
button:hover,.button:hover{color:var(--btn-fg);background:var(--btn-hover);border-color:var(--btn-hover)}
button:active,.button:active{transform:scale(.97)}
button:disabled{opacity:.6;cursor:not-allowed;transform:none}
.ghost,.secondary,.danger{color:var(--accent);background:transparent;border-color:var(--line)}
.ghost:hover,.secondary:hover{color:var(--accent);background:var(--sel);border-color:var(--field)}
.danger{color:var(--attn)}
.danger:hover{color:var(--attn-ink);background:var(--attn-soft);border-color:var(--attn)}
input,select,textarea{font:inherit;color:var(--fg);background:var(--surface);border:1px solid var(--field);
border-radius:8px;padding:var(--s2) var(--s3);max-width:100%}
input,select{min-height:var(--tap)}
textarea{display:block;width:100%;min-height:var(--tap);margin-top:var(--s1)}
input[type="checkbox"],input[type="radio"]{min-height:0;width:20px;height:20px;accent-color:var(--btn)}
input:focus-visible,select:focus-visible,textarea:focus-visible{outline-offset:1px}
::placeholder{color:var(--muted);opacity:1}
summary{cursor:pointer;padding:10px 0;font-weight:600}
details{margin-top:var(--s2)}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:var(--s2) var(--s3);border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:var(--t-sm);font-weight:600;color:var(--muted)}
.muted{color:var(--muted)}
.badge{display:inline-block;font-size:var(--t-sm);font-weight:600;line-height:1.4;padding:2px var(--s2);
border-radius:999px;color:var(--muted);background:var(--raised);vertical-align:middle;white-space:nowrap}
.badge.neutral{color:var(--muted);background:var(--raised)}
.badge.attn{color:var(--attn-ink);background:var(--attn-soft)}
.badge.info{color:var(--accent-ink);background:var(--accent-soft)}
.badge.ok{color:var(--ok-ink);background:var(--ok-soft)}
.note{color:var(--fg);background:var(--raised);border:1px solid var(--line);border-left:4px solid var(--field);
border-radius:8px;padding:var(--s3) var(--s4);margin:0 0 var(--s3);animation:note-in 200ms ease-out both}
.note.attn{color:var(--attn-ink);background:var(--attn-soft);border-color:var(--attn-soft);
border-left-color:var(--attn)}
.note.info{color:var(--accent-ink);background:var(--accent-soft);border-color:var(--accent-soft);
border-left-color:var(--accent)}
.note a{color:inherit}
@keyframes note-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
textarea.copy{min-height:240px;font-family:var(--mono);font-size:var(--t-sm);line-height:1.5;background:var(--raised)}
svg.chart{max-width:100%;height:auto}
nav.pager{display:flex;flex-wrap:wrap;gap:var(--s1) var(--s2);align-items:center;margin:var(--s3) 0}
nav.pager a,nav.pager strong{display:inline-flex;align-items:center;min-height:var(--tap);padding:0 var(--s2)}
.actions{display:flex;flex-wrap:wrap;gap:var(--s2);align-items:flex-start;margin:var(--s3) 0}
.actions form{margin:0}
.ws-card h2{display:flex;flex-wrap:wrap;align-items:center;gap:var(--s2)}
.ws-card details{border-top:1px solid var(--line);margin-top:var(--s4);padding-top:var(--s2)}
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
  const path = requestPath.split('?')[0].replace(/\/+$/, '');
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
</head>
<body>
<a class="skip" href="#main">Skip to main content</a>
<header class="site"><div class="bar"><strong class="brand">1.5 Gen Asians staff dashboard</strong>${account}</div></header>
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
