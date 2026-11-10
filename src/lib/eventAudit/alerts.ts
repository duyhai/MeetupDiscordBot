import dayjs from 'dayjs';

import { PUBLIC_APP_ORIGIN } from '../../constants.js';
import { tz } from '../../util/timezone.js';
import { LogEntry, alertText } from '../helpers/discordLogger.js';
import { describeBuildError } from '../reports/buildJob.js';
import {
  DASHBOARD_PATHS,
  dashboardPath,
  eventHistoryPath,
} from '../reports/dashboardPaths.js';
import { parseHosts } from '../repositories/postgresEventAuditRepository.js';
import { EventChange, EventChangeKind, EventHost } from './types.js';

/** The kinds leadership is told about; everything else is on the page only. */
export const ALERTABLE_KINDS: readonly EventChangeKind[] = [
  'deleted',
  'cancelled',
  'host_changed',
];
/** More alertable changes than this in one run post one summary instead. */
export const ALERT_CAP = 10;
/** One alert per event and kind in this window. */
export const ALERT_RATE_LIMIT_SEC = 6 * 60 * 60;

export const alertedKey = (eventId: string, kind: EventChangeKind): string =>
  `event-audit-alerted-${eventId}-${kind}`;

const TITLES: Partial<Record<EventChangeKind, string>> = {
  deleted: 'Event deleted',
  cancelled: 'Event cancelled',
  host_changed: 'Event hosts changed',
};

const CHANGES_PAGE = `${PUBLIC_APP_ORIGIN}${dashboardPath(DASHBOARD_PATHS.eventChanges)}`;

function hostList(hosts: EventHost[]): string {
  if (hosts.length === 0) {
    return '(no hosts listed)';
  }
  return hosts
    .map((h) => `${alertText(h.name) || '(no name)'} (${h.id})`)
    .join(', ');
}

const titleText = (title: string): string =>
  alertText(title) || '(untitled event)';

/** 'Dec 5, 2026 7:00 PM' in the group's timezone. */
const startText = (at: Date): string =>
  tz(dayjs(at)).format('MMM D, YYYY h:mm A');

function rsvpText(change: EventChange): string {
  if (change.rsvpYes === null) {
    return 'unknown';
  }
  const waitlist =
    change.waitlist === null ? '' : `, ${change.waitlist} on the waitlist`;
  return `${change.rsvpYes} going${waitlist}`;
}

/** The hosts stored in a change's old or new value, trusted only in the stored shape. */
const valueHosts = (value: unknown): EventHost[] =>
  parseHosts((value as { hosts?: unknown } | null)?.hosts);

/**
 * The plain alert for a deleted, cancelled or host-changed event; undefined
 * for every other kind. Embed text only: titles and names through alertText,
 * links from PUBLIC_APP_ORIGIN and the stored (validated) Meetup URL.
 */
export function changeAlertEntry(change: EventChange): LogEntry | undefined {
  const title = TITLES[change.kind];
  if (title === undefined) {
    return undefined;
  }
  const lines: string[] = [];
  if (change.kind === 'host_changed') {
    lines.push(`Hosts before: ${hostList(valueHosts(change.oldValue))}`);
    lines.push(`Hosts now: ${hostList(valueHosts(change.newValue))}`);
  } else {
    lines.push(`Hosts: ${hostList(change.hosts)}`);
  }
  lines.push(`Start: ${startText(change.startAt)}`);
  lines.push(`RSVPs at the last snapshot: ${rsvpText(change)}`);
  lines.push('Likely actor: one of the hosts above; Meetup does not say who.');
  if (change.kind !== 'deleted' && change.eventUrl !== null) {
    lines.push(`Meetup: ${change.eventUrl}`);
  }
  const history = eventHistoryPath(change.eventId);
  if (history !== undefined) {
    lines.push(`History: ${PUBLIC_APP_ORIGIN}${history}`);
  }
  return {
    title: `${title}: ${titleText(change.title)}`,
    description: lines.join('\n'),
  };
}

/** Posted instead of the individual alerts when one run has more than ALERT_CAP of them. */
export function summaryAlertEntry(count: number): LogEntry {
  return {
    title: `Event changes: ${count} in one pass`,
    description:
      `${count} events were deleted, cancelled or changed hosts in one snapshot pass, ` +
      'which is more than this bot alerts one by one. ' +
      `See the Event changes page: ${CHANGES_PAGE}`,
  };
}

/** Once a day while the snapshot fails. The error by class or HTTP status only. */
export function failureAlertEntry(error: unknown): LogEntry {
  return {
    title: 'Event snapshot failed',
    description:
      `The hourly Meetup event snapshot failed: ${describeBuildError(error)}\n\n` +
      'It retries every 15 minutes (30 minutes after a failure); this alert repeats at most once a day until it works.',
  };
}

/** Once a day while the reader is on the core query. Fixed text. */
export function fallbackAlertEntry(): LogEntry {
  return {
    title: 'Event snapshots are running without RSVP details',
    description:
      'Meetup refused the full audit query, so snapshots are taken with the core one: ' +
      'waitlist counts and the RSVPs-open flag are unknown until the query is fixed. ' +
      'Deletions, cancellations and host changes are still tracked.',
  };
}
