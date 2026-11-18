import { describe, expect, it, vi } from 'vitest';

import {
  LeaderboardDeps,
  LeaderboardView,
  createLeaderboardLoader,
  streaksFor,
} from '../../../src/lib/leaderboard/leaderboard.js';
import {
  LeaderboardEvent,
  MAX_AWARD_MONTHS,
  Medal,
} from '../../../src/lib/leaderboard/standings.js';
import { LeaderboardStore } from '../../../src/lib/repositories/postgresLeaderboardRepository.js';
import { SnapshotRun } from '../../../src/lib/repositories/postgresSnapshotRepository.js';

let seq = 0;
const ev = (day: string, hostIds: string[]): LeaderboardEvent => {
  seq += 1;
  return { id: String(seq), title: 'Games', status: 'PAST', hostIds, day };
};

const run = (listedAt: Date, id = 1): SnapshotRun => ({
  id,
  trigger: 'job',
  kind: 'incremental',
  startedAt: listedAt,
  finishedAt: new Date(listedAt.getTime() + 60_000),
  listedAt,
  eventsListed: 1,
  eventsFetched: 1,
  rsvpsStored: 1,
  failed: 0,
  requests: 1,
  lastError: undefined,
});

function store(events: LeaderboardEvent[]) {
  const months = new Set<string>();
  const medals: Medal[] = [];
  const award = vi.fn(
    async (list: Parameters<LeaderboardStore['award']>[0]) => {
      list.forEach((m) => {
        if (!months.has(m.month)) {
          months.add(m.month);
          medals.push(...m.medals);
        }
      });
    },
  );
  const hostedEvents = vi.fn(async () => events);
  const s: LeaderboardStore = {
    hostedEvents,
    hostNames: async () => new Map(),
    medals: async () => [...medals],
    awardedMonths: async () => new Set(months),
    award,
  };
  return { s, award, hostedEvents, months };
}

function loader(
  s: LeaderboardStore,
  over: Partial<LeaderboardDeps> & {
    listedAt?: Date;
    complete?: Date | undefined;
  } = {},
) {
  let now = over.now?.() ?? new Date('2026-11-17T18:00:00Z');
  const listedAt = over.listedAt ?? new Date('2026-11-17T08:00:00Z');
  const complete = 'complete' in over ? over.complete : listedAt;
  const l = createLeaderboardLoader({
    store: async () => s,
    snapshot: async () => ({
      hasFinishedFull: async () => true,
      lastFinishedRun: async () => run(listedAt),
      lastCompleteListing: async () => complete,
    }),
    ...over,
    now: () => now,
  });
  return {
    load: async () => (await l.load()) as LeaderboardView,
    setNow: (d: Date) => {
      now = d;
    },
  };
}

const OCT = [
  ev('2026-10-02', ['1']),
  ev('2026-10-03', ['1']),
  ev('2026-10-04', ['2']),
];

describe('createLeaderboardLoader', () => {
  it('awards closed months off a complete listing', async () => {
    const { s, months } = store(OCT);
    const view = await loader(s).load();
    expect(months).toEqual(new Set(['2026-10']));
    expect(view.medals.map((m) => [m.memberId, m.place])).toEqual([
      ['1', 1],
      ['2', 2],
    ]);
  });

  it('never awards off a short or failed listing', async () => {
    const { s, award } = store(OCT);
    const view = await loader(s, { complete: undefined }).load();
    expect(award).not.toHaveBeenCalled();
    expect(view.awarded.size).toBe(0);
    expect(view.medals).toEqual([]);
  });

  it('awards at most MAX_AWARD_MONTHS a read; later reads take the rest', async () => {
    const history = Array.from({ length: 30 }, (_, i) => {
      const y = 2024 + Math.floor(i / 12);
      return ev(`${y}-${String((i % 12) + 1).padStart(2, '0')}-10`, ['1']);
    });
    const { s, award } = store(history);
    const l = loader(s);
    await l.load();
    expect(award.mock.calls[0][0]).toHaveLength(MAX_AWARD_MONTHS);
    expect(award.mock.calls[0][0][0].month).toBe('2024-01');
    await l.load();
    expect(award.mock.calls[1][0][0].month).toBe('2025-01');
  });

  it('caches per snapshot run: a second read within the minute reads no events', async () => {
    const { s, hostedEvents } = store(OCT);
    const l = loader(s);
    await l.load(); // awards October: not cached
    await l.load(); // nothing due: cached
    await l.load();
    expect(hostedEvents).toHaveBeenCalledTimes(2);
    l.setNow(new Date('2026-11-17T18:01:01Z'));
    await l.load();
    expect(hostedEvents).toHaveBeenCalledTimes(3);
  });

  it('backs off after a failed award, then retries', async () => {
    const { s, award } = store(OCT);
    award.mockRejectedValueOnce(new Error('lock timeout'));
    const l = loader(s, { cacheMs: 0 });
    const first = await l.load();
    expect(first.awardFailed).toBe(true);
    const second = await l.load();
    expect(award).toHaveBeenCalledTimes(1);
    expect(second.awardFailed).toBe(true);
    l.setNow(new Date('2026-11-17T18:10:01Z'));
    const third = await l.load();
    expect(award).toHaveBeenCalledTimes(2);
    expect(third.awardFailed).toBe(false);
    expect(third.awarded.has('2026-10')).toBe(true);
  });

  it('ends streaks at the snapshot day, not the wall clock', async () => {
    const days = ['2026-11-10', '2026-11-11', '2026-11-12'];
    const { s } = store(days.map((d) => ev(d, ['1'])));
    // The snapshot listed on Nov 12 (Pacific); it is now Nov 16.
    const view = await loader(s, {
      listedAt: new Date('2026-11-12T20:00:00Z'),
      now: () => new Date('2026-11-16T20:00:00Z'),
    }).load();
    expect(view.streakDay).toBe('2026-11-12');
    expect(view.today).toBe('2026-11-16');
    expect(streaksFor(view, '1').daily.current).toBe(3);
    expect(streaksFor(view, 'nobody').daily).toEqual({ current: 0, best: 0 });
  });

  it('is not ready before the first full pull', async () => {
    const { s, hostedEvents } = store(OCT);
    const l = createLeaderboardLoader({
      store: async () => s,
      snapshot: async () => ({
        hasFinishedFull: async () => false,
        lastFinishedRun: async () => undefined,
        lastCompleteListing: async () => undefined,
      }),
      now: () => new Date(),
    });
    expect(await l.load()).toEqual({ ready: false });
    expect(hostedEvents).not.toHaveBeenCalled();
  });

  it('records a month with no hosted events as awarded, with no medals', async () => {
    const { s, months } = store([
      ev('2026-08-10', ['1']),
      ev('2026-10-10', ['1']),
    ]);
    const view = await loader(s).load();
    expect(months).toEqual(new Set(['2026-08', '2026-09', '2026-10']));
    expect(view.medals.filter((m) => m.month === '2026-09')).toEqual([]);
    expect(view.awarded.has('2026-09')).toBe(true);
  });

  it('a failure arriving after the read stopped waiting still backs off', async () => {
    const { s, award } = store(OCT);
    let fail: (e: Error) => void = () => {};
    award.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const l = loader(s, { awardBudgetMs: 5, cacheMs: 0 });
    const first = await l.load();
    expect(first.awardFailed).toBe(false);
    fail(new Error('lock timeout'));
    await new Promise((r) => {
      setTimeout(r, 0);
    });
    const second = await l.load();
    expect(second.awardFailed).toBe(true);
    expect(award).toHaveBeenCalledTimes(1);
  });

  it('shares one build and one award between concurrent reads', async () => {
    const { s, award, hostedEvents } = store(OCT);
    let finish: () => void = () => {};
    award.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const l = loader(s, { awardBudgetMs: 5, cacheMs: 0 });
    await Promise.all([l.load(), l.load(), l.load()]);
    expect(hostedEvents).toHaveBeenCalledTimes(1);
    // A read after the budget, while the award still runs, waits on it.
    await l.load();
    expect(award).toHaveBeenCalledTimes(1);
    finish();
  });
});
