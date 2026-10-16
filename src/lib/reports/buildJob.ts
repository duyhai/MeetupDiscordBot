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
  identityDigestInProgress,
  releaseBuildLease,
} from './buildLease.js';
import {
  BUILD_UTC_HOUR,
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
    const status = (error.response as { status?: unknown } | undefined)?.status;
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
  return `<@${builtBy}>`; // in an embed: never pings
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
): LogEntry {
  const label = monthLabel(period);
  return {
    title: `Report build failed: ${label}`,
    description:
      `Building the ${label} reports failed after ${seconds(durationMs)} s: ${describeBuildError(error)}\n\n` +
      'It retries every 15 minutes (never 18:00–19:00 UTC); this alert repeats at most once a day until it works.',
  };
}

async function recordFailure(
  deps: BuildJobDeps,
  cache: KeyValueCache,
  period: Period,
  durationMs: number,
  error: unknown,
): Promise<void> {
  try {
    const now = deps.now();
    // Keeps the first failure time.
    await cache.exclusive_set(
      failingKey(period),
      now.toISOString(),
      FAILING_TTL_SEC,
    );
    const key = alertedKey(period, utcDay(now));
    if (!(await cache.exclusive_set(key, '1', ALERTED_TTL_SEC))) {
      return; // already alerted today
    }
    if (!(await deps.alert(failureEntry(period, durationMs, error)))) {
      await cache.remove(key); // the next tick tries the alert again
    }
  } catch (bookkeepingError) {
    logger.error(
      `Report build failure bookkeeping failed: ${String(bookkeepingError)}`,
    );
  }
}

/** Builds one month and does all the alert bookkeeping. Never throws. */
async function buildAndRecord(
  deps: BuildJobDeps,
  cache: KeyValueCache,
  period: Period,
  builtBy: string,
): Promise<void> {
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
    await recordFailure(deps, cache, period, durationMs, error);
    return;
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
    const plan = planDueWork({
      now,
      builtAt: await loadBuiltAt(deps, now),
      linkProgressWrittenToday: await deps.linkProgress.hasDay(utcDay(now)),
    });
    for (const item of plan) {
      const startAt = deps.now();
      if (
        isQuietHour(startAt) ||
        // eslint-disable-next-line no-await-in-loop -- sequential on purpose: one month at a time
        (await identityDigestInProgress(cache, startAt))
      ) {
        logger.info(
          'Report build stopped early: quiet hour or identity digest',
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
  'quiet-hour' | 'identity-sweep' | 'busy' | 'future-month' | 'bad-requester';

export type RebuildResult =
  | { status: 'started'; done: Promise<void> }
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
  if (!/^[0-9]{1,20}$/.test(requestedBy)) {
    return {
      status: 'bad-requester',
      message: 'Only a signed-in staff member can refresh reports.',
    };
  }
  const now = deps.now();
  if (isQuietHour(now)) {
    return {
      status: 'quiet-hour',
      message:
        'Reports are not rebuilt between 18:00 and 19:00 UTC while the daily identity sweep runs. Try again after 19:00 UTC.',
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
  const done = (async () => {
    try {
      await buildAndRecord(deps, cache, period, requestedBy);
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
