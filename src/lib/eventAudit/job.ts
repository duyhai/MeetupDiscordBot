import crypto from 'node:crypto';

import { Client } from 'discord.js';
import { Logger } from 'tslog';

import { ApplicationCache } from '../../util/cache.js';
import { KeyValueCache } from '../cache/base.js';
import { logAlert } from '../helpers/discordLogger.js';
import {
  acquireBuildLease,
  identityDigestInProgress,
  releaseBuildLease,
} from '../reports/buildLease.js';
import { canStartMonthBuild, isQuietHour } from '../reports/buildSchedule.js';
import { PostgresEventAuditRepository } from '../repositories/postgresEventAuditRepository.js';
import { organizerReadMeetup } from './meetup.js';
import {
  BACKOFF_KEY,
  EventAuditDeps,
  EventAuditStore,
  RunOutcome,
  runEventAudit,
} from './run.js';

export type { EventAuditDeps } from './run.js';

const logger = new Logger({ name: 'eventAuditJob' });

/** The tick, as the report build job's: a run happens only when due. */
export const EVENT_AUDIT_TICK_MS = 15 * 60 * 1000;
/** Hourly: due once the latest saved run started this long ago. */
export const EVENT_AUDIT_INTERVAL_MS = 55 * 60 * 1000;
/** Snapshot now: one per two minutes across all staff. */
export const EVENT_AUDIT_COOLDOWN_SEC = 2 * 60;
export const COOLDOWN_KEY = 'event-audit-cooldown';

const DISCORD_ID = /^[0-9]{17,20}$/;

/**
 * No run in backoff (a run failed within 30 minutes); otherwise due with no
 * saved run at all, or when the latest saved run (Postgres, the durable
 * fact) started EVENT_AUDIT_INTERVAL_MS or more ago. Failed runs do not
 * push the next one back beyond the backoff.
 */
export async function isEventAuditDue(
  store: Pick<EventAuditStore, 'latestSavedRun'>,
  cache: KeyValueCache,
  now: Date,
): Promise<boolean> {
  if (await cache.get(BACKOFF_KEY)) {
    return false;
  }
  const latest = await store.latestSavedRun();
  return (
    latest === undefined ||
    latest.startedAt.getTime() + EVENT_AUDIT_INTERVAL_MS <= now.getTime()
  );
}

/**
 * One tick: nothing in the identity digest's hour or while it runs; the
 * build lease (the organizer token's critical section, shared with report
 * builds and manual refreshes) or skip; the due check; the run; release.
 * Infrastructure errors propagate to the scheduler's log.
 */
export async function runEventAuditTick(deps: EventAuditDeps): Promise<void> {
  const now = deps.now();
  if (isQuietHour(now)) {
    return;
  }
  const cache = await deps.cache();
  if (await identityDigestInProgress(cache, now)) {
    return;
  }
  const lease = deps.newLeaseValue();
  if (!(await acquireBuildLease(cache, lease))) {
    return;
  }
  try {
    if (!(await isEventAuditDue(await deps.store(), cache, deps.now()))) {
      return;
    }
    await runEventAudit(deps, 'job');
  } finally {
    await releaseBuildLease(cache, lease);
  }
}

export type EventAuditRefusal =
  'quiet-hour' | 'identity-sweep' | 'busy' | 'cooldown' | 'bad-requester';

/** `done` settles when the background run finishes; it never rejects. */
export type EventAuditRequestResult =
  | { status: 'started'; done: Promise<RunOutcome> }
  | { status: EventAuditRefusal };

/**
 * A staff member's "Snapshot now": requestRebuild's order of checks, the
 * build lease, a two-minute cooldown, then the run in the background with
 * the lease released in its finally. A refused request leaves nothing behind.
 */
export async function requestEventAudit(
  deps: EventAuditDeps,
  requestedBy: string,
): Promise<EventAuditRequestResult> {
  if (!DISCORD_ID.test(requestedBy)) {
    return { status: 'bad-requester' };
  }
  const now = deps.now();
  if (!canStartMonthBuild(now)) {
    return { status: 'quiet-hour' };
  }
  const cache = await deps.cache();
  if (await identityDigestInProgress(cache, now)) {
    return { status: 'identity-sweep' };
  }
  const lease = deps.newLeaseValue();
  if (!(await acquireBuildLease(cache, lease))) {
    return { status: 'busy' };
  }
  let cooling: boolean;
  try {
    cooling = !(await cache.exclusive_set(
      COOLDOWN_KEY,
      requestedBy,
      EVENT_AUDIT_COOLDOWN_SEC,
    ));
  } catch (error) {
    await releaseBuildLease(cache, lease);
    throw error;
  }
  if (cooling) {
    await releaseBuildLease(cache, lease);
    return { status: 'cooldown' };
  }
  const done = (async (): Promise<RunOutcome> => {
    try {
      return await runEventAudit(deps, requestedBy);
    } finally {
      await releaseBuildLease(cache, lease);
    }
  })();
  return { status: 'started', done };
}

export async function defaultEventAuditDeps(
  client: Client,
): Promise<EventAuditDeps> {
  const store = await PostgresEventAuditRepository.instance();
  return {
    now: () => new Date(),
    cache: ApplicationCache,
    store: async () => store,
    readMeetup: organizerReadMeetup(() => client),
    alert: (entry) => logAlert(client, entry),
    newLeaseValue: () => crypto.randomUUID(),
  };
}

type SchedulerLog = Pick<Logger<unknown>, 'error' | 'warn' | 'info'>;

export interface EventAuditSchedulerOptions {
  env?: Record<string, string | undefined>;
  makeDeps?: () => Promise<EventAuditDeps>;
  setIntervalFn?: typeof setInterval;
  log?: SchedulerLog;
}

/**
 * Ticks once now and every 15 minutes; `runEventAuditTick` decides whether a
 * run is due. A tick still running when the next fires is skipped. Without
 * DATABASE_URL there is nowhere to save, so it never starts. Failures are
 * logged in full to the process log only (what reaches here is
 * infrastructure; the run alerts its own failures).
 */
export function startEventAuditScheduler(
  client: Client,
  options: EventAuditSchedulerOptions = {},
): void {
  const env = options.env ?? process.env;
  const log = options.log ?? logger;
  if (!env.DATABASE_URL) {
    log.warn('Event audit job disabled: DATABASE_URL is not set');
    return;
  }
  const makeDeps = options.makeDeps ?? (() => defaultEventAuditDeps(client));
  let running = false;
  const tick = () => {
    if (running) {
      log.info('Event audit tick skipped: the previous tick is still running');
      return;
    }
    running = true;
    makeDeps()
      .then((deps) => runEventAuditTick(deps))
      .catch((error: unknown) => {
        log.error(`Event audit tick failed: ${String(error)}`);
      })
      .finally(() => {
        running = false;
      });
  };
  tick();
  (options.setIntervalFn ?? setInterval)(tick, EVENT_AUDIT_TICK_MS);
}
