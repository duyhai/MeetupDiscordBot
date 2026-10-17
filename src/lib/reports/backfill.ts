import { Logger } from 'tslog';

import { KeyValueCache } from '../cache/base.js';
import { LogEntry } from '../helpers/discordLogger.js';
import {
  buildMonth,
  describeBuildError,
  MembershipsUnreadableError,
  MonthBuildDeps,
  MonthBuildOptions,
} from './buildJob.js';
import {
  acquireBuildLease,
  identityDigestInProgress,
  releaseBuildLease,
} from './buildLease.js';
import { canStartMonthBuild } from './buildSchedule.js';
import {
  comparePeriods,
  GROUP_FIRST_PERIOD,
  monthLabel,
  Period,
  periodEnd,
  periodKey,
  periodOf,
  previousPeriod,
} from './period.js';
import { REPORT_TYPES } from './types.js';

/** The backfill starts at the group's first month unless --from says otherwise. */
export const BACKFILL_DEFAULT_FROM: Period = GROUP_FIRST_PERIOD;
/** A progress post after every this many months processed (built, skipped or failed). */
export const BACKFILL_PROGRESS_EVERY = 12;
export const BACKFILL_LEASE_POLL_MS = 60_000;
/** How long one month waits for another build's lease before the run stops. */
export const BACKFILL_LEASE_WAIT_MS = 20 * 60_000;
/** The pause after each month that was read from Meetup (not after skipped ones). */
export const BACKFILL_DEFAULT_DELAY_MS = 5_000;
/** Months named per list in the final post; the rest are counted. */
export const BACKFILL_LIST_LIMIT = 20;
/** Discord's embed description limit is 4096. */
const DESCRIPTION_LIMIT = 4000;

export interface BackfillDeps {
  now(): Date;
  /** Must be the shared Redis cache: the build lease only excludes other processes there. */
  cache(): Promise<KeyValueCache>;
  build: MonthBuildDeps;
  /** Posts one embed to #meetup-bot-alerts (no mentions); false when it failed. */
  post(entry: LogEntry): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  newLeaseValue(): string;
  log: Pick<Logger<unknown>, 'info' | 'warn' | 'error'>;
}

export interface BackfillOptions {
  /** Rebuild months that already have a finished build. */
  force: boolean;
  /** The oldest month to build; BACKFILL_DEFAULT_FROM when absent. */
  from?: Period;
  delayMs: number;
  leaseWaitMs: number;
  /** --allow-all-departed: save months the departed guard would refuse. */
  allowAllDeparted: boolean;
}

export type BackfillStop =
  'quiet-window' | 'identity-sweep' | 'lease-timeout' | 'cache-unavailable';

export interface BackfillFailure {
  period: Period;
  /** describeBuildError text only: it reaches Discord. */
  reason: string;
  /** Refused by the departed guard (3+ no-show members, all departed). */
  allDepartedRefusal: boolean;
}

export interface BackfillResult {
  months: number;
  built: Period[];
  skipped: Period[];
  failed: BackfillFailure[];
  /** Saved although every no-show member (one or more) has left the group. */
  allDeparted: Period[];
  /** Built months with no no-show members at all: saved normally, only counted. */
  noNoShows: number;
  stopped?: BackfillStop;
}

export type BackfillRefusal =
  'quiet-window' | 'identity-sweep' | 'before-group';

export class BackfillRefusedError extends Error {
  constructor(readonly reason: BackfillRefusal) {
    super(`Backfill refused: ${reason}`);
    this.name = 'BackfillRefusedError';
  }
}

const STOP_TEXT: Record<BackfillStop, string> = {
  'quiet-window':
    'Stopped before 17:45 UTC (unlinked digest and identity sweep). Run it again after 19:00 UTC; months already built are skipped.',
  'identity-sweep':
    'Stopped while the identity sweep runs. Run it again after 19:00 UTC; months already built are skipped.',
  'lease-timeout':
    'Stopped: another report build held the build lease for over 20 minutes. Run it again later; months already built are skipped.',
  'cache-unavailable':
    'Stopped: Redis did not answer, so the build lease and the identity sweep could not be checked. ' +
    'Run it again later; months already built are skipped.',
};

/** Newest first: the last finished month back to `first`. */
export function backfillMonths(first: Period, now: Date): Period[] {
  const months: Period[] = [];
  for (
    let p = previousPeriod(periodOf(now));
    comparePeriods(p, first) >= 0;
    p = previousPeriod(p)
  ) {
    months.push(p);
  }
  return months;
}

/** Both current rows were built at or after the month ended: a finished build exists. */
async function finishedBuildExists(
  build: MonthBuildDeps,
  period: Period,
): Promise<boolean> {
  const end = periodEnd(period).getTime();
  const metas = await Promise.all(
    REPORT_TYPES.map((type) => build.snapshots.getCurrentMeta(type, period)),
  );
  return metas.every((m) => m !== undefined && m.builtAt.getTime() >= end);
}

/** Why a month build may not start now; undefined when it may. Cache errors propagate. */
async function guardStop(
  deps: BackfillDeps,
  cache: KeyValueCache,
): Promise<BackfillStop | undefined> {
  const at = deps.now();
  if (!canStartMonthBuild(at)) {
    return 'quiet-window';
  }
  if (await identityDigestInProgress(cache, at)) {
    return 'identity-sweep';
  }
  return undefined;
}

async function takeLease(
  deps: BackfillDeps,
  cache: KeyValueCache,
  value: string,
  waitMs: number,
): Promise<boolean> {
  const deadline = deps.now().getTime() + waitMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- polling the shared lease
    if (await acquireBuildLease(cache, value)) {
      return true;
    }
    if (deps.now().getTime() >= deadline) {
      return false;
    }
    deps.log.info(
      'Backfill waiting for the build lease: another report build is running',
    );
    // eslint-disable-next-line no-await-in-loop -- polling the shared lease
    await deps.sleep(BACKFILL_LEASE_POLL_MS);
  }
}

const monthCount = (n: number) => `${n} ${n === 1 ? 'month' : 'months'}`;

function labels(periods: Period[]): string {
  const named = periods.slice(0, BACKFILL_LIST_LIMIT).map(monthLabel);
  const more = periods.length - named.length;
  return named.join(', ') + (more > 0 ? ` …and ${more} more` : '');
}

function startEntry(months: Period[], options: BackfillOptions): LogEntry {
  const notes: string[] = [];
  if (options.force) {
    notes.push('Rebuilding every month (--force).');
  }
  if (options.allowAllDeparted) {
    notes.push(
      'Months where every no-show member has left the group are saved (--allow-all-departed).',
    );
  }
  const range =
    months.length > 0
      ? `${monthCount(months.length)}, ${monthLabel(months[0])} back to ${monthLabel(months[months.length - 1])}.`
      : 'No finished months to build.';
  return {
    title: 'Report backfill started',
    description: [range, ...notes].join(' '),
  };
}

function counts(result: BackfillResult): string {
  return `${result.built.length} built, ${result.skipped.length} already built, ${result.failed.length} failed`;
}

function progressEntry(
  result: BackfillResult,
  processed: number,
  latest: Period,
): LogEntry {
  return {
    title: 'Report backfill progress',
    description: `${processed} of ${monthCount(result.months)} processed: ${counts(result)}. Latest: ${monthLabel(latest)}.`,
  };
}

function finalEntry(result: BackfillResult): LogEntry {
  const lines = [`${monthCount(result.months)}: ${counts(result)}.`];
  if (result.noNoShows > 0) {
    lines.push(
      `${monthCount(result.noNoShows)} had no no-shows recorded (saved normally).`,
    );
  }
  const refused = result.failed.filter((f) => f.allDepartedRefusal);
  const failures = result.failed.filter((f) => !f.allDepartedRefusal);
  if (failures.length > 0) {
    lines.push('', 'Failed:');
    failures.slice(0, BACKFILL_LIST_LIMIT).forEach((f) => {
      lines.push(`${monthLabel(f.period)}: ${f.reason}`);
    });
    if (failures.length > BACKFILL_LIST_LIMIT) {
      lines.push(`…and ${failures.length - BACKFILL_LIST_LIMIT} more`);
    }
  }
  if (refused.length > 0) {
    const oldest = refused[refused.length - 1].period;
    lines.push(
      '',
      `Not saved, because every no-show member (3 or more) has left the group: ${labels(refused.map((f) => f.period))}.`,
      'Membership is read as of today, so in old months they may really have left. ' +
        'If recent months look right on the dashboard, save these by running again with ' +
        `--allow-all-departed --from ${periodKey(oldest)}.`,
    );
  }
  if (result.allDeparted.length > 0) {
    lines.push(
      '',
      `Saved with every no-show member gone from the group: ${labels(result.allDeparted)}.`,
    );
  }
  if (result.stopped) {
    lines.push('', STOP_TEXT[result.stopped]);
  }
  let description = lines.join('\n');
  if (description.length > DESCRIPTION_LIMIT) {
    description = `${description.slice(0, DESCRIPTION_LIMIT - 1)}…`;
  }
  return {
    title: result.stopped
      ? 'Report backfill stopped'
      : 'Report backfill finished',
    description,
  };
}

/** Posts are best effort: a failed post is logged, never fatal. */
async function post(deps: BackfillDeps, entry: LogEntry): Promise<void> {
  try {
    if (!(await deps.post(entry))) {
      deps.log.warn(`Backfill post not delivered: ${entry.title}`);
    }
  } catch (error) {
    deps.log.warn(
      `Backfill post failed: ${error instanceof Error ? error.name : 'Error'}`,
    );
  }
}

/**
 * Builds every finished month from `from` (default the group's first) up to
 * the last finished month, newest first, with buildMonth (builtBy
 * 'backfill'): the same read and save as the daily job, and no per-month
 * Discord post. Resumable: a month with a finished build is skipped unless
 * `force`. One month at a time under the shared build lease (taken per month,
 * so the daily job waits at most one month build). Never starts a month
 * 17:45-19:00 UTC or while the identity digest runs; it refuses to begin
 * then, and stops before the next month when either starts mid-run.
 */
export async function runBackfill(
  deps: BackfillDeps,
  options: BackfillOptions,
): Promise<BackfillResult> {
  const first = options.from ?? BACKFILL_DEFAULT_FROM;
  if (comparePeriods(first, GROUP_FIRST_PERIOD) < 0) {
    throw new BackfillRefusedError('before-group');
  }
  if (!canStartMonthBuild(deps.now())) {
    throw new BackfillRefusedError('quiet-window');
  }
  const cache = await deps.cache();
  if (await identityDigestInProgress(cache, deps.now())) {
    throw new BackfillRefusedError('identity-sweep');
  }
  const months = backfillMonths(first, deps.now());
  const result: BackfillResult = {
    months: months.length,
    built: [],
    skipped: [],
    failed: [],
    allDeparted: [],
    noNoShows: 0,
  };
  // Only with the flag: the option is never passed otherwise.
  const buildOptions: MonthBuildOptions = options.allowAllDeparted
    ? { allowAllDeparted: true }
    : {};
  await post(deps, startEntry(months, options));
  let processed = 0;
  for (const [index, period] of months.entries()) {
    let stop: BackfillStop | undefined;
    try {
      // eslint-disable-next-line no-await-in-loop -- one month at a time, guards re-checked before each
      stop = await guardStop(deps, cache);
    } catch (error) {
      deps.log.error(`Backfill guard check failed: ${String(error)}`);
      stop = 'cache-unavailable';
    }
    if (stop) {
      result.stopped = stop;
      break;
    }
    let state: 'build' | 'skip' | 'unreadable' = 'build';
    try {
      // eslint-disable-next-line no-await-in-loop -- one month at a time
      if (!options.force && (await finishedBuildExists(deps.build, period))) {
        state = 'skip';
      }
    } catch (error) {
      // Postgres did not answer: building would fail the same way.
      deps.log.error(
        `Backfill ${periodKey(period)}: reading its current rows failed: ${String(error)}`,
      );
      result.failed.push({
        period,
        reason: describeBuildError(error),
        allDepartedRefusal: false,
      });
      state = 'unreadable';
    }
    if (state === 'skip') {
      result.skipped.push(period);
    } else if (state === 'build') {
      const lease = deps.newLeaseValue();
      let leased: boolean;
      try {
        // eslint-disable-next-line no-await-in-loop -- one month at a time
        leased = await takeLease(deps, cache, lease, options.leaseWaitMs);
      } catch (error) {
        deps.log.error(`Backfill lease failed: ${String(error)}`);
        result.stopped = 'cache-unavailable';
        break;
      }
      if (!leased) {
        result.stopped = 'lease-timeout';
        break;
      }
      try {
        // The lease wait may have crossed 17:45 or the sweep's start.
        // eslint-disable-next-line no-await-in-loop -- one month at a time
        stop = await guardStop(deps, cache).catch((error: unknown) => {
          deps.log.error(`Backfill guard check failed: ${String(error)}`);
          return 'cache-unavailable' as const;
        });
        if (!stop) {
          // eslint-disable-next-line no-await-in-loop -- one month at a time
          const outcome = await buildMonth(
            deps.build,
            period,
            'backfill',
            buildOptions,
          );
          result.built.push(period);
          if (outcome.allDeparted) {
            result.allDeparted.push(period);
          }
          if (outcome.noShow.members === 0) {
            result.noNoShows += 1;
          }
        }
      } catch (error) {
        // The full error (possibly a Meetup body) goes to the process log only.
        deps.log.error(
          `Backfill ${periodKey(period)} failed: ${String(error)}`,
        );
        result.failed.push({
          period,
          reason: describeBuildError(error),
          allDepartedRefusal: error instanceof MembershipsUnreadableError,
        });
      } finally {
        // eslint-disable-next-line no-await-in-loop -- one month at a time
        await releaseBuildLease(cache, lease);
      }
      if (stop) {
        result.stopped = stop;
        break;
      }
      if (options.delayMs > 0 && index < months.length - 1) {
        // eslint-disable-next-line no-await-in-loop -- the rate limit between Meetup reads
        await deps.sleep(options.delayMs);
      }
    }
    processed += 1;
    if (processed % BACKFILL_PROGRESS_EVERY === 0) {
      // eslint-disable-next-line no-await-in-loop -- progress posts are rare
      await post(deps, progressEntry(result, processed, period));
    }
  }
  await post(deps, finalEntry(result));
  return result;
}
