import dayjs from 'dayjs';
import express, { RequestHandler, Response } from 'express';
import { Logger } from 'tslog';

import { DASHBOARD_BASE } from '../../lib/reports/dashboardPaths.js';
import {
  CopySource,
  DEFAULT_DURATION,
  DEFAULT_TIME,
  DURATIONS,
  Duration,
  FormField,
  MAX_DAYS_AHEAD,
  START_TIMES,
  copyDefaults,
  copySettings,
  freshSettings,
  isHostOf,
  parseRequestForm,
  prefixFor,
  TITLE_MAX,
} from '../../lib/hosts/eventRequest.js';
import { pacificDay } from '../../lib/hosts/hostEvents.js';
import { PublishOutcome } from '../../lib/hosts/publishRequest.js';
import { LogEntry } from '../../lib/helpers/discordLogger.js';
import {
  EventRequest,
  NewEventRequest,
} from '../../lib/repositories/postgresEventRequestRepository.js';
import {
  SafeHtml,
  html,
  localUrl,
  memberText,
  pageLink,
  safeHref,
} from '../html.js';
import { withDeadline } from '../routes/workspaceActions.js';
import { hostLocals } from './hostRouter.js';
import { hostPage, unavailable } from './hostPageKit.js';
import { HOST_BASE, HostSession } from './hostSession.js';

const logger = new Logger({ name: 'hostDashboard' });

export const CREATE_PATHS = {
  create: `${HOST_BASE}/create`,
  request: (id: string) => `${HOST_BASE}/requests/${id}`,
} as const;

/**
 * How long a Community Host's publish may run before the page moves on (it
 * goes on in the background): inside Heroku's 30 s router timeout.
 */
const PUBLISH_DEADLINE_MS = 20_000;

/** A regular host may have at most this many requests waiting for leadership. */
export const MAX_PENDING = 5;

// Meetup ids are numeric, but older recurring events have letters too.
const EVENT_ID = /^[A-Za-z0-9]{1,40}$/;
const REQUEST_ID = /^[1-9][0-9]{0,17}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The request store's host-side reads and writes. */
export interface HostRequestStore {
  create: (input: NewEventRequest) => Promise<EventRequest>;
  get: (id: string) => Promise<EventRequest | undefined>;
  listForMember: (
    meetupMemberId: string,
    limit?: number,
  ) => Promise<EventRequest[]>;
  countPending: (meetupMemberId: string) => Promise<number>;
}

export interface CreatePageDeps {
  now: () => Date;
  /** Rejects when Postgres cannot answer: the page answers 503. */
  requests: () => Promise<HostRequestStore>;
  /** The source of a copy, read with the organizer credential. Throws when Meetup is down. */
  copySource: (eventId: string) => Promise<CopySource | undefined>;
  /** publishRequest for a Community Host's own request (actor: their Meetup id). */
  publish: (
    id: string,
    version: number,
    actor: string,
  ) => Promise<PublishOutcome>;
  /** #meetup-bot-alerts, plain (no mentions); fire and forget. */
  alert: (entry: LogEntry) => Promise<unknown>;
  /** A Host Tip for a regular host's fresh event. */
  tip: () => string;
}

interface FormView {
  title: string;
  day: string;
  time: string;
  duration: string;
  copy?: CopySource;
  errors: Partial<Record<FormField | 'form', string>>;
}

/** One form field as a string; a missing or repeated field is undefined. */
function field(body: unknown, name: string): string | undefined {
  const value = (body as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' ? value : undefined;
}

const durationLabel = (d: Duration) => {
  const m = /^PT(\d+)H(?:(\d+)M)?$/.exec(d);
  const hours = Number(m?.[1] ?? 0);
  const minutes = Number(m?.[2] ?? 0);
  return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
};

const timeOption = (t: string) => dayjs(`2000-01-01T${t}`).format('h:mm A');

function errorText(message: string | undefined): SafeHtml | '' {
  return message ? html`<span class="field-error">${message}</span>` : '';
}

/** The create form; every value the host typed is escaped. */
function formBody(
  session: HostSession,
  view: FormView,
  today: string,
): SafeHtml {
  const max = TITLE_MAX;
  const first = dayjs(today).add(1, 'day').format('YYYY-MM-DD');
  const last = dayjs(today).add(MAX_DAYS_AHEAD, 'day').format('YYYY-MM-DD');
  const times = START_TIMES.map((t) => {
    if (t === view.time) {
      return html`<option value="${t}" selected>${timeOption(t)}</option>`;
    }
    return html`<option value="${t}">${timeOption(t)}</option>`;
  });
  const durations = DURATIONS.map((d) => {
    if (d === view.duration) {
      return html`<option value="${d}" selected>${durationLabel(d)}</option>`;
    }
    return html`<option value="${d}">${durationLabel(d)}</option>`;
  });
  const promoted = session.tier === 'promoted';
  const source = view.copy;
  const sourceHref = source ? safeHref(source.eventUrl ?? '') : undefined;
  const intro = source
    ? html`<p>
        Copying
        ${
          sourceHref
            ? html`<a
                href="${sourceHref}"
                rel="noopener noreferrer"
                target="_blank"
                >${memberText(source.title ?? '')}</a
              >`
            : memberText(source.title ?? '')
        }.
        The description, photo, venue, directions and RSVP limits are copied as
        they are on Meetup. Pick the new date below.
      </p>`
    : html`<p>
        The event starts with the group's standard description. Once it is on
        Meetup you are its host, so you can fill in the details there.
      </p>`;
  const next = promoted
    ? html`<p class="muted">
        As a Community Host your event is published on Meetup as soon as you
        submit, titled "${prefixFor('promoted')}…".
      </p>`
    : html`<p class="muted">
        The 1.5 Leadership Team reviews your request. Once approved it is
        published on Meetup, titled "${prefixFor('regular')}…".
      </p>`;
  return html`<div class="card">
    <h1>${source ? 'Copy an event' : 'Host an event'}</h1>
    ${intro} ${errorText(view.errors.form)}
    <form
      class="request-form"
      method="post"
      action="${localUrl(CREATE_PATHS.create)}"
    >
      <input type="hidden" name="_csrf" value="${session.csrfToken}" />
      ${source ? html`<input type="hidden" name="copy" value="${source.id}" />` : ''}
      <label class="field"
        >Title (up to ${max} characters)
        <input
          name="title"
          maxlength="${max}"
          value="${view.title}"
          autocomplete="off"
          required
        />
        ${errorText(view.errors.title)}
      </label>
      <label class="field"
        >Date
        <input
          type="date"
          name="day"
          min="${first}"
          max="${last}"
          value="${view.day}"
          required
        />
        ${errorText(view.errors.day)}
      </label>
      <label class="field"
        >Start time
        <select name="time">
          ${times}
        </select>
        ${errorText(view.errors.time)}
      </label>
      <label class="field"
        >Length
        <select name="duration">
          ${durations}
        </select>
        ${errorText(view.errors.duration)}
      </label>
      ${next}
      <button type="submit">
        ${promoted ? 'Publish on Meetup' : 'Send for approval'}
      </button>
    </form>
  </div>`;
}

/** The status of a request as a pill: coral when it needs someone, green when done. */
export function requestStatusBadge(request: EventRequest): SafeHtml {
  switch (request.status) {
    case 'pending':
      return html`<span class="badge attn">Waiting for approval</span>`;
    case 'publishing':
      return html`<span class="badge info">Publishing</span>`;
    case 'published':
      return html`<span class="badge ok">Published</span>`;
    case 'denied':
      return html`<span class="badge attn">Not approved</span>`;
    default:
      return html`<span class="badge attn">Could not publish</span>`;
  }
}

const whenLabel = (startLocal: string) =>
  dayjs(startLocal).format('ddd, MMM D, YYYY [at] h:mm A');

function requestBody(request: EventRequest): SafeHtml {
  const meetupHref = safeHref(request.eventUrl ?? '');
  const detail = (() => {
    switch (request.status) {
      case 'pending':
        return html`<p>
          The 1.5 Leadership Team will review it. You'll see the result here.
        </p>`;
      case 'publishing':
        return html`<p>
          It is being published on Meetup. Reload in a minute.
        </p>`;
      case 'published':
        return meetupHref
          ? html`<p>
              It is on Meetup:
              <a href="${meetupHref}" rel="noopener noreferrer" target="_blank"
                >open the event</a
              >. You are its host there, so fill in the details and RSVP
              settings as needed.
            </p>`
          : html`<p>It is on Meetup.</p>`;
      case 'denied':
        return html`<p>The Leadership Team did not approve it:</p>
          <blockquote>${memberText(request.denyReason ?? '')}</blockquote>`;
      default:
        return html`<p>
          Publishing failed. The Leadership Team has been told and will retry or
          contact you.
        </p>`;
    }
  })();
  return html`<div class="card">
    <h1>${memberText(request.title)}</h1>
    <p>${requestStatusBadge(request)}</p>
    <p>
      ${whenLabel(request.startLocal)},
      ${durationLabel(request.duration as Duration)}${
        request.kind === 'copy' ? ', copied from a past event' : ''
      }
    </p>
    ${detail}
    <p><a href="${localUrl(HOST_BASE)}">Back to home</a></p>
  </div>`;
}

/** The host's latest requests for the home page. */
export function requestsCard(requests: EventRequest[] | undefined): SafeHtml {
  if (requests === undefined) {
    return html`<div class="card">
      <h2>Your requests</h2>
      <p class="muted">Your requests cannot be loaded right now.</p>
    </div>`;
  }
  if (requests.length === 0) {
    return html``;
  }
  const rows = requests.map(
    (r) =>
      html`<tr>
        <td data-label="Date">${whenLabel(r.startLocal)}</td>
        <td data-label="Event">
          <a href="${localUrl(CREATE_PATHS.request(r.id))}"
            >${memberText(r.title)}</a
          >
        </td>
        <td data-label="Status">${requestStatusBadge(r)}</td>
      </tr>`,
  );
  return html`<div class="card">
    <h2>Your requests</h2>
    <table class="stack">
      <thead>
        <tr>
          <th>Date</th>
          <th>Event</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </div>`;
}

function notFound(res: Response) {
  hostPage(res, {
    title: 'Not found',
    status: 404,
    body: html`<div class="card">
      <h1>Not found</h1>
      <p>That page does not exist, or it is not yours.</p>
    </div>`,
  });
}

function storeUnavailable(res: Response, error: unknown) {
  logger.warn(
    `Host request store failed: ${error instanceof Error ? error.name : 'Error'}`,
  );
  hostPage(res, {
    title: 'Unavailable',
    status: 503,
    body: html`<div class="card">
      <h1>Unavailable</h1>
      <p>
        Requests cannot be saved or read right now. Please try again in a few
        minutes.
      </p>
    </div>`,
  });
}

/** A day the form may start with: a real date after today, else blank. */
function startDay(value: unknown, today: string): string {
  if (typeof value !== 'string' || !DAY.test(value)) {
    return '';
  }
  return dayjs(value).format('YYYY-MM-DD') === value && value > today
    ? value
    : '';
}

/** The new-request alert: plain text, no mentions. */
function newRequestAlert(origin: string, request: EventRequest): LogEntry {
  return {
    title: 'New host event request',
    description: `Review it at ${origin}${DASHBOARD_BASE}/hosts/requests`,
    fields: [
      { name: 'Host', value: request.hostName, inline: true },
      { name: 'When', value: whenLabel(request.startLocal), inline: true },
      { name: 'Title', value: request.title },
    ],
  };
}

/**
 * GET/POST /host/create and GET /host/requests/:id. The router's session
 * gate and unsafe-method guard (rate limit, Origin, CSRF) run first.
 * `origin` is the site's own origin, for the alert's queue link.
 */
export function registerCreatePages(
  router: express.Router,
  deps: CreatePageDeps,
  origin: string,
): void {
  const today = () => pacificDay(deps.now());

  /** The copy source, or 'not-found' unless it exists and this host hosted it. */
  async function ownSource(
    copyId: string,
    session: HostSession,
  ): Promise<CopySource | 'not-found'> {
    if (!EVENT_ID.test(copyId)) {
      return 'not-found';
    }
    const source = await deps.copySource(copyId);
    return source && isHostOf(source, session.userId) ? source : 'not-found';
  }

  router.get('/create', (async (req, res) => {
    const { session } = hostLocals(res);
    const copyId = req.query.copy;
    const day = startDay(req.query.day, today());
    if (copyId === undefined) {
      hostPage(res, {
        title: 'Host an event',
        body: formBody(
          session,
          {
            title: '',
            day,
            time: DEFAULT_TIME,
            duration: DEFAULT_DURATION,
            errors: {},
          },
          today(),
        ),
      });
      return;
    }
    let source: CopySource | 'not-found';
    try {
      source =
        typeof copyId === 'string'
          ? await ownSource(copyId, session)
          : 'not-found';
    } catch (error: unknown) {
      unavailable(res, error);
      return;
    }
    if (source === 'not-found') {
      notFound(res);
      return;
    }
    const defaults = copyDefaults(source);
    hostPage(res, {
      title: 'Copy an event',
      body: formBody(
        session,
        {
          title: Array.from(defaults.title).slice(0, TITLE_MAX).join(''),
          day,
          time: defaults.time,
          duration: defaults.duration,
          copy: source,
          errors: {},
        },
        today(),
      ),
    });
  }) as RequestHandler);

  router.post('/create', (async (req, res) => {
    const { session } = hostLocals(res);
    const body = req.body as unknown;
    const copyId = field(body, 'copy');
    let source: CopySource | undefined;
    if (copyId !== undefined) {
      try {
        const own = await ownSource(copyId, session);
        if (own === 'not-found') {
          notFound(res);
          return;
        }
        source = own;
      } catch (error: unknown) {
        unavailable(res, error);
        return;
      }
    }
    const view = (errors: FormView['errors']): FormView => ({
      title: field(body, 'title') ?? '',
      day: field(body, 'day') ?? '',
      time: field(body, 'time') ?? DEFAULT_TIME,
      duration: field(body, 'duration') ?? DEFAULT_DURATION,
      copy: source,
      errors,
    });
    const parsed = parseRequestForm(
      body as Record<string, unknown> | undefined,
      today(),
    );
    if (parsed.ok === false) {
      hostPage(res, {
        title: source ? 'Copy an event' : 'Host an event',
        status: 422,
        body: formBody(session, view(parsed.errors), today()),
      });
      return;
    }
    const form = parsed.value;
    let created: EventRequest;
    try {
      const store = await deps.requests();
      if (
        session.tier === 'regular' &&
        (await store.countPending(session.userId)) >= MAX_PENDING
      ) {
        hostPage(res, {
          title: source ? 'Copy an event' : 'Host an event',
          status: 429,
          body: formBody(
            session,
            view({
              form: `You already have ${MAX_PENDING} requests waiting for approval. Wait for one to be reviewed before sending another.`,
            }),
            today(),
          ),
        });
        return;
      }
      const settings = source
        ? copySettings(source, form.duration)
        : freshSettings(session.tier, deps.tip(), form.duration);
      created = await store.create({
        meetupMemberId: session.userId,
        discordUserId: session.discordUserId,
        hostName: Array.from(session.username || 'Host')
          .slice(0, 100)
          .join(''),
        tier: session.tier,
        kind: source ? 'copy' : 'fresh',
        sourceEventId: source ? String(source.id) : null,
        title: form.title,
        startLocal: `${form.day}T${form.time}`,
        ...settings,
      });
    } catch (error: unknown) {
      storeUnavailable(res, error);
      return;
    }
    if (session.tier === 'regular') {
      deps.alert(newRequestAlert(origin, created)).catch(() => undefined);
    } else {
      try {
        const outcome = await withDeadline(PUBLISH_DEADLINE_MS, () =>
          deps.publish(created.id, created.version, session.userId),
        );
        if (outcome.code === 'published') {
          deps
            .alert({
              title: 'Community Host published an event',
              description: outcome.request.eventUrl ?? '',
              fields: [
                { name: 'Host', value: created.hostName, inline: true },
                {
                  name: 'When',
                  value: whenLabel(created.startLocal),
                  inline: true,
                },
                { name: 'Title', value: created.title },
              ],
            })
            .catch(() => undefined);
        }
      } catch (error: unknown) {
        // A timeout leaves it publishing; the request page shows where it
        // stopped, and leadership can retry.
        logger.error(
          `Community Host publish threw: ${error instanceof Error ? error.name : 'Error'}`,
        );
      }
    }
    res.redirect(303, CREATE_PATHS.request(created.id));
  }) as RequestHandler);

  router.get('/requests/:id', (async (req, res) => {
    const { session } = hostLocals(res);
    const id = req.params.id;
    if (typeof id !== 'string' || !REQUEST_ID.test(id)) {
      notFound(res);
      return;
    }
    let request: EventRequest | undefined;
    try {
      request = await (await deps.requests()).get(id);
    } catch (error: unknown) {
      storeUnavailable(res, error);
      return;
    }
    if (!request || request.meetupMemberId !== session.userId) {
      notFound(res);
      return;
    }
    hostPage(res, { title: 'Your request', body: requestBody(request) });
  }) as RequestHandler);
}

/** The "Host on this day" link for a calendar day. */
export const createDayLink = (day: string) =>
  pageLink(CREATE_PATHS.create, { day });

/** The "Copy" link for a past event. */
export const copyLink = (eventId: string) =>
  pageLink(CREATE_PATHS.create, { copy: eventId });
