import { Logger } from 'tslog';

import { KeyValueCache } from '../cache/base.js';
import { LogEntry } from '../helpers/discordLogger.js';
import { utcDay } from '../reports/period.js';
import { PostgresEventAuditRepository } from '../repositories/postgresEventAuditRepository.js';
import {
  ALERT_CAP,
  ALERT_RATE_LIMIT_SEC,
  ALERTABLE_KINDS,
  alertedKey,
  changeAlertEntry,
  failureAlertEntry,
  summaryAlertEntry,
  unconfirmedAlertEntry,
} from './alerts.js';
import { deletionChange, diffEvent } from './diff.js';
import { AuditMeetupReader, ReadMeetup } from './meetup.js';
import {
  EventObservation,
  NewEventChange,
  isCancelledStatus,
} from './types.js';

const logger = new Logger({ name: 'eventAuditRun' });

/** Vanished events confirmed by id per run: a listing outage costs this many reads, not hundreds. */
export const CONFIRM_CAP = 25;
/** After a failed run the job leaves the snapshot alone for this long. */
export const BACKOFF_SEC = 30 * 60;
export const BACKOFF_KEY = 'event-audit-backoff';
const ONCE_A_DAY_TTL_SEC = 26 * 60 * 60;
export const failedAlertedKey = (day: string): string =>
  `event-audit-failed-alerted-${day}`;
/** Vanished events whose confirmation has failed this many runs in a row are shown on the page and alerted once. */
export const UNCONFIRMED_ALERT_AFTER = 3;
export const unconfirmedAlertedKey = (eventId: string): string =>
  `event-audit-unconfirmed-alerted-${eventId}`;
const UNCONFIRMED_ALERT_TTL_SEC = 7 * 24 * 60 * 60;

export type EventAuditStore = Pick<
  PostgresEventAuditRepository,
  | 'latestRun'
  | 'latestSavedRun'
  | 'hasAnyState'
  | 'liveStates'
  | 'saveRun'
  | 'recordFailedRun'
  | 'unalerted'
  | 'markAlerted'
  | 'unconfirmable'
  | 'prune'
>;

export interface EventAuditDeps {
  now(): Date;
  cache(): Promise<KeyValueCache>;
  store(): Promise<EventAuditStore>;
  /** Every Meetup read of one run, inside one organizer-credential call. */
  readMeetup: ReadMeetup;
  /** #meetup-bot-alerts; resolves whether the post landed. */
  alert(entry: LogEntry): Promise<boolean>;
  newLeaseValue(): string;
}

export type RunOutcome =
  | {
      ok: true;
      listed: number;
      confirmed: number;
      changes: number;
      deleted: number;
      durationMs: number;
    }
  | { ok: false; error: unknown };

interface MeetupReads {
  observations: EventObservation[];
  deletedEventIds: string[];
  /** Vanished events whose confirmation read failed this run. */
  unconfirmedEventIds: string[];
  listed: number;
  confirmed: number;
}

/**
 * The listing, then each live event that vanished from it while its start is
 * still ahead is read by id (oldest start first, at most CONFIRM_CAP): a
 * null answer is a deletion, a node is treated as listed, an error leaves
 * the event for the next run. Read-only, so withOrganizerMeetup may re-run
 * it on a 401.
 */
async function readMeetup(
  reader: AuditMeetupReader,
  store: EventAuditStore,
  now: Date,
): Promise<MeetupReads> {
  const listed = await reader.listEvents(now);
  const listedIds = new Set(listed.map((o) => o.eventId));
  const states = await store.liveStates();
  const vanished = states
    .filter(
      (s) =>
        !listedIds.has(s.eventId) &&
        s.latest.startAt.getTime() > now.getTime() &&
        s.latest.status !== 'PAST' &&
        !isCancelledStatus(s.latest.status),
    )
    .sort((a, b) => a.latest.startAt.getTime() - b.latest.startAt.getTime())
    .slice(0, CONFIRM_CAP);
  const observations = [...listed];
  const deletedEventIds: string[] = [];
  const unconfirmedEventIds: string[] = [];
  for (const state of vanished) {
    try {
      // eslint-disable-next-line no-await-in-loop -- one read at a time, at most CONFIRM_CAP
      const answer = await reader.getEvent(state.eventId);
      if (answer === null) {
        deletedEventIds.push(state.eventId);
      } else {
        observations.push(answer);
      }
    } catch (error) {
      unconfirmedEventIds.push(state.eventId);
      // Process log only; the event is tried again next run.
      logger.warn(
        `Event audit: confirming event ${state.eventId} failed: ${error instanceof Error ? error.name : 'Error'}`,
      );
    }
  }
  return {
    observations,
    deletedEventIds,
    unconfirmedEventIds,
    listed: listed.length,
    confirmed: vanished.length,
  };
}

/** Posts a fixed entry at most once per UTC day (the key is freed when the post does not land). */
async function alertOncePerDay(
  deps: EventAuditDeps,
  cache: KeyValueCache,
  key: string,
  entry: LogEntry,
): Promise<void> {
  try {
    if (!(await cache.exclusive_set(key, '1', ONCE_A_DAY_TTL_SEC))) {
      return;
    }
    if (!(await deps.alert(entry))) {
      await cache.remove(key);
    }
  } catch (error) {
    logger.error(`Event audit alert bookkeeping failed: ${String(error)}`);
  }
}

/**
 * Alerts for every unalerted deleted, cancelled or host-changed row (this
 * run's and any left over): over ALERT_CAP of them, one summary and all
 * marked; otherwise one each under the per-event-and-kind rate limit (a
 * suppressed one is still marked; a post that does not land stays for the
 * next run and frees its key). Never throws.
 */
async function alertChanges(
  deps: EventAuditDeps,
  cache: KeyValueCache,
  store: EventAuditStore,
): Promise<void> {
  try {
    const pending = await store.unalerted([...ALERTABLE_KINDS]);
    if (pending.length === 0) {
      return;
    }
    const now = deps.now();
    if (pending.length > ALERT_CAP) {
      if (await deps.alert(summaryAlertEntry(pending.length))) {
        await store.markAlerted(
          pending.map((c) => c.id),
          now,
        );
      }
      return;
    }
    for (const change of pending) {
      const entry = changeAlertEntry(change);
      if (entry === undefined) {
        continue;
      }
      const key = alertedKey(change.eventId, change.kind);
      // eslint-disable-next-line no-await-in-loop -- a handful of posts, in order
      if (!(await cache.exclusive_set(key, '1', ALERT_RATE_LIMIT_SEC))) {
        // eslint-disable-next-line no-await-in-loop -- see above
        await store.markAlerted([change.id], now);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop -- see above
      if (await deps.alert(entry)) {
        // eslint-disable-next-line no-await-in-loop -- see above
        await store.markAlerted([change.id], now);
      } else {
        // eslint-disable-next-line no-await-in-loop -- see above
        await cache.remove(key);
      }
    }
  } catch (error) {
    logger.error(`Event audit alerts failed: ${String(error)}`);
  }
}

/**
 * One alert per event (a week's key) once its confirmation has failed
 * UNCONFIRMED_ALERT_AFTER runs in a row; only for events that failed this
 * run, so an old streak does not re-alert. Never throws.
 */
async function alertUnconfirmed(
  deps: EventAuditDeps,
  cache: KeyValueCache,
  store: EventAuditStore,
  unconfirmedEventIds: string[],
): Promise<void> {
  if (unconfirmedEventIds.length === 0) {
    return;
  }
  try {
    const stuck = (await store.unconfirmable(UNCONFIRMED_ALERT_AFTER)).filter(
      (s) => unconfirmedEventIds.includes(s.eventId),
    );
    for (const state of stuck) {
      const key = unconfirmedAlertedKey(state.eventId);
      // eslint-disable-next-line no-await-in-loop -- a handful at most
      if (await cache.exclusive_set(key, '1', UNCONFIRMED_ALERT_TTL_SEC)) {
        const entry = unconfirmedAlertEntry(state, state.unconfirmedRuns);
        // eslint-disable-next-line no-await-in-loop -- see above
        const posted = await deps.alert(entry);
        if (!posted) {
          // eslint-disable-next-line no-await-in-loop -- see above
          await cache.remove(key);
        }
      }
    }
  } catch (error) {
    logger.error(`Event audit unconfirmed alerts failed: ${String(error)}`);
  }
}

async function recordFailure(
  deps: EventAuditDeps,
  startedAt: Date,
  requestedBy: string,
  error: unknown,
): Promise<void> {
  // The full error (possibly a Meetup body) goes to the process log only.
  logger.error(`Event audit run failed: ${String(error)}`);
  try {
    const store = await deps.store();
    await store.recordFailedRun(startedAt, deps.now(), requestedBy);
  } catch (storeError) {
    logger.error(
      `Event audit failed-run row not written: ${String(storeError)}`,
    );
  }
  try {
    const cache = await deps.cache();
    await cache.set(BACKOFF_KEY, deps.now().toISOString(), BACKOFF_SEC);
    await alertOncePerDay(
      deps,
      cache,
      failedAlertedKey(utcDay(deps.now())),
      failureAlertEntry(error),
    );
  } catch (cacheError) {
    logger.error(
      `Event audit failure bookkeeping failed: ${String(cacheError)}`,
    );
  }
}

/**
 * One snapshot pass. Never throws. Does not take the lease: job.ts does.
 * Meetup reads first (one credential call), then one transaction, then the
 * alerts and the prune.
 */
export async function runEventAudit(
  deps: EventAuditDeps,
  requestedBy: string,
): Promise<RunOutcome> {
  const startedAt = deps.now();
  let reads: MeetupReads;
  let changes: NewEventChange[];
  let store: EventAuditStore;
  try {
    store = await deps.store();
    reads = await deps.readMeetup((reader) =>
      readMeetup(reader, store, startedAt),
    );
    const baseline = !(await store.hasAnyState());
    const latest = new Map(
      (await store.liveStates()).map((s) => [s.eventId, s.latest]),
    );
    changes = reads.observations.flatMap((o) =>
      diffEvent(latest.get(o.eventId), o, { baseline, now: startedAt }),
    );
    for (const id of reads.deletedEventIds) {
      const previous = latest.get(id);
      if (previous) {
        changes.push(deletionChange(previous));
      }
    }
    await store.saveRun({
      startedAt,
      finishedAt: deps.now(),
      requestedBy,
      listed: reads.listed,
      confirmed: reads.confirmed,
      observations: reads.observations,
      deletedEventIds: reads.deletedEventIds,
      unconfirmedEventIds: reads.unconfirmedEventIds,
      changes,
    });
  } catch (error) {
    await recordFailure(deps, startedAt, requestedBy, error);
    return { ok: false, error };
  }
  const durationMs = deps.now().getTime() - startedAt.getTime();
  logger.info(
    `Event audit run (${requestedBy}) listed ${reads.listed}, confirmed ${reads.confirmed} ` +
      `(${reads.unconfirmedEventIds.length} unanswered), ${changes.length} changes, ` +
      `${reads.deletedEventIds.length} deleted, took ${durationMs} ms`,
  );
  try {
    const cache = await deps.cache();
    await cache.remove(BACKOFF_KEY);
    await alertChanges(deps, cache, store);
    await alertUnconfirmed(deps, cache, store, reads.unconfirmedEventIds);
  } catch (error) {
    logger.error(`Event audit after-save bookkeeping failed: ${String(error)}`);
  }
  try {
    await store.prune(deps.now());
  } catch (error) {
    logger.error(`Event audit prune failed: ${String(error)}`);
  }
  return {
    ok: true,
    listed: reads.listed,
    confirmed: reads.confirmed,
    changes: changes.length,
    deleted: reads.deletedEventIds.length,
    durationMs,
  };
}
