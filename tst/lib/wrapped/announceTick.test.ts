import { describe, expect, it, vi } from 'vitest';

import {
  runWrappedAnnounce,
  WrappedAnnounceDeps,
  WrappedAnnounceStore,
  wrappedAnnounceEntry,
} from '../../../src/lib/wrapped/announce.js';
import {
  WrappedAnnouncementRecord,
  WrappedClaim,
} from '../../../src/lib/repositories/postgresWrappedAnnouncementRepository.js';

const CHANNEL = '123456789012345678';
const MESSAGE = '987654321098765432';
const CONFIG = { date: '2026-12-01', hour: 17, channelId: CHANNEL };
/** 17:05 Pacific on 1 Dec 2026. */
const DUE = new Date('2026-12-02T01:05:00Z');
const EARLY = new Date('2026-12-02T00:55:00Z');

/**
 * The repository's contract in memory, shared by every "process" in a test:
 * one row per year, claimed before posting, final once posted, retryable
 * after a release.
 */
class FakeStore implements WrappedAnnounceStore {
  readonly rows = new Map<
    number,
    {
      postedAt?: Date;
      channelId?: string;
      messageId?: string;
      released: boolean;
    }
  >();

  async claim(year: number): Promise<WrappedClaim> {
    const row = this.rows.get(year);
    if (!row) {
      this.rows.set(year, { released: false });
      return 'fresh';
    }
    if (row.postedAt || !row.released) {
      return false;
    }
    row.released = false;
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

  async release(year: number): Promise<void> {
    const row = this.rows.get(year);
    if (row && !row.postedAt) {
      row.released = true;
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
        }
      : undefined;
  }
}

function makeDeps(
  overrides: Partial<WrappedAnnounceDeps> = {},
  store = new FakeStore(),
) {
  const post = vi
    .fn<WrappedAnnounceDeps['post']>()
    .mockResolvedValue({ messageId: MESSAGE });
  const recentTitles = vi
    .fn<WrappedAnnounceDeps['recentTitles']>()
    .mockResolvedValue([]);
  const deps: WrappedAnnounceDeps = {
    now: () => DUE,
    config: () => CONFIG,
    store: async () => store,
    post,
    recentTitles,
    ...overrides,
  };
  return { deps, store, post, recentTitles };
}

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

  it('a failed post releases the claim and the next tick retries', async () => {
    const { deps, store, post } = makeDeps();
    post.mockResolvedValueOnce(undefined);
    expect(await runWrappedAnnounce(deps)).toBe('failed');
    expect((await store.get(2026))?.postedAt).toBeUndefined();
    expect(await runWrappedAnnounce(deps)).toBe('posted');
    expect(post).toHaveBeenCalledTimes(2);
    expect((await store.get(2026))?.messageId).toBe(MESSAGE);
  });

  it('a post that throws counts as failed and is retried', async () => {
    const { deps, post } = makeDeps();
    post.mockRejectedValueOnce(new Error('Discord 503'));
    expect(await runWrappedAnnounce(deps)).toBe('failed');
    expect(await runWrappedAnnounce(deps)).toBe('posted');
  });

  it('a retry first looks for the notice in the channel and marks it posted without posting again', async () => {
    const { deps, store, post, recentTitles } = makeDeps();
    post.mockResolvedValueOnce(undefined);
    expect(await runWrappedAnnounce(deps)).toBe('failed');
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
    const { deps, post, recentTitles } = makeDeps();
    post.mockResolvedValueOnce(undefined);
    await runWrappedAnnounce(deps);
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
