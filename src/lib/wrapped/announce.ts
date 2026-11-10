/**
 * The "your Wrapped is ready" notice: one public message a season, in a
 * configured channel, on a configured Pacific date and hour, telling linked
 * members to run /wrapped (and where the website page is). Posted at most
 * once per year, across restarts and processes, by the same claim / mark
 * posted / release pattern as the report-ready notice (buildJob.ts): a
 * Postgres row per year, claimed before posting, final once posted, and
 * retried only when the post failed (after a backoff, with one alert a day).
 *
 * No DMs. The post text is a function so a DM variant can reuse it later.
 */
import dayjs from 'dayjs';
import { Client } from 'discord.js';
import { Logger } from 'tslog';

import {
  EMBED_COLORS,
  GET_VERIFIED_CHANNEL_ID,
  PUBLIC_APP_ORIGIN,
} from '../../constants.js';
import { ApplicationCache } from '../../util/cache.js';
import { tz } from '../../util/timezone.js';
import { KeyValueCache } from '../cache/base.js';
import {
  LogEntry,
  logAlert,
  postEmbed,
  PostedEmbed,
  recentEmbedTitles,
} from '../helpers/discordLogger.js';
import { utcDay } from '../reports/period.js';
import { PostgresWrappedAnnouncementRepository } from '../repositories/postgresWrappedAnnouncementRepository.js';

const logger = new Logger({ name: 'wrappedAnnounce' });

/** The group's timezone, the one the date and hour are read in. */
const PACIFIC = 'America/Los_Angeles';

export const WRAPPED_ANNOUNCE_DEFAULT_DATE = '2026-12-01';
export const WRAPPED_ANNOUNCE_DEFAULT_HOUR = 17;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const HOUR_PATTERN = /^\d{1,2}$/;
const SNOWFLAKE = /^[0-9]{17,20}$/;

export interface WrappedAnnounceConfig {
  /**
   * 'YYYY-MM-DD', a real calendar date, read in Pacific time. Undefined when
   * WRAPPED_ANNOUNCE_DATE is set but malformed: nothing is posted on a date
   * nobody chose.
   */
  date: string | undefined;
  /** 0-23, Pacific. */
  hour: number;
  /** The channel to post in; undefined disables the post entirely. */
  channelId: string | undefined;
}

/** The post is possible: a date and a channel. */
export type WrappedAnnounceSchedule = WrappedAnnounceConfig & {
  date: string;
  channelId: string;
};

export function announceSchedule(
  config: WrappedAnnounceConfig,
): WrappedAnnounceSchedule | undefined {
  return config.date !== undefined && config.channelId !== undefined
    ? { date: config.date, hour: config.hour, channelId: config.channelId }
    : undefined;
}

/**
 * WRAPPED_ANNOUNCE_DATE (default 2026-12-01), WRAPPED_ANNOUNCE_HOUR (default
 * 17) and WRAPPED_ANNOUNCE_CHANNEL_ID (no default: unset means no post).
 * Every warning names the variable, never its value. A malformed date or
 * channel disables the post; a malformed hour falls back to 17. A date in a
 * past Pacific year is well-formed but can never post, so it warns too.
 */
export function wrappedAnnounceConfig(
  env: Record<string, string | undefined>,
  warn: (message: string) => void = (message) => logger.warn(message),
  now: Date = new Date(),
): WrappedAnnounceConfig {
  let date: string | undefined = WRAPPED_ANNOUNCE_DEFAULT_DATE;
  const rawDate = env.WRAPPED_ANNOUNCE_DATE?.trim();
  if (rawDate) {
    if (DATE_PATTERN.test(rawDate) && isRealDate(rawDate)) {
      date = rawDate;
    } else {
      date = undefined;
      warn(
        'WRAPPED_ANNOUNCE_DATE is not a real YYYY-MM-DD date; the Wrapped announcement will not be posted',
      );
    }
  }
  if (
    date !== undefined &&
    announceYear({ date }) < tz(dayjs(now), PACIFIC).year()
  ) {
    warn(
      'WRAPPED_ANNOUNCE_DATE is in a past year, so the Wrapped announcement will never be posted; set it to a date this year',
    );
  }
  let hour = WRAPPED_ANNOUNCE_DEFAULT_HOUR;
  const rawHour = env.WRAPPED_ANNOUNCE_HOUR?.trim();
  if (rawHour) {
    const parsed = Number(rawHour);
    if (HOUR_PATTERN.test(rawHour) && parsed >= 0 && parsed <= 23) {
      hour = parsed;
    } else {
      warn(
        `WRAPPED_ANNOUNCE_HOUR is not an hour 0-23; using ${WRAPPED_ANNOUNCE_DEFAULT_HOUR}`,
      );
    }
  }
  let channelId: string | undefined;
  const rawChannel = env.WRAPPED_ANNOUNCE_CHANNEL_ID?.trim();
  if (!rawChannel) {
    warn(
      'WRAPPED_ANNOUNCE_CHANNEL_ID is not set; the Wrapped announcement will not be posted',
    );
  } else if (SNOWFLAKE.test(rawChannel)) {
    channelId = rawChannel;
  } else {
    warn(
      'WRAPPED_ANNOUNCE_CHANNEL_ID is not a Discord channel id (17-20 digits); the Wrapped announcement will not be posted',
    );
  }
  return { date, hour, channelId };
}

/** '2026-02-30' matches the pattern but is no date: UTC round-trips the real ones only. */
function isRealDate(value: string): boolean {
  const [y, m, d] = value.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === m - 1 &&
    probe.getUTCDate() === d
  );
}

let loaded: WrappedAnnounceConfig | undefined;

/**
 * process.env's config, parsed once per process: the scheduler reads it at
 * boot (so the warnings are boot warnings, through its log), and the
 * dashboard gets the same object with no second warning.
 */
export function loadWrappedAnnounceConfig(
  warn?: (message: string) => void,
): WrappedAnnounceConfig {
  if (loaded === undefined) {
    loaded = wrappedAnnounceConfig(process.env, warn);
  }
  return loaded;
}

/** The year the notice is about: the configured date's. */
export function announceYear(config: { date: string }): number {
  return Number(config.date.slice(0, 4));
}

/**
 * The instant of the configured hour on the configured date, Pacific. Across
 * a DST change the hour is read as the clock there: the repeated 01:00 of the
 * fall-back day is its second occurrence (standard time), the skipped 02:00
 * of the spring-forward day is 03:00 daylight time; either way one instant.
 */
export function announceDueAt(config: { date: string; hour: number }): Date {
  const hh = String(config.hour).padStart(2, '0');
  return dayjs.tz(`${config.date} ${hh}:00:00`, PACIFIC).toDate();
}

/**
 * Due from the configured instant until the end of that Pacific calendar
 * year: a bot down on the day still posts when it is back, while a date left
 * over from last year posts nothing.
 */
export function isAnnounceDue(
  now: Date,
  config: { date: string; hour: number },
): boolean {
  return (
    now.getTime() >= announceDueAt(config).getTime() &&
    tz(dayjs(now), PACIFIC).year() === announceYear(config)
  );
}

/**
 * The notice itself. Plain text in an embed: no @everyone, @here or role
 * mention anywhere (the sender also parses no mentions). A DM variant can
 * reuse this.
 */
export function wrappedAnnounceEntry(
  year: number,
  origin: string = PUBLIC_APP_ORIGIN,
): LogEntry {
  return {
    title: `Your 1.5 Gen Wrapped ${year} is ready`,
    description: [
      'Your year with the group, wrapped: run `/wrapped` in any channel to see it ' +
        'privately, and share it if you like.',
      `On the web: ${origin}/host/wrapped`,
      'Wrapped is for linked members. Not linked yet? Press **Verify** in ' +
        `<#${GET_VERIFIED_CHANNEL_ID}> to link your Meetup account, then run \`/wrapped\`.`,
    ].join('\n'),
  };
}

/** The year's row: what the tick needs of PostgresWrappedAnnouncementRepository (claim and markPosted on the same instance). */
export type WrappedAnnounceStore = Pick<
  PostgresWrappedAnnouncementRepository,
  'claim' | 'markPosted' | 'release' | 'get'
>;

/** After a failed post the job waits this long before trying again (Post now does not wait). */
export const WRAPPED_RETRY_BACKOFF_MS = 60 * 60 * 1000;
/** The failure alert is said once per UTC day. */
export const FAILED_ALERT_TTL_SEC = 26 * 60 * 60;
export const failedAlertKey = (day: string) =>
  `wrapped-announce-failed-alert:${day}`;

export interface WrappedAnnounceDeps {
  now(): Date;
  config(): WrappedAnnounceConfig;
  store(): Promise<WrappedAnnounceStore>;
  /** Dedupes the failure alert (exclusive_set). */
  cache(): Promise<KeyValueCache>;
  /** Sends the embed to the channel; the landed post (postEmbed), undefined when it did not land. May reject. */
  post(channelId: string, entry: LogEntry): Promise<PostedEmbed | undefined>;
  /** This bot's embed titles among the channel's recent messages; undefined when unreadable. Only read on a retry. */
  recentTitles(channelId: string): Promise<string[] | undefined>;
  /** #meetup-bot-alerts (plain, no pings): the post keeps failing. May reject. */
  alert(entry: LogEntry): Promise<unknown>;
}

export type WrappedAnnounceOutcome =
  /** No channel, or no usable date, configured. */
  | 'disabled'
  /** Before the configured instant (or after that Pacific year). */
  | 'not-due'
  | 'already-posted'
  /** Another process holds a live claim, or the job is backing off after a failed post. */
  | 'in-progress'
  | 'posted'
  /** The post did not land; the claim is released for a later tick (after the backoff). */
  | 'failed';

/** Fixed text plus the channel id (digits): nothing from Discord's error, which is in the process log. */
export function failedAlertEntry(year: number, channelId: string): LogEntry {
  return {
    title: 'Wrapped announcement not posted',
    description:
      `The "your Wrapped ${year} is ready" notice could not be posted to channel ${channelId}. ` +
      'Check that the bot can see and post in that channel (WRAPPED_ANNOUNCE_CHANNEL_ID). ' +
      'It is tried again every hour, or at once from the staff dashboard; this is said once a day. ' +
      'Details are in the process log.',
  };
}

/** Says once a day (deduped in Redis) that the post keeps failing. Never throws. */
async function alertFailure(
  deps: WrappedAnnounceDeps,
  year: number,
  channelId: string,
): Promise<void> {
  try {
    const cache = await deps.cache();
    if (
      !(await cache.exclusive_set(
        failedAlertKey(utcDay(deps.now())),
        '1',
        FAILED_ALERT_TTL_SEC,
      ))
    ) {
      return;
    }
    await deps.alert(failedAlertEntry(year, channelId));
  } catch (error) {
    logger.warn(
      `Wrapped announcement failure alert skipped: ${error instanceof Error ? error.name : 'Error'}`,
    );
  }
}

/**
 * One attempt: the job's tick, or the staff dashboard's Post now with
 * `force` (which skips the clock and the backoff, not the dedupe). Delivery
 * is at least once: the claim comes before the post, a failed post releases
 * it (with a backoff and one alert a day), and a retry first looks for the
 * notice in the channel (a timed-out send can still land) before posting
 * again. Store errors propagate.
 */
export async function runWrappedAnnounce(
  deps: WrappedAnnounceDeps,
  options: { force?: boolean } = {},
): Promise<WrappedAnnounceOutcome> {
  const schedule = announceSchedule(deps.config());
  if (schedule === undefined) {
    return 'disabled';
  }
  const { channelId } = schedule;
  if (!options.force && !isAnnounceDue(deps.now(), schedule)) {
    return 'not-due';
  }
  const year = announceYear(schedule);
  const store = await deps.store();
  const claim = await store.claim(year, {
    ignoreBackoff: options.force === true,
  });
  if (!claim) {
    return (await store.get(year))?.postedAt ? 'already-posted' : 'in-progress';
  }
  const entry = wrappedAnnounceEntry(year);
  if (claim === 'retry') {
    const titles = await deps
      .recentTitles(channelId)
      .catch((): string[] | undefined => undefined);
    if (titles?.includes(entry.title)) {
      await store.markPosted(year, { channelId, messageId: undefined });
      logger.info(
        `Wrapped ${year} announcement was already in the channel; marked posted`,
      );
      return 'posted';
    }
  }
  let posted: PostedEmbed | undefined;
  try {
    posted = await deps.post(channelId, entry);
  } catch (error) {
    logger.warn(
      `Wrapped ${year} announcement post threw: ${error instanceof Error ? error.name : 'Error'}`,
    );
  }
  if (posted !== undefined) {
    if (
      !(await store.markPosted(year, {
        channelId,
        messageId: posted.messageId,
      }))
    ) {
      logger.warn(
        `Wrapped ${year} announcement posted, but its claim was taken over; a retry will find the post`,
      );
    }
    return 'posted';
  }
  await store.release(year, WRAPPED_RETRY_BACKOFF_MS);
  await alertFailure(deps, year, channelId);
  return 'failed';
}

/** Production deps: the shared dashboard pool's repository, the shared cache, and the bot client for the posts. */
export function productionWrappedAnnounceDeps(
  getClient: () => Client | undefined,
  config: () => WrappedAnnounceConfig = () => loadWrappedAnnounceConfig(),
): WrappedAnnounceDeps {
  return {
    now: () => new Date(),
    config,
    store: () => PostgresWrappedAnnouncementRepository.instance(),
    cache: () => ApplicationCache(),
    post: async (channelId, entry) => {
      const client = getClient();
      return client
        ? postEmbed(client, channelId, EMBED_COLORS.info, entry)
        : undefined;
    },
    recentTitles: async (channelId) => {
      const client = getClient();
      return client ? recentEmbedTitles(client, channelId) : undefined;
    },
    alert: async (entry) => {
      const client = getClient();
      return client ? logAlert(client, entry) : false;
    },
  };
}

export const WRAPPED_ANNOUNCE_TICK_MS = 15 * 60 * 1000;

export interface WrappedAnnounceSchedulerOptions {
  env?: Record<string, string | undefined>;
  /** The parsed config (tests). Left out: process.env, parsed once, warning through `log`. */
  config?: () => WrappedAnnounceConfig;
  setIntervalFn?: typeof setInterval;
  log?: Pick<Logger<unknown>, 'warn' | 'error' | 'info'>;
}

/**
 * Ticks once now and every 15 minutes; runWrappedAnnounce decides whether
 * the post is due. A tick still running when the next fires is skipped (the
 * Postgres claim covers other processes). Without DATABASE_URL there is no
 * row to claim, and without a channel or a usable date nothing to post, so
 * it never starts. The config's own warnings are the boot warnings; this
 * adds one line saying the job is off.
 */
export function startWrappedAnnounceScheduler(
  _client: Client,
  makeDeps: () => WrappedAnnounceDeps,
  options: WrappedAnnounceSchedulerOptions = {},
): void {
  const env = options.env ?? process.env;
  const log = options.log ?? logger;
  if (!env.DATABASE_URL) {
    log.warn('Wrapped announcement disabled: DATABASE_URL is not set');
    return;
  }
  const config = (
    options.config ??
    (() => loadWrappedAnnounceConfig((message) => log.warn(message)))
  )();
  if (announceSchedule(config) === undefined) {
    log.info('Wrapped announcement disabled: see the warning above');
    return;
  }
  let running = false;
  const tick = () => {
    if (running) {
      return;
    }
    running = true;
    let pending: Promise<WrappedAnnounceOutcome>;
    try {
      pending = runWrappedAnnounce(makeDeps());
    } catch (error) {
      pending = Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    pending
      .then((outcome) => {
        if (outcome !== 'not-due' && outcome !== 'already-posted') {
          log.info(`Wrapped announcement: ${outcome}`);
        }
      })
      .catch((error: unknown) => {
        // Process log only: what reaches here is infrastructure (pg, Discord
        // client), and operators need its text.
        log.error(`Wrapped announcement tick failed: ${String(error)}`);
      })
      .finally(() => {
        running = false;
      });
  };
  tick();
  (options.setIntervalFn ?? setInterval)(tick, WRAPPED_ANNOUNCE_TICK_MS);
}
