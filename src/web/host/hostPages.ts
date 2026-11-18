import dayjs from 'dayjs';
import express, { RequestHandler } from 'express';
import { Logger } from 'tslog';

import {
  EVENT_TYPES,
  EVENT_TYPE_LABELS,
  EventType,
  isEventType,
} from '../../lib/hosts/eventTypes.js';
import {
  CalendarDay,
  HostEvent,
  HostEventsDeps,
  attendanceUrl,
  countedOnly,
  groupCalendar,
  monthCalendar,
  hostedEvents,
  pacificDay,
} from '../../lib/hosts/hostEvents.js';
import { MAX_DAYS_AHEAD } from '../../lib/hosts/eventRequest.js';
import { matchHolidays } from '../../lib/hosts/holidays.js';
import { hostedExclusion } from '../../lib/helpers/countedEvents.js';
import {
  SafeHtml,
  html,
  localUrl,
  meetupPhotoSrc,
  memberText,
  pageLink,
  safeHref,
  yearAnchor,
  yearTarget,
} from '../html.js';
import { eventLink } from '../links.js';
import {
  AnnounceRouteDeps,
  announceBadge,
  announceButton,
  announceGuidelines,
  announceNotice,
  recreateOffer,
  registerAnnounceRoute,
  tooLateEvent,
} from './announcePage.js';
import { Recreatable } from '../../lib/hosts/recreateEvent.js';
import { heatMapYear } from './heatMap.js';
import { HOST_LINK_RESULTS, HostLinkResult, hostLocals } from './hostRouter.js';
import { EventRequest } from '../../lib/repositories/postgresEventRequestRepository.js';
import { Announcement } from '../../lib/repositories/postgresEventAnnouncementRepository.js';
import {
  HostRequestStore,
  copyLink,
  createDayLink,
  requestsCard,
} from './createPage.js';
import {
  dateLabel,
  dayLabel,
  hostPage,
  timeLabel,
  unavailable,
} from './hostPageKit.js';
import {
  CALENDAR_SCRIPT,
  HISTORY_SCRIPT,
  TIMELINE_SCRIPT,
} from './hostScripts.js';
import { COPY_ICON, LIST_ICON, MEETUP_MARK, TILES_ICON } from '../ui/icons.js';
import { HOST_BASE, HostSession } from './hostSession.js';

const logger = new Logger({ name: 'hostDashboard' });

export interface HostPageDeps {
  events: HostEventsDeps;
  /** The host's requests for the home page; a failure hides only that card. */
  requests?: () => Promise<Pick<HostRequestStore, 'listForMember'>>;
  /** The Announce button and its route; without it, no button. */
  announce?: AnnounceRouteDeps;
}

export const HOST_PATHS = {
  calendar: `${HOST_BASE}/calendar`,
  history: `${HOST_BASE}/history`,
} as const;

const CREATE_PAGE = `${HOST_BASE}/create`;
const WRAPPED_PAGE = `${HOST_BASE}/wrapped`;
/** How many of the host's requests the home page lists. */
const HOME_REQUESTS_SHOWN = 10;

/** How many quiet days the home page suggests. */
const QUIET_DAYS_SHOWN = 5;
const QUIET_WINDOW_DAYS = 14;

/**
 * Who they are here, as pills: Leadership and Organizer when they hold
 * those Discord roles, Community Host when promoted; otherwise Guest Host.
 */
function tierBadge(session: HostSession): SafeHtml {
  const staff = session.staffRoles ?? [];
  const badges: SafeHtml[] = [];
  if (staff.includes('leadership')) {
    badges.push(html`<span class="badge ok">Leadership</span>`);
  }
  if (staff.includes('organizer')) {
    badges.push(html`<span class="badge ok">Organizer</span>`);
  }
  if (session.tier === 'promoted') {
    badges.push(html`<span class="badge ok">Community Host</span>`);
  }
  if (badges.length === 0) {
    badges.push(html`<span class="badge neutral">Guest Host</span>`);
  }
  const [first, ...rest] = badges;
  return html`${first}${rest.map((badge) => html` ${badge}`)}`;
}

/** The event on Meetup: the Meetup mark and the words. */
function meetupButton(event: HostEvent): SafeHtml {
  const href = safeHref(event.eventUrl);
  return href
    ? html`<a
        class="button ghost"
        href="${href}"
        rel="noopener noreferrer"
        target="_blank"
        >${MEETUP_MARK}<span>View on Meetup</span></a
      >`
    : html``;
}

/** The one action with words: "Take attendance" by the Meetup mark (read as "… on Meetup"). */
function attendanceButton(event: HostEvent): SafeHtml {
  const url = attendanceUrl(event.eventUrl);
  const href = url ? safeHref(url) : undefined;
  return href
    ? html`<a
        class="button ghost"
        href="${href}"
        rel="noopener noreferrer"
        target="_blank"
        title="Take attendance on Meetup"
        >${MEETUP_MARK}<span>Take attendance</span
        ><span class="sr-only"> on Meetup</span></a
      >`
    : html``;
}

/** A new request from this event's details: the copy icon alone. */
function copyButton(event: HostEvent): SafeHtml {
  return html`<a
    class="button ghost icon-only"
    href="${copyLink(event.id)}"
    aria-label="Copy this event"
    title="Copy this event"
    >${COPY_ICON}</a
  >`;
}

/** Days with no group event in the next two weeks, from today (Pacific). */
function quietDays(days: CalendarDay[], today: string): CalendarDay[] {
  // From tomorrow: today's finished events are no longer published, so
  // today can look quiet when it was not.
  const first = dayjs(today).add(1, 'day').format('YYYY-MM-DD');
  const last = dayjs(today).add(QUIET_WINDOW_DAYS, 'day').format('YYYY-MM-DD');
  return days.filter((d) => d.day >= first && d.day <= last && d.busy === 0);
}

/** The holidays a day's event titles name, each once. */
const holidaysOn = (events: HostEvent[]): string[] => [
  ...new Set(events.flatMap((e) => matchHolidays(e.title))),
];

const LINK_DISCORD_PATH = `${HOST_BASE}/link/discord`;

/** The fixed text for each `?link=` result; the code itself is never shown. */
const LINK_NOTICES: Record<HostLinkResult, { ok: boolean; text: string }> = {
  linked: {
    ok: true,
    text: 'Your Meetup and Discord accounts are now linked.',
  },
  already: { ok: true, text: 'Your Discord account was already linked.' },
  cancelled: { ok: false, text: 'Linking was cancelled. Nothing was changed.' },
  'meetup-taken': {
    ok: false,
    text:
      'Your Meetup account is already linked to a different Discord account, so ' +
      'nothing was changed. If that is not right, please contact the moderators.',
  },
  'discord-taken': {
    ok: false,
    text:
      'That Discord account is already linked to a different Meetup account, so ' +
      'nothing was changed. If that is not right, please contact the moderators.',
  },
  error: {
    ok: false,
    text: 'Linking did not work this time, and nothing was changed. Please try again in a minute.',
  },
};

function linkNotice(code: HostLinkResult): SafeHtml {
  const { ok, text } = LINK_NOTICES[code];
  return ok
    ? html`<p class="note info">${text}</p>`
    : html`<p class="note attn">${text}</p>`;
}

/** A `?link=` code, or undefined for anything else. */
function linkResultOf(value: unknown): HostLinkResult | undefined {
  return (HOST_LINK_RESULTS as readonly unknown[]).includes(value)
    ? (value as HostLinkResult)
    : undefined;
}

function homeBody(
  session: HostSession,
  upcoming: HostEvent[],
  calendar: CalendarDay[],
  today: string,
  requests: EventRequest[] | undefined,
  extra: {
    linkResult?: HostLinkResult;
    /** Each upcoming event's announcement; undefined: no Announce button. */
    announcements?: Map<string, Announcement>;
    announceResult?: unknown;
    /** After a too-late refusal: the event, and whether it may be recreated. */
    tooLate?: { eventId: string; offer: Recreatable | undefined };
    now?: Date;
  } = {},
): SafeHtml {
  const { linkResult, announcements } = extra;
  const now = extra.now ?? new Date();
  const quiet = quietDays(calendar, today).slice(0, QUIET_DAYS_SHOWN);
  // "Verify on Discord": the same Verify as the button in the server, and
  // once linked, "Refresh roles and badges" runs it again. Only for a
  // Meetup sign-in: a Discord sign-in whose link was removed since carries
  // a Discord name, not a Meetup one.
  const verifyForm = (label: string) =>
    html`<form method="post" action="${localUrl(LINK_DISCORD_PATH)}">
      <input type="hidden" name="_csrf" value="${session.csrfToken}" />
      <button type="submit">${label}</button>
    </form>`;
  let linkNudge: SafeHtml | '' = '';
  if (session.via === 'meetup' && session.discordUserId === null) {
    linkNudge = html`<div class="note info">
      <p>
        Your Meetup account is not linked to Discord yet. Verifying is optional:
        it links the two, adds you to our Discord server if you are not in it,
        and gives you the same roles and badges as pressing Verify in our
        Discord server.
      </p>
      ${verifyForm('Verify on Discord')}
    </div>`;
  } else if (session.via === 'meetup') {
    linkNudge = html`<div class="note info">
      <p>
        Re-run Verify to update your Guest Host role and badges from your Meetup
        activity.
      </p>
      ${verifyForm('Refresh roles and badges')}
    </div>`;
  }
  const notice = linkResult ? linkNotice(linkResult) : '';
  const rows = upcoming.map(
    (event) =>
      html`<tr>
          <td data-label="Date">
            <span class="when">${dateLabel(event.dateTime)},</span>
            <span class="when">${timeLabel(event.dateTime)}</span>
          </td>
          <td class="event" data-label="Event">
            ${eventLink(event)}${excludedBadge(event)}
          </td>
          <td class="type" data-label="Type">
            ${EVENT_TYPE_LABELS[event.type]}
          </td>
          <td class="status" data-label="Status">
            <span class="badge ok">Published</span>
            ${
              announcements
                ? announceBadge(announcements.get(event.id), now)
                : ''
            }
          </td>
          <td class="buttons" data-label="Actions">
            <div class="actions row">
              ${meetupButton(event)}
              ${
                announcements
                  ? announceButton(
                      event,
                      announcements.get(event.id),
                      session.csrfToken,
                      now,
                    )
                  : ''
              }
            </div>
          </td>
        </tr>
        ${
          extra.tooLate?.eventId === event.id
            ? html`<tr class="offer-row">
                <td colspan="5">
                  ${recreateOffer(event, extra.tooLate.offer)}
                </td>
              </tr>`
            : ''
        }`,
  );
  return html`<div class="card">
      <h1>Hi, ${memberText(session.username)}</h1>
      <p>${tierBadge(session)}</p>
      ${notice} ${linkNudge}
      <div class="actions">
        <a class="button" href="${pageLink(CREATE_PAGE)}">Host an event</a>
        <a class="button ghost" href="${pageLink(WRAPPED_PAGE)}"
          >Your Wrapped</a
        >
      </div>
    </div>
    ${requestsCard(requests)}
    <div class="card">
      <h2>Your upcoming events</h2>
      ${announceNotice(extra.announceResult)}
      ${
        announcements && upcoming.length > 0
          ? html`<p class="muted">
                Announce sends Meetup's announcement email about your event to
                the group. It goes out once per event. A request made 10–4
                Mon–Fri waits until 4 pm; the time is shown by the event, and
                you can cancel it until then.
              </p>
              ${announceGuidelines()}`
          : ''
      }
      ${
        upcoming.length === 0
          ? html`<p class="muted">You have no upcoming events on Meetup.</p>`
          : html`<table class="stack upcoming">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Event</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${rows}
              </tbody>
            </table>`
      }
    </div>
    <div class="card">
      <h2>Picking a day</h2>
      ${
        quiet.length === 0
          ? html`<p>Every day in the next two weeks already has an event.</p>`
          : html`<p>Quiet days in the next two weeks:</p>
              <ul>
                ${quiet.map(
                  (d) =>
                    html`<li>
                      <a href="${createDayLink(d.day)}">${dayLabel(d.day)}</a>
                    </li>`,
                )}
              </ul>`
      }
      <div class="actions">
        <a class="button" href="${pageLink(HOST_PATHS.calendar)}"
          >Open the calendar</a
        >
        <a class="button ghost" href="${pageLink(HOST_PATHS.history)}"
          >My hosting history</a
        >
      </div>
    </div>`;
}

/**
 * A member who has never hosted (Wrapped addendum): one card, their Wrapped
 * and their link status. No host features, no Meetup read. A member is
 * linked by definition, so the only Verify offer is the refresh, and only
 * for a Meetup sign-in (the same rule as a host's).
 */
function memberBody(
  session: HostSession,
  linkResult: HostLinkResult | undefined,
): SafeHtml {
  const refresh =
    session.via === 'meetup'
      ? html`<div class="note info">
          <p>
            Your Meetup account is linked to Discord. Re-run Verify to update
            your roles and badges from your Meetup activity.
          </p>
          <form method="post" action="${localUrl(LINK_DISCORD_PATH)}">
            <input type="hidden" name="_csrf" value="${session.csrfToken}" />
            <button type="submit">Refresh roles and badges</button>
          </form>
        </div>`
      : html`<p class="muted">Your Meetup account is linked to Discord.</p>`;
  return html`<div class="card">
    <h1>Hi, ${memberText(session.username)}</h1>
    ${linkResult ? linkNotice(linkResult) : ''}
    <p>
      Your 1.5 Gen Wrapped is your year with the group: your first event, events
      this year, top activities, busiest month and who you went with.
    </p>
    <div class="actions">
      <a class="button" href="${pageLink(WRAPPED_PAGE)}">Your Wrapped</a>
    </div>
    ${refresh}
  </div>`;
}

/** The title link and any holiday badges the title names. */
function eventTitle(e: HostEvent): SafeHtml {
  return html`${eventLink(e)}${matchHolidays(e.title).map(
    (name) => html` <span class="badge info">${name}</span>`,
  )}`;
}

/** "hosted by A, B", or nothing when Meetup lists no host. */
function hostedBy(e: HostEvent): SafeHtml | '' {
  return e.hosts.length
    ? html`<span class="muted"
        >hosted by
        ${e.hosts.map((h, i) => html`${i ? ', ' : ''}${memberText(h.name)}`)}</span
      >`
    : '';
}

/** One event as a line: time, title link, holiday badges, hosts. */
function eventLine(e: HostEvent): SafeHtml {
  const hosts = hostedBy(e);
  return html`${timeLabel(e.dateTime)}:
  ${eventTitle(e)}${hosts ? html` ${hosts}` : ''}`;
}

/**
 * The event's Meetup photo as a 48px square beside it in the day-by-day
 * list: lazy, fixed size (no layout shift), empty alt (the title is next
 * to it). Only an https URL on Meetup's photo host is used (meetupPhotoSrc);
 * anything else, or no photo, is a neutral placeholder of the same size.
 */
function eventThumb(e: HostEvent): SafeHtml {
  const src = meetupPhotoSrc(e.photoUrl);
  return src
    ? html`<img
        class="ev-thumb"
        src="${src}"
        alt=""
        width="48"
        height="48"
        loading="lazy"
        decoding="async"
        referrerpolicy="no-referrer"
      />`
    : html`<span class="ev-thumb ev-thumb-none" aria-hidden="true"></span>`;
}

/**
 * One event as a tile: its photo in a fixed 2:1 box on top, then time,
 * title link and hosts. The width and height attributes give the box its
 * ratio before the photo loads, so nothing shifts; CSS crops it
 * (object-fit: cover, a little above centre, where faces and signs
 * usually are) over the placeholder pattern, which shows through if the
 * photo fails to load. With no standard rendition the box is the
 * placeholder, with the 80px thumbnail at its own size in the middle
 * (never stretched) when there is one. The title link's text is the same
 * as in the list. Only Meetup's photo host is used (meetupPhotoSrc).
 */
function eventTile(e: HostEvent): SafeHtml {
  const src = meetupPhotoSrc(e.tilePhotoUrl);
  const thumb = meetupPhotoSrc(e.photoUrl);
  const small = thumb
    ? html`<img
        class="tile-thumb"
        src="${thumb}"
        alt=""
        width="80"
        height="80"
        loading="lazy"
        decoding="async"
        referrerpolicy="no-referrer"
      />`
    : '';
  const photo = src
    ? html`<img
        class="tile-photo"
        src="${src}"
        alt=""
        width="600"
        height="300"
        loading="lazy"
        decoding="async"
        referrerpolicy="no-referrer"
      />`
    : html`<span class="tile-photo tile-photo-none" aria-hidden="true"
        >${small}</span
      >`;
  return html`<li class="cal-tile">
    ${photo}
    <div class="tile-body">
      <p class="tile-time">${timeLabel(e.dateTime)}</p>
      <p class="tile-title">${eventTitle(e)}</p>
      ${hostedBy(e)}
    </div>
  </li>`;
}

/**
 * A day's popover: a <details> whose <summary> (the count) opens it with a
 * click, a tap, Enter or Space, with no script. CALENDAR_SCRIPT adds
 * hover, one-open-at-a-time, Escape, tap-outside and placement. It lists
 * every event that day, not just what the cell has room for.
 */
/**
 * Whether the create form takes this day: from tomorrow to MAX_DAYS_AHEAD
 * days on (the calendar pages a little further than that).
 */
function canHostOn(day: string, today: string): boolean {
  const last = dayjs(today).add(MAX_DAYS_AHEAD, 'day').format('YYYY-MM-DD');
  return day > today && day <= last;
}

function dayPopover(day: CalendarDay, today: string): SafeHtml {
  const count = day.events.length;
  const countText =
    count === 0 ? 'Free' : count === 1 ? '1 event' : `${count} events`;
  const holidays = holidaysOn(day.events);
  const label = dayLabel(day.day);
  const events =
    count === 0
      ? html`<p class="muted">No events yet.</p>`
      : html`<ul>
          ${day.events.map((e) => html`<li>${eventLine(e)}</li>`)}
        </ul>`;
  const host = canHostOn(day.day, today)
    ? html`<p><a href="${createDayLink(day.day)}">Host on this day</a></p>`
    : '';
  return html`<details class="cal-pop">
    <summary>
      <span class="sr-only">${label}: </span
      ><span class="cal-count">${countText}</span>${
        holidays.length
          ? html`<span class="cal-date">${holidays.join(', ')}</span>`
          : ''
      }
    </summary>
    <div class="cal-panel" role="group" aria-label="${label}">
      <p class="cal-panel-title">${label}</p>
      ${events} ${host}
    </div>
  </details>`;
}

/**
 * One calendar cell. The busy class is one of four literals; the count is
 * also text, so the shading is never the only signal. From tomorrow, a +
 * link opens the create form for that day; the day number is plain text.
 */
function calendarCell(day: CalendarDay, today: string): SafeHtml {
  const dayText = dayjs(day.day).format(
    day.day.endsWith('-01') ? 'MMM D' : 'D',
  );
  const number = html`<span class="cal-day">${dayText}</span>`;
  if (day.day < today) {
    // What already happened, greyed out: no busy shading (it is not a
    // choice any more) and no +.
    return day.events.length === 0
      ? html`<td class="cal past">${number}</td>`
      : html`<td class="cal past">
          <div class="cal-head">${number}</div>
          ${dayPopover(day, today)}
        </td>`;
  }
  const add = canHostOn(day.day, today)
    ? html`<a
        class="cal-add"
        href="${createDayLink(day.day)}"
        aria-label="Host an event on ${dayLabel(day.day)}"
        >+</a
      >`
    : '';
  const inner = html`<div class="cal-head">${number}${add}</div>
    ${dayPopover(day, today)}`;
  switch (day.busy) {
    case 0:
      return html`<td class="cal busy0">${inner}</td>`;
    case 1:
      return html`<td class="cal busy1">${inner}</td>`;
    case 2:
      return html`<td class="cal busy2">${inner}</td>`;
    default:
      return html`<td class="cal busy3">${inner}</td>`;
  }
}

/** How many months ahead the calendar pages (the form takes a year ahead). */
export const CALENDAR_MONTHS_AHEAD = 12;

/** `?month=YYYY-MM` when it is this month or up to a year on; else this month. */
export function calendarMonth(query: unknown, today: string): string {
  const current = today.slice(0, 7);
  if (typeof query !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(query)) {
    return current;
  }
  const last = dayjs(`${current}-01`)
    .add(CALENDAR_MONTHS_AHEAD, 'month')
    .format('YYYY-MM');
  return query >= current && query <= last ? query : current;
}

/** Day by day's tabs: the days still to come (today on), or those gone. */
export type CalendarTab = 'upcoming' | 'past';
/** Day by day's layout: photo tiles, or compact rows with thumbnails. */
export type CalendarView = 'tiles' | 'list';

/** `?tab=past`, else Upcoming. */
export function calendarTab(query: unknown): CalendarTab {
  return query === 'past' ? 'past' : 'upcoming';
}

/** `?view=list`, else Tiles. */
export function calendarView(query: unknown): CalendarView {
  return query === 'list' ? 'list' : 'tiles';
}

/**
 * A calendar link. The view is always spelled out, so the calendar's own
 * links keep it (CALENDAR_VIEW_SCRIPT only rewrites links to the bare
 * calendar); Upcoming, the default tab, is left out.
 */
function calendarLink(to: {
  month: string;
  tab: CalendarTab;
  view: CalendarView;
}): ReturnType<typeof pageLink> {
  return pageLink(HOST_PATHS.calendar, {
    month: to.month,
    tab: to.tab === 'past' ? 'past' : undefined,
    view: to.view,
  });
}

/**
 * The pager choices: the current one is aria-current text, the others
 * links. Labels and keys are literals from the callers.
 */
function choices<K extends string>(
  label: string,
  options: readonly { key: K; label: string }[],
  current: K,
  href: (key: K) => ReturnType<typeof pageLink>,
  unavailable?: { key: K; why: string },
): SafeHtml {
  const items = options.map((o) => {
    if (o.key === current) {
      return html`<strong aria-current="page">${o.label}</strong>`;
    }
    if (o.key === unavailable?.key) {
      return html`<span
        >${o.label}<span class="sr-only"> (${unavailable.why})</span></span
      >`;
    }
    return html`<a href="${href(o.key)}">${o.label}</a>`;
  });
  return html`<nav class="pager choices" aria-label="${label}">${items}</nav>`;
}

const CALENDAR_TABS = [
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'past', label: 'Past' },
] as const;
const CALENDAR_VIEWS = [
  { key: 'tiles', label: 'Tiles' },
  { key: 'list', label: 'List' },
] as const;

/**
 * The Layout switch: an icon button per view, the same links as before
 * (CALENDAR_VIEW_SCRIPT listens on [data-cal-views] a). The current one is
 * aria-current text, named by hidden text; the other is a link named by
 * aria-label. Both carry a title, the tooltip. The nav's aria-label names
 * the group.
 */
function viewSwitch(
  month: string,
  tab: CalendarTab,
  view: CalendarView,
): SafeHtml {
  const items = CALENDAR_VIEWS.map((o) => {
    const icon = o.key === 'tiles' ? TILES_ICON : LIST_ICON;
    if (o.key === view) {
      return html`<strong
        class="button ghost icon-only"
        aria-current="page"
        title="${o.label}"
        >${icon}<span class="sr-only">${o.label}</span></strong
      >`;
    }
    return html`<a
      class="button ghost icon-only"
      href="${calendarLink({ month, tab, view: o.key })}"
      aria-label="${o.label}"
      title="${o.label}"
      >${icon}</a
    >`;
  });
  return html`<nav
    class="pager choices view-switch"
    aria-label="Layout"
    data-cal-views
  >
    ${items}
  </nav>`;
}

/**
 * One day of the day-by-day list, as rows or tiles. The tabs split past
 * from upcoming, so a day needs no Past badge.
 */
function dayEntry(d: CalendarDay, today: string, view: CalendarView): SafeHtml {
  const events =
    view === 'tiles'
      ? html`<ul class="cal-tiles">
          ${d.events.map((e) => eventTile(e))}
        </ul>`
      : html`<ul class="cal-items">
          ${d.events.map(
            (e) =>
              html`<li>
                ${eventThumb(e)}<span class="cal-item-text"
                  >${eventLine(e)}</span
                >
              </li>`,
          )}
        </ul>`;
  return html`<li>
    <h3>${dayLabel(d.day)}</h3>
    ${
      d.day > today
        ? html`<p>
            <a href="${createDayLink(d.day)}">Host on this day</a>
          </p>`
        : ''
    }
    ${events}
  </li>`;
}

/**
 * Day by day: Upcoming (today on, in order) or Past (the month's earlier
 * days, most recent first), as tiles or a list. Both are links with the
 * month and the other choice kept, so they work without script.
 */
function dayByDay(
  days: CalendarDay[],
  today: string,
  month: string,
  asked: CalendarTab,
  view: CalendarView,
): SafeHtml {
  // A month none of whose days have passed (a future one) has no Past
  // tab: it is plain text, and ?tab=past shows Upcoming.
  const hasPast = `${month}-01` < today;
  const tab = hasPast ? asked : 'upcoming';
  const listed = days.filter(
    (d) => d.day.startsWith(month) && d.events.length > 0,
  );
  const shown =
    tab === 'past'
      ? listed.filter((d) => d.day < today).reverse()
      : listed.filter((d) => d.day >= today);
  const current = today.slice(0, 7);
  const empty =
    tab === 'past'
      ? 'Nothing happened earlier this month.'
      : month === current
        ? 'Nothing more is scheduled this month yet.'
        : 'Nothing scheduled this month yet.';
  return html`<div class="card">
    <h2>Day by day: ${dayjs(`${month}-01`).format('MMMM')}</h2>
    <div class="cal-bar">
      ${choices(
        'Which days',
        CALENDAR_TABS,
        tab,
        (key) => calendarLink({ month, tab: key, view }),
        hasPast ? undefined : { key: 'past', why: 'no days have passed yet' },
      )}
      ${viewSwitch(month, tab, view)}
    </div>
    ${
      shown.length === 0
        ? html`<p class="muted">${empty}</p>`
        : html`<ol class="cal-list">
            ${shown.map((d) => dayEntry(d, today, view))}
          </ol>`
    }
  </div>`;
}

/** Previous and next month; each is disabled text at the ends. */
function monthNav(month: string, today: string, view: CalendarView): SafeHtml {
  const first = dayjs(`${month}-01`);
  const prev = first.subtract(1, 'month');
  const next = first.add(1, 'month');
  const current = today.slice(0, 7);
  const last = dayjs(`${current}-01`)
    .add(CALENDAR_MONTHS_AHEAD, 'month')
    .format('YYYY-MM');
  const link = (m: dayjs.Dayjs) =>
    calendarLink({ month: m.format('YYYY-MM'), tab: 'upcoming', view });
  const prevPart =
    month > current
      ? html`<a class="button ghost" href="${link(prev)}"
          >← ${prev.format('MMM')}</a
        >`
      : html`<span class="button ghost disabled"
          >← ${prev.format('MMM')}<span class="sr-only">
            (past months are not shown)</span
          ></span
        >`;
  const nextPart =
    month < last
      ? html`<a class="button ghost" href="${link(next)}"
          >${next.format('MMM')} →</a
        >`
      : html`<span class="button ghost disabled"
          >${next.format('MMM')} →<span class="sr-only">
            (too far ahead)</span
          ></span
        >`;
  return html`<nav class="year-nav" aria-label="Month">
    ${prevPart}<strong>${first.format('MMMM YYYY')}</strong>${nextPart}
  </nav>`;
}

function calendarBody(
  days: CalendarDay[],
  today: string,
  month: string,
  tab: CalendarTab,
  view: CalendarView,
): SafeHtml {
  const weeks: CalendarDay[][] = [];
  for (let i = 0; i < days.length; i += 7) {
    weeks.push(days.slice(i, i + 7));
  }
  const inMonth = (d: CalendarDay) => d.day.startsWith(month);
  // Days of the months around it are left blank.
  const monthCell = (d: CalendarDay): SafeHtml => {
    if (inMonth(d)) {
      return calendarCell(d, today);
    }
    return html`<td class="cal out" aria-hidden="true"></td>`;
  };
  const grid = weeks.map(
    (week) =>
      html`<tr>
        ${week.map((d) => monthCell(d))}
      </tr>`,
  );
  return html`<div class="card">
      <h1>Calendar</h1>
      <p>
        The group's published events, a month at a time. Pick a free or quiet
        day for your event: open a day's count to see its events, or press + to
        host on that day. Days that have passed are greyed out, with what
        happened on them.
      </p>
      ${monthNav(month, today, view)}
      <p class="cal-legend">
        <span class="swatch busy0"></span> Free
        <span class="swatch busy1"></span> 1 event
        <span class="swatch busy2"></span> 2 events
        <span class="swatch busy3"></span> 3 or more
        <span class="swatch past"></span> Past
      </p>
      <div class="table-scroll">
        <table class="cal-grid">
          <thead>
            <tr>
              <th>Mon</th>
              <th>Tue</th>
              <th>Wed</th>
              <th>Thu</th>
              <th>Fri</th>
              <th>Sat</th>
              <th>Sun</th>
            </tr>
          </thead>
          <tbody>
            ${grid}
          </tbody>
        </table>
      </div>
    </div>
    ${dayByDay(days, today, month, tab, view)}`;
}

/** The history page's query: what it filters on and which year it maps. */
interface HistoryView {
  selected: EventType | undefined;
  /** `?before=YYYY`: the list starts with the newest year before this one. */
  before: number | undefined;
  year: number;
  /** YYYY-MM-DD: only this day's events are listed. */
  day: string | undefined;
  /** The earliest year with a shown event: where Prev stops. */
  earliest: number;
  /** `?all=1`: the events that do not count (cancelled, Open House) are shown too. */
  showExcluded: boolean;
}

interface HistoryLinkParams {
  type?: EventType;
  year?: number;
  day?: string;
  all?: boolean;
  before?: number;
}

/** A history link that keeps the filters the caller passes. */
function historyLink(params: HistoryLinkParams): ReturnType<typeof pageLink> {
  return pageLink(HOST_PATHS.history, {
    type: params.type,
    year: params.year === undefined ? undefined : String(params.year),
    day: params.day,
    all: params.all ? '1' : undefined,
    before: params.before === undefined ? undefined : String(params.before),
  });
}

/** The excluded events' badge: why this one does not count. */
function excludedBadge(event: HostEvent): SafeHtml | '' {
  switch (hostedExclusion(event)) {
    case 'cancelled':
      return html` <span class="badge neutral">Not counted: cancelled</span>`;
    case 'open-house':
      return html` <span class="badge neutral">Not counted: Open House</span>`;
    default:
      return '';
  }
}

function typeFilter(
  selected: EventType | undefined,
  counts: Map<EventType, number>,
  year: number,
  all: boolean,
): SafeHtml {
  const links = EVENT_TYPES.filter((t) => (counts.get(t) ?? 0) > 0).map((t) => {
    const text = `${EVENT_TYPE_LABELS[t]} (${counts.get(t) ?? 0})`;
    return t === selected
      ? html`<a
          href="${historyLink({ type: t, year, all })}"
          aria-current="page"
          ><strong>${text}</strong></a
        >`
      : html`<a href="${historyLink({ type: t, year, all })}">${text}</a>`;
  });
  const every = selected
    ? html`<a href="${historyLink({ year, all })}">All types</a>`
    : html`<a href="${historyLink({ year, all })}" aria-current="page"
        ><strong>All types</strong></a
      >`;
  return html`<nav class="type-filter" aria-label="Event type">
    ${every}${links}
  </nav>`;
}

/** Prev and next year; each is disabled text when there is nothing there. */
function yearNav(
  view: HistoryView,
  earliest: number,
  current: number,
): SafeHtml {
  const prev =
    view.year > earliest
      ? html`<a
          class="button ghost"
          href="${historyLink({
            type: view.selected,
            year: view.year - 1,
            all: view.showExcluded,
          })}"
          >← ${String(view.year - 1)}</a
        >`
      : html`<span class="button ghost disabled"
          >← ${String(view.year - 1)}<span class="sr-only">
            (no earlier events)</span
          ></span
        >`;
  const next =
    view.year < current
      ? html`<a
          class="button ghost"
          href="${historyLink({
            type: view.selected,
            year: view.year + 1,
            all: view.showExcluded,
          })}"
          >${String(view.year + 1)} →</a
        >`
      : html`<span class="button ghost disabled"
          >${String(view.year + 1)} →<span class="sr-only">
            (not yet)</span
          ></span
        >`;
  return html`<nav class="year-nav" aria-label="Year">
    ${prev}<strong>${String(view.year)}</strong>${next}
  </nav>`;
}

/**
 * The year a history page maps: the day filter's year when there is one (so
 * the map and the list agree), else `?year=`, kept only between the
 * earliest hosted year and this one; else this year.
 */
export function historyYear(
  query: unknown,
  day: string | undefined,
  earliest: number,
  current: number,
): number {
  const wanted = day
    ? Number(day.slice(0, 4))
    : typeof query === 'string' && /^\d{4}$/.test(query)
      ? Number(query)
      : current;
  return wanted >= earliest && wanted <= current ? wanted : current;
}

/** `?before=YYYY` as a year, or undefined for anything else. */
export function beforeParam(value: unknown): number | undefined {
  return typeof value === 'string' && /^[0-9]{4}$/.test(value)
    ? Number(value)
    : undefined;
}

/** A real YYYY-MM-DD date, or undefined. */
function dayParam(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return undefined;
  }
  return dayjs(value).format('YYYY-MM-DD') === value ? value : undefined;
}

/**
 * The fewest events one chunk of the history timeline holds: the server
 * renders whole years, newest first, until it has at least this many (so
 * the most recent year or so); "Older" loads the next chunk the same way.
 */
export const TIMELINE_CHUNK_MIN = 30;

/** An event's Pacific year. */
const yearOf = (event: HostEvent): number =>
  Number(pacificDay(event.dateTime).slice(0, 4));

/** Every year with an event, newest first. */
export function timelineYears(events: HostEvent[]): number[] {
  return [...new Set(events.map(yearOf))].sort((a, b) => b - a);
}

export interface TimelineChunk {
  /** The years shown, newest first; whole years only. */
  years: number[];
  /** Their events, in the order given (newest first). */
  events: HostEvent[];
  /** `?before=` for the next chunk; undefined when nothing older is left. */
  nextBefore: number | undefined;
  /** The newest year the next chunk starts with (its label). */
  nextYear: number | undefined;
}

/**
 * One chunk of the timeline: from the newest year before `before` (every
 * year when undefined), whole years until at least `min` events.
 */
export function timelineChunk(
  events: HostEvent[],
  before: number | undefined,
  min: number = TIMELINE_CHUNK_MIN,
): TimelineChunk {
  const perYear = new Map<number, number>();
  for (const event of events) {
    const y = yearOf(event);
    perYear.set(y, (perYear.get(y) ?? 0) + 1);
  }
  const candidates = timelineYears(events).filter(
    (y) => before === undefined || y < before,
  );
  const years: number[] = [];
  let count = 0;
  for (const y of candidates) {
    if (years.length > 0 && count >= min) {
      break;
    }
    years.push(y);
    count += perYear.get(y) ?? 0;
  }
  const inChunk = new Set(years);
  return {
    years,
    events: events.filter((e) => inChunk.has(yearOf(e))),
    nextBefore:
      candidates.length > years.length ? years[years.length - 1] : undefined,
    nextYear: candidates[years.length],
  };
}

/** One timeline row: the day, the event, its type and the three actions. */
function timelineRow(event: HostEvent): SafeHtml {
  return html`<tr>
    <td class="tl-date" data-label="Date">
      <span class="when">${dayLabel(pacificDay(event.dateTime))}</span>
    </td>
    <td class="event" data-label="Event">
      ${eventLink(event)}${excludedBadge(event)}
    </td>
    <td class="type" data-label="Type">${EVENT_TYPE_LABELS[event.type]}</td>
    <td class="buttons" data-label="Actions">
      <div class="actions row one-line">
        ${attendanceButton(event)}${meetupButton(event)}${copyButton(event)}
      </div>
    </td>
  </tr>`;
}

/**
 * A year of the timeline: its sticky heading, then a sticky heading and a
 * table per month, newest first. Every table has the same fixed columns,
 * so they line up as one list; the column names are for screen readers
 * (the month heading says what the rows are).
 */
function timelineYear(year: number, events: HostEvent[]): SafeHtml {
  const months = new Map<string, HostEvent[]>();
  for (const event of events) {
    const key = pacificDay(event.dateTime).slice(0, 7);
    months.set(key, [...(months.get(key) ?? []), event]);
  }
  const sections = [...months.entries()].map(([month, monthEvents]) => {
    const count = monthEvents.length;
    return html`<section class="tl-month">
      <h4 class="tl-month-head">
        ${dayjs(`${month}-01`).format('MMMM')}
        <span class="tl-count"
          >${count === 1 ? '1 event' : `${count} events`}</span
        >
      </h4>
      <table class="stack tl-table">
        <colgroup>
          <col class="tl-c-date" />
          <col />
          <col class="tl-c-type" />
          <col class="tl-c-actions" />
        </colgroup>
        <thead>
          <tr>
            <th>Date</th>
            <th>Event</th>
            <th>Type</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${monthEvents.map(timelineRow)}
        </tbody>
      </table>
    </section>`;
  });
  return html`<section class="tl-year" data-year="${year}">
    ${yearTarget(year)}
    <h3 class="tl-year-head">${String(year)}</h3>
    ${sections}
  </section>`;
}

/**
 * The year rail: every year with a listed event. A loaded year is an
 * in-page link; an older one opens the list from that year
 * (`?before=year+1`). TIMELINE_SCRIPT loads the years in between instead,
 * and marks the year being read (aria-current="location").
 */
function yearRail(
  years: number[],
  loaded: Set<number>,
  link: (before: number | undefined) => ReturnType<typeof pageLink>,
): SafeHtml {
  const newest = years[0];
  const items = years.map((y) => {
    const href = loaded.has(y)
      ? yearAnchor(y)
      : localUrl(
          `${link(y === newest ? undefined : y + 1).href}${yearAnchor(y).href}`,
        );
    // aria-current is a literal: the first loaded year starts current.
    return y === years.find((x) => loaded.has(x))
      ? html`<li>
          <a href="${href}" data-year="${y}" aria-current="location"
            >${String(y)}</a
          >
        </li>`
      : html`<li><a href="${href}" data-year="${y}">${String(y)}</a></li>`;
  });
  return html`<nav class="year-rail" aria-label="Jump to a year" data-year-rail>
    <ol>
      ${items}
    </ol>
  </nav>`;
}

function historyBody(
  everything: HostEvent[],
  view: HistoryView,
  today: string,
): SafeHtml {
  const { selected, before, year, day, showExcluded } = view;
  // Counts, the type filter and the map follow the shared rule; the host
  // can show the excluded events too.
  const counted = countedOnly(everything);
  const past = showExcluded ? everything : counted;
  const excludedCount = everything.length - counted.length;
  const counts = new Map<EventType, number>();
  for (const event of past) {
    counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  }
  const shown = selected ? past.filter((e) => e.type === selected) : past;
  const byDay = new Map<string, HostEvent[]>();
  for (const event of shown) {
    const key = pacificDay(event.dateTime);
    byDay.set(key, [...(byDay.get(key) ?? []), event]);
  }
  // A day's events in the order they happen.
  for (const events of byDay.values()) {
    events.sort(
      (a, b) => dayjs(a.dateTime).valueOf() - dayjs(b.dateTime).valueOf(),
    );
  }
  if (everything.length === 0) {
    return html`<div class="card">
      <h1>My hosting history</h1>
      <p class="muted">No past events yet.</p>
    </div>`;
  }
  const currentYear = Number(today.slice(0, 4));
  const listLink = (b: number | undefined) =>
    historyLink({ type: selected, year, all: showExcluded, before: b });
  const dayFilter = day
    ? html`<p class="day-filter">
        Showing ${dayLabel(day)}, ${day.slice(0, 4)} ·
        <a href="${historyLink({ type: selected, year, all: showExcluded })}"
          >Clear</a
        >
      </p>`
    : '';
  const excludedNote =
    excludedCount === 0
      ? ''
      : showExcluded
        ? html` ${excludedCount} shown that
            ${excludedCount === 1 ? 'does' : 'do'} not count (cancelled, or an
            Open House) ·
            <a href="${historyLink({ type: selected, year })}"
              >Hide excluded</a
            >`
        : html` ${excludedCount} more ${excludedCount === 1 ? 'is' : 'are'} not
            counted (cancelled, or an Open House) ·
            <a href="${historyLink({ type: selected, year, all: true })}"
              >Show excluded</a
            >`;
  // A ?before= past the newest year is the whole list: no Newer link.
  const shownYears = timelineYears(shown);
  const from =
    before !== undefined && shownYears.length > 0 && before <= shownYears[0]
      ? before
      : undefined;
  // A day filter lists that day alone; otherwise one chunk of the timeline.
  const chunk: TimelineChunk = day
    ? {
        years: timelineYears(byDay.get(day) ?? []),
        events: byDay.get(day) ?? [],
        nextBefore: undefined,
        nextYear: undefined,
      }
    : timelineChunk(shown, from);
  const allYears = day ? chunk.years : shownYears;
  const yearSections = chunk.years.map((y) =>
    timelineYear(
      y,
      chunk.events.filter((e) => yearOf(e) === y),
    ),
  );
  // Whenever the list starts part-way, there is a way back to the top.
  const newer =
    !day && from !== undefined
      ? html`<p class="tl-newer">
          <a class="button ghost" href="${listLink(undefined)}"
            >↑ Newer events</a
          >
        </p>`
      : '';
  const more =
    chunk.nextBefore === undefined || chunk.nextYear === undefined
      ? ''
      : html`<p class="tl-more" data-timeline-more>
          <a class="button ghost" href="${listLink(chunk.nextBefore)}"
            >Older events (${String(chunk.nextYear)} and before)</a
          >
        </p>`;
  const list =
    chunk.events.length === 0
      ? html`<p class="muted">
            ${
              day
                ? `No events on ${dayLabel(day)}.`
                : from === undefined
                  ? 'No events.'
                  : 'No older events.'
            }
          </p>
          ${newer}`
      : html`<div class="timeline-wrap">
          ${
            allYears.length > 1
              ? yearRail(allYears, new Set(chunk.years), listLink)
              : ''
          }
          <div class="timeline" data-timeline>
            ${newer}${yearSections}${more}
            <p class="sr-only" role="status" data-timeline-status></p>
          </div>
        </div>`;
  return html`<div class="card">
      <h1>My hosting history</h1>
      <p>
        ${`${counted.length} hosted ${counted.length === 1 ? 'event' : 'events'} in all.`}${excludedNote}
      </p>
      ${typeFilter(selected, counts, year, showExcluded)}
      ${yearNav(view, view.earliest, currentYear)}
      ${heatMapYear({
        byDay,
        year,
        today,
        dayLink: (d) =>
          historyLink({ type: selected, year, day: d, all: showExcluded }),
      })}
      <p class="muted">
        Types are guessed from event titles. Cancelled events and Open Houses
        are not counted as hosted.
      </p>
    </div>
    <div class="card">
      <h2>${selected ? EVENT_TYPE_LABELS[selected] : 'Past events'}</h2>
      ${dayFilter}
      <p class="muted">
        "Take attendance" opens the event's attendee list on Meetup, where hosts
        mark who came and who did not show. "View on Meetup" opens the event,
        and the copy icon starts a new request with its details.
      </p>
      ${list}
    </div>`;
}

/** The earliest year with a hosted event (this year when there is none). */
function earliestYear(events: HostEvent[], current: number): number {
  return events.reduce(
    (min, e) => Math.min(min, Number(pacificDay(e.dateTime).slice(0, 4))),
    current,
  );
}

export function registerHostPages(
  router: express.Router,
  deps: HostPageDeps,
): void {
  const today = () => pacificDay(deps.events.now());
  if (deps.announce) {
    registerAnnounceRoute(router, deps.announce, {
      ownUpcoming: (memberId) =>
        hostedEvents(deps.events, memberId, 'upcoming'),
      now: () => deps.events.now(),
    });
  }

  router.get('/', (async (req, res) => {
    const { session } = hostLocals(res);
    if (session.role === 'member') {
      hostPage(res, {
        title: 'Home',
        current: 'home',
        body: memberBody(session, linkResultOf(req.query.link)),
      });
      return;
    }
    let upcoming: HostEvent[];
    let calendar: CalendarDay[];
    try {
      [upcoming, calendar] = await Promise.all([
        hostedEvents(deps.events, session.userId, 'upcoming'),
        groupCalendar(deps.events),
      ]);
    } catch (error: unknown) {
      unavailable(res, error);
      return;
    }
    let requests: EventRequest[] | undefined = [];
    if (deps.requests) {
      try {
        requests = await (
          await deps.requests()
        ).listForMember(session.userId, HOME_REQUESTS_SHOWN);
      } catch (error: unknown) {
        logger.warn(
          `Host requests read failed: ${error instanceof Error ? error.name : 'Error'}`,
        );
        requests = undefined;
      }
    }
    let announcements: Map<string, Announcement> | undefined;
    let tooLate:
      { eventId: string; offer: Recreatable | undefined } | undefined;
    if (deps.announce) {
      try {
        announcements = await deps.announce.announcements(
          upcoming.map((e) => e.id),
        );
      } catch (error: unknown) {
        // The buttons still show: the server refuses a second send anyway.
        logger.warn(
          `Host announcements read failed: ${error instanceof Error ? error.name : 'Error'}`,
        );
        announcements = new Map();
      }
      const eventId = tooLateEvent(req.query);
      if (eventId !== undefined && upcoming.some((e) => e.id === eventId)) {
        let offer: Recreatable | undefined;
        try {
          offer = await deps.announce.recreatable(
            { meetupMemberId: session.userId, name: session.username },
            eventId,
          );
        } catch (error: unknown) {
          logger.warn(
            `Recreatable check failed: ${error instanceof Error ? error.name : 'Error'}`,
          );
        }
        tooLate = { eventId, offer };
      }
    }
    hostPage(res, {
      title: 'Home',
      current: 'home',
      body: homeBody(session, upcoming, calendar, today(), requests, {
        linkResult: linkResultOf(req.query.link),
        announcements,
        announceResult: req.query.announce,
        tooLate,
        now: deps.events.now(),
      }),
    });
  }) as RequestHandler);

  router.get('/calendar', (async (req, res) => {
    const month = calendarMonth(req.query.month, today());
    let days: CalendarDay[];
    try {
      days = await monthCalendar(deps.events, month);
    } catch (error: unknown) {
      unavailable(res, error);
      return;
    }
    hostPage(res, {
      title: 'Calendar',
      current: 'calendar',
      body: calendarBody(
        days,
        today(),
        month,
        calendarTab(req.query.tab),
        calendarView(req.query.view),
      ),
      script: CALENDAR_SCRIPT,
    });
  }) as RequestHandler);

  router.get('/history', (async (req, res) => {
    const { session } = hostLocals(res);
    // An unknown type, year or day is ignored: the page falls back to all
    // types, this year and every day.
    const selected = isEventType(req.query.type) ? req.query.type : undefined;
    const before = beforeParam(req.query.before);
    let past: HostEvent[];
    try {
      past = await hostedEvents(deps.events, session.userId, 'past');
    } catch (error: unknown) {
      unavailable(res, error);
      return;
    }
    const now = today();
    const current = Number(now.slice(0, 4));
    const showExcluded = req.query.all === '1';
    const base = showExcluded ? past : countedOnly(past);
    const shown = selected ? base.filter((e) => e.type === selected) : base;
    const day = dayParam(req.query.day);
    const earliest = earliestYear(shown, current);
    const year = historyYear(req.query.year, day, earliest, current);
    hostPage(res, {
      title: 'My hosting history',
      current: 'history',
      body: historyBody(
        past,
        { selected, before, year, day, earliest, showExcluded },
        now,
      ),
      script: [HISTORY_SCRIPT, TIMELINE_SCRIPT],
    });
  }) as RequestHandler);
}
