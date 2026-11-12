/**
 * Starts the group snapshot ingest (ingest.ts) beside the Wrapped backfill:
 * a tick now and every SNAPSHOT_TICK_MS; the tick decides what is due.
 */
import crypto from 'node:crypto';

import { Client } from 'discord.js';
import { Logger } from 'tslog';

import { ApplicationCache } from '../../util/cache.js';
import { GqlMeetupClient } from '../client/meetup/gqlClient.js';
import { logAlert } from '../helpers/discordLogger.js';
import { identityDigestInProgress } from '../reports/buildLease.js';
import { canStartMonthBuild } from '../reports/buildSchedule.js';
import {
  defaultOrganizerMeetupDeps,
  withOrganizerMeetup,
} from '../reports/organizerMeetup.js';
import { PostgresSnapshotRepository } from '../repositories/postgresSnapshotRepository.js';
import {
  SNAPSHOT_TICK_MS,
  SnapshotDeps,
  SnapshotTickOutcome,
  runSnapshotTick,
  snapshotTuning,
} from './ingest.js';

const logger = new Logger({ name: 'groupSnapshotJob' });

type SchedulerLog = Pick<Logger<unknown>, 'info' | 'warn' | 'error'>;

export interface SnapshotSchedulerOptions {
  env?: Record<string, string | undefined>;
  setIntervalFn?: typeof setInterval;
  log?: SchedulerLog;
  /** Tests. */
  runTick?: (deps: SnapshotDeps) => Promise<SnapshotTickOutcome>;
}

/**
 * A tick still running when the next fires is skipped (the open-run index
 * and the report lease cover other processes). Without DATABASE_URL there
 * is nowhere to store the snapshot, so it never starts. Never throws.
 */
export function startGroupSnapshotScheduler(
  _client: Client,
  makeDeps: () => Promise<SnapshotDeps>,
  options: SnapshotSchedulerOptions = {},
): void {
  const env = options.env ?? process.env;
  const log = options.log ?? logger;
  if (!env.DATABASE_URL) {
    log.warn('Group snapshot disabled: DATABASE_URL is not set');
    return;
  }
  const runTick = options.runTick ?? runSnapshotTick;
  const pace = snapshotTuning(env);
  log.info(
    `Group snapshot pace: ${pace.callsPerTick} Meetup calls a tick, ${pace.concurrency} event(s) at a time`,
  );
  let running = false;
  const tick = () => {
    if (running) {
      return;
    }
    running = true;
    makeDeps()
      .then(async (deps) => {
        const outcome = await runTick(deps);
        if (outcome.kind === 'ran') {
          log.info(
            `Group snapshot tick: run ${outcome.runId}, listed ${String(outcome.listed)}, ` +
              `read ${outcome.fetched} events, failed ${outcome.failed}, ${outcome.calls} Meetup calls` +
              (outcome.finished ? ', run finished' : ''),
          );
        }
      })
      .catch((error: unknown) => {
        log.error(`Group snapshot tick failed: ${String(error)}`);
      })
      .finally(() => {
        running = false;
      });
  };
  tick();
  (options.setIntervalFn ?? setInterval)(tick, SNAPSHOT_TICK_MS);
}

export async function productionSnapshotDeps(
  getClient: () => Client | undefined,
): Promise<SnapshotDeps> {
  return {
    now: () => new Date(),
    cache: ApplicationCache,
    store: () => PostgresSnapshotRepository.instance(),
    // Never the request cache: nothing from the snapshot goes to Redis.
    withOrganizer: (fn) =>
      withOrganizerMeetup(getClient(), fn, {
        ...defaultOrganizerMeetupDeps,
        makeClient: (accessToken) =>
          new GqlMeetupClient(accessToken, { bypassCache: true }),
      }),
    canStart: async (now, cache) =>
      canStartMonthBuild(now) && !(await identityDigestInProgress(cache, now)),
    alert: async (entry) => {
      const client = getClient();
      return client ? logAlert(client, entry) : false;
    },
    newLeaseValue: () => crypto.randomUUID(),
    tuning: snapshotTuning(),
  };
}
