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
  monthCalendar,
  hostedEvents,
  pacificDay,
} from '../../lib/hosts/hostEvents.js';
import { MAX_DAYS_AHEAD } from '../../lib/hosts/eventRequest.js';
import { matchHolidays } from '../../lib/hosts/holidays.js';
import {
  SafeHtml,
  html,
  localUrl,
  memberText,
  pageLink,
  safeHref,
} from '../html.js';
import { eventLink } from '../links.js';
import { PAGE_SIZE, pageNav, parsePage } from '../paging.js';
import { heatMapYear } from './heatMap.js';
import { HOST_LINK_RESULTS, HostLinkResult, hostLocals } from './hostRouter.js';
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
import { CALENDAR_SCRIPT, HISTORY_SCRIPT } from './hostScripts.js';
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
  linkResult?: HostLinkResult,
): SafeHtml {
  const quiet = quietDays(calendar, today).slice(0, QUIET_DAYS_SHOWN);
  // "Verify on Discord": the same Verify as the button in the server. Only for a Meetup sign-in: a Discord sign-in
  // whose link was removed since carries a Discord name, not a Meetup one.
  const linkNudge =
    session.discordUserId === null && session.via === 'meetup'
      ? html`<div class="note info">
          <p>
            Your Meetup account is not linked to Discord yet. Verifying is
            optional: it links the two, adds you to our Discord server if you
            are not in it, and gives you the same roles and badges as pressing
            Verify there.
          </p>
          <form method="post" action="${localUrl(LINK_DISCORD_PATH)}">
            <input type="hidden" name="_csrf" value="${session.csrfToken}" />
            <button type="submit">Verify on Discord</button>
          </form>
        </div>`
      : '';
  const notice = linkResult ? linkNotice(linkResult) : '';
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
      ${notice} ${linkNudge}
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

/** One event as a line: time, title link, holiday badges, hosts. */
function eventLine(e: HostEvent): SafeHtml {
  return html`${timeLabel(e.dateTime)}:
  ${eventLink(e)}${matchHolidays(e.title).map(
    (name) => html` <span class="badge info">${name}</span>`,
  )}${
    e.hosts.length
      ? html` <span class="muted"
          >hosted by
          ${e.hosts.map((h, i) => html`${i ? ', ' : ''}${memberText(h.name)}`)}</span
        >`
      : ''
  }`;
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
    // Only published (upcoming) events are read, so a past day's count
    // would be wrong: it shows the date only.
    return html`<td class="cal past">${number}</td>`;
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

/** Previous and next month; each is disabled text at the ends. */
function monthNav(month: string, today: string): SafeHtml {
  const first = dayjs(`${month}-01`);
  const prev = first.subtract(1, 'month');
  const next = first.add(1, 'month');
  const current = today.slice(0, 7);
  const last = dayjs(`${current}-01`)
    .add(CALENDAR_MONTHS_AHEAD, 'month')
    .format('YYYY-MM');
  const link = (m: dayjs.Dayjs) =>
    pageLink(HOST_PATHS.calendar, { month: m.format('YYYY-MM') });
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
  const listed = days.filter(
    (d) => inMonth(d) && d.day >= today && d.events.length > 0,
  );
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
          ${d.events.map((e) => html`<li>${eventLine(e)}</li>`)}
        </ul>
      </li>`,
  );
  return html`<div class="card">
      <h1>Calendar</h1>
      <p>
        The group's published events, a month at a time. Pick a free or quiet
        day for your event: open a day's count to see its events, or press + to
        host on that day.
      </p>
      ${monthNav(month, today)}
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
      <h2>Day by day: ${dayjs(`${month}-01`).format('MMMM')}</h2>
      ${
        listed.length === 0
          ? html`<p class="muted">Nothing scheduled this month yet.</p>`
          : html`<ol class="cal-list">
              ${list}
            </ol>`
      }
    </div>`;
}

/** The history page's query: what it filters on and which year it maps. */
interface HistoryView {
  selected: EventType | undefined;
  page: number;
  year: number;
  /** YYYY-MM-DD: only this day's events are listed. */
  day: string | undefined;
  /** The earliest year with a shown event: where Prev stops. */
  earliest: number;
}

/** A history link that keeps the filters the caller passes. */
function historyLink(params: {
  type?: EventType;
  year?: number;
  day?: string;
}): ReturnType<typeof pageLink> {
  return pageLink(HOST_PATHS.history, {
    type: params.type,
    year: params.year === undefined ? undefined : String(params.year),
    day: params.day,
  });
}

function typeFilter(
  selected: EventType | undefined,
  counts: Map<EventType, number>,
  year: number,
): SafeHtml {
  const links = EVENT_TYPES.filter((t) => (counts.get(t) ?? 0) > 0).map((t) => {
    const text = `${EVENT_TYPE_LABELS[t]} (${counts.get(t) ?? 0})`;
    return t === selected
      ? html`<a href="${historyLink({ type: t, year })}" aria-current="page"
          ><strong>${text}</strong></a
        >`
      : html`<a href="${historyLink({ type: t, year })}">${text}</a>`;
  });
  const all = selected
    ? html`<a href="${historyLink({ year })}">All types</a>`
    : html`<a href="${historyLink({ year })}" aria-current="page"
        ><strong>All types</strong></a
      >`;
  return html`<nav class="type-filter" aria-label="Event type">
    ${all}${links}
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
          href="${historyLink({ type: view.selected, year: view.year - 1 })}"
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
          href="${historyLink({ type: view.selected, year: view.year + 1 })}"
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

/** A real YYYY-MM-DD date, or undefined. */
function dayParam(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return undefined;
  }
  return dayjs(value).format('YYYY-MM-DD') === value ? value : undefined;
}

function historyBody(
  past: HostEvent[],
  view: HistoryView,
  today: string,
): SafeHtml {
  const { selected, page, year, day } = view;
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
  const listed = day ? (byDay.get(day) ?? []) : shown;
  const slice = listed.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const rows = slice.map(
    (event) =>
      html`<tr>
        <td data-label="Date">${dateLabel(event.dateTime)}</td>
        <td data-label="Event">${eventLink(event)}</td>
        <td data-label="Type">${EVENT_TYPE_LABELS[event.type]}</td>
        <td data-label="Actions">
          <div class="actions">
            ${meetupButton(event)}${attendanceButton(event)}
            <a class="button ghost" href="${copyLink(event.id)}"
              >Copy this event</a
            >
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
  const currentYear = Number(today.slice(0, 4));
  const dayFilter = day
    ? html`<p class="day-filter">
        Showing ${dayLabel(day)}, ${day.slice(0, 4)} ·
        <a href="${historyLink({ type: selected, year })}">Clear</a>
      </p>`
    : '';
  return html`<div class="card">
      <h1>My hosting history</h1>
      <p>
        ${past.length} hosted ${past.length === 1 ? 'event' : 'events'} in all.
      </p>
      ${typeFilter(selected, counts, year)}
      ${yearNav(view, view.earliest, currentYear)}
      ${heatMapYear({
        byDay,
        year,
        today,
        dayLink: (d) => historyLink({ type: selected, year, day: d }),
      })}
      <p class="muted">Types are guessed from event titles.</p>
    </div>
    <div class="card">
      <h2>${selected ? EVENT_TYPE_LABELS[selected] : 'Past events'}</h2>
      ${dayFilter}
      <p class="muted">
        "Take attendance on Meetup" opens the event's attendee list, where hosts
        mark who came and who did not show. "Copy this event" starts a new
        request with its details.
      </p>
      ${
        rows.length === 0
          ? html`<p class="muted">
              ${day ? `No events on ${dayLabel(day)}.` : 'No events on this page.'}
            </p>`
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
      ${pageNav(HOST_PATHS.history, page, listed.length > page * PAGE_SIZE, {
        type: selected,
        year: String(year),
        day,
      })}
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

  router.get('/', (async (req, res) => {
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
      body: homeBody(
        session,
        upcoming,
        calendar,
        today(),
        requests,
        linkResultOf(req.query.link),
      ),
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
      body: calendarBody(days, today(), month),
      script: CALENDAR_SCRIPT,
    });
  }) as RequestHandler);

  router.get('/history', (async (req, res) => {
    const { session } = hostLocals(res);
    // An unknown type, year or day is ignored: the page falls back to all
    // types, this year and every day.
    const selected = isEventType(req.query.type) ? req.query.type : undefined;
    const page = parsePage(req.query.page);
    let past: HostEvent[];
    try {
      past = await hostedEvents(deps.events, session.userId, 'past');
    } catch (error: unknown) {
      unavailable(res, error);
      return;
    }
    const now = today();
    const current = Number(now.slice(0, 4));
    const shown = selected ? past.filter((e) => e.type === selected) : past;
    const day = dayParam(req.query.day);
    const earliest = earliestYear(shown, current);
    const year = historyYear(req.query.year, day, earliest, current);
    hostPage(res, {
      title: 'My hosting history',
      current: 'history',
      body: historyBody(past, { selected, page, year, day, earliest }, now),
      script: HISTORY_SCRIPT,
    });
  }) as RequestHandler);
}
