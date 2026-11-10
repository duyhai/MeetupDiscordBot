/**
 * Sends held announcements when their time comes. Same shape as the report
 * build job (src/lib/reports/buildJob.ts): a tick every minute, a Redis
 * lease so one process runs it at a time, the due rows from Postgres so a
 * restart loses nothing, and a compare-and-set claim per row so a re-tick
 * (or a second process after the lease lapsed) never sends one twice.
 */
import { Client } from 'discord.js';
import crypto from 'node:crypto';
import { Logger } from 'tslog';

import { KeyValueCache } from '../cache/base.js';
import { LogEntry, alertText, logAlert } from '../helpers/discordLogger.js';
import { releaseOwnedKey } from '../reports/buildLease.js';
import { Announcement } from '../repositories/postgresEventAnnouncementRepository.js';
import {
  AnnounceDeps,
  AnnounceStore,
  deliverAnnouncement,
} from './announceEvent.js';

const logger = new Logger({ name: 'announceTick' });

export const ANNOUNCE_TICK_MS = 60 * 1000;
export const ANNOUNCE_LEASE_KEY = 'announce-send-claim';
/** A tick sends at most a handful of emails; well under this. */
export const ANNOUNCE_LEASE_TTL_SEC = 5 * 60;

export interface TickStore extends Pick<AnnounceStore, 'finish'> {
  /** Held rows whose time has come. */
  due: (now: Date) => Promise<Announcement[]>;
  /** held → sending, only while still held and due; false otherwise. */
  claimHeld: (meetupEventId: string, now: Date) => Promise<boolean>;
}

export interface AnnounceTickDeps extends Pick<
  AnnounceDeps,
  'eventDetails' | 'announce' | 'alert' | 'now'
> {
  cache: () => Promise<KeyValueCache>;
  announcements: () => Promise<TickStore>;
  newLeaseValue?: () => string;
}

export interface TickResult {
  /** Rows due this tick that this process claimed. */
  sent: number;
  skipped: boolean;
}

/**
 * One tick. Rows whose event Meetup no longer has (cancelled, deleted) are
 * finished as failed with an alert; a Meetup read failing leaves the row
 * held for the next tick. Never throws for one row's sake: each is logged
 * and the next is tried.
 */
export async function runAnnounceTick(
  deps: AnnounceTickDeps,
): Promise<TickResult> {
  const cache = await deps.cache();
  const lease = deps.newLeaseValue?.() ?? crypto.randomUUID();
  if (
    !(await cache.exclusive_set(
      ANNOUNCE_LEASE_KEY,
      lease,
      ANNOUNCE_LEASE_TTL_SEC,
    ))
  ) {
    return { sent: 0, skipped: true };
  }
  let sent = 0;
  try {
    const store = await deps.announcements();
    const now = deps.now();
    for (const row of await store.due(now)) {
      // eslint-disable-next-line no-await-in-loop
      sent += await sendHeld(deps, store, row, now);
    }
  } finally {
    await releaseOwnedKey(cache, ANNOUNCE_LEASE_KEY, lease).catch(
      (error: unknown) => {
        logger.warn(
          `Announce lease release failed: ${error instanceof Error ? error.name : 'Error'}`,
        );
      },
    );
  }
  return { sent, skipped: false };
}

async function sendHeld(
  deps: AnnounceTickDeps,
  store: TickStore,
  row: Announcement,
  now: Date,
): Promise<number> {
  const id = row.meetupEventId;
  let details: Awaited<ReturnType<AnnounceDeps['eventDetails']>>;
  try {
    details = await deps.eventDetails(id);
  } catch (error: unknown) {
    // Left held: the next tick asks again.
    logger.warn(
      `Held announcement ${id}: event read failed (${error instanceof Error ? error.name : 'Error'})`,
    );
    return 0;
  }
  if (!(await store.claimHeld(id, now))) {
    return 0;
  }
  const hostName =
    details?.hosts.find((h) => h.id === row.requestedBy)?.name ??
    `Meetup member ${row.requestedBy}`;
  if (details === undefined) {
    await store
      .finish(id, 'failed', 'The event is no longer on Meetup.')
      .catch(() => undefined);
    deps
      .alert({
        title: 'A host’s scheduled announcement was not sent',
        description:
          'The event is no longer on Meetup (cancelled or deleted), so nothing was sent.',
        fields: [
          { name: 'Event', value: alertText(id), inline: true },
          { name: 'Host', value: alertText(hostName), inline: true },
        ],
      } satisfies LogEntry)
      .catch(() => undefined);
    return 1;
  }
  await deliverAnnouncement(deps, store, details, hostName, 'scheduled');
  return 1;
}

export interface AnnounceSchedulerOptions {
  env?: Record<string, string | undefined>;
  setIntervalFn?: typeof setInterval;
  log?: Pick<Logger<unknown>, 'warn' | 'error' | 'info'>;
}

/**
 * Ticks once now and every minute. A tick still running when the next one
 * fires is skipped (the lease covers other processes). Without
 * DATABASE_URL there are no held rows, so it never starts.
 */
export function startAnnounceScheduler(
  client: Client,
  makeDeps: () => AnnounceTickDeps,
  options: AnnounceSchedulerOptions = {},
): void {
  const env = options.env ?? process.env;
  const log = options.log ?? logger;
  if (!env.DATABASE_URL) {
    log.warn('Announce scheduler disabled: DATABASE_URL is not set');
    return;
  }
  let running = false;
  let failures = 0;
  const tick = () => {
    if (running) {
      return;
    }
    running = true;
    runAnnounceTick(makeDeps())
      .then(() => {
        failures = 0;
      })
      .catch((error: unknown) => {
        failures += 1;
        log.error(`Announce tick failed: ${String(error)}`);
        // An hour of failures: say so once in Discord, then once an hour.
        if (failures % 60 === 0) {
          logAlert(client, {
            title: 'Scheduled announcements are not going out',
            description:
              `The announce tick has failed ${failures} times in a row; held ` +
              'announcements stay held. Details are in the process log.',
          }).catch(() => undefined);
        }
      })
      .finally(() => {
        running = false;
      });
  };
  tick();
  (options.setIntervalFn ?? setInterval)(tick, ANNOUNCE_TICK_MS);
}
