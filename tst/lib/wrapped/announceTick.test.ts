import { describe, expect, it, vi } from 'vitest';

import {
  failedAlertEntry,
  failedAlertKey,
  FAILED_ALERT_TTL_SEC,
  runWrappedAnnounce,
  WRAPPED_RETRY_BACKOFF_MS,
  WrappedAnnounceDeps,
  WrappedAnnounceStore,
  wrappedAnnounceEntry,
} from '../../../src/lib/wrapped/announce.js';
import {
  WrappedAnnouncementRecord,
  WrappedClaim,
  WrappedClaimOptions,
} from '../../../src/lib/repositories/postgresWrappedAnnouncementRepository.js';
import { FakeCache } from '../../web/fakeCache.js';

const CHANNEL = '123456789012345678';
const MESSAGE = '987654321098765432';
const CONFIG = { date: '2026-12-01', hour: 17, channelId: CHANNEL };
/** 17:05 Pacific on 1 Dec 2026. */
const DUE = new Date('2026-12-02T01:05:00Z');
const EARLY = new Date('2026-12-02T00:55:00Z');

/**
 * The repository's contract in memory, shared by every "process" in a test:
 * one row per year, claimed before posting, final once posted, retryable
 * after a release (after its backoff, unless ignoreBackoff). `clock` stands
 * in for the database clock.
 */
class FakeStore implements WrappedAnnounceStore {
  clock = DUE.getTime();

  readonly rows = new Map<
    number,
    {
      postedAt?: Date;
      channelId?: string;
      messageId?: string;
      released: boolean;
      retryAfter?: number;
    }
  >();

  readonly releases: number[] = [];

  async claim(
    year: number,
    options: WrappedClaimOptions = {},
  ): Promise<WrappedClaim> {
    const row = this.rows.get(year);
    if (!row) {
      this.rows.set(year, { released: false });
      return 'fresh';
    }
    if (row.postedAt || !row.released) {
      return false;
    }
    if (
      !options.ignoreBackoff &&
      row.retryAfter !== undefined &&
      row.retryAfter > this.clock
    ) {
      return false;
    }
    row.released = false;
    row.retryAfter = undefined;
    return 'retry';
  }

  async markPosted(
    year: number,
    post: { channelId: string; messageId: string | undefined },
  ): Promise<boolean> {
    const row = this.rows.get(year);
    if (!row || row.postedAt) {
      return false;
    }
    row.postedAt = new Date('2026-12-02T01:05:30Z');
    row.channelId = post.channelId;
    row.messageId = post.messageId;
    return true;
  }

  async release(year: number, retryAfterMs = 0): Promise<void> {
    this.releases.push(retryAfterMs);
    const row = this.rows.get(year);
    if (row && !row.postedAt) {
      row.released = true;
      row.retryAfter = this.clock + retryAfterMs;
    }
  }

  async get(year: number): Promise<WrappedAnnouncementRecord | undefined> {
    const row = this.rows.get(year);
    return row
      ? {
          year,
          claimedAt: new Date('2026-12-02T01:05:00Z'),
          postedAt: row.postedAt,
          channelId: row.channelId,
          messageId: row.messageId,
          retryAfter:
            row.retryAfter === undefined ? undefined : new Date(row.retryAfter),
        }
      : undefined;
  }
}

function makeDeps(
  overrides: Partial<WrappedAnnounceDeps> = {},
  store = new FakeStore(),
  cache = new FakeCache(),
) {
  const post = vi
    .fn<WrappedAnnounceDeps['post']>()
    .mockResolvedValue({ messageId: MESSAGE });
  const recentTitles = vi
    .fn<WrappedAnnounceDeps['recentTitles']>()
    .mockResolvedValue([]);
  const alert = vi.fn<WrappedAnnounceDeps['alert']>().mockResolvedValue(true);
  const deps: WrappedAnnounceDeps = {
    now: () => DUE,
    config: () => CONFIG,
    store: async () => store,
    cache: async () => cache,
    post,
    recentTitles,
    alert,
    ...overrides,
  };
  return { deps, store, cache, post, recentTitles, alert };
}

/** The next tick, after the job's backoff has passed (Post now does not wait). */
const afterBackoff = (store: FakeStore) => {
  store.clock += WRAPPED_RETRY_BACKOFF_MS;
};

describe('runWrappedAnnounce', () => {
  it('posts the notice once it is due, then records channel and message', async () => {
    const { deps, store, post } = makeDeps();
    expect(await runWrappedAnnounce(deps)).toBe('posted');
    expect(post).toHaveBeenCalledWith(CHANNEL, wrappedAnnounceEntry(2026));
    expect(await store.get(2026)).toMatchObject({
      year: 2026,
      channelId: CHANNEL,
      messageId: MESSAGE,
    });
    expect((await store.get(2026))?.postedAt).toBeInstanceOf(Date);
  });

  it('does nothing before the due instant', async () => {
    const { deps, store, post } = makeDeps({ now: () => EARLY });
    expect(await runWrappedAnnounce(deps)).toBe('not-due');
    expect(post).not.toHaveBeenCalled();
    expect(store.rows.size).toBe(0);
  });

  it('with no channel configured, posts nothing and touches no store', async () => {
    const storeSpy = vi.fn<WrappedAnnounceDeps['store']>();
    const { deps, post } = makeDeps({
      config: () => ({ ...CONFIG, channelId: undefined }),
      store: storeSpy,
    });
    expect(await runWrappedAnnounce(deps)).toBe('disabled');
    expect(await runWrappedAnnounce(deps, { force: true })).toBe('disabled');
    expect(post).not.toHaveBeenCalled();
    expect(storeSpy).not.toHaveBeenCalled();
  });

  it('with a malformed date (no date), posts nothing even when forced', async () => {
    const storeSpy = vi.fn<WrappedAnnounceDeps['store']>();
    const { deps, post } = makeDeps({
      config: () => ({ ...CONFIG, date: undefined }),
      store: storeSpy,
    });
    expect(await runWrappedAnnounce(deps)).toBe('disabled');
    expect(await runWrappedAnnounce(deps, { force: true })).toBe('disabled');
    expect(post).not.toHaveBeenCalled();
    expect(storeSpy).not.toHaveBeenCalled();
  });

  it('a second tick after a post is a no-op (dedupe across ticks)', async () => {
    const { deps, post } = makeDeps();
    expect(await runWrappedAnnounce(deps)).toBe('posted');
    expect(await runWrappedAnnounce(deps)).toBe('already-posted');
    expect(await runWrappedAnnounce(deps)).toBe('already-posted');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('the job and the Post now button share one row: whichever is first posts, the other sees it', async () => {
    const store = new FakeStore();
    const button = makeDeps({ now: () => EARLY }, store);
    const job = makeDeps({}, store);
    // Leadership presses Post now before the date: posted (force skips the clock).
    expect(await runWrappedAnnounce(button.deps, { force: true })).toBe(
      'posted',
    );
    // The job's tick on the day finds it done.
    expect(await runWrappedAnnounce(job.deps)).toBe('already-posted');
    expect(job.post).not.toHaveBeenCalled();
    // And a second press is refused too.
    expect(await runWrappedAnnounce(button.deps, { force: true })).toBe(
      'already-posted',
    );
    expect(button.post).toHaveBeenCalledTimes(1);
  });

  it('a failed post releases the claim with the backoff; the job retries once it has passed', async () => {
    const { deps, store, post } = makeDeps();
    post.mockResolvedValueOnce(undefined);
    expect(await runWrappedAnnounce(deps)).toBe('failed');
    expect(store.releases).toEqual([WRAPPED_RETRY_BACKOFF_MS]);
    expect((await store.get(2026))?.postedAt).toBeUndefined();
    // The next 15-minute tick is inside the backoff: nothing, said as such.
    expect(await runWrappedAnnounce(deps)).toBe('backing-off');
    expect(post).toHaveBeenCalledTimes(1);
    afterBackoff(store);
    expect(await runWrappedAnnounce(deps)).toBe('posted');
    expect(post).toHaveBeenCalledTimes(2);
    expect((await store.get(2026))?.messageId).toBe(MESSAGE);
  });

  it('Post now (force) retries at once, through the backoff', async () => {
    const { deps, post } = makeDeps();
    post.mockResolvedValueOnce(undefined);
    expect(await runWrappedAnnounce(deps)).toBe('failed');
    expect(await runWrappedAnnounce(deps, { force: true })).toBe('posted');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('a failed post alerts #meetup-bot-alerts once a day: fixed text and the channel id, no pings', async () => {
    const { deps, store, post, alert, cache } = makeDeps();
    post.mockResolvedValue(undefined);
    expect(await runWrappedAnnounce(deps)).toBe('failed');
    expect(alert).toHaveBeenCalledTimes(1);
    const entry = failedAlertEntry(2026, CHANNEL);
    expect(alert).toHaveBeenCalledWith(entry);
    expect(entry.description).toContain(CHANNEL);
    expect(`${entry.title}\n${entry.description ?? ''}`).not.toMatch(
      /@everyone|@here|<@/,
    );
    expect(cache.ttls.get(failedAlertKey('2026-12-02'))).toBe(
      FAILED_ALERT_TTL_SEC,
    );
    // A second failure the same day: no second alert.
    afterBackoff(store);
    expect(await runWrappedAnnounce(deps)).toBe('failed');
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it('an alert that did not land gives the day back, so the next failure says it', async () => {
    const { deps, store, post, alert, cache } = makeDeps();
    post.mockResolvedValue(undefined);
    // The alerts channel is unreadable (logAlert resolves false, never throws).
    alert.mockResolvedValueOnce(false);
    expect(await runWrappedAnnounce(deps)).toBe('failed');
    expect(alert).toHaveBeenCalledTimes(1);
    expect(cache.values.has(failedAlertKey('2026-12-02'))).toBe(false);
    afterBackoff(store);
    expect(await runWrappedAnnounce(deps)).toBe('failed');
    expect(alert).toHaveBeenCalledTimes(2);
    expect(cache.values.has(failedAlertKey('2026-12-02'))).toBe(true);
  });

  it('an alert that throws gives the day back too', async () => {
    const { deps, store, post, alert, cache } = makeDeps();
    post.mockResolvedValue(undefined);
    alert.mockRejectedValueOnce(new Error('discord down'));
    expect(await runWrappedAnnounce(deps)).toBe('failed');
    expect(cache.values.has(failedAlertKey('2026-12-02'))).toBe(false);
    afterBackoff(store);
    expect(await runWrappedAnnounce(deps)).toBe('failed');
    expect(alert).toHaveBeenCalledTimes(2);
  });

  it('Post now never posts a past year’s notice, even forced', async () => {
    const storeSpy = vi.fn<WrappedAnnounceDeps['store']>();
    const { deps, post } = makeDeps({
      config: () => ({ ...CONFIG, date: '2025-12-01' }),
      store: storeSpy,
    });
    expect(await runWrappedAnnounce(deps, { force: true })).toBe('disabled');
    expect(await runWrappedAnnounce(deps)).toBe('disabled');
    expect(post).not.toHaveBeenCalled();
    expect(storeSpy).not.toHaveBeenCalled();
  });

  it('an alert that cannot be deduped or sent never breaks the tick', async () => {
    const { deps, post } = makeDeps({
      cache: () => Promise.reject(new Error('redis down')),
    });
    post.mockResolvedValueOnce(undefined);
    expect(await runWrappedAnnounce(deps)).toBe('failed');
    const { deps: deps2, post: post2 } = makeDeps({
      alert: () => Promise.reject(new Error('discord down')),
    });
    post2.mockResolvedValueOnce(undefined);
    expect(await runWrappedAnnounce(deps2)).toBe('failed');
  });

  it('a post that throws counts as failed and is retried', async () => {
    const { deps, store, post } = makeDeps();
    post.mockRejectedValueOnce(new Error('Discord 503'));
    expect(await runWrappedAnnounce(deps)).toBe('failed');
    afterBackoff(store);
    expect(await runWrappedAnnounce(deps)).toBe('posted');
  });

  it('a retry first looks for the notice in the channel and marks it posted without posting again', async () => {
    const { deps, store, post, recentTitles } = makeDeps();
    post.mockResolvedValueOnce(undefined);
    expect(await runWrappedAnnounce(deps)).toBe('failed');
    afterBackoff(store);
    // The timed-out send landed after all.
    recentTitles.mockResolvedValueOnce([wrappedAnnounceEntry(2026).title]);
    expect(await runWrappedAnnounce(deps)).toBe('posted');
    expect(post).toHaveBeenCalledTimes(1);
    expect(recentTitles).toHaveBeenCalledWith(CHANNEL);
    expect(await store.get(2026)).toMatchObject({
      channelId: CHANNEL,
      messageId: undefined,
    });
    expect((await store.get(2026))?.postedAt).toBeInstanceOf(Date);
  });

  it('a fresh claim never reads the channel history', async () => {
    const { deps, recentTitles } = makeDeps();
    expect(await runWrappedAnnounce(deps)).toBe('posted');
    expect(recentTitles).not.toHaveBeenCalled();
  });

  it('an unreadable history on a retry posts anyway', async () => {
    const { deps, store, post, recentTitles } = makeDeps();
    post.mockResolvedValueOnce(undefined);
    await runWrappedAnnounce(deps);
    afterBackoff(store);
    recentTitles.mockRejectedValueOnce(new Error('Missing Access'));
    expect(await runWrappedAnnounce(deps)).toBe('posted');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('a live claim held by another process is reported as in progress', async () => {
    const store = new FakeStore();
    const other = makeDeps({}, store);
    const mine = makeDeps({}, store);
    // The other process claimed but has not posted yet (nor released).
    expect(await store.claim(2026)).toBe('fresh');
    expect(await runWrappedAnnounce(mine.deps)).toBe('in-progress');
    expect(mine.post).not.toHaveBeenCalled();
    expect(other.post).not.toHaveBeenCalled();
  });

  it('a store failure propagates (the scheduler logs it; the button answers error)', async () => {
    const { deps } = makeDeps({
      store: () => Promise.reject(new Error('no pool')),
    });
    await expect(runWrappedAnnounce(deps)).rejects.toThrow('no pool');
  });
});
