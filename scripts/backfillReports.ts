/**
 * One-off: builds the Hall of Fame and no-show reports for every finished
 * month since the group's first (March 2013), with the daily job's own build
 * code (buildMonth), organizer credential and uncached Meetup client.
 *
 *   heroku run:detached -a meetup-discord-bot "PG_POOL_MAX=1 yarn tsx scripts/backfillReports.ts"
 *
 * Options:
 *   --from YYYY-MM         oldest month to build (default 2013-03, never earlier)
 *   --force                rebuild months that already have a finished build
 *   --delay-ms N           pause after each month read from Meetup (0-60000, default 5000)
 *   --allow-all-departed   save months where 3+ no-show members have all left
 *
 * - Resumable: months with a finished build (both current rows built after the
 *   month ended) are skipped unless --force, so re-running continues.
 * - Newest month first, one at a time, each under the shared Redis build lease
 *   (report-build-claim), so it never builds while the bot's own job does. A
 *   lease held by another build for over 20 minutes stops the run.
 * - Never starts a month 17:45-19:00 UTC or while the identity digest runs;
 *   it refuses to start then, and stops before the next month mid-run.
 * - Posts a start post, a progress post every 12 months and a final post to
 *   #meetup-bot-alerts over Discord REST only: no gateway login, no content,
 *   allowed_mentions { parse: [] }. Error text in posts is describeBuildError's
 *   (never a Meetup body); full errors go to the process log only.
 * - Stops (exit 3) after a 401 or 429 from Meetup, no usable organizer token,
 *   3 failed months in a row, a Redis timeout (5 s per command), or SIGTERM
 *   / SIGINT (the month in progress finishes first).
 * - Needs DATABASE_URL, REDISCLOUD_URL and DISCORD_API_KEY. Sets PG_POOL_MAX=1
 *   when unset, so the dyno holds at most three connections (dashboard 1,
 *   suspension 1, credential 1). PG_POOL_MAX must never be set as an app
 *   config var: it would shrink the web dyno's pools too.
 *
 * Exit codes: 0 done; 1 bad arguments, missing env or failed months;
 * 2 refused to start; 3 stopped early (run it again to resume).
 */
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Re-exported by discord.js (@discordjs/rest, discord-api-types); no gateway
// Client is ever created.
import { REST, Routes } from 'discord.js';
import { Logger } from 'tslog';

import { BOT_ALERTS_CHANNEL_ID } from '../src/constants.js';
import { KeyValueCache } from '../src/lib/cache/base.js';
import { RedisCache } from '../src/lib/cache/redisCache.js';
import { LogEntry } from '../src/lib/helpers/discordLogger.js';
import {
  BACKFILL_DEFAULT_DELAY_MS,
  BACKFILL_LEASE_WAIT_MS,
  BackfillRefusal,
  BackfillRefusedError,
  backfillLogText,
  runBackfill,
} from '../src/lib/reports/backfill.js';
import { organizerMonthReports } from '../src/lib/reports/buildJob.js';
import {
  comparePeriods,
  GROUP_FIRST_PERIOD,
  parsePeriodKey,
  Period,
  periodKey,
} from '../src/lib/reports/period.js';
import { PostgresReportSnapshotRepository } from '../src/lib/repositories/postgresReportSnapshotRepository.js';
import { PostgresSuspensionRepository } from '../src/lib/repositories/postgresSuspensionRepository.js';
// A script may import src/web (only src/lib must not).
import {
  releaseLateBuildLease,
  timedCacheFactory,
} from '../src/web/timedCache.js';

const logger = new Logger({ name: 'backfillReports' });

export interface BackfillArgs {
  force: boolean;
  from?: Period;
  delayMs: number;
  allowAllDeparted: boolean;
}

const MAX_DELAY_MS = 60_000;

/** Every backfill Redis command gives up after this; the run then stops as cache-unavailable. */
export const BACKFILL_CACHE_TIMEOUT_MS = 5_000;

/**
 * Redis with a per-command timeout, so an outage stops the run instead of
 * hanging it (node-redis queues commands while offline). A lease granted
 * after its request timed out is released at once through the untimed
 * client (value-compared), so it is never left ownerless for its TTL.
 */
export function backfillCache(
  getInner: () => Promise<KeyValueCache> = () => RedisCache.instance(),
  ms: number = BACKFILL_CACHE_TIMEOUT_MS,
): () => Promise<KeyValueCache> {
  return timedCacheFactory(
    getInner,
    ms,
    releaseLateBuildLease(getInner, logger),
  );
}

export interface SignalSource {
  on(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
  removeListener(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
}

/**
 * SIGTERM (Heroku restart or deploy) or SIGINT asks the run to stop before
 * the next month: the month in progress finishes and releases its lease,
 * then the final post goes out and main exits 3. Heroku sends SIGKILL about
 * 30 s after SIGTERM; a month still building then is killed with its lease
 * held until the lease TTL (30 minutes) runs out, and nothing of it is saved
 * unless both rows were (a re-run rebuilds it either way).
 */
export function stopOnSignals(source: SignalSource = process): {
  requested(): boolean;
  dispose(): void;
} {
  let requested = false;
  const onSignal = () => {
    if (!requested) {
      logger.warn('Backfill asked to stop: finishing the current month');
    }
    requested = true;
  };
  source.on('SIGTERM', onSignal);
  source.on('SIGINT', onSignal);
  return {
    requested: () => requested,
    dispose: () => {
      source.removeListener('SIGTERM', onSignal);
      source.removeListener('SIGINT', onSignal);
    },
  };
}

/** Never echoes an argument back: it could be anything. */
export function parseBackfillArgs(
  argv: string[],
): BackfillArgs | { error: string } {
  const args: BackfillArgs = {
    force: false,
    delayMs: BACKFILL_DEFAULT_DELAY_MS,
    allowAllDeparted: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      continue;
    }
    if (arg === '--force') {
      args.force = true;
    } else if (arg === '--allow-all-departed') {
      args.allowAllDeparted = true;
    } else if (arg === '--from') {
      const from = parsePeriodKey(argv[i + 1] ?? '');
      if (!from || comparePeriods(from, GROUP_FIRST_PERIOD) < 0) {
        return {
          error: `--from needs a month YYYY-MM, no earlier than ${periodKey(GROUP_FIRST_PERIOD)}`,
        };
      }
      args.from = from;
      i += 1;
    } else if (arg === '--delay-ms') {
      const value = argv[i + 1] ?? '';
      const delayMs = /^[0-9]{1,5}$/.test(value) ? Number(value) : NaN;
      if (!(delayMs >= 0 && delayMs <= MAX_DELAY_MS)) {
        return {
          error: `--delay-ms needs a whole number from 0 to ${MAX_DELAY_MS}`,
        };
      }
      args.delayMs = delayMs;
      i += 1;
    } else {
      return { error: 'unknown argument' };
    }
  }
  return args;
}

/** One embed per post, no content, no mentions. False (logged) when the post failed. */
export function restPoster(
  rest: Pick<REST, 'post'>,
  channelId: string = BOT_ALERTS_CHANNEL_ID,
): (entry: LogEntry) => Promise<boolean> {
  return async (entry: LogEntry): Promise<boolean> => {
    try {
      await rest.post(Routes.channelMessages(channelId), {
        body: {
          embeds: [
            {
              title: entry.title,
              description: entry.description,
              color: 0x5865f2,
              timestamp: new Date().toISOString(),
            },
          ],
          allowed_mentions: { parse: [] },
        },
      });
      return true;
    } catch (error) {
      logger.warn(
        `Backfill post failed: ${error instanceof Error ? error.name : 'Error'}`,
      );
      return false;
    }
  };
}

const REFUSAL_TEXT: Record<BackfillRefusal, string> = {
  'quiet-window':
    'Refusing to start between 17:45 and 19:00 UTC (the identity sweep). Run it after 19:00 UTC.',
  'identity-sweep':
    'Refusing to start while the identity sweep runs. Run it again in a few minutes.',
  'before-group': `--from cannot be earlier than ${periodKey(GROUP_FIRST_PERIOD)}.`,
  'cache-unavailable':
    'Refusing to start: Redis did not answer, so the build lease could not be taken. Run it again later.',
  'already-running':
    'Refusing to start: another backfill is running (or one was killed in the last 30 minutes ' +
    'without releasing its lock). Two runs and the bot would exceed the database connection limit. Try again later.',
};

export async function main(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  signals: SignalSource = process,
): Promise<number> {
  const args = parseBackfillArgs(argv);
  if ('error' in args) {
    logger.error(args.error);
    return 1;
  }
  // Before any pool exists (each is created on first use).
  if (env.PG_POOL_MAX === undefined) {
    env.PG_POOL_MAX = '1';
  }
  if (!env.DATABASE_URL) {
    logger.error('DATABASE_URL is not set');
    return 1;
  }
  if (!env.REDISCLOUD_URL) {
    logger.error(
      'REDISCLOUD_URL is not set: the backfill needs Redis for the shared build lease',
    );
    return 1;
  }
  if (!env.DISCORD_API_KEY) {
    logger.error('DISCORD_API_KEY is not set');
    return 1;
  }
  const rest = new REST({ version: '10' }).setToken(env.DISCORD_API_KEY);
  const [snapshots, suspensions] = await Promise.all([
    PostgresReportSnapshotRepository.instance(),
    PostgresSuspensionRepository.instance(),
  ]);
  const stop = stopOnSignals(signals);
  try {
    const result = await runBackfill(
      {
        now: () => new Date(),
        // Redis itself, never the in-memory fallback: only Redis excludes
        // the bot's own build job. Timed, so an outage stops the run.
        cache: backfillCache(),
        build: {
          now: () => new Date(),
          snapshots,
          // No Discord client: the organizer token helper sends no alerts.
          fetchMonthReports: organizerMonthReports(undefined, suspensions),
        },
        post: restPoster(rest),
        sleep: (ms) =>
          new Promise((resolve) => {
            setTimeout(resolve, ms);
          }),
        newLeaseValue: () => crypto.randomUUID(),
        log: logger,
        stopRequested: () => stop.requested(),
      },
      {
        force: args.force,
        from: args.from,
        delayMs: args.delayMs,
        leaseWaitMs: BACKFILL_LEASE_WAIT_MS,
        allowAllDeparted: args.allowAllDeparted,
      },
    );
    logger.info(
      `Backfill done: ${result.built.length} built, ${result.skipped.length} skipped, ` +
        `${result.failed.length} failed${result.stopped ? `, stopped (${result.stopped})` : ''}`,
    );
    if (result.stopped) {
      return 3;
    }
    return result.failed.length > 0 ? 1 : 0;
  } catch (error) {
    if (error instanceof BackfillRefusedError) {
      logger.error(REFUSAL_TEXT[error.reason]);
      return 2;
    }
    throw error;
  } finally {
    stop.dispose();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  // Exit explicitly: pg and Redis keep the process alive.
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      // Full details (never a Meetup body): backfillLogText.
      logger.error(`Backfill crashed: ${backfillLogText(error)}`);
      process.exit(1);
    },
  );
}
