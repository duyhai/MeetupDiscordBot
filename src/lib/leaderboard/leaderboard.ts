/**
 * Loads what the Leaderboard page shows, from the snapshot only, and awards
 * any closed month's medals on the way (standings.ts has the rules).
 */
import { Logger } from 'tslog';

import type { SnapshotRun } from '../repositories/postgresSnapshotRepository.js';
import type { LeaderboardStore } from '../repositories/postgresLeaderboardRepository.js';
import {
  LeaderboardEvent,
  Medal,
  countedEvents,
  medalsFor,
  monthCounts,
  monthsToAward,
  pacificDayOf,
  rank,
} from './standings.js';

const logger = new Logger({ name: 'hostLeaderboard' });

export interface LeaderboardDeps {
  store: () => Promise<LeaderboardStore>;
  snapshot: () => Promise<{
    hasFinishedFull(): Promise<boolean>;
    lastFinishedRun(): Promise<SnapshotRun | undefined>;
  }>;
  now: () => Date;
  /** Tests: how long a read waits for awarding (AWARD_BUDGET_MS). */
  awardBudgetMs?: number;
}

/**
 * The longest a page read waits for awarding (the first read backfills
 * every past month). Past it the award finishes in the background, under
 * its lock, and this read shows the medals stored so far.
 */
export const AWARD_BUDGET_MS = 2000;

/** The awarded months; undefined (logged) when they cannot be read. */
async function awardedOrNone(
  store: LeaderboardStore,
): Promise<Set<string> | undefined> {
  try {
    return await store.awardedMonths();
  } catch (error: unknown) {
    // Medals are extra: the page shows the standings without them.
    logger.warn(
      `Medal months read failed: ${error instanceof Error ? error.name : 'Error'}`,
    );
    return undefined;
  }
}

/** Awards, waiting at most `budgetMs`; never throws. */
async function awardWithin(
  store: LeaderboardStore,
  months: { month: string; medals: Medal[] }[],
  budgetMs: number,
): Promise<void> {
  const award = store.award(months).catch((error: unknown) => {
    logger.warn(
      `Medal award failed: ${error instanceof Error ? error.name : 'Error'}`,
    );
  });
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, budgetMs);
  });
  await Promise.race([award, late]);
  clearTimeout(timer);
}

export type LeaderboardData =
  | { ready: false }
  | {
      ready: true;
      /** When the latest snapshot run finished. */
      updatedAt: Date | undefined;
      /** Counted hosted events only. */
      events: LeaderboardEvent[];
      names: Map<string, string>;
      medals: Medal[];
      awarded: Set<string>;
      /** Medals could not be read: the page says so and shows none. */
      medalsUnavailable: boolean;
      /** YYYY-MM-DD, Pacific. */
      today: string;
    };

/**
 * Throws when the snapshot cannot be read. Medals never fail or hold up the
 * page: awarding waits at most AWARD_BUDGET_MS and a failure is logged (the
 * next read awards again); medals that cannot be read leave the page
 * without them.
 */
export async function loadLeaderboard(
  deps: LeaderboardDeps,
): Promise<LeaderboardData> {
  const snapshot = await deps.snapshot();
  if (!(await snapshot.hasFinishedFull())) {
    return { ready: false };
  }
  const store = await deps.store();
  const [run, all, names, awarded] = await Promise.all([
    snapshot.lastFinishedRun(),
    store.hostedEvents(),
    store.hostNames(),
    awardedOrNone(store),
  ]);
  const events = countedEvents(all);
  const page = (
    m: Medal[],
    months: Set<string>,
  ): Extract<LeaderboardData, { ready: true }> => ({
    ready: true,
    updatedAt: run?.finishedAt,
    events,
    names,
    medals: m,
    awarded: months,
    medalsUnavailable: false,
    today: pacificDayOf(deps.now()),
  });
  const withoutMedals = (): LeaderboardData => ({
    ...page([], new Set()),
    medalsUnavailable: true,
  });
  const listedAt = run?.listedAt;
  if (awarded === undefined) {
    return withoutMedals();
  }
  const due = listedAt ? monthsToAward(events, awarded, listedAt) : [];
  if (due.length > 0) {
    await awardWithin(
      store,
      due.map((month) => ({
        month,
        medals: medalsFor(month, rank(monthCounts(events, month))),
      })),
      deps.awardBudgetMs ?? AWARD_BUDGET_MS,
    );
  }
  let medals: Medal[] = [];
  let nowAwarded = awarded;
  try {
    // Months first, then medals: an award committing in between can only
    // add medals for a month not yet shown as awarded, never the reverse.
    if (due.length > 0) {
      nowAwarded = await store.awardedMonths();
    }
    medals = await store.medals();
  } catch (error: unknown) {
    logger.warn(
      `Medal read failed: ${error instanceof Error ? error.name : 'Error'}`,
    );
    return withoutMedals();
  }
  return page(medals, nowAwarded);
}
