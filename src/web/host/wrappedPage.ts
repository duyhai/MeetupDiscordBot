/**
 * /host/wrapped: a linked member's 1.5 Gen Wrapped on the website, the
 * second front door onto the Discord command's stats. The same cache entry,
 * hourly build slot and in-flight lease as /wrapped (handlers.ts), so web
 * and Discord together cost Meetup at most one build an hour per member.
 * The build reads Meetup with the member's own stored token; nothing here
 * writes anything but the Wrapped cache. Other people appear only as
 * server display names of linked members, resolved through the bot at
 * render time; everyone else is a count.
 */
import dayjs from 'dayjs';
import express, { RequestHandler, Response } from 'express';
import { Logger } from 'tslog';

import { KeyValueCache } from '../../lib/cache/base.js';
import { LogEntry } from '../../lib/helpers/discordLogger.js';
import { EVENT_TYPE_LABELS } from '../../lib/hosts/eventTypes.js';
import { describeBuildError } from '../../lib/reports/buildJob.js';
import { WrappedBackfillStore } from '../../lib/repositories/postgresWrappedBackfillRepository.js';
import { WrappedEntryStore } from '../../lib/repositories/postgresWrappedEntryRepository.js';
import {
  BuildDeps,
  BuildResult,
  WrappedMeetup,
  buildWrapped,
} from '../../lib/wrapped/build.js';
import {
  BUILDING_LEASE_TTL_SEC,
  CachedWrapped,
  FIRST_WRAPPED_YEAR,
  buildingKey,
} from '../../lib/wrapped/cache.js';
import { CompanionDeps, NamedCompanion } from '../../lib/wrapped/companions.js';
import {
  HostedRanked,
  NamedCohort,
  TopType,
  WrappedEvent,
} from '../../lib/wrapped/stats.js';
import {
  nextTickAt,
  pacificClock,
  queueForLater,
  queuedText,
  readyBy,
} from '../../lib/wrapped/queue.js';
import {
  WrappedTiers,
  readEntry,
  writeEntry,
} from '../../lib/wrapped/store.js';
import { tz } from '../../util/timezone.js';
import {
  SafeHtml,
  html,
  localUrl,
  memberText,
  pageLink,
  safeHref,
} from '../html.js';
import { FixedWindowLimiter } from '../rateLimit.js';
import { hostPage } from './hostPageKit.js';
import { hostLocals } from './hostRouter.js';
import { HOST_BASE, HostSession } from './hostSession.js';

const logger = new Logger({ name: 'hostDashboard' });

export const WRAPPED_PATH = `${HOST_BASE}/wrapped`;
const REBUILD_PATH = `${WRAPPED_PATH}/rebuild`;
const LINK_DISCORD_PATH = `${HOST_BASE}/link/discord`;
const MEETUP_SIGN_IN = `${HOST_BASE}/auth/meetup/start`;
/** How long the page waits for Meetup; the build goes on after that. */
const BUILD_DEADLINE_MS = 20_000;
/** Companions and cohort members shown before the "Show all" expander. */
export const COMPANIONS_SHOWN = 3;
export const COHORT_SHOWN = 5;

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export interface WrappedPageDeps {
  /** The Wrapped cache: the bot's ApplicationCache, not the 2 s timed one. */
  cache: () => Promise<KeyValueCache>;
  /** The member's stored Meetup access token (the bot's store), if usable. */
  memberToken: (discordUserId: string) => Promise<string | undefined>;
  meetupClient: (accessToken: string) => WrappedMeetup;
  organizerRsvps: BuildDeps['organizerRsvps'];
  findByMeetupId: CompanionDeps['findByMeetupId'];
  isPresent: CompanionDeps['isPresent'];
  /** A linked companion's server display name; undefined → counted. */
  displayName: (discordUserId: string) => Promise<string | undefined>;
  /** wrappedBuildLimiter in production: the slot /wrapped takes. */
  limiter: FixedWindowLimiter;
  /** #meetup-bot-alerts, plain (no mentions). */
  alert: (entry: LogEntry) => Promise<unknown>;
  groupId: string;
  now?: () => Date;
  /** Tests only. */
  deadlineMs?: number;
  /** The backfill queue; left out, a throttled request is only told to wait. */
  queue?: () => Promise<WrappedBackfillStore>;
  /** The durable Wrapped store; left out or rejecting, Redis alone. */
  entries?: () => Promise<WrappedEntryStore>;
}

/** `?year=`: this calendar year (Pacific) unless a year 2015..this year. */
export function wrappedYear(query: unknown, now: Date): number {
  const thisYear = tz(dayjs(now)).year();
  if (typeof query !== 'string' || !/^\d{4}$/.test(query)) {
    return thisYear;
  }
  const year = Number(query);
  return year >= FIRST_WRAPPED_YEAR && year <= thisYear ? year : thisYear;
}

/**
 * The picker's years, newest first: this year, then each earlier year with a
 * counted event in any of the copies given (this year's cached copy keeps
 * the list current when a past year is shown).
 */
export function yearList(
  thisYear: number,
  ...copies: (CachedWrapped | undefined)[]
): number[] {
  const years = new Set<number>([thisYear]);
  copies.forEach((copy) =>
    copy?.stats.activeYears.forEach((year) => {
      if (year < thisYear) {
        years.add(year);
      }
    }),
  );
  return [...years].sort((a, b) => b - a);
}

/** Every `?notice=` code: fixed texts only; the code itself is never shown. */
export const WRAPPED_NOTICES = {
  'rate-limited': (minutes: number) =>
    `You built your Wrapped less than an hour ago (here or in Discord); try again in ${plural(minutes, 'minute')}.`,
  mismatch: () =>
    'The Meetup account you connected is not the one linked to your Discord. Sign in with Meetup again to reconnect it.',
  'not-in-group': () =>
    'We cannot see your Meetup history. Are you still a member of the Meetup group?',
  building: () =>
    'Your Wrapped is already being built (perhaps in Discord). Reload in a minute.',
  slow: () =>
    "Still building your Wrapped — you've been busy! Reload in a minute.",
  failed: () =>
    'Could not build your Wrapped right now; try again in a little while.',
  'no-token': () =>
    'To build your Wrapped we need your Meetup connection. Sign in with Meetup below, or run /wrapped in Discord.',
  // The queued texts come from the queue itself (queuedNotice): these are
  // the fallback when the row is gone by the time the page is read.
  queued: () => 'Your Wrapped is queued; reload in a few minutes.',
  'already-queued': () => 'Your Wrapped is queued; reload in a few minutes.',
} as const;

type NoticeCode = keyof typeof WRAPPED_NOTICES;

const isNoticeCode = (value: unknown): value is NoticeCode =>
  typeof value === 'string' && Object.hasOwn(WRAPPED_NOTICES, value);

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function notice(code: NoticeCode, retryMinutes: number): SafeHtml {
  const text = WRAPPED_NOTICES[code](retryMinutes);
  return code === 'building' || code === 'slow'
    ? html`<p class="note info">${text}</p>`
    : html`<p class="note attn">${text}</p>`;
}

function yearNav(years: number[], current: number): SafeHtml {
  return html`<nav class="pager choices" aria-label="Year">
    ${years.map((year) => {
      if (year === current) {
        return html`<strong aria-current="page">${String(year)}</strong>`;
      }
      return html`<a href="${pageLink(WRAPPED_PATH, { year: String(year) })}"
        >${String(year)}</a
      >`;
    })}
  </nav>`;
}

/** A Discord user id, as discordOAuth.ts checks it: nothing else goes into a profile URL. */
const SNOWFLAKE = /^\d{17,20}$/;

/** A linked member: their server display name linking to their Discord profile (the identity they consented to by linking). */
function profileLink(discordUserId: string, name: string): SafeHtml {
  const href = SNOWFLAKE.test(discordUserId)
    ? safeHref(`https://discord.com/users/${discordUserId}`)
    : undefined;
  const text = memberText(name);
  return href
    ? html`<a href="${href}" rel="noopener noreferrer" target="_blank"
        >${text}</a
      >`
    : text;
}

/** One of the member's own events: Pacific date and a Meetup link (text when the URL is not one). */
function eventItem(event: WrappedEvent): SafeHtml {
  const href = safeHref(event.eventUrl);
  const title = memberText(event.title);
  const link = href
    ? html`<a href="${href}" rel="noopener noreferrer" target="_blank"
        >${title}</a
      >`
    : title;
  return html`<li>
    <time>${tz(dayjs(event.dateTime)).format('ll')}</time> · ${link}
  </li>`;
}

function eventList(events: WrappedEvent[]): SafeHtml {
  return html`<ul class="event-list">
    ${events.map(eventItem)}
  </ul>`;
}

/** The first `shown` items, then the rest behind "Show all N". */
function showAll(items: SafeHtml[], shown: number): SafeHtml {
  const first = items.slice(0, shown);
  const rest = items.slice(shown);
  return html`<ul class="people">
      ${first.map((item) => html`<li>${item}</li>`)}
    </ul>
    ${
      rest.length > 0
        ? html`<details>
            <summary>Show all ${String(items.length)}</summary>
            <ul class="people">
              ${rest.map((item) => html`<li>${item}</li>`)}
            </ul>
          </details>`
        : ''
    }`;
}

/**
 * Linked companions by display name, three first and the rest behind an
 * expander; anyone not in the map (or never named) is counted. Under the
 * top companion, the events the two of you shared.
 */
function companionsSection(
  wrapped: CachedWrapped,
  displayNames: Record<string, string>,
): SafeHtml {
  const { named, otherCount } = wrapped.companions;
  if (named.length === 0 && otherCount === 0) {
    return html`<p>Nobody yet — next year!</p>`;
  }
  const resolved: (NamedCompanion & { name: string })[] = [];
  let others = otherCount;
  named.forEach((companion) => {
    const name = displayNames[companion.discordUserId];
    if (name === undefined) {
      others += 1;
    } else {
      resolved.push({ ...companion, name });
    }
  });
  const items = resolved.map(
    ({ discordUserId, name, sharedCount }) =>
      html`<strong>${profileLink(discordUserId, name)}</strong>
        (${plural(sharedCount, 'event')})`,
  );
  const top = resolved[0];
  const together =
    top?.sharedEvents && top.sharedEvents.length > 0
      ? html`<details>
          <summary>
            Together with ${memberText(top.name)}
            (${plural(top.sharedEvents.length, 'event')})
          </summary>
          ${eventList(top.sharedEvents)}
        </details>`
      : '';
  const othersText =
    others > 0
      ? html`<p class="muted">
          ${items.length > 0 ? 'and ' : ''}${plural(others, 'other member')}
          ${items.length > 0 ? '' : 'you shared events with'}
        </p>`
      : '';
  return html`${items.length > 0 ? showAll(items, COMPANIONS_SHOWN) : ''}
  ${othersText} ${together}`;
}

function hostedItem({ event, attendance }: HostedRanked): SafeHtml {
  const href = safeHref(event.eventUrl);
  const title = memberText(event.title);
  const link = href
    ? html`<a href="${href}" rel="noopener noreferrer" target="_blank"
        >${title}</a
      >`
    : title;
  return html`<li>
    ${link} (${String(attendance)} RSVPs) ·
    <time>${tz(dayjs(event.dateTime)).format('ll')}</time>
  </li>`;
}

function hostingSection(
  hosting: NonNullable<CachedWrapped['stats']['hosting']>,
): SafeHtml {
  return html`<p>
      You hosted ${plural(hosting.thisYear, 'event')} this year
      (${String(hosting.allTime)} all-time). Thank you!
    </p>
    ${
      hosting.topThisYear.length > 0
        ? html`<h3>Most attended this year</h3>
            <ol>
              ${hosting.topThisYear.map(hostedItem)}
            </ol>`
        : ''
    }
    ${
      hosting.allTimeBest
        ? html`<h3>All-time most attended</h3>
            <ul class="event-list">
              ${hostedItem(hosting.allTimeBest)}
            </ul>`
        : ''
    }`;
}

function cohortSection(
  cohort: NamedCohort,
  displayNames: Record<string, string>,
): SafeHtml {
  let others = cohort.otherCount;
  const items: SafeHtml[] = [];
  cohort.named.forEach(({ discordUserId, earlyCount, sharedCount }) => {
    const name = displayNames[discordUserId];
    if (name === undefined) {
      others += 1;
      return;
    }
    items.push(
      html`${profileLink(discordUserId, name)}
      (${plural(earlyCount, 'early event')}, ${String(sharedCount)} this year)`,
    );
  });
  if (items.length === 0 && others === 0) {
    return html``;
  }
  // A backfill reads one page of a big early event: the counts are "at least".
  const atLeast = cohort.partial ? 'at least ' : '';
  const shown = items.length > 0 ? items.length : others;
  const summary = `Still around from your early cohort (${atLeast}${String(shown)})`;
  const othersText = `${items.length > 0 ? 'and ' : ''}${atLeast}${plural(others, 'other member')}`;
  return html`<details>
    <summary>${summary}</summary>
    ${items.length > 0 ? showAll(items, COHORT_SHOWN) : ''}
    ${others > 0 ? html`<p class="muted">${othersText}</p>` : ''}
  </details>`;
}

function topTypeItem(
  top: TopType,
  displayNames: Record<string, string>,
): SafeHtml {
  const label = EVENT_TYPE_LABELS[top.type];
  return html`<li>
    ${label} (${plural(top.count, 'event')})
    ${
      top.firstEvents.length > 0
        ? html`<details>
            <summary>
              Your first ${String(top.firstEvents.length)}
              ${label.toLowerCase()}
              ${top.firstEvents.length === 1 ? 'event' : 'events'}
            </summary>
            ${eventList(top.firstEvents)}
            ${cohortSection(top.cohort, displayNames)}
          </details>`
        : ''
    }
  </li>`;
}

function firstEventText(wrapped: CachedWrapped): SafeHtml {
  const { firstEvent } = wrapped.stats;
  if (!firstEvent) {
    return html`Still ahead of you!`;
  }
  const href = safeHref(firstEvent.eventUrl);
  const title = memberText(firstEvent.title);
  const link = href
    ? html`<a href="${href}" rel="noopener noreferrer" target="_blank"
        >${title}</a
      >`
    : title;
  return html`${link} on ${tz(dayjs(firstEvent.dateTime)).format('ll')}`;
}

/**
 * The Wrapped itself: the embed's sections as cards. Linked companions by
 * the display names given; anyone not in the map is counted.
 */
export function wrappedBody({
  session,
  wrapped,
  years,
  displayNames,
  notice: noticeHtml = '',
}: {
  session: HostSession;
  wrapped: CachedWrapped;
  years: number[];
  displayNames: Record<string, string>;
  notice?: SafeHtml | '';
}): SafeHtml {
  const { stats } = wrapped;
  const { year } = stats;
  const thisYear = stats.attendedThisYear;
  return html`<div class="card">
      <h1>
        🎁 ${memberText(session.username)}'s 1.5 Gen Wrapped ${String(year)}
      </h1>
      ${yearNav(years, year)}
      <p class="muted">
        A past year is built on the same once-an-hour limit as this one, here or
        in Discord.
      </p>
      ${noticeHtml}
      ${
        thisYear === 0
          ? html`<p>
              A quiet year: no events in ${String(year)}, but
              ${plural(stats.attendedAllTime, 'event')} with us all-time. See
              you at the next one!
            </p>`
          : ''
      }
      <dl class="stats">
        <div class="stat">
          <dt>Events in ${String(year)}</dt>
          <dd>${String(thisYear)}</dd>
        </div>
        <div class="stat">
          <dt>All-time</dt>
          <dd>${String(stats.attendedAllTime)}</dd>
        </div>
        <div class="stat">
          <dt>Longest streak (months)</dt>
          <dd>
            ${stats.longestStreakMonths > 0 ? String(stats.longestStreakMonths) : '—'}
          </dd>
        </div>
      </dl>
    </div>
    <div class="card">
      <h2>First event with us</h2>
      <p>${firstEventText(wrapped)}</p>
    </div>
    <div class="card">
      <h2>Top activities</h2>
      ${
        stats.topTypes.length > 0
          ? html`<ul class="top-types">
              ${stats.topTypes.map((top) => topTypeItem(top, displayNames))}
            </ul>`
          : html`<p class="muted">None this year</p>`
      }
    </div>
    ${
      stats.hosting
        ? html`<div class="card">
            <h2>Hosting</h2>
            ${hostingSection(stats.hosting)}
          </div>`
        : ''
    }
    <div class="card">
      <h2>Busiest month</h2>
      <p>
        ${
          stats.busiestMonth
            ? html`${MONTHS[stats.busiestMonth.month]}
              (${plural(stats.busiestMonth.count, 'event')})`
            : html`None this year`
        }
      </p>
      ${
        stats.busiestMonth && stats.busiestMonth.events.length > 0
          ? html`<details>
              <summary>
                Events that month (${String(stats.busiestMonth.events.length)})
              </summary>
              ${eventList(stats.busiestMonth.events)}
            </details>`
          : ''
      }
    </div>
    <div class="card">
      <h2>Went with the most</h2>
      ${companionsSection(wrapped, displayNames)}
      <p class="muted">
        Counted from Meetup RSVPs, so an event you signed up for but missed
        still counts. Only members who have linked their Meetup account are
        named.
      </p>
      <form method="post" action="${localUrl(REBUILD_PATH)}">
        <input type="hidden" name="_csrf" value="${session.csrfToken}" />
        <input type="hidden" name="year" value="${String(year)}" />
        <button type="submit" class="secondary">Rebuild from Meetup</button>
      </form>
      <p class="muted">
        Rebuilding reads Meetup again, once an hour at most (here or in
        Discord).
      </p>
    </div>`;
}

/** A page with no Wrapped to show: a notice and what to do next. */
function messageBody(
  session: HostSession,
  years: number[],
  year: number,
  body: SafeHtml,
): SafeHtml {
  return html`<div class="card">
    <h1>
      🎁 ${memberText(session.username)}'s 1.5 Gen Wrapped ${String(year)}
    </h1>
    ${yearNav(years, year)} ${body}
  </div>`;
}

type Outcome =
  BuildResult | { kind: 'building' } | { kind: 'slow' } | { kind: 'failed' };

/** Notices whose rebuild would be refused anyway: shown, nothing built. */
const FINAL_NOTICES: readonly NoticeCode[] = [
  'rate-limited',
  'mismatch',
  'not-in-group',
  'no-token',
  'queued',
  'already-queued',
];

export function registerWrappedPage(
  router: express.Router,
  deps: WrappedPageDeps,
): void {
  const now = deps.now ?? (() => new Date());
  const deadlineMs = deps.deadlineMs ?? BUILD_DEADLINE_MS;

  /**
   * One build, as runWrapped does it: the lease, the member's client, the
   * shared slot (taken only once the history is readable), the cache write.
   * Resolves `slow` at the deadline while the build goes on; `failed` after
   * the alert. Never throws.
   */
  async function build(
    session: HostSession,
    discordUserId: string,
    year: number,
    accessToken: string,
    tiers: WrappedTiers,
  ): Promise<Outcome> {
    const { cache } = tiers;
    const lease = buildingKey(discordUserId, year);
    if (
      !(await cache.exclusive_set(
        lease,
        now().toISOString(),
        BUILDING_LEASE_TTL_SEC,
      ))
    ) {
      return { kind: 'building' };
    }
    let claimed = false;
    const run = (async (): Promise<Outcome> => {
      try {
        const result = await buildWrapped(
          {
            meetup: deps.meetupClient(accessToken),
            claimBuild: () => {
              claimed = deps.limiter.take(discordUserId);
              return claimed;
            },
            organizerRsvps: deps.organizerRsvps,
            findByMeetupId: deps.findByMeetupId,
            isPresent: deps.isPresent,
            now,
          },
          session.userId,
          year,
          deps.groupId,
        );
        if (result.kind === 'built') {
          await writeEntry(tiers, discordUserId, year, result.wrapped, now());
          await dropQueued(discordUserId, year);
        } else if (result.kind === 'account-mismatch') {
          logger.warn(
            `Wrapped (web): token account ${result.tokenMeetupId} is not the linked account for Discord user ${discordUserId}`,
          );
        }
        return result;
      } catch (error: unknown) {
        if (claimed) {
          // The member got nothing for the slot.
          deps.limiter.release(discordUserId);
        }
        // Name only here; the alert carries a composed summary, never
        // Meetup's response body.
        logger.error(
          `Wrapped (web) build failed: ${error instanceof Error ? error.name : 'Error'}`,
        );
        try {
          await deps.alert({
            title: 'Wrapped on the website failed',
            description:
              `Member: <@${discordUserId}> (Meetup member ${session.userId})\n` +
              `Error: ${describeBuildError(error)}`,
          });
        } catch (alertError: unknown) {
          logger.warn(
            `Could not post the Wrapped alert: ${alertError instanceof Error ? alertError.name : 'Error'}`,
          );
        }
        return { kind: 'failed' };
      } finally {
        await cache.remove(lease).catch(() => undefined);
      }
    })();
    let timer: NodeJS.Timeout | undefined;
    const slow = new Promise<Outcome>((resolve) => {
      timer = setTimeout(() => {
        resolve({ kind: 'slow' });
      }, deadlineMs);
    });
    try {
      return await Promise.race([run, slow]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Both tiers; a Postgres that cannot be reached leaves the Redis tier alone. */
  async function tiersFor(): Promise<WrappedTiers> {
    const cache = await deps.cache();
    if (!deps.entries) {
      return { cache };
    }
    try {
      return { cache, entries: await deps.entries() };
    } catch (error) {
      logger.warn(
        `Wrapped entries unavailable, Redis only: ${error instanceof Error ? error.name : 'Error'}`,
      );
      return { cache };
    }
  }

  /**
   * Throttled with nothing stored for `year`: queue it (or say which year is
   * already queued) instead of a build that would only be refused. Undefined
   * when there is no queue, it failed, or a copy exists after all.
   */
  async function queueOnThrottle(
    discordUserId: string,
    meetupId: string,
    year: number,
    tiers: WrappedTiers,
  ): Promise<SafeHtml | undefined> {
    if (!deps.queue) {
      return undefined;
    }
    try {
      const outcome = await queueForLater(
        await deps.queue(),
        tiers,
        { discordUserId, meetupId },
        year,
        now(),
      );
      if (outcome.kind === 'cached') {
        return undefined;
      }
      const minutes = Math.max(
        1,
        Math.ceil(deps.limiter.retryAfterSec(discordUserId) / 60),
      );
      return html`<p class="note info">
        ${WRAPPED_NOTICES['rate-limited'](minutes)}
        ${queuedText(outcome, pacificClock)}
      </p>`;
    } catch (error) {
      logger.warn(
        `Could not queue the Wrapped: ${error instanceof Error ? error.name : 'Error'}`,
      );
      return undefined;
    }
  }

  /**
   * The queued state, from the queue itself: the hourly-limit line and when
   * the backfill will have built it. Undefined when the member has no row
   * (built or dropped since), or there is no queue.
   */
  async function queuedNotice(
    discordUserId: string,
    cache: KeyValueCache,
    year: number,
  ): Promise<SafeHtml | undefined> {
    if (!deps.queue) {
      return undefined;
    }
    try {
      const store = await deps.queue();
      const queued = await store.position(discordUserId);
      if (!queued) {
        return undefined;
      }
      const minutes = Math.max(
        1,
        Math.ceil(deps.limiter.retryAfterSec(discordUserId) / 60),
      );
      const text = queuedText(
        {
          kind: queued.row.year === year ? 'queued' : 'already',
          year: queued.row.year,
          readyBy: readyBy(await nextTickAt(cache, now()), queued.position),
        },
        pacificClock,
      );
      return html`<p class="note info">
        ${WRAPPED_NOTICES['rate-limited'](minutes)} ${text}
      </p>`;
    } catch (error) {
      logger.warn(
        `Could not read the Wrapped queue: ${error instanceof Error ? error.name : 'Error'}`,
      );
      return undefined;
    }
  }

  /** After an on-demand build, a queued request for that year is moot. */
  async function dropQueued(
    discordUserId: string,
    year: number,
  ): Promise<void> {
    if (!deps.queue) {
      return;
    }
    try {
      await (await deps.queue()).complete(discordUserId, year);
    } catch {
      // The tick drops it as fresh.
    }
  }

  /** Every named person's display name (companions and cohorts), through the bot, in parallel. */
  async function namesFor(
    wrapped: CachedWrapped,
  ): Promise<Record<string, string>> {
    const names: Record<string, string> = {};
    const ids = new Set<string>([
      ...wrapped.companions.named.map((c) => c.discordUserId),
      ...wrapped.stats.topTypes.flatMap((top) =>
        top.cohort.named.map((c) => c.discordUserId),
      ),
    ]);
    await Promise.all(
      [...ids].map(async (discordUserId) => {
        try {
          const name = await deps.displayName(discordUserId);
          if (name !== undefined) {
            names[discordUserId] = name;
          }
        } catch {
          // Counted, not named.
        }
      }),
    );
    return names;
  }

  async function render(
    res: Response,
    session: HostSession,
    year: number,
    wrapped: CachedWrapped,
    tiers: WrappedTiers,
    noticeHtml: SafeHtml | '' = '',
    status = 200,
  ) {
    const thisYear = tz(dayjs(now())).year();
    const current =
      year === thisYear
        ? undefined
        : await readEntry(
            tiers,
            session.discordUserId ?? '',
            thisYear,
            session.userId,
            now(),
          );
    hostPage(res, {
      title: `Wrapped ${year}`,
      current: 'wrapped',
      status,
      body: wrappedBody({
        session,
        wrapped,
        years: yearList(thisYear, wrapped, current),
        displayNames: await namesFor(wrapped),
        notice: noticeHtml,
      }),
    });
  }

  function message(
    res: Response,
    session: HostSession,
    year: number,
    body: SafeHtml,
    status = 200,
  ) {
    hostPage(res, {
      title: `Wrapped ${year}`,
      current: 'wrapped',
      status,
      body: messageBody(session, yearList(tz(dayjs(now())).year()), year, body),
    });
  }

  const meetupSignIn = html`<p>
    <a class="button" href="${localUrl(MEETUP_SIGN_IN)}">Sign in with Meetup</a>
  </p>`;

  /** What an outcome other than `built` shows, with any cached copy under it. */
  async function show(
    res: Response,
    session: HostSession,
    discordUserId: string,
    year: number,
    outcome: Exclude<Outcome, { kind: 'built' }>,
    tiers: WrappedTiers,
  ) {
    const minutes = Math.ceil(deps.limiter.retryAfterSec(discordUserId) / 60);
    const code: NoticeCode =
      outcome.kind === 'rate-limited'
        ? 'rate-limited'
        : outcome.kind === 'account-mismatch'
          ? 'mismatch'
          : outcome.kind === 'not-in-group'
            ? 'not-in-group'
            : outcome.kind;
    const status = code === 'failed' ? 503 : 200;
    const cached = await readEntry(
      tiers,
      discordUserId,
      year,
      session.userId,
      now(),
    );
    if (cached) {
      await render(
        res,
        session,
        year,
        cached,
        tiers,
        notice(code, minutes),
        status,
      );
      return;
    }
    message(
      res,
      session,
      year,
      html`${notice(code, minutes)} ${code === 'mismatch' ? meetupSignIn : ''}`,
      status,
    );
  }

  /** Steps 2–5 of the spec's flow: token, lease, build, outcome. */
  async function buildAndShow(
    res: Response,
    session: HostSession,
    discordUserId: string,
    year: number,
    tiers: WrappedTiers,
  ) {
    const token = await deps.memberToken(discordUserId);
    if (token === undefined) {
      message(
        res,
        session,
        year,
        html`${notice('no-token', 0)} ${meetupSignIn}
          <p class="muted">
            Signing in with Meetup keeps your Meetup connection for Wrapped; it
            does not change your link.
          </p>`,
      );
      return;
    }
    const outcome = await build(session, discordUserId, year, token, tiers);
    if (outcome.kind === 'built') {
      await render(res, session, year, outcome.wrapped, tiers);
      return;
    }
    await show(res, session, discordUserId, year, outcome, tiers);
  }

  const notLinked = (session: HostSession) =>
    html`<div class="note info">
      <p>
        Wrapped is for linked members. Link your Discord account and you can see
        your year with the group here and with /wrapped in Discord.
      </p>
      ${
        session.via === 'meetup'
          ? html`<form method="post" action="${localUrl(LINK_DISCORD_PATH)}">
              <input type="hidden" name="_csrf" value="${session.csrfToken}" />
              <button type="submit">Verify on Discord</button>
            </form>`
          : ''
      }
    </div>`;

  router.get('/wrapped', (async (req, res) => {
    const { session } = hostLocals(res);
    const year = wrappedYear(req.query.year, now());
    if (session.discordUserId === null) {
      message(res, session, year, notLinked(session));
      return;
    }
    const discordUserId = session.discordUserId;
    const tiers = await tiersFor();
    const { cache } = tiers;
    // Minutes from the limiter itself, never the URL: it is in-process and
    // the source of truth, and a hand-typed notice can't say "0 minutes".
    const code = isNoticeCode(req.query.notice) ? req.query.notice : undefined;
    const minutes = Math.max(
      1,
      Math.ceil(deps.limiter.retryAfterSec(discordUserId) / 60),
    );
    const noticeHtml =
      code === 'queued' || code === 'already-queued'
        ? ((await queuedNotice(discordUserId, cache, year)) ??
          notice(code, minutes))
        : code
          ? notice(code, minutes)
          : '';
    const cached = await readEntry(
      tiers,
      discordUserId,
      year,
      session.userId,
      now(),
    );
    if (cached) {
      await render(res, session, year, cached, tiers, noticeHtml);
      return;
    }
    if (!code && deps.limiter.isLimited(discordUserId)) {
      // Throttled with nothing stored: queued (now, or already) beats a build
      // that would only be refused.
      const queued = await queueOnThrottle(
        discordUserId,
        session.userId,
        year,
        tiers,
      );
      if (queued) {
        message(res, session, year, queued);
        return;
      }
    }
    if (noticeHtml && code && FINAL_NOTICES.includes(code)) {
      // Back from a rebuild that was refused: say so, build nothing. After
      // a slow, in-flight or failed one the page says to reload, so a
      // reload builds (the lease answers while one is still in flight).
      message(res, session, year, noticeHtml);
      return;
    }
    await buildAndShow(res, session, discordUserId, year, tiers);
  }) as RequestHandler);

  // The web counterpart of `/wrapped refresh:true`: the same hourly slot.
  router.post('/wrapped/rebuild', (async (req, res) => {
    const { session } = hostLocals(res);
    const body = req.body as Record<string, unknown> | undefined;
    const year = wrappedYear(body?.year, now());
    const back = (query: Record<string, string | undefined> = {}) =>
      res.redirect(
        303,
        pageLink(WRAPPED_PATH, { year: String(year), ...query }).href,
      );
    if (session.discordUserId === null) {
      back();
      return;
    }
    const discordUserId = session.discordUserId;
    const tiers = await tiersFor();
    const token = await deps.memberToken(discordUserId);
    if (token === undefined) {
      back({ notice: 'no-token' });
      return;
    }
    const outcome = await build(session, discordUserId, year, token, tiers);
    switch (outcome.kind) {
      case 'built':
        back();
        return;
      case 'rate-limited': {
        let code: NoticeCode = 'rate-limited';
        if (deps.queue) {
          try {
            const outcome = await queueForLater(
              await deps.queue(),
              tiers,
              { discordUserId, meetupId: session.userId },
              year,
              now(),
            );
            if (outcome.kind === 'queued') {
              code = 'queued';
            } else if (outcome.kind === 'already') {
              code = 'already-queued';
            }
          } catch (error) {
            logger.warn(
              `Could not queue the Wrapped: ${error instanceof Error ? error.name : 'Error'}`,
            );
          }
        }
        back({ notice: code });
        return;
      }
      case 'account-mismatch':
        back({ notice: 'mismatch' });
        return;
      default:
        back({ notice: outcome.kind });
    }
  }) as RequestHandler);
}
