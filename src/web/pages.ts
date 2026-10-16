// src/web/pages.ts
import dayjs from 'dayjs';

import { tz } from '../util/timezone.js';
import { SafeHtml, html, memberText } from './html.js';

export interface PageUser {
  username: string;
  csrfToken: string;
}

const STYLE = `
body{font-family:system-ui,sans-serif;margin:0;color:#1f2328;background:#f6f8fa}
header{display:flex;justify-content:space-between;align-items:center;padding:12px 24px;background:#5865F2;color:#fff}
header form{margin:0}
main{max-width:960px;margin:24px auto;padding:0 16px}
button,.button{font:inherit;padding:6px 14px;border-radius:6px;border:1px solid #d0d7de;
background:#fff;color:#1f2328;cursor:pointer;text-decoration:none}
.card{background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:16px;margin-bottom:16px}
`;

export function layout({
  title,
  nonce,
  user,
  body,
}: {
  title: string;
  nonce: string;
  user?: PageUser;
  body: SafeHtml;
}): string {
  const account = user
    ? html`<span>Signed in as ${memberText(user.username)}</span>
        <form method="post" action="/dashboard/logout">
          <input type="hidden" name="_csrf" value="${user.csrfToken}" />
          <button type="submit">Sign out</button>
        </form>`
    : '';
  // prettier-ignore
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title} · 1.5 Gen Asians staff</title>
<style nonce="${nonce}">${new SafeHtml(STYLE)}</style>
</head>
<body>
<header><strong>1.5 Gen Asians staff dashboard</strong>${account}</header>
<main>${body}</main>
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
): string {
  return layout({
    title: 'Home',
    nonce,
    user,
    body: html`<div class="card">
        <h1>Welcome</h1>
        <p>Reports will appear here once the monthly build job is running.</p>
      </div>
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
      <p><a href="/dashboard">Back to the dashboard</a></p>
    </div>`,
  });
}
