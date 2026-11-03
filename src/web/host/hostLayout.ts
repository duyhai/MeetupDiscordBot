import { SafeHtml, html, localUrl, memberText } from '../html.js';
import { STYLE } from '../pages.js';
import { HOST_BASE } from './hostSession.js';

/** The host site's pages, in order. Links and labels are fixed. */
const HOST_NAV_ITEMS = [
  { key: 'home', path: HOST_BASE, label: 'Home' },
  { key: 'calendar', path: `${HOST_BASE}/calendar`, label: 'Calendar' },
  { key: 'history', path: `${HOST_BASE}/history`, label: 'My history' },
] as const;

export type HostNavKey = (typeof HOST_NAV_ITEMS)[number]['key'];

function hostNav(current: HostNavKey | undefined): SafeHtml {
  // prettier-ignore
  const links = HOST_NAV_ITEMS.map((item) => {
    const href = localUrl(item.path);
    return item.key === current
      ? html`<a href="${href}" aria-current="page">${item.label}</a>`
      : html`<a href="${href}">${item.label}</a>`;
  });
  return html`<nav class="site" aria-label="Host pages">
    <div class="tabs">${links}</div>
  </nav>`;
}

/**
 * The host site's page shell: the staff dashboard's stylesheet and
 * structure (skip link, header, tab bar, main), its own brand, nav and
 * sign-out path. Kept apart from the staff `layout` so neither site's nav or
 * sign-out can point at the other.
 */
export function hostLayout({
  title,
  nonce,
  user,
  current,
  body,
}: {
  title: string;
  nonce: string;
  user?: { username: string; csrfToken: string };
  current?: HostNavKey;
  body: SafeHtml;
}): string {
  const account = user
    ? html`<div class="account">
        <span>Signed in as ${memberText(user.username)}</span>
        <form method="post" action="/host/logout">
          <input type="hidden" name="_csrf" value="${user.csrfToken}" />
          <button type="submit" class="ghost">Sign out</button>
        </form>
      </div>`
    : '';
  const nav = user ? hostNav(current) : '';
  // prettier-ignore
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title} · 1.5 Gen Asians hosts</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<a class="skip" href="#main">Skip to main content</a>
<header class="site"><div class="bar"><strong class="brand">1.5 Gen Asians host dashboard</strong>${account}</div></header>
${nav}
<main id="main" tabindex="-1">${body}</main>
</body>
</html>`.value;
}

export function hostLoginPage(
  nonce: string,
  notice?: SafeHtml | string,
): string {
  return hostLayout({
    title: 'Sign in',
    nonce,
    body: html`<div class="card">
      <h1>Host sign-in</h1>
      <p>For members who have hosted an event with us.</p>
      ${notice ? html`<p class="note">${notice}</p>` : ''}
      <div class="actions">
        <a class="button" href="/host/auth/discord/start"
          >Sign in with Discord</a
        >
        <a class="button" href="/host/auth/meetup/start">Sign in with Meetup</a>
      </div>
    </div>`,
  });
}

export const HOST_ERROR_MESSAGES = {
  400: 'This sign-in link expired or was already used. Please sign in again.',
  403: 'The host dashboard is for members who have hosted an event with us.',
  404: 'There is nothing at this address.',
  429: 'Too many requests. Please wait a minute and try again.',
  500: 'Something went wrong on our end. Please try again.',
  502: 'The sign-in did not complete. Please try again.',
  503: 'The host dashboard cannot check your access right now. Please try again in a minute.',
} as const;

export type HostErrorStatus = keyof typeof HOST_ERROR_MESSAGES;

/** Shown instead of the 403 text when a Discord sign-in has no Meetup link. */
export const NOT_LINKED_MESSAGE =
  'Your Discord account is not linked to Meetup yet. Sign in with Meetup instead, or press Verify in our Discord server to link it.';

export function hostErrorPage(
  status: HostErrorStatus,
  nonce: string,
  message: string = HOST_ERROR_MESSAGES[status],
): string {
  return hostLayout({
    title: 'Error',
    nonce,
    body: html`<div class="card">
      <h1>${status === 500 ? 'Something went wrong' : 'Unable to continue'}</h1>
      <p>${message}</p>
      <p><a href="${localUrl('/host/login')}">Back to sign-in</a></p>
    </div>`,
  });
}
