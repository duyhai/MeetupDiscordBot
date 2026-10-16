import { RebuildRefusal } from '../../lib/reports/buildJob.js';
import {
  DASHBOARD_PATHS,
  monthPath,
} from '../../lib/reports/dashboardPaths.js';
import { Period } from '../../lib/reports/period.js';
import { SafeHtml, html, localUrl } from '../html.js';

export type RefreshCode = RebuildRefusal | 'started' | 'error' | 'unavailable';

/** Fixed text per code. Nothing from the request or from requestRebuild is ever shown. */
export const REFRESH_MESSAGES = {
  started:
    'Refreshing from Meetup. The result is posted to #meetup-bot-alerts; reload this page in a minute or two.',
  'quiet-hour':
    'Reports are not rebuilt between 17:45 and 19:00 UTC while the daily identity sweep runs. Try again after 19:00 UTC.',
  'identity-sweep':
    'The daily identity sweep is still running. Try again in a few minutes.',
  busy: 'A report build is already running. Try again when it finishes.',
  cooldown:
    'This month was refreshed in the last 10 minutes. Try again in a few minutes.',
  'future-month': 'That month has not started yet.',
  'bad-month': 'That is not a valid month.',
  'bad-requester': 'Only a signed-in staff member can refresh reports.',
  error: 'The refresh could not be started. Please try again later.',
  unavailable: 'Refreshing is unavailable right now. Please try again later.',
} as const satisfies Record<RefreshCode, string>;

export const REFRESH_CODES = Object.keys(REFRESH_MESSAGES) as RefreshCode[];

const isRefreshCode = (code: unknown): code is RefreshCode =>
  typeof code === 'string' && Object.hasOwn(REFRESH_MESSAGES, code);

/** Fixed text for a known code; anything else in the query renders nothing (never echoed). */
export function refreshNotice(code: unknown): SafeHtml | '' {
  return isRefreshCode(code)
    ? html`<p class="note">${REFRESH_MESSAGES[code]}</p>`
    : '';
}

export type RefreshReturn = 'hall-of-fame' | 'no-show-history';

export function refreshForm(
  period: Period,
  csrfToken: string,
  returnTo: RefreshReturn,
): SafeHtml {
  return html`<form
    method="post"
    action="${localUrl(monthPath(DASHBOARD_PATHS.refresh, period))}"
  >
    <input type="hidden" name="_csrf" value="${csrfToken}" />
    <input type="hidden" name="return" value="${returnTo}" />
    <button type="submit">Refresh from Meetup</button>
  </form>`;
}
