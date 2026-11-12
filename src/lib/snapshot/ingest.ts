/**
 * The group snapshot ingest: every event of the group and every past
 * event's YES, WAITLIST and ATTENDED RSVPs (Meetup ids only) in Postgres,
 * read with the organizer credential. One run at a time (meetup_snapshot_runs):
 *
 * 1. List every PAST/CANCELLED and ACTIVE event (one tick), upsert them,
 *    mark the ones a complete listing no longer has, and copy the event
 *    audit's confirmed deletions.
 * 2. Read RSVPs for the events that need them (never read, read before they
 *    happened, or within RSVP_SETTLE_DAYS and read before this run), oldest
 *    first, up to `concurrency` events at a time, under `callsPerTick` calls a
 *    tick. The work set is a query, so a restart resumes where it was.
 * 3. Finish when nothing is left.
 *
 * The first run is a full pull (probed 2026-11-11: ~5.2k events, ~4,850
 * calls, ~33 ticks ≈ 2.7 h); later runs, one a day, list again (~52 calls)
 * and read the new and settling events. Nothing sets SNAPSHOT_RUN_NOW_KEY
 * yet: the staff button that will comes with PR 2.
 * Each tick holds the report build lease for its reads, so the organizer
 * credential is never read by two jobs at once. Nothing is written to Redis
 * but the lease, the run-now flag and the alert guard.
 */
import { ClientError } from 'graphql-request';
import { Logger } from 'tslog';

import { KeyValueCache } from '../cache/base.js';
import { LogEntry } from '../helpers/discordLogger.js';
import { isMeetupUnauthorized } from '../helpers/organizerMeetupClient.js';
import { acquireBuildLease, releaseBuildLease } from '../reports/buildLease.js';
import { OrganizerTokenUnavailableError } from '../reports/organizerMeetup.js';
import { utcDay } from '../reports/period.js';
import {
  SnapshotRun,
  SnapshotStore,
} from '../repositories/postgresSnapshotRepository.js';
import {
  CallCounter,
  EventRsvpRead,
  SnapshotMeetup,
  listAllEvents,
  readEventRsvps,
} from './read.js';

/** A 200 that is not believable: the stored rows are kept. */
export class ShortRsvpReadError extends Error {
  constructor() {
    super('RSVP read shorter than Meetup counts');
    this.name = 'ShortRsvpReadError';
  }
}

/** Short: no edges where Meetup counts RSVPs, or under MIN_EDGE_RATIO of its total. */
export function isShortRead(
  read: EventRsvpRead,
  yesCount: number | null,
): boolean {
  if (read.edges === 0) {
    return read.totalCount > 0 || (yesCount ?? 0) > 0;
  }
  return read.edges < MIN_EDGE_RATIO * read.totalCount;
}

const logger = new Logger({ name: 'groupSnapshot' });

export const SNAPSHOT_TICK_MS = 5 * 60_000;
/** Meetup calls a tick may start events under; an event in flight reads all its pages. */
export const SNAPSHOT_TICK_CALL_BUDGET = 150;
/** Events whose RSVPs are read at once by default (listing pages are always one at a time). */
export const SNAPSHOT_CONCURRENCY = 1;
const MAX_CALLS_PER_TICK = 10_000;
/**
 * A tick stops starting events this long after it began, so a slow Meetup
 * day cannot overrun the 5-minute interval or the 30-minute report lease.
 * Checked at event (batch) boundaries; an event in flight finishes.
 */
export const SNAPSHOT_TICK_MAX_MS = 4 * 60_000;
/** The last tick's numbers, for the staff card: counts only, a day's TTL. */
export const SNAPSHOT_LAST_TICK_KEY = 'group-snapshot-last-tick';
const LAST_TICK_TTL_SEC = 24 * 60 * 60;

export interface LastSnapshotTick {
  at: string;
  calls: number;
  fetched: number;
}
const MAX_CONCURRENCY = 8;

/**
 * The ingest's pace, from the environment (Heroku config vars), so the
 * full pull can be sped up without a deploy:
 * - SNAPSHOT_CALLS_PER_TICK: 1..10000, default 150.
 * - SNAPSHOT_CONCURRENCY: 1..8, default 1.
 * Live (2026-11-12): sequential RSVP reads run ~75–90 ms apart, so the
 * budget is the bottleneck; 5000 at concurrency 1 finishes the full pull in
 * about two ticks. Anything out of range falls back to the default. The
 * SNAPSHOT_TICK_MAX_MS cap and the quiet-hour and digest guards still apply.
 */
export interface SnapshotTuning {
  callsPerTick: number;
  concurrency: number;
}

function boundedInt(
  raw: string | undefined,
  max: number,
  fallback: number,
): number {
  const value = Number(raw);
  return raw !== undefined &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= max
    ? value
    : fallback;
}

export function snapshotTuning(
  env: Record<string, string | undefined> = process.env,
): SnapshotTuning {
  return {
    callsPerTick: boundedInt(
      env.SNAPSHOT_CALLS_PER_TICK,
      MAX_CALLS_PER_TICK,
      SNAPSHOT_TICK_CALL_BUDGET,
    ),
    concurrency: boundedInt(
      env.SNAPSHOT_CONCURRENCY,
      MAX_CONCURRENCY,
      SNAPSHOT_CONCURRENCY,
    ),
  };
}
/** A new run starts this long after the last one finished. */
export const SNAPSHOT_RUN_INTERVAL_MS = 20 * 60 * 60_000;
/** Past events this recent are read again once per run: hosts mark attendance after. */
export const RSVP_SETTLE_DAYS = 14;
/** A listing with fewer PAST events than this share of the stored ones marks nothing deleted. */
export const MIN_LISTING_RATIO = 0.95;
/**
 * A read is refused as short when Meetup returned no edges for an event it
 * counts RSVPs on, or fewer than this share of its totalCount. (A few hidden
 * RSVPs are normal: 41 edges for a totalCount of 46 was seen live.)
 */
export const MIN_EDGE_RATIO = 0.5;
/** This many RSVP reads failing in a row is Meetup, not the events: the tick ends. */
export const CONSECUTIVE_FAILURE_LIMIT = 3;
/** Set (to the requester's Discord id) to start a run on the next tick. */
export const SNAPSHOT_RUN_NOW_KEY = 'group-snapshot-run-now';
export const SNAPSHOT_RUN_NOW_TTL_SEC = 2 * 60 * 60;
const FAILING_ALERT_TTL_SEC = 26 * 60 * 60;
const STALLED_AFTER_MS = 24 * 60 * 60_000;
export const failingAlertKey = (day: string): string =>
  `group-snapshot-alerted-${day}`;

type SchedulerLog = Pick<Logger<unknown>, 'info' | 'warn' | 'error'>;

export interface SnapshotDeps {
  now(): Date;
  cache(): Promise<KeyValueCache>;
  store(): Promise<SnapshotStore>;
  /**
   * withOrganizerMeetup. On a 401 it refreshes the token and runs `fn` again
   * from the start; `fn` recomputes its work from the store, so a re-run
   * reads only what the first pass did not finish.
   */
  withOrganizer<T>(fn: (meetup: SnapshotMeetup) => Promise<T>): Promise<T>;
  /** The report window rule and no identity digest running. */
  canStart(now: Date, cache: KeyValueCache): Promise<boolean>;
  /** #meetup-bot-alerts, plain. */
  alert(entry: LogEntry): Promise<boolean>;
  newLeaseValue(): string;
  /** Pace; the defaults (150 calls, one event at a time) when left out. */
  tuning?: SnapshotTuning;
  log?: SchedulerLog;
}

export type SnapshotTickOutcome =
  | { kind: 'skipped'; reason: 'guard' | 'lease' | 'not-due' }
  | {
      kind: 'ran';
      runId: number;
      listed: boolean;
      fetched: number;
      failed: number;
      calls: number;
      finished: boolean;
    }
  | { kind: 'failed'; runId: number; error: string };

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error';
}

const seconds = (ms: number) => (ms / 1000).toFixed(0);

/** "Group snapshot is failing", once per UTC day, by error class only. */
async function alertFailingOnce(
  deps: SnapshotDeps,
  cache: KeyValueCache,
  error: unknown,
  run: SnapshotRun,
  log: SchedulerLog,
): Promise<void> {
  try {
    const key = failingAlertKey(utcDay(deps.now()));
    if (!(await cache.exclusive_set(key, '1', FAILING_ALERT_TTL_SEC))) {
      return;
    }
    const openMs = deps.now().getTime() - run.startedAt.getTime();
    const stalled =
      openMs > STALLED_AFTER_MS
        ? ` The ${run.kind} run has been open for ${Math.floor(openMs / 3_600_000)} h.`
        : '';
    const posted = await deps.alert({
      title: 'Group snapshot is failing',
      description:
        `A group snapshot tick failed: ${errorName(error)}. ` +
        `It retries every 5 minutes; details are in the process log.${stalled} ` +
        'This alert repeats at most once a day.',
    });
    if (!posted) {
      await cache.remove(key).catch(() => undefined);
    }
  } catch (alertError) {
    log.error(`Group snapshot failure alert failed: ${errorName(alertError)}`);
  }
}

/** Meetup's rate limit: not the event's fault; the tick backs off. */
export function isRateLimited(error: unknown): boolean {
  return error instanceof ClientError && error.response?.status === 429;
}

/** An infrastructure failure that must end the tick (and, for a 401, re-run the callback). */
function isFatal(error: unknown): boolean {
  return (
    isMeetupUnauthorized(error) ||
    error instanceof OrganizerTokenUnavailableError
  );
}

interface TickWork {
  /** When the tick began, for SNAPSHOT_TICK_MAX_MS. */
  startedMs: number;
  listed: boolean;
  shortListing: boolean;
  fetched: number;
  failed: number;
  finished: boolean;
}

async function listPhase(
  deps: SnapshotDeps,
  store: SnapshotStore,
  run: SnapshotRun,
  meetup: SnapshotMeetup,
  calls: CallCounter,
  log: SchedulerLog,
): Promise<boolean> {
  const listingStart = deps.now();
  let short = false;
  const before = await store.pastEventCount();
  const { events, pastSeen, dropped } = await listAllEvents(meetup, calls);
  await store.upsertEvents(events, listingStart);
  if (pastSeen >= MIN_LISTING_RATIO * before) {
    const delisted = await store.markDelisted(listingStart, deps.now());
    if (delisted > 0) {
      log.info(`Group snapshot: ${delisted} events no longer listed`);
    }
  } else {
    // A short listing (an outage, a filter change) never deletes history.
    log.warn(
      `Group snapshot: the listing had ${pastSeen} past events of ${before} stored; nothing marked deleted`,
    );
    await store.recordError(run.id, 'ShortListing');
    short = true;
  }
  const deleted = await store.markAuditDeletions();
  await store.markListed(run.id, deps.now(), events.length);
  log.info(
    `Group snapshot run ${run.id}: listed ${events.length} events (${dropped} unusable nodes dropped, ` +
      `${deleted} audit deletions applied)`,
  );
  return short;
}

/**
 * Up to `concurrency` events read at once, then written in event order. The
 * budget is checked at event boundaries: a batch never starts more events
 * than the calls left, and an event in flight reads all its pages. Failures
 * count in event order across batches and any good read resets the count,
 * so "three in a row" means the same with one reader or several. A rate
 * limit, a refused token or an unusable credential ends the tick without
 * marking the event failed (the good reads of the batch are kept).
 */
async function rsvpPhase(
  deps: SnapshotDeps,
  cache: KeyValueCache,
  store: SnapshotStore,
  run: SnapshotRun,
  meetup: SnapshotMeetup,
  calls: CallCounter,
  work: TickWork,
  log: SchedulerLog,
): Promise<void> {
  const { callsPerTick, concurrency } = deps.tuning ?? {
    callsPerTick: SNAPSHOT_TICK_CALL_BUDGET,
    concurrency: SNAPSHOT_CONCURRENCY,
  };
  let failingInARow = 0;
  for (;;) {
    const room = callsPerTick - calls.n;
    if (room <= 0) {
      return;
    }
    if (deps.now().getTime() - work.startedMs >= SNAPSHOT_TICK_MAX_MS) {
      log.info('Group snapshot: the tick reached its time cap; the tick ends');
      return;
    }
    // eslint-disable-next-line no-await-in-loop -- one batch in flight, by design
    if (!(await deps.canStart(deps.now(), cache))) {
      log.info('Group snapshot: the window closed; the tick ends');
      return;
    }
    // eslint-disable-next-line no-await-in-loop -- one batch in flight, by design
    const batch = await store.eventsNeedingRsvps({
      runStartedAt: run.startedAt,
      now: deps.now(),
      settleDays: RSVP_SETTLE_DAYS,
      limit: Math.min(concurrency, room),
    });
    if (batch.length === 0) {
      work.finished = true;
      return;
    }
    // eslint-disable-next-line no-await-in-loop -- one batch in flight, by design
    const reads = await Promise.allSettled(
      batch.map(async (next) => {
        const read = await readEventRsvps(meetup, next.eventId, calls);
        if (read && isShortRead(read, next.yesCount)) {
          throw new ShortRsvpReadError();
        }
        return read;
      }),
    );
    let stop: unknown;
    for (const [i, settled] of reads.entries()) {
      const next = batch[i];
      if (settled.status === 'rejected') {
        const error: unknown = settled.reason;
        if (isFatal(error) || isRateLimited(error)) {
          stop ??= error;
          continue;
        }
        // Recorded on the event, so it stays out of this run (across
        // restarts too) and is read again by the next one.
        failingInARow += 1;
        work.failed += 1;
        // eslint-disable-next-line no-await-in-loop -- two small writes
        await store.recordRsvpFailure(
          next.eventId,
          errorName(error),
          deps.now(),
        );
        // eslint-disable-next-line no-await-in-loop -- see above
        await store.advance(run.id, {
          eventsFetched: 0,
          rsvpsStored: 0,
          failed: 1,
        });
        log.warn(
          `Group snapshot: reading RSVPs of event ${next.eventId} failed: ${errorName(error)}; retried next run`,
        );
        if (failingInARow >= CONSECUTIVE_FAILURE_LIMIT) {
          // Likely Meetup rather than the events: end the tick and alert.
          stop ??= error;
        }
        continue;
      }
      failingInARow = 0;
      const read = settled.value;
      if (read === null) {
        // eslint-disable-next-line no-await-in-loop -- one small write
        await store.markDeleted(next.eventId, deps.now());
        log.info(`Group snapshot: event ${next.eventId} is gone from Meetup`);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop -- one event's write
      await store.replaceRsvps(next.eventId, read.rsvps, deps.now());
      // eslint-disable-next-line no-await-in-loop -- one small write
      await store.advance(run.id, {
        eventsFetched: 1,
        rsvpsStored: read.rsvps.length,
        failed: 0,
      });
      work.fetched += 1;
    }
    if (stop !== undefined) {
      throw stop;
    }
  }
}

async function dueRun(
  deps: SnapshotDeps,
  cache: KeyValueCache,
  store: SnapshotStore,
): Promise<SnapshotRun | undefined> {
  const open = await store.openRun();
  if (open) {
    return open;
  }
  const runNow = await cache.get(SNAPSHOT_RUN_NOW_KEY);
  const last = await store.lastFinishedRun();
  const due =
    runNow !== undefined ||
    last?.finishedAt === undefined ||
    deps.now().getTime() - last.finishedAt.getTime() >=
      SNAPSHOT_RUN_INTERVAL_MS;
  if (!due) {
    return undefined;
  }
  const kind = (await store.hasFinishedFull()) ? 'incremental' : 'full';
  const run = await store.startRun(runNow ?? 'job', kind);
  if (runNow !== undefined) {
    await cache.remove(SNAPSHOT_RUN_NOW_KEY).catch(() => undefined);
  }
  return run;
}

export async function runSnapshotTick(
  deps: SnapshotDeps,
): Promise<SnapshotTickOutcome> {
  const log = deps.log ?? logger;
  const tickStartedMs = deps.now().getTime();
  const cache = await deps.cache();
  if (!(await deps.canStart(deps.now(), cache))) {
    return { kind: 'skipped', reason: 'guard' };
  }
  const store = await deps.store();
  const run = await dueRun(deps, cache, store);
  if (!run) {
    return { kind: 'skipped', reason: 'not-due' };
  }
  const lease = deps.newLeaseValue();
  if (!(await acquireBuildLease(cache, lease))) {
    return { kind: 'skipped', reason: 'lease' };
  }
  const calls: CallCounter = { n: 0 };
  let recorded = 0;
  const settle = async () => {
    if (calls.n > recorded) {
      const delta = calls.n - recorded;
      recorded = calls.n;
      await store.recordRequests(run.id, delta).catch(() => undefined);
    }
  };
  const work: TickWork = {
    startedMs: tickStartedMs,
    listed: run.listedAt !== undefined,
    shortListing: false,
    fetched: 0,
    failed: 0,
    finished: false,
  };
  const listedBefore = work.listed;
  try {
    await deps.withOrganizer(async (meetup) => {
      if (!work.listed) {
        work.shortListing = await listPhase(
          deps,
          store,
          run,
          meetup,
          calls,
          log,
        );
        work.listed = true;
      }
      await rsvpPhase(deps, cache, store, run, meetup, calls, work, log);
    });
  } catch (error) {
    log.error(`Group snapshot tick failed: ${String(error)}`);
    await store.recordError(run.id, errorName(error)).catch(() => undefined);
    await settle();
    await releaseBuildLease(cache, lease);
    await alertFailingOnce(deps, cache, error, run, log);
    return { kind: 'failed', runId: run.id, error: errorName(error) };
  }
  try {
    await settle();
    // A good tick clears the last tick's failure, unless this one found the
    // listing short (which it recorded itself).
    if (run.lastError !== undefined && !work.shortListing) {
      await store.recordError(run.id, undefined).catch(() => undefined);
    }
    if (work.finished) {
      const done = await store.finishRun(run.id);
      if (done) {
        const totals = await store.totals();
        const took =
          (done.finishedAt ?? deps.now()).getTime() - done.startedAt.getTime();
        log.info(
          `Group snapshot run ${done.id} (${done.kind}) finished: ${done.eventsFetched} events read, ` +
            `${done.failed} failed, ${done.requests} Meetup calls, ${seconds(took)} s`,
        );
        if (done.kind === 'full') {
          await deps
            .alert({
              title: 'Group snapshot finished',
              description:
                `Full pull done: ${totals.events} events and ${totals.rsvps} RSVPs stored; ` +
                `${done.eventsFetched} events read, ${done.failed} failed (retried next run); ` +
                `${done.requests} Meetup calls. Took ${seconds(took)} s.`,
            })
            .catch((error: unknown) =>
              log.error(
                `Group snapshot summary alert failed: ${errorName(error)}`,
              ),
            );
        }
      }
    }
  } finally {
    await releaseBuildLease(cache, lease);
  }
  const last: LastSnapshotTick = {
    at: deps.now().toISOString(),
    calls: calls.n,
    fetched: work.fetched,
  };
  await cache
    .set(SNAPSHOT_LAST_TICK_KEY, JSON.stringify(last), LAST_TICK_TTL_SEC)
    .catch(() => undefined);
  return {
    kind: 'ran',
    runId: run.id,
    listed: work.listed && !listedBefore,
    fetched: work.fetched,
    failed: work.failed,
    calls: calls.n,
    finished: work.finished,
  };
}
