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
 *    first, one event at a time, under SNAPSHOT_TICK_CALL_BUDGET calls a
 *    tick. The work set is a query, so a restart resumes where it was.
 * 3. Finish when nothing is left.
 *
 * The first run is a full pull (~2–3k calls over many ticks); later runs,
 * one a day, list again (~30 calls) and read the new and settling events.
 * Each tick holds the report build lease for its reads, so the organizer
 * credential is never read by two jobs at once. Nothing is written to Redis
 * but the lease, the run-now flag and the alert guard.
 */
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
  SnapshotMeetup,
  listAllEvents,
  readEventRsvps,
} from './read.js';

const logger = new Logger({ name: 'groupSnapshot' });

export const SNAPSHOT_TICK_MS = 5 * 60_000;
/** Meetup calls a tick may start events under; an event in flight reads all its pages. */
export const SNAPSHOT_TICK_CALL_BUDGET = 150;
/** A new run starts this long after the last one finished. */
export const SNAPSHOT_RUN_INTERVAL_MS = 20 * 60 * 60_000;
/** Past events this recent are read again once per run: hosts mark attendance after. */
export const RSVP_SETTLE_DAYS = 14;
/** A listing with fewer PAST events than this share of the stored ones marks nothing deleted. */
export const MIN_LISTING_RATIO = 0.95;
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

/** Events that failed this run, skipped until the next one. In process only. */
const skipped: { runId: number | undefined; ids: Set<string> } = {
  runId: undefined,
  ids: new Set(),
};

function skipSet(runId: number): Set<string> {
  if (skipped.runId !== runId) {
    skipped.runId = runId;
    skipped.ids = new Set();
  }
  return skipped.ids;
}

/** Tests: a clean skip set, as a fresh process has. */
export function resetSkipped(): void {
  skipped.runId = undefined;
  skipped.ids = new Set();
}

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

/** An infrastructure failure that must end the tick (and, for a 401, re-run the callback). */
function isFatal(error: unknown): boolean {
  return (
    isMeetupUnauthorized(error) ||
    error instanceof OrganizerTokenUnavailableError
  );
}

interface TickWork {
  listed: boolean;
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
): Promise<void> {
  const listingStart = deps.now();
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
  }
  const deleted = await store.markAuditDeletions();
  await store.markListed(run.id, deps.now(), events.length);
  log.info(
    `Group snapshot run ${run.id}: listed ${events.length} events (${dropped} unusable nodes dropped, ` +
      `${deleted} audit deletions applied)`,
  );
}

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
  const skip = skipSet(run.id);
  let failingInARow: string[] = [];
  for (;;) {
    if (calls.n >= SNAPSHOT_TICK_CALL_BUDGET) {
      return;
    }
    // eslint-disable-next-line no-await-in-loop -- one event in flight, by design
    if (!(await deps.canStart(deps.now(), cache))) {
      log.info('Group snapshot: the window closed; the tick ends');
      return;
    }
    // eslint-disable-next-line no-await-in-loop -- one event in flight, by design
    const [next] = await store.eventsNeedingRsvps({
      runStartedAt: run.startedAt,
      now: deps.now(),
      settleDays: RSVP_SETTLE_DAYS,
      limit: 1,
      skip: [...skip],
    });
    if (!next) {
      work.finished = true;
      return;
    }
    let rsvps: Awaited<ReturnType<typeof readEventRsvps>>;
    try {
      // eslint-disable-next-line no-await-in-loop -- one event in flight, by design
      rsvps = await readEventRsvps(meetup, next.eventId, calls);
    } catch (error) {
      if (isFatal(error)) {
        throw error;
      }
      failingInARow.push(next.eventId);
      if (failingInARow.length >= CONSECUTIVE_FAILURE_LIMIT) {
        // Meetup is down, not these events: they are tried again next tick.
        failingInARow.forEach((id) => skip.delete(id));
        throw error;
      }
      skip.add(next.eventId);
      work.failed += 1;
      // eslint-disable-next-line no-await-in-loop -- one small write
      await store.advance(run.id, {
        eventsFetched: 0,
        rsvpsStored: 0,
        failed: 1,
      });
      log.warn(
        `Group snapshot: reading RSVPs of event ${next.eventId} failed: ${errorName(error)}; retried next run`,
      );
      continue;
    }
    failingInARow = [];
    if (rsvps === null) {
      // eslint-disable-next-line no-await-in-loop -- one small write
      await store.markDeleted(next.eventId, deps.now());
      log.info(`Group snapshot: event ${next.eventId} is gone from Meetup`);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- one event in flight, by design
    await store.replaceRsvps(next.eventId, rsvps, deps.now());
    // eslint-disable-next-line no-await-in-loop -- one small write
    await store.advance(run.id, {
      eventsFetched: 1,
      rsvpsStored: rsvps.length,
      failed: 0,
    });
    work.fetched += 1;
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
    listed: run.listedAt !== undefined,
    fetched: 0,
    failed: 0,
    finished: false,
  };
  const listedBefore = work.listed;
  try {
    await deps.withOrganizer(async (meetup) => {
      if (!work.listed) {
        await listPhase(deps, store, run, meetup, calls, log);
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
    if (work.finished) {
      const done = await store.finishRun(run.id);
      if (skipped.runId === run.id) {
        resetSkipped();
      }
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
