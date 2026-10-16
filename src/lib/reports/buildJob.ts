import crypto from 'node:crypto';

import { Client } from 'discord.js';
import { ClientError } from 'graphql-request';
import { Logger } from 'tslog';

import Configuration from '../../configuration.js';
import {
  BASE_DISCORD_BOT_URL,
  BOT_ALERTS_CHANNEL_ID,
  SERVER_ROLES,
} from '../../constants.js';
import { ApplicationCache } from '../../util/cache.js';
import { KeyValueCache } from '../cache/base.js';
import {
  LogEntry,
  logAlert,
  postRoleNotice,
} from '../helpers/discordLogger.js';
import { safeErrorSummary } from '../helpers/identity/digest.js';
import { PostgresDashboardNoticeRepository } from '../repositories/postgresDashboardNoticeRepository.js';
import { PostgresLinkProgressRepository } from '../repositories/postgresLinkProgressRepository.js';
import { PostgresReportSnapshotRepository } from '../repositories/postgresReportSnapshotRepository.js';
import { PostgresSuspensionRepository } from '../repositories/postgresSuspensionRepository.js';
import {
  acquireBuildLease,
  BUILD_LEASE_TTL_SEC,
  identityDigestInProgress,
  releaseBuildLease,
} from './buildLease.js';
import {
  BUILD_UTC_HOUR,
  canStartLinkProgress,
  canStartMonthBuild,
  isQuietHour,
  planDueWork,
  snapshotKey,
} from './buildSchedule.js';
import { collectLinkProgress, LinkProgressCounts } from './linkProgress.js';
import { noShowsMissing } from './meetupMonth.js';
import { buildMonthReports, MonthReports } from './monthReports.js';
import { withOrganizerMeetup } from './organizerMeetup.js';
import {
  buildAsOf,
  comparePeriods,
  isFinished,
  monthLabel,
  Period,
  periodEnd,
  periodKey,
  periodOf,
  previousPeriod,
  suspensionCutoff,
  utcDay,
} from './period.js';
import {
  AttendanceEvidence,
  HallOfFameSummary,
  NoShowSummary,
  REPORT_TYPES,
} from './types.js';

const logger = new Logger({ name: 'reportBuildJob' });

const FAILING_TTL_SEC = 8 * 24 * 60 * 60;
const ALERTED_TTL_SEC = 26 * 60 * 60;
const failingKey = (p: Period) => `report-build-failing-${periodKey(p)}`;
const alertedKey = (p: Period, day: string) =>
  `report-build-alerted-${periodKey(p)}-${day}`;
const REBUILD_COOLDOWN_SEC = 10 * 60;
const rebuildCooldownKey = (p: Period) =>
  `report-rebuild-cooldown-${periodKey(p)}`;
/** A Discord user id: what a manual rebuild records as builtBy. */
const DISCORD_ID = /^[0-9]{1,20}$/;
const isManual = (builtBy: string) => DISCORD_ID.test(builtBy);
const linkProgressAlertedKey = (day: string) => `link-progress-alerted-${day}`;

/**
 * The report-ready notice links to the month's dashboard page, which ships in
 * PR 4; that PR flips this in the same change. Deliberately a constant, not
 * a config var.
 */
export const REPORT_READY_ENABLED = false;

export const REPORT_READY_ROLE_IDS: readonly string[] = [
  SERVER_ROLES.moderator,
  SERVER_ROLES.leadership,
];

export const reportMonthUrl = (period: Period): string =>
  `${BASE_DISCORD_BOT_URL}/dashboard/no-shows/${periodKey(period)}`;

/**
 * What a build failure may say in Discord. A graphql-request ClientError's
 * message embeds the raw Meetup response (and the request), so only its HTTP
 * status is shown; otherwise the digest's rule applies (organizer-safe
 * messages verbatim, anything else its class name). The full error goes to
 * the process log only.
 */
export function describeBuildError(error: unknown): string {
  if (error instanceof ClientError) {
    const response = error.response as
      { status?: unknown; errors?: unknown } | undefined;
    const status = response?.status;
    // Meetup reports query errors with HTTP 200; their text can echo input.
    if (
      status === 200 &&
      Array.isArray(response?.errors) &&
      response.errors.length > 0
    ) {
      return 'Meetup GraphQL error';
    }
    return `Meetup API error (HTTP ${typeof status === 'number' ? status : 'unknown'})`;
  }
  return safeErrorSummary(error);
}

export interface MonthBuildOutcome {
  period: Period;
  builtBy: string;
  durationMs: number;
  sourceComplete: boolean;
  /** The month had ended when the build started. */
  finished: boolean;
  hallOfFame: HallOfFameSummary;
  noShow: NoShowSummary;
  attendance: AttendanceEvidence;
}

export interface BuildJobDeps {
  now(): Date;
  cache(): Promise<KeyValueCache>;
  snapshots: Pick<PostgresReportSnapshotRepository, 'save' | 'getCurrentMeta'>;
  /** claim and release must hit the same instance: release only removes its own claim's marker. */
  notices: Pick<PostgresDashboardNoticeRepository, 'claim' | 'release'>;
  linkProgress: Pick<PostgresLinkProgressRepository, 'hasDay' | 'upsertDay'>;
  /**
   * Reads Meetup with the organizer credential and builds both payloads.
   * Read-only: it may be re-run from the start on a 401.
   */
  fetchMonthReports(
    period: Period,
    asOf: Date,
    suspensionCutoff: Date | undefined,
  ): Promise<MonthReports>;
  collectLinkProgress(): Promise<LinkProgressCounts>;
  alert(entry: LogEntry): Promise<boolean>;
  postRoleNotice(
    roleIds: readonly string[],
    content: string,
    entry: LogEntry,
  ): Promise<boolean>;
  reportReadyEnabled(): boolean;
  newLeaseValue(): string;
}

const seconds = (ms: number) => (ms / 1000).toFixed(1);

/**
 * Reads the month from Meetup, then saves both snapshots. `builtAt` is the
 * start time (when the data was read), so a refresh that starts before the
 * month ends and saves after it is not counted as a finished build. Throws on
 * any failure; nothing is saved unless the whole read succeeded.
 */
export async function buildMonth(
  deps: BuildJobDeps,
  period: Period,
  builtBy: string,
): Promise<MonthBuildOutcome> {
  const started = deps.now();
  const finished = isFinished(period, started);
  const asOf = buildAsOf(period, started);
  const reports = await deps.fetchMonthReports(
    period,
    asOf,
    finished ? suspensionCutoff(period) : undefined,
  );
  const builtAt = started;
  const mode = finished ? 'supersede' : 'update-open';
  await deps.snapshots.save({
    reportType: 'hall_of_fame',
    period,
    builtAt,
    builtBy,
    sourceComplete: true,
    payload: reports.hallOfFame,
    mode,
  });
  await deps.snapshots.save({
    reportType: 'no_show',
    period,
    builtAt,
    builtBy,
    sourceComplete: reports.sourceComplete,
    payload: reports.noShow,
    mode,
  });
  const durationMs = deps.now().getTime() - started.getTime();
  logger.info(
    `Report build ${periodKey(period)} (${builtBy}) took ${durationMs} ms`,
  );
  return {
    period,
    builtBy,
    durationMs,
    sourceComplete: reports.sourceComplete,
    finished,
    hallOfFame: reports.hallOfFame.summary,
    noShow: reports.noShow.summary,
    attendance: reports.noShow.attendance,
  };
}

function builtByText(builtBy: string): string {
  if (builtBy === 'job') {
    return 'the daily job';
  }
  if (builtBy === 'backfill') {
    return 'the backfill';
  }
  if (isManual(builtBy)) {
    return `<@${builtBy}>`; // in an embed: never pings
  }
  return 'a staff member'; // never echo anything else into Discord
}

export function buildSummaryEntry(o: MonthBuildOutcome): LogEntry {
  const label = monthLabel(o.period);
  const lines = [
    `Hall of Fame: ${o.hallOfFame.events} events, ${o.hallOfFame.hosts} hosts (${o.hallOfFame.newHosts} new).`,
    `No-shows: ${o.noShow.noShows} no-show RSVPs; ${o.noShow.warnings} warnings, ${o.noShow.suspensionCandidates} suspension candidates.`,
    `Took ${seconds(o.durationMs)} s. Built by ${builtByText(o.builtBy)}.`,
  ];
  // Hosts mark no-shows only; a finished month with none at all is worth a
  // look, but it is not incomplete and does not hold back report-ready.
  if (o.finished && noShowsMissing(o.attendance)) {
    lines.push(
      `Note: no no-shows recorded for ${label} across ${o.attendance.pastEventsWithRsvps} past events with RSVPs; ` +
        'check that attendance was taken.',
    );
  }
  return {
    title: `Reports built: ${label}`,
    description: lines.join('\n'),
  };
}

function failureEntry(
  period: Period,
  durationMs: number,
  error: unknown,
  manual: boolean,
): LogEntry {
  const label = monthLabel(period);
  const next = manual
    ? 'Try the refresh again later; the daily job retries only months that are due.'
    : 'It retries every 15 minutes (never 18:00–19:00 UTC); this alert repeats at most once a day until it works.';
  return {
    title: `Report build failed: ${label}`,
    description: `Building the ${label} reports failed after ${seconds(durationMs)} s: ${describeBuildError(error)}\n\n${next}`,
  };
}

async function recordFailure(
  deps: BuildJobDeps,
  cache: KeyValueCache,
  period: Period,
  durationMs: number,
  error: unknown,
  builtBy: string,
): Promise<void> {
  try {
    const now = deps.now();
    // Keeps the first failure time.
    await cache.exclusive_set(
      failingKey(period),
      now.toISOString(),
      FAILING_TTL_SEC,
    );
    if (isManual(builtBy)) {
      // A manual refresh always reports to its requester's team and leaves
      // the job's once-a-day alert for the month untouched (the per-month
      // cooldown already limits how often this can post).
      await deps.alert(failureEntry(period, durationMs, error, true));
      return;
    }
    const key = alertedKey(period, utcDay(now));
    if (!(await cache.exclusive_set(key, '1', ALERTED_TTL_SEC))) {
      return; // already alerted today
    }
    if (!(await deps.alert(failureEntry(period, durationMs, error, false)))) {
      await cache.remove(key); // the next tick tries the alert again
    }
  } catch (bookkeepingError) {
    logger.error(
      `Report build failure bookkeeping failed: ${String(bookkeepingError)}`,
    );
  }
}

/**
 * Builds one month and does all the alert bookkeeping. Never throws; returns
 * whether the build was saved.
 */
async function buildAndRecord(
  deps: BuildJobDeps,
  cache: KeyValueCache,
  period: Period,
  builtBy: string,
): Promise<boolean> {
  const startedMs = deps.now().getTime();
  let outcome: MonthBuildOutcome;
  try {
    outcome = await buildMonth(deps, period, builtBy);
  } catch (error: unknown) {
    const durationMs = deps.now().getTime() - startedMs;
    // The full error (possibly a Meetup body) goes to the process log only.
    logger.error(
      `Report build ${periodKey(period)} failed after ${durationMs} ms: ${String(error)}`,
    );
    await recordFailure(deps, cache, period, durationMs, error, builtBy);
    return false;
  }
  try {
    if (await cache.get(failingKey(period))) {
      const label = monthLabel(period);
      const posted = await deps.alert({
        title: `Report build working again: ${label}`,
        description: `The ${label} reports were built (${seconds(outcome.durationMs)} s).`,
      });
      if (posted) {
        await cache.remove(failingKey(period));
      }
    }
  } catch (error) {
    logger.error(`Report build recovery bookkeeping failed: ${String(error)}`);
  }
  // The open month's daily build is logged only; finished months and manual
  // refreshes post a summary.
  try {
    if (builtBy !== 'job' || outcome.finished) {
      await deps.alert(buildSummaryEntry(outcome));
    }
  } catch (error) {
    logger.error(`Report build summary failed: ${String(error)}`);
  }
  return true;
}

async function writeLinkProgress(
  deps: BuildJobDeps,
  cache: KeyValueCache,
  day: string,
): Promise<void> {
  try {
    await deps.linkProgress.upsertDay(day, await deps.collectLinkProgress());
  } catch (error: unknown) {
    logger.error(`Link progress for ${day} failed: ${String(error)}`);
    try {
      const key = linkProgressAlertedKey(day);
      if (await cache.exclusive_set(key, '1', ALERTED_TTL_SEC)) {
        const posted = await deps.alert({
          title: 'Link progress not recorded',
          description: `Today's Meetup link counts could not be recorded: ${describeBuildError(error)}. It retries every 15 minutes.`,
        });
        if (!posted) {
          await cache.remove(key);
        }
      }
    } catch (alertError) {
      logger.error(`Link progress alert failed: ${String(alertError)}`);
    }
  }
}

/** builtAt of the current rows of the previous and current month (Postgres is the durable fact). */
async function loadBuiltAt(
  deps: BuildJobDeps,
  now: Date,
): Promise<Map<string, Date>> {
  const current = periodOf(now);
  const builtAt = new Map<string, Date>();
  for (const period of [previousPeriod(current), current]) {
    for (const type of REPORT_TYPES) {
      // eslint-disable-next-line no-await-in-loop -- four small reads on a pool of three
      const meta = await deps.snapshots.getCurrentMeta(type, period);
      if (meta) {
        builtAt.set(snapshotKey(type, period), meta.builtAt);
      }
    }
  }
  return builtAt;
}

/**
 * One tick: guards, lease, due plan from Postgres, each due month and link
 * progress in order, then report-ready. Never starts work in the quiet hour
 * or while the identity digest runs, checked again before each item.
 */
export async function runBuildTick(deps: BuildJobDeps): Promise<void> {
  const now = deps.now();
  if (isQuietHour(now) || now.getUTCHours() < BUILD_UTC_HOUR) {
    return;
  }
  const cache = await deps.cache();
  if (await identityDigestInProgress(cache, now)) {
    logger.info('Report build deferred: the identity digest is running');
    return;
  }
  const lease = deps.newLeaseValue();
  if (!(await acquireBuildLease(cache, lease))) {
    return;
  }
  try {
    // Re-read the clock: a tick stuck on a Redis outage must not plan (or
    // pick today's link-progress day) with the time it started at.
    const planNow = deps.now();
    const plan = planDueWork({
      now: planNow,
      builtAt: await loadBuiltAt(deps, planNow),
      linkProgressWrittenToday: await deps.linkProgress.hasDay(utcDay(planNow)),
    });
    for (const item of plan) {
      const startAt = deps.now();
      const mayStart =
        item.kind === 'month'
          ? canStartMonthBuild(startAt)
          : canStartLinkProgress(startAt);
      if (
        !mayStart ||
        // eslint-disable-next-line no-await-in-loop -- sequential on purpose: one month at a time
        (await identityDigestInProgress(cache, startAt))
      ) {
        // Items come months first, then link progress, and neither window
        // reopens before 19:00 UTC, so nothing later in the plan could start.
        logger.info(
          'Report build stopped early: too close to the identity sweep or the digests',
        );
        break;
      }
      // eslint-disable-next-line no-await-in-loop -- sequential on purpose: one month at a time
      await (item.kind === 'month'
        ? buildAndRecord(deps, cache, item.period, 'job')
        : writeLinkProgress(deps, cache, item.day));
    }
    await maybePostReportReady(deps);
  } finally {
    await releaseBuildLease(cache, lease);
  }
}

export function reportReadyMessage(
  period: Period,
  hallOfFame: HallOfFameSummary,
  noShow: NoShowSummary,
): { content: string; entry: LogEntry } {
  const label = monthLabel(period);
  const url = reportMonthUrl(period);
  return {
    // Role mentions only ping from content; <url> suppresses the link preview.
    content: `<@&${SERVER_ROLES.moderator}> <@&${SERVER_ROLES.leadership}> The ${label} reports are ready: <${url}>`,
    entry: {
      title: `Reports ready: ${label}`,
      description:
        `No-shows: ${noShow.warnings} warnings, ${noShow.suspensionCandidates} suspension candidates.\n` +
        `Hall of Fame: ${hallOfFame.events} events, ${hallOfFame.hosts} hosts (${hallOfFame.newHosts} new).\n${url}`,
    },
  };
}

/**
 * For the latest finished month only, once ever: needs both current snapshots
 * built at or after the month ended (whoever built them: job, manual or
 * backfill) and a complete no-show row. The marker row is inserted before
 * posting (so two processes cannot both post) and deleted if the post fails
 * (so the next tick retries). If that delete itself throws, the marker stays
 * and the month is never announced; logged. The backfill never calls this.
 */
export async function maybePostReportReady(
  deps: BuildJobDeps,
): Promise<'posted' | 'skipped' | 'failed'> {
  if (!deps.reportReadyEnabled()) {
    return 'skipped';
  }
  try {
    const period = previousPeriod(periodOf(deps.now()));
    const [hof, noShow] = await Promise.all([
      deps.snapshots.getCurrentMeta('hall_of_fame', period),
      deps.snapshots.getCurrentMeta('no_show', period),
    ]);
    const end = periodEnd(period).getTime();
    if (
      !hof ||
      !noShow ||
      hof.builtAt.getTime() < end ||
      noShow.builtAt.getTime() < end ||
      !noShow.sourceComplete
    ) {
      return 'skipped';
    }
    if (!(await deps.notices.claim('report_ready', period))) {
      return 'skipped';
    }
    const { content, entry } = reportReadyMessage(
      period,
      hof.summary as HallOfFameSummary,
      noShow.summary as NoShowSummary,
    );
    if (await deps.postRoleNotice(REPORT_READY_ROLE_IDS, content, entry)) {
      return 'posted';
    }
    await deps.notices.release('report_ready', period);
    return 'failed';
  } catch (error) {
    logger.error(`Report-ready notice failed: ${String(error)}`);
    return 'failed';
  }
}

export type RebuildRefusal =
  | 'quiet-hour'
  | 'identity-sweep'
  | 'busy'
  | 'cooldown'
  | 'future-month'
  | 'bad-month'
  | 'bad-requester';

/** Whether a manual rebuild saved both snapshots. */
export type RebuildOutcome = { ok: true } | { ok: false };

/** `done` settles when the background build finishes; it never rejects. */
export type RebuildResult =
  | { status: 'started'; done: Promise<RebuildOutcome> }
  | { status: RebuildRefusal; message: string };

/**
 * A staff member's refresh of one month. Shares the lease and guards with the
 * job; the build runs in the background (`done`) and never posts report-ready.
 */
export async function requestRebuild(
  deps: BuildJobDeps,
  period: Period,
  requestedBy: string,
): Promise<RebuildResult> {
  if (!isManual(requestedBy)) {
    return {
      status: 'bad-requester',
      message: 'Only a signed-in staff member can refresh reports.',
    };
  }
  if (
    !Number.isInteger(period?.year) ||
    !Number.isInteger(period?.month) ||
    period.year < 2000 ||
    period.month < 1 ||
    period.month > 12
  ) {
    return { status: 'bad-month', message: 'That is not a valid month.' };
  }
  const now = deps.now();
  if (!canStartMonthBuild(now)) {
    return {
      status: 'quiet-hour',
      message:
        'Reports are not rebuilt between 17:45 and 19:00 UTC while the daily identity sweep runs. Try again after 19:00 UTC.',
    };
  }
  if (comparePeriods(period, periodOf(now)) > 0) {
    return {
      status: 'future-month',
      message: 'That month has not started yet.',
    };
  }
  const cache = await deps.cache();
  if (await identityDigestInProgress(cache, now)) {
    return {
      status: 'identity-sweep',
      message:
        'The daily identity sweep is still running. Try again in a few minutes.',
    };
  }
  const lease = deps.newLeaseValue();
  if (!(await acquireBuildLease(cache, lease))) {
    return {
      status: 'busy',
      message: 'A report build is already running. Try again when it finishes.',
    };
  }
  // Taken only once every other check passed, so a refused request never
  // starts the cooldown.
  let cooling: boolean;
  try {
    cooling = !(await cache.exclusive_set(
      rebuildCooldownKey(period),
      requestedBy,
      REBUILD_COOLDOWN_SEC,
    ));
  } catch (error) {
    await releaseBuildLease(cache, lease);
    throw error;
  }
  if (cooling) {
    await releaseBuildLease(cache, lease);
    return {
      status: 'cooldown',
      message:
        'That month was refreshed in the last 10 minutes. Try again in a few minutes.',
    };
  }
  const done = (async (): Promise<RebuildOutcome> => {
    try {
      return (await buildAndRecord(deps, cache, period, requestedBy))
        ? { ok: true }
        : { ok: false };
    } catch (error) {
      logger.error(`Manual report rebuild failed: ${String(error)}`);
      return { ok: false };
    } finally {
      await releaseBuildLease(cache, lease);
    }
  })();
  return { status: 'started', done };
}

export async function defaultBuildJobDeps(
  client: Client,
): Promise<BuildJobDeps> {
  const [snapshots, notices, linkProgress, suspensions] = await Promise.all([
    PostgresReportSnapshotRepository.instance(),
    PostgresDashboardNoticeRepository.instance(),
    PostgresLinkProgressRepository.instance(),
    PostgresSuspensionRepository.instance(),
  ]);
  return {
    now: () => new Date(),
    cache: ApplicationCache,
    snapshots,
    notices, // one instance for claim and release
    linkProgress,
    // The only Meetup read path: the organizer credential, read-only inside
    // the wrapper; saves and posts happen after it returns.
    fetchMonthReports: (period, asOf, cutoff) =>
      withOrganizerMeetup(client, (meetupClient) =>
        buildMonthReports(meetupClient, period, {
          asOf,
          suspensionCutoff: cutoff,
          groupId: Configuration.meetup.groupId,
          suspensions,
        }),
      ),
    collectLinkProgress: () => collectLinkProgress(client),
    alert: (entry) => logAlert(client, entry),
    postRoleNotice: (roleIds, content, entry) =>
      postRoleNotice(
        client,
        BOT_ALERTS_CHANNEL_ID,
        [...roleIds],
        content,
        entry,
      ),
    reportReadyEnabled: () => REPORT_READY_ENABLED,
    newLeaseValue: () => crypto.randomUUID(),
  };
}

export const BUILD_TICK_MS = 15 * 60 * 1000;

type SchedulerLog = Pick<Logger<unknown>, 'error' | 'warn' | 'info'>;

/** Never rejects: dependency or tick failures are logged. */
export async function runBuildTickSafely(
  makeDeps: () => Promise<BuildJobDeps>,
  log: Pick<Logger<unknown>, 'error'> = logger,
): Promise<void> {
  try {
    await runBuildTick(await makeDeps());
  } catch (error) {
    // Process log only (never Discord): what reaches here is infrastructure
    // (pg, Redis, the lease), and operators need its text.
    log.error(`Report build tick failed: ${String(error)}`);
  }
}

export interface ReportBuildSchedulerOptions {
  env?: Record<string, string | undefined>;
  makeDeps?: () => Promise<BuildJobDeps>;
  setIntervalFn?: typeof setInterval;
  log?: SchedulerLog;
  /** Milliseconds since the epoch (tests). */
  now?: () => number;
}

/**
 * Ticks once now and every 15 minutes; `runBuildTick` decides whether
 * anything is due. A tick still running when the next one fires is skipped,
 * so one process never runs two builds at once (the Redis lease covers other
 * processes). Without DATABASE_URL there is nowhere to save, so it never
 * starts.
 */
export function startReportBuildScheduler(
  client: Client,
  options: ReportBuildSchedulerOptions = {},
): void {
  const env = options.env ?? process.env;
  const log = options.log ?? logger;
  if (!env.DATABASE_URL) {
    log.warn('Report build job disabled: DATABASE_URL is not set');
    return;
  }
  const makeDeps = options.makeDeps ?? (() => defaultBuildJobDeps(client));
  const now = options.now ?? Date.now;
  let running = false;
  let skipLogged = false;
  let tickStartedAt = 0;
  let wedgeWarned = false;
  const tick = () => {
    if (running) {
      if (!skipLogged) {
        log.info(
          'Report build tick skipped: the previous tick is still running',
        );
        skipLogged = true;
      }
      // Past the lease TTL another process may take the lease, and this
      // process stays blocked until the stuck tick ends: say so once.
      if (!wedgeWarned && now() - tickStartedAt > BUILD_LEASE_TTL_SEC * 1000) {
        log.warn('Report build tick has been running for over 30 minutes');
        wedgeWarned = true;
      }
      return;
    }
    running = true;
    skipLogged = false;
    wedgeWarned = false;
    tickStartedAt = now();
    runBuildTickSafely(makeDeps, log)
      .finally(() => {
        running = false;
      })
      // runBuildTickSafely only rejects if logging itself throws.
      .catch(() => undefined);
  };
  tick(); // like the digests: a deploy inside the build window should not wait 15 minutes
  (options.setIntervalFn ?? setInterval)(tick, BUILD_TICK_MS);
}
