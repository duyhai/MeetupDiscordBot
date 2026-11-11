import { describe, expect, it } from 'vitest';

import { CachedWrapped, writeWrapped } from '../../../src/lib/wrapped/cache.js';
import {
  BACKFILL_TICK_MS,
  MEMBERS_PER_TICK,
  NEXT_TICK_KEY,
  discordClock,
  pacificClock,
  queueForLater,
  queuedText,
  readyBy,
} from '../../../src/lib/wrapped/queue.js';
import { FakeCache } from '../../web/fakeCache.js';
import { FakeBackfillStore } from './backfillFakes.js';

const USER = '100000000000000001';
/** 2026-12-10, 12:00 Pacific. */
const NOW = new Date('2026-12-10T20:00:00Z');

const wrapped: CachedWrapped = {
  meetupId: 'm1',
  stats: {
    year: 2026,
    firstEvent: null,
    attendedThisYear: 0,
    attendedAllTime: 0,
    topTypes: [],
    hosting: null,
    busiestMonth: null,
    longestStreakMonths: 0,
    activeYears: [],
  },
  companions: { named: [], otherCount: 0 },
  builtAt: NOW.toISOString(),
};

describe('readyBy', () => {
  it('counts one tick per four entries from the next tick', () => {
    expect(MEMBERS_PER_TICK).toBe(4);
    expect(BACKFILL_TICK_MS).toBe(5 * 60_000);
    const next = new Date('2026-12-10T20:03:00Z');
    expect(readyBy(next, 1)).toEqual(next);
    expect(readyBy(next, 4)).toEqual(next);
    expect(readyBy(next, 5)).toEqual(new Date('2026-12-10T20:08:00Z'));
    expect(readyBy(next, 9)).toEqual(new Date('2026-12-10T20:13:00Z'));
  });

  it('skips the sweep-window closure (17:45–19:00 UTC)', () => {
    const next = new Date('2026-12-10T18:02:00Z');
    expect(readyBy(next, 2)).toEqual(new Date('2026-12-10T19:00:00Z'));
    // From 17:45 no build starts (the report job's lead on the identity sweep).
    expect(readyBy(new Date('2026-12-10T17:58:00Z'), 2)).toEqual(
      new Date('2026-12-10T19:00:00Z'),
    );
    expect(readyBy(new Date('2026-12-10T17:40:00Z'), 2)).toEqual(
      new Date('2026-12-10T17:40:00Z'),
    );
    // Past the quiet hour the remaining ticks still count.
    // 17:55 is inside the closure: that tick and the two behind it land after 19:00.
    expect(readyBy(new Date('2026-12-10T17:55:00Z'), 9)).toEqual(
      new Date('2026-12-10T19:10:00Z'),
    );
  });
});

describe('queueForLater', () => {
  it("enqueues when nothing is cached and reports the position's ready-by", async () => {
    const store = new FakeBackfillStore(() => NOW.getTime());
    const cache = new FakeCache();
    await cache.set(NEXT_TICK_KEY, '2026-12-10T20:03:00.000Z');
    await store.enqueue({ discordUserId: '9', meetupId: 'x', year: 2026 });

    const outcome = await queueForLater(
      store,
      { cache },
      { discordUserId: USER, meetupId: 'm1' },
      2025,
      NOW,
    );

    expect(outcome).toEqual({
      kind: 'queued',
      year: 2025,
      readyBy: new Date('2026-12-10T20:03:00Z'),
    });
    expect((await store.position(USER))?.row).toMatchObject({
      meetupId: 'm1',
      year: 2025,
    });
  });

  it('falls back to one tick from now without a recorded next tick', async () => {
    const store = new FakeBackfillStore(() => NOW.getTime());
    const outcome = await queueForLater(
      store,
      { cache: new FakeCache() },
      { discordUserId: USER, meetupId: 'm1' },
      2026,
      NOW,
    );
    expect(outcome).toMatchObject({
      kind: 'queued',
      readyBy: new Date(NOW.getTime() + BACKFILL_TICK_MS),
    });
  });

  it('reports the year already queued', async () => {
    const store = new FakeBackfillStore(() => NOW.getTime());
    await store.enqueue({ discordUserId: USER, meetupId: 'm1', year: 2024 });

    const outcome = await queueForLater(
      store,
      { cache: new FakeCache() },
      { discordUserId: USER, meetupId: 'm1' },
      2026,
      NOW,
    );

    expect(outcome).toMatchObject({ kind: 'already', year: 2024 });
  });

  it('the same year queued again reads as queued, not "already"', async () => {
    const store = new FakeBackfillStore(() => NOW.getTime());
    await store.enqueue({ discordUserId: USER, meetupId: 'm1', year: 2026 });

    const outcome = await queueForLater(
      store,
      { cache: new FakeCache() },
      { discordUserId: USER, meetupId: 'm1' },
      2026,
      NOW,
    );

    expect(outcome).toMatchObject({ kind: 'queued', year: 2026 });
  });

  it('is "cached" when a copy for the current Meetup id exists', async () => {
    const store = new FakeBackfillStore(() => NOW.getTime());
    const cache = new FakeCache();
    await writeWrapped(cache, USER, 2026, wrapped, NOW);

    expect(
      await queueForLater(
        store,
        { cache },
        { discordUserId: USER, meetupId: 'm1' },
        2026,
        NOW,
      ),
    ).toEqual({ kind: 'cached' });
    expect(await store.queueLength()).toBe(0);
    // A copy for another Meetup account (a relink) is not a copy.
    expect(
      await queueForLater(
        store,
        { cache },
        { discordUserId: USER, meetupId: 'm2' },
        2026,
        NOW,
      ),
    ).toMatchObject({ kind: 'queued' });
  });
});

describe('queuedText', () => {
  const at = new Date('2026-12-10T20:05:00Z');

  it('spells both outcomes', () => {
    expect(
      queuedText({ kind: 'queued', year: 2026, readyBy: at }, pacificClock),
    ).toBe("Queued — it'll be ready by about 12:05 pm.");
    expect(
      queuedText({ kind: 'already', year: 2024, readyBy: at }, discordClock),
    ).toBe(
      "You already have 2024 queued; it'll be ready by about <t:1796933100:t>.",
    );
  });
});
