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
      /** YYYY-MM-DD, Pacific. */
      today: string;
    };

/**
 * Throws when the snapshot cannot be read. Awarding failing is logged and
 * the medals already stored are shown: the next read awards again.
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
    store.awardedMonths(),
  ]);
  const events = countedEvents(all);
  const listedAt = run?.listedAt;
  const due = listedAt ? monthsToAward(events, awarded, listedAt) : [];
  if (due.length > 0) {
    try {
      await store.award(
        due.map((month) => ({
          month,
          medals: medalsFor(month, rank(monthCounts(events, month))),
        })),
      );
    } catch (error: unknown) {
      logger.warn(
        `Medal award failed: ${error instanceof Error ? error.name : 'Error'}`,
      );
    }
  }
  const [medals, nowAwarded] =
    due.length > 0
      ? await Promise.all([store.medals(), store.awardedMonths()])
      : [await store.medals(), awarded];
  return {
    ready: true,
    updatedAt: run?.finishedAt,
    events,
    names,
    medals,
    awarded: nowAwarded,
    today: pacificDayOf(deps.now()),
  };
}
