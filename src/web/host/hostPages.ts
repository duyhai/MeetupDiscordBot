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
  groupCalendar,
  hostedEvents,
  pacificDay,
} from '../../lib/hosts/hostEvents.js';
import { matchHolidays } from '../../lib/hosts/holidays.js';
import { SafeHtml, html, memberText, pageLink, safeHref } from '../html.js';
import { eventLink } from '../links.js';
import { PAGE_SIZE, pageNav, parsePage } from '../paging.js';
import { heatMap as heatMapFor } from './heatMap.js';
import { hostLocals } from './hostRouter.js';
import { EventRequest } from '../../lib/repositories/postgresEventRequestRepository.js';
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
import { HOST_BASE, HostSession } from './hostSession.js';

const logger = new Logger({ name: 'hostDashboard' });

export interface HostPageDeps {
  events: HostEventsDeps;
  /** The host's requests for the home page; a failure hides only that card. */
  requests?: () => Promise<Pick<HostRequestStore, 'listForMember'>>;
}

export const HOST_PATHS = {
  calendar: `${HOST_BASE}/calendar`,
  history: `${HOST_BASE}/history`,
} as const;

const CREATE_PAGE = `${HOST_BASE}/create`;
/** How many of the host's requests the home page lists. */
const HOME_REQUESTS_SHOWN = 10;

/** How many quiet days the home page suggests. */
const QUIET_DAYS_SHOWN = 5;
const QUIET_WINDOW_DAYS = 14;

/** The tier as a pill: green for Community Host, grey for a regular host. */
function tierBadge(session: HostSession): SafeHtml {
  return session.tier === 'promoted'
    ? html`<span class="badge ok">Community Host</span>`
    : html`<span class="badge neutral">Guest Host</span>`;
}

function meetupButton(event: HostEvent): SafeHtml {
  const href = safeHref(event.eventUrl);
  return href
    ? html`<a
        class="button ghost"
        href="${href}"
        rel="noopener noreferrer"
        target="_blank"
        >View on Meetup</a
      >`
    : html``;
}

function attendanceButton(event: HostEvent): SafeHtml {
  const url = attendanceUrl(event.eventUrl);
  const href = url ? safeHref(url) : undefined;
  return href
    ? html`<a
        class="button ghost"
        href="${href}"
        rel="noopener noreferrer"
        target="_blank"
        >Take attendance on Meetup</a
      >`
    : html``;
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

function homeBody(
  session: HostSession,
  upcoming: HostEvent[],
  calendar: CalendarDay[],
  today: string,
  requests: EventRequest[] | undefined,
): SafeHtml {
  const quiet = quietDays(calendar, today).slice(0, QUIET_DAYS_SHOWN);
  const linkNudge =
    session.discordUserId === null
      ? html`<div class="note info">
          <p>
            Your Meetup account is not linked to Discord. Linking is optional,
            but it lets us recognise you in our Discord server: press
            <strong>Verify</strong> there to link it.
          </p>
        </div>`
      : '';
  const rows = upcoming.map(
    (event) =>
      html`<tr>
        <td data-label="Date">
          ${dateLabel(event.dateTime)}, ${timeLabel(event.dateTime)}
        </td>
        <td data-label="Event">${eventLink(event)}</td>
        <td data-label="Type">${EVENT_TYPE_LABELS[event.type]}</td>
        <td data-label="Status"><span class="badge ok">Published</span></td>
        <td data-label="Actions">${meetupButton(event)}</td>
      </tr>`,
  );
  return html`<div class="card">
      <h1>Hi, ${memberText(session.username)}</h1>
      <p>${tierBadge(session)}</p>
      ${linkNudge}
      <div class="actions">
        <a class="button" href="${pageLink(CREATE_PAGE)}">Host an event</a>
      </div>
    </div>
    ${requestsCard(requests)}
    <div class="card">
      <h2>Your upcoming events</h2>
      ${
        upcoming.length === 0
          ? html`<p class="muted">You have no upcoming events on Meetup.</p>`
          : html`<table class="stack">
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
 * One calendar cell. The busy class is one of four literals; the count is
 * also text, so the shading is never the only signal.
 */
function calendarCell(day: CalendarDay, today: string): SafeHtml {
  const past = day.day < today;
  const dayText = dayjs(day.day).format(
    day.day.endsWith('-01') ? 'MMM D' : 'D',
  );
  // From tomorrow, the day number opens the create form for that day.
  const label =
    day.day > today
      ? html`<a class="cal-day" href="${createDayLink(day.day)}"
          ><span class="sr-only">Host an event on </span>${dayText}</a
        >`
      : html`<span class="cal-day">${dayText}</span>`;
  const count = day.events.length;
  const countText = html`<span class="cal-count"
    >${count === 0 ? 'Free' : count === 1 ? '1 event' : `${count} events`}</span
  >`;
  const holidays = holidaysOn(day.events);
  const dates = holidays.length
    ? html`<span class="cal-date">${holidays.join(', ')}</span>`
    : '';
  const inner = html`${label}${countText}${dates}`;
  if (past) {
    // Only published (upcoming) events are read, so a past day's count
    // would be wrong: it shows the date only.
    return html`<td class="cal past">${label}</td>`;
  }
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

function calendarBody(days: CalendarDay[], today: string): SafeHtml {
  const weeks: CalendarDay[][] = [];
  for (let i = 0; i < days.length; i += 7) {
    weeks.push(days.slice(i, i + 7));
  }
  const grid = weeks.map(
    (week) =>
      html`<tr>
        ${week.map((d) => calendarCell(d, today))}
      </tr>`,
  );
  const listed = days.filter((d) => d.day >= today && d.events.length > 0);
  const list = listed.map(
    (d) =>
      html`<li>
        <h3>${dayLabel(d.day)}</h3>
        ${
          d.day > today
            ? html`<p>
                <a href="${createDayLink(d.day)}">Host on this day</a>
              </p>`
            : ''
        }
        <ul>
          ${d.events.map(
            (e) =>
              html`<li>
                ${timeLabel(e.dateTime)}:
                ${eventLink(e)}${matchHolidays(e.title).map(
                  (name) => html` <span class="badge info">${name}</span>`,
                )}${
                  e.hosts.length
                    ? html` <span class="muted"
                        >hosted by
                        ${e.hosts.map((h, i) => html`${i ? ', ' : ''}${memberText(h.name)}`)}</span
                      >`
                    : ''
                }
              </li>`,
          )}
        </ul>
      </li>`,
  );
  return html`<div class="card">
      <h1>Calendar</h1>
      <p>
        The group's published events for the next 8 weeks. Pick a free or quiet
        day for your event.
      </p>
      <p class="cal-legend">
        <span class="swatch busy0"></span> Free
        <span class="swatch busy1"></span> 1 event
        <span class="swatch busy2"></span> 2 events
        <span class="swatch busy3"></span> 3 or more
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
    <div class="card">
      <h2>Day by day</h2>
      ${
        listed.length === 0
          ? html`<p class="muted">Nothing scheduled yet.</p>`
          : html`<ol class="cal-list">
              ${list}
            </ol>`
      }
    </div>`;
}

function typeFilter(
  selected: EventType | undefined,
  counts: Map<EventType, number>,
): SafeHtml {
  const links = EVENT_TYPES.filter((t) => (counts.get(t) ?? 0) > 0).map((t) => {
    const text = `${EVENT_TYPE_LABELS[t]} (${counts.get(t) ?? 0})`;
    return t === selected
      ? html`<a
          href="${pageLink(HOST_PATHS.history, { type: t })}"
          aria-current="page"
          ><strong>${text}</strong></a
        >`
      : html`<a href="${pageLink(HOST_PATHS.history, { type: t })}"
          >${text}</a
        >`;
  });
  const all = selected
    ? html`<a href="${pageLink(HOST_PATHS.history)}">All types</a>`
    : html`<a href="${pageLink(HOST_PATHS.history)}" aria-current="page"
        ><strong>All types</strong></a
      >`;
  return html`<nav class="type-filter" aria-label="Event type">
    ${all}${links}
  </nav>`;
}

function historyBody(
  past: HostEvent[],
  selected: EventType | undefined,
  page: number,
  today: string,
): SafeHtml {
  const counts = new Map<EventType, number>();
  for (const event of past) {
    counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  }
  const shown = selected ? past.filter((e) => e.type === selected) : past;
  const perDay = new Map<string, number>();
  for (const event of shown) {
    const day = pacificDay(event.dateTime);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }
  const slice = shown.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const rows = slice.map(
    (event) =>
      html`<tr>
        <td data-label="Date">${dateLabel(event.dateTime)}</td>
        <td data-label="Event">${eventLink(event)}</td>
        <td data-label="Type">${EVENT_TYPE_LABELS[event.type]}</td>
        <td data-label="Actions">
          <div class="actions">
            ${meetupButton(event)}${attendanceButton(event)}
            <a class="button ghost" href="${copyLink(event.id)}">Copy</a>
          </div>
        </td>
      </tr>`,
  );
  if (past.length === 0) {
    return html`<div class="card">
      <h1>My hosting history</h1>
      <p class="muted">No past events yet.</p>
    </div>`;
  }
  return html`<div class="card">
      <h1>My hosting history</h1>
      <p>
        ${past.length} hosted ${past.length === 1 ? 'event' : 'events'} in all.
      </p>
      ${typeFilter(selected, counts)} ${heatMapFor(perDay, today)}
      <p class="muted">Types are guessed from event titles.</p>
    </div>
    <div class="card">
      <h2>${selected ? EVENT_TYPE_LABELS[selected] : 'Past events'}</h2>
      <p class="muted">
        "Take attendance on Meetup" opens the event's attendee list, where hosts
        mark who came and who did not show.
      </p>
      ${
        rows.length === 0
          ? html`<p class="muted">No events on this page.</p>`
          : html`<table class="stack">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Event</th>
                  <th>Type</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${rows}
              </tbody>
            </table>`
      }
      ${pageNav(HOST_PATHS.history, page, shown.length > page * PAGE_SIZE, { type: selected })}
    </div>`;
}

export function registerHostPages(
  router: express.Router,
  deps: HostPageDeps,
): void {
  const today = () => pacificDay(deps.events.now());

  router.get('/', (async (_req, res) => {
    const { session } = hostLocals(res);
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
    hostPage(res, {
      title: 'Home',
      current: 'home',
      body: homeBody(session, upcoming, calendar, today(), requests),
    });
  }) as RequestHandler);

  router.get('/calendar', (async (_req, res) => {
    let days: CalendarDay[];
    try {
      days = await groupCalendar(deps.events);
    } catch (error: unknown) {
      unavailable(res, error);
      return;
    }
    hostPage(res, {
      title: 'Calendar',
      current: 'calendar',
      body: calendarBody(days, today()),
    });
  }) as RequestHandler);

  router.get('/history', (async (req, res) => {
    const { session } = hostLocals(res);
    // An unknown type is ignored: the page shows every type.
    const selected = isEventType(req.query.type) ? req.query.type : undefined;
    const page = parsePage(req.query.page);
    let past: HostEvent[];
    try {
      past = await hostedEvents(deps.events, session.userId, 'past');
    } catch (error: unknown) {
      unavailable(res, error);
      return;
    }
    hostPage(res, {
      title: 'My hosting history',
      current: 'history',
      body: historyBody(past, selected, page, today()),
    });
  }) as RequestHandler);
}
