/**
 * Loads what the Leaderboard page shows, from the snapshot only, and awards
 * closed months' medals on the way (standings.ts has the rules).
 *
 * The page runs in the bot's process, so the work is kept small and done
 * once: events come with their Pacific day from SQL, are bucketed by month
 * and host in one pass, and the result is cached per snapshot run for
 * CACHE_MS. A read awards at most MAX_AWARD_MONTHS months (the first reads
 * after deploy work through the history 12 months at a time), and never off
 * a listing that was not complete.
 */
import { Logger } from 'tslog';

import type { SnapshotRun } from '../repositories/postgresSnapshotRepository.js';
import type { LeaderboardStore } from '../repositories/postgresLeaderboardRepository.js';
import { AwardBoard, awardBoards } from './awards.js';
import {
  HostStreaks,
  LeaderboardEvent,
  Medal,
  countedEvents,
  countsByMonth,
  eventsByHost,
  firstMonthOf,
  medalsFor,
  monthsToAward,
  pacificDayOf,
  rank,
  streaksOf,
} from './standings.js';

const logger = new Logger({ name: 'hostLeaderboard' });

export interface LeaderboardDeps {
  store: () => Promise<LeaderboardStore>;
  snapshot: () => Promise<{
    hasFinishedFull(): Promise<boolean>;
    lastFinishedRun(): Promise<SnapshotRun | undefined>;
    /** The latest finished run's listing end, only if it was complete. */
    lastCompleteListing(): Promise<Date | undefined>;
  }>;
  now: () => Date;
  /** Tests: AWARD_BUDGET_MS, CACHE_MS, AWARD_RETRY_MS. */
  awardBudgetMs?: number;
  cacheMs?: number;
  awardRetryMs?: number;
}

/** The longest a read waits for the award's database writes. */
export const AWARD_BUDGET_MS = 2000;
/** A loaded leaderboard is reused this long while the snapshot run is the same. */
export const CACHE_MS = 60_000;
/** After a failed award, reads do not try again for this long. */
export const AWARD_RETRY_MS = 10 * 60_000;

export interface LeaderboardView {
  ready: true;
  /** When the latest snapshot run finished. */
  updatedAt: Date | undefined;
  /** Counted hosted events only, oldest first. */
  events: LeaderboardEvent[];
  names: Map<string, string>;
  medals: Medal[];
  awarded: Set<string>;
  /** Medals could not be read: the page says so and shows none. */
  medalsUnavailable: boolean;
  /** The last award attempt failed (retried after AWARD_RETRY_MS). */
  awardFailed: boolean;
  /** Each host's counted events. */
  byHost: Map<string, LeaderboardEvent[]>;
  /** Events per host, per Pacific month. */
  byMonth: Map<string, Map<string, number>>;
  /** Each host's streaks, as of `streakDay`. */
  streaks: Map<string, HostStreaks>;
  /** The earliest month with a counted event; undefined with none. */
  firstMonth: string | undefined;
  /** Pacific day of the snapshot listing (or now, if sooner): streaks end here. */
  streakDay: string;
  /** Pacific day now: the current month. */
  today: string;
  /** The Hall of fame's all-time award boards, computed once per load. */
  awards: AwardBoard[];
}

export type LeaderboardData = { ready: false } | LeaderboardView;

const NO_STREAK: HostStreaks = {
  daily: { current: 0, best: 0 },
  weekly: { current: 0, best: 0 },
};

export const streaksFor = (data: LeaderboardView, id: string): HostStreaks =>
  data.streaks.get(id) ?? NO_STREAK;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}

/** The awarded months; undefined (logged) when they cannot be read. */
async function awardedOrNone(
  store: LeaderboardStore,
): Promise<Set<string> | undefined> {
  try {
    return await store.awardedMonths();
  } catch (error: unknown) {
    // Medals are extra: the page shows the standings without them.
    logger.warn(`Medal months read failed: ${errorName(error)}`);
    return undefined;
  }
}

type AwardOutcome = 'done' | 'failed' | 'late';

/** `outcome`, or 'late' once `budgetMs` has passed; never throws. */
async function within(
  outcome: Promise<AwardOutcome>,
  budgetMs: number,
): Promise<AwardOutcome> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<AwardOutcome>((resolve) => {
    timer = setTimeout(() => resolve('late'), budgetMs);
  });
  const first = await Promise.race([outcome, late]);
  clearTimeout(timer);
  return first;
}

/**
 * A loader with its own cache and award back-off: one per process. load()
 * throws when the snapshot's events cannot be read. Medals never fail the
 * page: unreadable medals leave it without them.
 */
export function createLeaderboardLoader(deps: LeaderboardDeps): {
  load(): Promise<LeaderboardData>;
} {
  const cacheMs = deps.cacheMs ?? CACHE_MS;
  const retryMs = deps.awardRetryMs ?? AWARD_RETRY_MS;
  let cached: { key: string; at: number; view: LeaderboardView } | undefined;
  let awardFailedAt: number | undefined;
  /** One award at a time: later reads wait on it instead of queueing on the lock. */
  let awardInFlight: Promise<AwardOutcome> | undefined;
  /** One build per snapshot run at a time: concurrent misses share it. */
  let building:
    | {
        key: string;
        promise: Promise<{ view: LeaderboardView; cacheable: boolean }>;
      }
    | undefined;

  /** Starts an award unless one is running; settles to its outcome, never rejects. */
  function award(
    store: LeaderboardStore,
    months: { month: string; medals: Medal[] }[],
  ): Promise<AwardOutcome> {
    if (awardInFlight === undefined) {
      const running = store
        .award(months)
        .then(
          (): AwardOutcome => {
            awardFailedAt = undefined;
            return 'done';
          },
          (error: unknown): AwardOutcome => {
            // Also when it settles after the read stopped waiting.
            logger.warn(`Medal award failed: ${errorName(error)}`);
            awardFailedAt = deps.now().getTime();
            return 'failed';
          },
        )
        .finally(() => {
          awardInFlight = undefined;
        });
      awardInFlight = running;
    }
    return awardInFlight;
  }
  const failedRecently = (now: number) =>
    awardFailedAt !== undefined && now - awardFailedAt < retryMs;

  async function build(
    run: SnapshotRun | undefined,
    complete: Date | undefined,
    nowDate: Date,
  ): Promise<{ view: LeaderboardView; cacheable: boolean }> {
    const store = await deps.store();
    const [all, names, awarded] = await Promise.all([
      store.hostedEvents(),
      store.hostNames(),
      awardedOrNone(store),
    ]);
    const events = countedEvents(all);
    const byHost = eventsByHost(events);
    const byMonth = countsByMonth(events);
    const firstMonth = firstMonthOf(events);
    // Streaks end at the snapshot's day: a stale snapshot never shows
    // every streak as broken.
    const listedAt = run?.listedAt;
    const streakDay = pacificDayOf(
      listedAt && listedAt < nowDate ? listedAt : nowDate,
    );
    const streaks = new Map<string, HostStreaks>();
    byHost.forEach((hostEvents, id) => {
      streaks.set(id, streaksOf(hostEvents, streakDay));
    });
    const view = (
      medals: Medal[],
      months: Set<string>,
      medalsUnavailable: boolean,
    ): LeaderboardView => ({
      ready: true,
      updatedAt: run?.finishedAt,
      events,
      names,
      medals,
      awarded: months,
      medalsUnavailable,
      awardFailed: failedRecently(deps.now().getTime()),
      byHost,
      byMonth,
      streaks,
      firstMonth,
      streakDay,
      today: pacificDayOf(nowDate),
      awards: awardBoards({ events, byHost, streaks, medals, names }),
    });
    if (awarded === undefined) {
      return { view: view([], new Set(), true), cacheable: false };
    }
    let cacheable = true;
    const due =
      complete && !failedRecently(nowDate.getTime())
        ? monthsToAward(firstMonth, awarded, complete)
        : [];
    if (due.length > 0) {
      await within(
        award(
          store,
          due.map((month) => ({
            month,
            medals: medalsFor(
              month,
              rank(byMonth.get(month) ?? new Map<string, number>()),
            ),
          })),
        ),
        deps.awardBudgetMs ?? AWARD_BUDGET_MS,
      );
      // More months may be due (the cap), or the award is still running.
      cacheable = false;
    }
    try {
      // Months first, then medals: an award committing in between can only
      // add medals for a month not yet shown as awarded, never the reverse.
      const months = due.length > 0 ? await store.awardedMonths() : awarded;
      const medals = await store.medals();
      return { view: view(medals, months, false), cacheable };
    } catch (error: unknown) {
      logger.warn(`Medal read failed: ${errorName(error)}`);
      return { view: view([], new Set(), true), cacheable: false };
    }
  }

  return {
    async load(): Promise<LeaderboardData> {
      const snapshot = await deps.snapshot();
      if (!(await snapshot.hasFinishedFull())) {
        return { ready: false };
      }
      const [run, complete] = await Promise.all([
        snapshot.lastFinishedRun(),
        snapshot.lastCompleteListing(),
      ]);
      const nowDate = deps.now();
      const key = `${run?.id ?? ''}:${run?.finishedAt?.getTime() ?? ''}`;
      if (
        cached &&
        cached.key === key &&
        nowDate.getTime() - cached.at < cacheMs
      ) {
        return { ...cached.view, today: pacificDayOf(nowDate) };
      }
      if (building?.key !== key) {
        const promise = build(run, complete, nowDate);
        const mine = { key, promise };
        building = mine;
        promise
          .then(({ view, cacheable }) => {
            // A slower build for an older run never replaces a newer one.
            if (building !== mine) {
              return;
            }
            cached = cacheable
              ? { key, at: nowDate.getTime(), view }
              : undefined;
          })
          .catch(() => undefined)
          .finally(() => {
            if (building === mine) {
              building = undefined;
            }
          });
      }
      const { view } = await building.promise;
      return { ...view, today: pacificDayOf(nowDate) };
    },
  };
}
