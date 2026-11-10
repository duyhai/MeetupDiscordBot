/**
 * Sends held announcements when their time comes. Same shape as the report
 * build job (src/lib/reports/buildJob.ts): a tick every minute, a Redis
 * lease so one process runs it at a time, the due rows from Postgres so a
 * restart loses nothing, and a compare-and-set claim per row so a re-tick
 * (or a second process after the lease lapsed) never sends one twice.
 *
 * One send per tick, and never within SPACING_MS of the last one that went
 * out: the spacing rule is enforced here, at send time, not only when the
 * due times were computed (two requests in the same second compute the
 * same due time; after a restart every overdue row is due at once).
 */
import { Client } from 'discord.js';
import crypto from 'node:crypto';
import { Logger } from 'tslog';

import { KeyValueCache } from '../cache/base.js';
import { LogEntry, alertText, logAlert } from '../helpers/discordLogger.js';
import { releaseOwnedKey } from '../reports/buildLease.js';
import { OrganizerTokenUnavailableError } from '../reports/organizerMeetup.js';
import { Announcement } from '../repositories/postgresEventAnnouncementRepository.js';
import {
  AnnounceDeps,
  AnnounceStore,
  deliverAnnouncement,
} from './announceEvent.js';
import { SPACING_MS, dueLabel } from './announceSchedule.js';

const logger = new Logger({ name: 'announceTick' });

export const ANNOUNCE_TICK_MS = 60 * 1000;
export const ANNOUNCE_LEASE_KEY = 'announce-send-claim';
/** A tick sends one email; well under this. */
export const ANNOUNCE_LEASE_TTL_SEC = 5 * 60;
/** A due row still unreadable this long after its time is alerted, once a day. */
export const STUCK_AFTER_MS = 15 * 60 * 1000;
export const STUCK_ALERT_TTL_SEC = 24 * 60 * 60;
export const stuckAlertKey = (meetupEventId: string) =>
  `announce-stuck-alert:${meetupEventId}`;

/** How many due rows a tick looks at, to get past one it cannot read. */
export const DUE_PER_TICK = 5;

export interface TickStore extends Pick<AnnounceStore, 'finish'> {
  /** Held rows whose time has come, earliest first, at most `limit`. */
  due: (now: Date, limit: number) => Promise<Announcement[]>;
  /** held → sending, only while still held and due; false otherwise. */
  claimHeld: (meetupEventId: string, now: Date) => Promise<boolean>;
  /** sending → held again, keeping its due time (the credential was gone). */
  unclaim: (meetupEventId: string) => Promise<void>;
  /** When announcements actually went or are going out from `since` on. */
  recentSends: (since: Date) => Promise<Date[]>;
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
  /** 1 when this tick sent (or finished) a row. */
  sent: number;
  skipped: boolean;
}

/**
 * One tick. Nothing is sent while another announcement went out within
 * SPACING_MS (the due rows wait, in order). Otherwise it takes the
 * earliest of up to DUE_PER_TICK due rows that Meetup can tell it about:
 * a row it cannot read stays held (alerted once a day once it is
 * STUCK_AFTER_MS late) and the next is tried, so one bad event never
 * blocks the rest. Meetup no longer having the event finishes the row as
 * failed with an alert; else it is sent. At most one row a tick.
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
    sent = await sendNextDue(deps, cache, store, now);
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

/** Alerts once a day that a due row cannot be sent; `why` is fixed text. */
async function alertStuck(
  deps: AnnounceTickDeps,
  cache: KeyValueCache,
  row: Announcement,
  now: Date,
  why: string,
): Promise<void> {
  const late = now.getTime() - (row.dueAt?.getTime() ?? now.getTime());
  if (late < STUCK_AFTER_MS) {
    return;
  }
  try {
    if (
      !(await cache.exclusive_set(
        stuckAlertKey(row.meetupEventId),
        '1',
        STUCK_ALERT_TTL_SEC,
      ))
    ) {
      return;
    }
  } catch (error: unknown) {
    logger.warn(
      `Stuck-alert dedupe failed: ${error instanceof Error ? error.name : 'Error'}`,
    );
    return;
  }
  await deps
    .alert({
      title: 'A scheduled announcement is stuck',
      description:
        `It was due ${dueLabel(row.dueAt ?? now)} and ${why} It is tried again ` +
        'every minute; this is said once a day.',
      fields: [
        { name: 'Event', value: alertText(row.meetupEventId), inline: true },
        {
          name: 'Host',
          value: `Meetup member ${alertText(row.requestedBy)}`,
          inline: true,
        },
      ],
    } satisfies LogEntry)
    .catch(() => undefined);
}

async function sendNextDue(
  deps: AnnounceTickDeps,
  cache: KeyValueCache,
  store: TickStore,
  now: Date,
): Promise<number> {
  // The spacing rule at send time: only real sends count, not held rows,
  // however overdue. The due rows keep their times and their order.
  const recent = (
    await store.recentSends(new Date(now.getTime() - SPACING_MS))
  ).filter((t) => {
    const ago = now.getTime() - t.getTime();
    return ago >= 0 && ago < SPACING_MS;
  });
  if (recent.length > 0) {
    return 0;
  }
  for (const row of await store.due(now, DUE_PER_TICK)) {
    let details: Awaited<ReturnType<AnnounceDeps['eventDetails']>>;
    try {
      // eslint-disable-next-line no-await-in-loop
      details = await deps.eventDetails(row.meetupEventId);
    } catch (error: unknown) {
      // Left held: a later tick asks again. The organizer credential
      // being gone surfaces here too (the read needs it), before any claim.
      const why =
        error instanceof OrganizerTokenUnavailableError
          ? 'the Meetup organizer login is not usable (renew it on the dashboard).'
          : 'Meetup could not be asked about the event.';
      logger.warn(
        `Held announcement ${row.meetupEventId}: event read failed (${error instanceof Error ? error.name : 'Error'})`,
      );
      // eslint-disable-next-line no-await-in-loop
      await alertStuck(deps, cache, row, now, why);
      continue;
    }
    // The first readable row is the one this tick handles.

    return sendRow(deps, cache, store, row, details, now);
  }
  return 0;
}

async function sendRow(
  deps: AnnounceTickDeps,
  cache: KeyValueCache,
  store: TickStore,
  row: Announcement,
  details: Awaited<ReturnType<AnnounceDeps['eventDetails']>>,
  now: Date,
): Promise<number> {
  const id = row.meetupEventId;
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
  const code = await deliverAnnouncement(deps, store, details, hostName, {
    how: 'scheduled',
    // The credential went away between the read and the send: back to
    // held, no "refused" alert; the next tick's read says what is wrong.
    onNoToken: async () => {
      await store.unclaim(id);
      await alertStuck(
        deps,
        cache,
        row,
        now,
        'the Meetup organizer login is not usable (renew it on the dashboard).',
      );
    },
  });
  return code === 'deferred' ? 0 : 1;
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
