import { randomBytes } from 'node:crypto';

import dayjs from 'dayjs';
import express, { RequestHandler, Response } from 'express';
import { Logger } from 'tslog';

import { DASHBOARD_BASE } from '../../lib/reports/dashboardPaths.js';
import {
  CopySource,
  DEFAULT_DURATION,
  DEFAULT_TIME,
  DESCRIPTION_MAX,
  DURATIONS,
  Duration,
  FormField,
  GUEST_LIMIT_RANGE,
  MAX_DAYS_AHEAD,
  RSVP_LIMIT_RANGE,
  START_TIMES,
  copyDefaults,
  copySettings,
  formMatches,
  freshSettings,
  isHostOf,
  parseRequestForm,
  prefixFor,
  TITLE_MAX,
} from '../../lib/hosts/eventRequest.js';
import {
  GUEST_HOST_EVENT_DESCRIPTION,
  createEventTemplate,
} from '../../templates/createEventTemplate.js';
import { pacificDay } from '../../lib/hosts/hostEvents.js';
import { PublishOutcome } from '../../lib/hosts/publishRequest.js';
import { LogEntry, alertText } from '../../lib/helpers/discordLogger.js';
import {
  EventRequest,
  NewEventRequest,
  SUBMIT_TOKEN,
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
  /** undefined when the host already sent this form (same submitToken). */
  create: (input: NewEventRequest) => Promise<EventRequest | undefined>;
  findBySubmitToken: (
    meetupMemberId: string,
    submitToken: string,
  ) => Promise<EventRequest | undefined>;
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
  /** Tests only: how long a Community Host's publish holds the page. */
  publishDeadlineMs?: number;
}

interface FormView {
  title: string;
  day: string;
  time: string;
  duration: string;
  /** The optional fields, as typed (a fresh event only). */
  description: string;
  rsvpLimit: string;
  guestLimit: string;
  copy?: CopySource;
  /** One per rendered form: sending it twice makes one request. */
  submitToken: string;
  errors: Partial<Record<FormField | 'form', string>>;
}

const newSubmitToken = () => randomBytes(18).toString('base64url');

/** The optional fields as a fresh form starts: the template's description, blank limits. */
const DEFAULT_OPTIONS = {
  description: GUEST_HOST_EVENT_DESCRIPTION,
  rsvpLimit: '',
  guestLimit: '',
} as const;

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

const TEMPLATE_LIMITS = createEventTemplate.rsvpSettings;

/**
 * A fresh event's optional fields, folded away: open when the host changed
 * one or one has an error, so nothing they typed is hidden.
 */
function moreOptions(view: FormView): SafeHtml {
  const changed =
    view.rsvpLimit.trim() !== '' ||
    view.guestLimit.trim() !== '' ||
    view.description.replace(/\r\n?/g, '\n').trim() !==
      GUEST_HOST_EVENT_DESCRIPTION.trim();
  const hasError =
    view.errors.description !== undefined ||
    view.errors.rsvpLimit !== undefined ||
    view.errors.guestLimit !== undefined;
  const inner = html`<summary>More options</summary>
    <p class="muted">
      Optional. Leave these as they are to use the group's standard description
      and limits.
    </p>
    <label class="field"
      >Description
      <textarea name="description" rows="10" maxlength="${DESCRIPTION_MAX}">
${view.description}</textarea>
      ${errorText(view.errors.description)}
    </label>
    <label class="field"
      >RSVP limit (${RSVP_LIMIT_RANGE.min}–${RSVP_LIMIT_RANGE.max}; blank means
      ${TEMPLATE_LIMITS.rsvpLimit})
      <input
        name="rsvpLimit"
        type="number"
        inputmode="numeric"
        min="${RSVP_LIMIT_RANGE.min}"
        max="${RSVP_LIMIT_RANGE.max}"
        value="${view.rsvpLimit}"
      />
      ${errorText(view.errors.rsvpLimit)}
    </label>
    <label class="field"
      >Guests per member (${GUEST_LIMIT_RANGE.min}–${GUEST_LIMIT_RANGE.max};
      blank means ${TEMPLATE_LIMITS.guestLimit})
      <input
        name="guestLimit"
        type="number"
        inputmode="numeric"
        min="${GUEST_LIMIT_RANGE.min}"
        max="${GUEST_LIMIT_RANGE.max}"
        value="${view.guestLimit}"
      />
      ${errorText(view.errors.guestLimit)}
    </label>`;
  return changed || hasError
    ? html`<details class="more-options" open>${inner}</details>`
    : html`<details class="more-options">${inner}</details>`;
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
          The event starts with the group's standard description and limits;
          change them under More options if you like. Once it is on Meetup you
          are its host, so you can fill in the details there too.
        </p>
        <p class="note info">
          Doing one again? Copy one of your past events:
          <a href="${pageLink(`${HOST_BASE}/history`)}">open My history</a> and
          press "Copy this event" on it. Its description, photo, venue and
          limits come with it.
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
      <input type="hidden" name="submit" value="${view.submitToken}" />
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
      ${source ? '' : moreOptions(view)} ${next}
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

function requestBody(request: EventRequest, resentChanged: boolean): SafeHtml {
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
    ${
      resentChanged
        ? html`<p class="note attn">
            That form had already been sent, so the changes in your second send
            were not saved. This is the request it made. To change it, send a
            new request from home.
          </p>`
        : ''
    }
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

/** The new-request alert: plain text, no mentions, markdown escaped. */
function newRequestAlert(origin: string, request: EventRequest): LogEntry {
  return {
    title: 'New host event request',
    description: `Review it at ${origin}${DASHBOARD_BASE}/hosts/requests`,
    fields: [
      { name: 'Host', value: alertText(request.hostName), inline: true },
      { name: 'When', value: whenLabel(request.startLocal), inline: true },
      { name: 'Title', value: alertText(request.title) },
    ],
  };
}

/** A Community Host's published event: plain text, markdown escaped. */
function publishedAlert(
  created: EventRequest,
  published: EventRequest,
): LogEntry {
  return {
    title: 'Community Host published an event',
    description: published.eventUrl ?? '',
    fields: [
      { name: 'Host', value: alertText(created.hostName), inline: true },
      { name: 'When', value: whenLabel(created.startLocal), inline: true },
      { name: 'Title', value: alertText(created.title) },
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
            ...DEFAULT_OPTIONS,
            submitToken: newSubmitToken(),
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
          ...DEFAULT_OPTIONS,
          copy: source,
          submitToken: newSubmitToken(),
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
    const sentToken = field(body, 'submit');
    const submitToken =
      sentToken !== undefined && SUBMIT_TOKEN.test(sentToken)
        ? sentToken
        : undefined;
    const view = (errors: FormView['errors']): FormView => ({
      title: field(body, 'title') ?? '',
      day: field(body, 'day') ?? '',
      time: field(body, 'time') ?? DEFAULT_TIME,
      duration: field(body, 'duration') ?? DEFAULT_DURATION,
      description: field(body, 'description') ?? DEFAULT_OPTIONS.description,
      rsvpLimit: field(body, 'rsvpLimit') ?? '',
      guestLimit: field(body, 'guestLimit') ?? '',
      copy: source,
      // Kept on a re-render, so the corrected form is still one request.
      submitToken: submitToken ?? newSubmitToken(),
      errors,
    });
    // A copy keeps its source's description and limits and its form has no
    // fields for them, so any sent are ignored, never shown as errors.
    const formFields = body as Record<string, unknown> | undefined;
    const parsed = parseRequestForm(
      source
        ? {
            ...formFields,
            description: undefined,
            rsvpLimit: undefined,
            guestLimit: undefined,
          }
        : formFields,
      today(),
    );
    if (parsed.ok === false || submitToken === undefined) {
      hostPage(res, {
        title: source ? 'Copy an event' : 'Host an event',
        status: 422,
        body: formBody(
          session,
          view(
            parsed.ok === false
              ? parsed.errors
              : {
                  form: 'This form was out of date. Check the details and send it again.',
                },
          ),
          today(),
        ),
      });
      return;
    }
    const form = parsed.value;
    /**
     * The request this form already made: its page, not a second request.
     * If this send differs from the first, the page says the changes were
     * not saved rather than dropping them silently.
     */
    const toExisting = (existing: EventRequest) =>
      res.redirect(
        303,
        formMatches(existing, form, source ? 'copy' : 'fresh')
          ? CREATE_PATHS.request(existing.id)
          : `${CREATE_PATHS.request(existing.id)}?resent=changed`,
      );
    let created: EventRequest | undefined;
    try {
      const store = await deps.requests();
      const sent = await store.findBySubmitToken(session.userId, submitToken);
      if (sent !== undefined) {
        toExisting(sent);
        return;
      }
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
        : freshSettings(session.tier, deps.tip(), form.duration, form);
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
        submitToken,
        ...settings,
      });
      if (created === undefined) {
        // The same form landed twice at once; the other one made it.
        const raced = await store.findBySubmitToken(
          session.userId,
          submitToken,
        );
        if (raced === undefined) {
          throw new Error('Request with this submit token vanished');
        }
        toExisting(raced);
        return;
      }
    } catch (error: unknown) {
      storeUnavailable(res, error);
      return;
    }
    if (session.tier === 'regular') {
      deps.alert(newRequestAlert(origin, created)).catch(() => undefined);
    } else {
      // The alert rides on the publish itself, not on the page's deadline:
      // a slow publish that finishes after the page moved on still alerts.
      const publishing = deps
        .publish(created.id, created.version, session.userId)
        .then((outcome) => {
          if (outcome.code === 'published') {
            deps
              .alert(publishedAlert(created, outcome.request))
              .catch(() => undefined);
          }
          return outcome;
        });
      publishing.catch((error: unknown) => {
        logger.error(
          `Community Host publish threw: ${error instanceof Error ? error.name : 'Error'}`,
        );
      });
      try {
        await withDeadline(
          deps.publishDeadlineMs ?? PUBLISH_DEADLINE_MS,
          () => publishing,
        );
      } catch {
        // A timeout leaves it publishing (it goes on, and alerts when done);
        // the request page shows where it stopped, and leadership can retry.
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
    hostPage(res, {
      title: 'Your request',
      body: requestBody(request, req.query.resent === 'changed'),
    });
  }) as RequestHandler);
}

/** The "Host on this day" link for a calendar day. */
export const createDayLink = (day: string) =>
  pageLink(CREATE_PATHS.create, { day });

/** The "Copy" link for a past event. */
export const copyLink = (eventId: string) =>
  pageLink(CREATE_PATHS.create, { copy: eventId });
