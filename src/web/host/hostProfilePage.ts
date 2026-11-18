/**
 * /host/hosts/<meetupId>: one host's hosting record, for signed-in hosts.
 * Only hosting activity Meetup already shows publicly: events hosted, their
 * attendance, medals and streaks. Nothing a host attended, and no no-show,
 * moderation or request data. From the group snapshot (no Meetup call).
 */
import dayjs from 'dayjs';
import express, { RequestHandler } from 'express';
import { Logger } from 'tslog';

import {
  EVENT_TYPES,
  EVENT_TYPE_LABELS,
  EventType,
  classifyEventType,
} from '../../lib/hosts/eventTypes.js';
import {
  LeaderboardData,
  LeaderboardView,
  streaksFor,
} from '../../lib/leaderboard/leaderboard.js';
import { LeaderboardEvent, Medal } from '../../lib/leaderboard/standings.js';
import type { ProfileEvent } from '../../lib/repositories/postgresSnapshotRepository.js';
import { GUEST_HOST_MEETUP_BLACKLIST } from '../../constants.js';
import { SafeHtml, html, memberText, pageLink } from '../html.js';
import { eventLink } from '../links.js';
import { dateLabel, hostPage } from './hostPageKit.js';
import { MAP_PAGE, hostMap } from './hostMap.js';
import { eventPlaces } from '../../lib/leaderboard/places.js';
import { hostLocals } from './hostRouter.js';
import {
  DAILY_STREAK_ICON,
  LEADERBOARD_PATH,
  WEEKLY_STREAK_ICON,
  emoji,
  medalBadge,
  monthName,
  plural,
  updatedLine,
} from './leaderboardKit.js';

const logger = new Logger({ name: 'hostDashboard' });

export interface HostProfileDeps {
  /**
   * The host's live past events with Meetup's YES + ATTENDED count
   * (Wrapped's number), undefined where the snapshot has none.
   */
  hostedEvents: (meetupId: string) => Promise<ProfileEvent[]>;
  isPromoted: (meetupId: string) => Promise<boolean>;
}

/** Top and recent lists' length. */
export const PROFILE_TOP_EVENTS = 5;
export const PROFILE_RECENT_EVENTS = 10;

const MEETUP_ID = /^[0-9]{1,20}$/;

function card(title: string, body: SafeHtml): SafeHtml {
  return html`<div class="card">
    <h1>${title}</h1>
    ${body}
  </div>`;
}

const notFoundBody = card(
  'No such host',
  html`<p>
    There is no host with hosted events at this address.
    <a href="${pageLink(LEADERBOARD_PATH, {})}">Back to the leaderboard</a>
  </p>`,
);

/**
 * Community Host for a promoted host, else no tier badge: "not promoted" is
 * not "Guest Host" (organizers, moderators and past hosts are not promoted
 * either). Never for an id on the Guest Host blacklist.
 */
export function tierBadge(
  memberId: string,
  promoted: boolean | undefined,
): SafeHtml | '' {
  return promoted === true && !GUEST_HOST_MEETUP_BLACKLIST.includes(memberId)
    ? html`<span class="badge ok">Community Host</span>`
    : '';
}

/** Whether a profile shows its map: never for an id on the Guest Host blacklist. */
export function profileHasMap(memberId: string): boolean {
  return !GUEST_HOST_MEETUP_BLACKLIST.includes(memberId);
}

/** Attendees hosted leaves out events without attendance data; say so. */
function unknownNote(n: number): SafeHtml | '' {
  return n > 0
    ? html`<p class="muted">
        ${`Attendees hosted excludes ${plural(n, 'event')} without attendance data.`}
      </p>`
    : '';
}

/** Unknown attendance (never read from Meetup) shows as a dash. */
function attendanceCell(n: number | undefined): SafeHtml {
  return n === undefined
    ? html`<span title="No attendance data">–</span>`
    : html`${n}`;
}

function eventsTable(events: ProfileEvent[], caption: string): SafeHtml {
  const rows = events.map(
    (e) =>
      html`<tr>
        <td data-label="Date">
          <span class="when">${dateLabel(e.dateTime)}</span>
        </td>
        <td class="event" data-label="Event">${eventLink(e)}</td>
        <td data-label="Attendees">${attendanceCell(e.attendance)}</td>
      </tr>`,
  );
  return html`<table class="stack">
    <caption class="sr-only">
      ${caption}
    </caption>
    <thead>
      <tr>
        <th>Date</th>
        <th>Event</th>
        <th>Attendees</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>`;
}

function medalList(medals: Medal[]): SafeHtml {
  if (medals.length === 0) {
    return html`<p class="muted">No medals yet.</p>`;
  }
  const items = [...medals]
    .sort((a, b) => b.month.localeCompare(a.month) || a.place - b.place)
    .map(
      (m) =>
        html`<li>
          ${medalBadge(m.place, m.month)}
          <a href="${pageLink(LEADERBOARD_PATH, { month: m.month })}"
            >${monthName(m.month)}</a
          >
          <span class="muted">· ${plural(m.events, 'event')}</span>
        </li>`,
    );
  return html`<ul>
    ${items}
  </ul>`;
}

function typeList(events: LeaderboardEvent[]): SafeHtml {
  const counts = new Map<EventType, number>();
  events.forEach((e) => {
    const type = classifyEventType(e.title);
    counts.set(type, (counts.get(type) ?? 0) + 1);
  });
  const items = EVENT_TYPES.filter((t) => (counts.get(t) ?? 0) > 0)
    .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))
    .map(
      (t) =>
        html`<li>
          ${`${EVENT_TYPE_LABELS[t]}: ${plural(counts.get(t) ?? 0, 'event')}`}
        </li>`,
    );
  return html`<ul>
    ${items}
  </ul>`;
}

export function profileBody(
  data: LeaderboardView,
  memberId: string,
  selfId: string,
  hosted: ProfileEvent[],
  promoted: boolean | undefined,
): SafeHtml {
  const name = data.names.get(memberId);
  // Counts come from the Leaderboard's own counted events, so the two pages
  // always agree; the attendance rows are only for sums and lists.
  const countedEvents = data.byHost.get(memberId) ?? [];
  const counted = new Set(countedEvents.map((e) => e.id));
  const newestFirst = (a: ProfileEvent, b: ProfileEvent) =>
    dayjs(b.dateTime).valueOf() - dayjs(a.dateTime).valueOf();
  const events = hosted.filter((e) => counted.has(e.id)).sort(newestFirst);
  const known = events.filter(
    (e): e is ProfileEvent & { attendance: number } =>
      e.attendance !== undefined,
  );
  const attendees = known.reduce((sum, e) => sum + e.attendance, 0);
  const medals = data.medals.filter((m) => m.memberId === memberId);
  const streaks = streaksFor(data, memberId);
  // Ties in attendance: the more recent event first.
  const top = [...known]
    .sort((a, b) => b.attendance - a.attendance || newestFirst(a, b))
    .slice(0, PROFILE_TOP_EVENTS);
  // No profile map for an id on the Guest Host blacklist until Hai decides.
  const showMap = profileHasMap(memberId);
  const you =
    memberId === selfId ? html` <span class="badge info">You</span>` : '';
  return html`<div class="card">
      <p>
        <a href="${pageLink(LEADERBOARD_PATH, { view: 'all' })}"
          >← Hall of fame</a
        >
      </p>
      <h1>${name ? memberText(name) : 'Unnamed host'}${you}</h1>
      <p>${tierBadge(memberId, promoted)}</p>
      <dl class="stats profile">
        <div class="stat">
          <dt>Events hosted</dt>
          <dd>${countedEvents.length}</dd>
        </div>
        <div class="stat">
          <dt>Attendees hosted</dt>
          <dd>${attendees}</dd>
        </div>
        <div class="stat">
          <dt>Medals</dt>
          <dd>${medals.length}</dd>
        </div>
        <div class="stat">
          <dt>${emoji(WEEKLY_STREAK_ICON, 'Weekly streak')} Weekly streak</dt>
          <dd>
            ${plural(streaks.weekly.current, 'week')}
            <span class="muted streak-best"
              >${`Best: ${plural(streaks.weekly.best, 'week')}`}</span
            >
          </dd>
        </div>
        <div class="stat">
          <dt>${emoji(DAILY_STREAK_ICON, 'Daily streak')} Daily streak</dt>
          <dd>
            ${plural(streaks.daily.current, 'day')}
            <span class="muted streak-best"
              >${`Best: ${plural(streaks.daily.best, 'day')}`}</span
            >
          </dd>
        </div>
      </dl>
      <p class="muted">
        Attendees are the RSVPs Meetup lists as going or attended, the number
        Wrapped uses. Only hosting activity is shown here.
      </p>
      ${unknownNote(countedEvents.length - known.length)} ${updatedLine(data)}
    </div>
    <div class="card">
      <h2>Medals</h2>
      ${medalList(medals)}
      <h2>Event types</h2>
      ${typeList(countedEvents)}
      <p class="muted">Types are guessed from event titles.</p>
    </div>
    ${
      showMap
        ? html`<div class="card">
            <h2>Where they've hosted</h2>
            ${hostMap(eventPlaces(countedEvents), name ? `${name} has` : 'this host has')}
          </div>`
        : ''
    }
    <div class="card">
      <h2>Top events</h2>
      <p class="muted">
        By attendees, all time. Events without attendance data are left out.
      </p>
      ${eventsTable(top, 'Top events by attendees')}
    </div>
    <div class="card">
      <h2>Recent events</h2>
      ${eventsTable(
        events.slice(0, PROFILE_RECENT_EVENTS),
        'Most recent hosted events',
      )}
    </div>`;
}

/** The profile route, on the Leaderboard's loader (its cache and medals). */
export function registerHostProfile(
  router: express.Router,
  load: () => Promise<LeaderboardData>,
  deps: HostProfileDeps,
): void {
  router.get('/hosts/:memberId', (async (req, res) => {
    const { session } = hostLocals(res);
    // Members never reach here: the router keeps them to MEMBER_PATHS.
    const { memberId } = req.params;
    if (!MEETUP_ID.test(memberId)) {
      hostPage(res, {
        title: 'Not found',
        current: 'leaderboard',
        status: 404,
        body: notFoundBody,
      });
      return;
    }
    let data: LeaderboardData;
    let hosted: ProfileEvent[];
    try {
      data = await load();
      hosted =
        data.ready && data.byHost.has(memberId)
          ? await deps.hostedEvents(memberId)
          : [];
    } catch (error: unknown) {
      logger.warn(
        `Host profile read failed: ${error instanceof Error ? error.name : 'Error'}`,
      );
      hostPage(res, {
        title: 'Unavailable',
        current: 'leaderboard',
        status: 503,
        body: card(
          'Unavailable',
          html`<p>
            This profile cannot be loaded right now. Please try again in a
            minute.
          </p>`,
        ),
      });
      return;
    }
    if (!data.ready) {
      hostPage(res, {
        title: 'Host profile',
        current: 'leaderboard',
        body: card(
          'Host profile',
          html`<p>
            Profiles are still being built from the group's event history.
            Please check back in a few hours.
          </p>`,
        ),
      });
      return;
    }
    if (!data.byHost.has(memberId)) {
      hostPage(res, {
        title: 'Not found',
        current: 'leaderboard',
        status: 404,
        body: notFoundBody,
      });
      return;
    }
    let promoted: boolean | undefined;
    try {
      promoted = await deps.isPromoted(memberId);
    } catch (error: unknown) {
      // The badge is extra: the profile shows without it.
      logger.warn(
        `Promoted check failed: ${error instanceof Error ? error.name : 'Error'}`,
      );
    }
    const name = data.names.get(memberId);
    hostPage(res, {
      title: name ? `${name} · Host profile` : 'Host profile',
      current: 'leaderboard',
      body: profileBody(data, memberId, session.userId, hosted, promoted),
      ...(profileHasMap(memberId) ? MAP_PAGE : {}),
    });
  }) as RequestHandler);
}
