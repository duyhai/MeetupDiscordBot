import { Client } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  IDENTITY_DIGEST_UTC_HOUR,
  annotateReverts,
  formatIdentityDigest,
  identityDigestWindow,
  runIdentityDigestOnce,
} from '../../../src/lib/helpers/identityDigest.js';
import { logAlert } from '../../../src/lib/helpers/discordLogger.js';
import { runIdentitySweep } from '../../../src/lib/helpers/identitySweep.js';
import { IdentityChangeRecord } from '../../../src/lib/repositories/identityTypes.js';

const repo = vi.hoisted(() => ({
  listChangesMetadataBetween: vi.fn(),
  storageStats: vi.fn(),
}));
const cache = vi.hoisted(() => ({
  exclusive_set: vi.fn(),
  remove: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/util/identityRepository.js', () => ({
  ApplicationIdentityRepository: vi.fn(async () => repo),
}));
vi.mock('../../../src/util/cache.js', () => ({
  ApplicationCache: vi.fn(async () => cache),
}));
vi.mock('../../../src/lib/helpers/discordLogger.js', () => ({
  logAlert: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../../src/lib/helpers/identitySweep.js', () => ({
  runIdentitySweep: vi.fn().mockResolvedValue({ scanned: 0, changed: 0 }),
}));

const at = (iso: string) => new Date(iso);

const change = (
  over: Partial<IdentityChangeRecord> = {},
): IdentityChangeRecord => ({
  id: '1',
  discordUserId: 'u1',
  field: 'user_avatar',
  oldValue: 'aaa',
  newValue: 'bbb',
  oldThumb: null,
  newThumb: null,
  detectedAt: at('2026-08-16T14:02:00Z'),
  source: 'event',
  ...over,
});

const stats = { changeCount: 1204, totalBytes: 64_000_000 };

describe('annotateReverts', () => {
  it('marks a change that was undone later the same day', () => {
    const out = annotateReverts([
      change({ id: '1', oldValue: 'aaa', newValue: 'bbb' }),
      change({
        id: '2',
        oldValue: 'bbb',
        newValue: 'aaa',
        detectedAt: at('2026-08-16T18:31:00Z'),
      }),
    ]);

    // A change reverted hours later is far more suspicious than one that
    // stuck, and a daily snapshot diff would miss the pair entirely.
    expect(out[0].revertedAt).toEqual(at('2026-08-16T18:31:00Z'));
  });

  it('leaves a change that stuck unannotated', () => {
    const out = annotateReverts([change()]);

    expect(out[0].revertedAt).toBeUndefined();
  });

  it('annotates only the original, not the change that reverted it', () => {
    const out = annotateReverts([
      change({ id: '1', oldValue: 'aaa', newValue: 'bbb' }),
      change({
        id: '2',
        oldValue: 'bbb',
        newValue: 'aaa',
        detectedAt: at('2026-08-16T18:31:00Z'),
      }),
    ]);

    // Direction matters: without the ordering check the later change matches
    // the earlier one and reports a revert timestamp that precedes it.
    expect(out[0].revertedAt).toEqual(at('2026-08-16T18:31:00Z'));
    expect(out[1].revertedAt).toBeUndefined();
  });

  it("does not treat another member's change as a revert", () => {
    const out = annotateReverts([
      change({ id: '1', discordUserId: 'u1' }),
      change({
        id: '2',
        discordUserId: 'u2',
        oldValue: 'bbb',
        newValue: 'aaa',
        detectedAt: at('2026-08-16T18:31:00Z'),
      }),
    ]);

    expect(out[0].revertedAt).toBeUndefined();
  });
});

describe('formatIdentityDigest', () => {
  it('returns undefined when there were no changes', () => {
    // A silent day must post nothing rather than an empty embed.
    expect(formatIdentityDigest([], stats)).toBeUndefined();
  });

  it('lists each change and reports storage', () => {
    const entry = formatIdentityDigest([change()], stats);

    expect(entry?.title).toContain('1');
    expect(entry?.description).toContain('<@u1>');
    expect(entry?.description).toContain('user avatar');
    expect(entry?.description).toContain('1,204 changes on record');
  });

  it('notes the revert inline', () => {
    const entry = formatIdentityDigest(
      annotateReverts([
        change({ id: '1' }),
        change({
          id: '2',
          oldValue: 'bbb',
          newValue: 'aaa',
          detectedAt: at('2026-08-16T18:31:00Z'),
        }),
      ]),
      stats,
    );

    expect(entry?.description).toContain('reverted');
  });

  it('truncates a flood rather than exceeding the embed limit', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      change({ id: String(i), discordUserId: `u${i}` }),
    );

    const entry = formatIdentityDigest(many, stats);

    // Discord rejects descriptions over 4096 characters outright, which would
    // turn a busy day into no digest at all.
    expect((entry?.description ?? '').length).toBeLessThanOrEqual(4096);
    expect(entry?.description).toContain('more');
  });
});

describe('identityDigestWindow', () => {
  it('anchors both ends to the digest hour, not to the run time', () => {
    // Run time deliberately not on the hour: a `now - 24h` window would start
    // at 18:41 yesterday, so anything between yesterday's run and this one
    // falls into neither digest -- or, if a run slips earlier, into both.
    const { since, until } = identityDigestWindow(
      new Date(Date.UTC(2026, 7, 16, IDENTITY_DIGEST_UTC_HOUR, 41, 7)),
    );

    expect(until.toISOString()).toBe(
      `2026-08-16T${String(IDENTITY_DIGEST_UTC_HOUR).padStart(2, '0')}:00:00.000Z`,
    );
    expect(since.toISOString()).toBe(
      `2026-08-15T${String(IDENTITY_DIGEST_UTC_HOUR).padStart(2, '0')}:00:00.000Z`,
    );
  });

  it('makes consecutive days exactly contiguous', () => {
    const day1 = identityDigestWindow(
      new Date(Date.UTC(2026, 7, 16, IDENTITY_DIGEST_UTC_HOUR, 3)),
    );
    const day2 = identityDigestWindow(
      new Date(Date.UTC(2026, 7, 17, IDENTITY_DIGEST_UTC_HOUR, 55)),
    );

    // No gap and no overlap: every change lands in exactly one digest.
    expect(day2.since.getTime()).toBe(day1.until.getTime());
  });
});

describe('runIdentityDigestOnce', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(
      new Date(Date.UTC(2026, 7, 16, IDENTITY_DIGEST_UTC_HOUR, 5)),
    );
    cache.exclusive_set.mockResolvedValue(true);
    cache.remove.mockResolvedValue(undefined);
    repo.listChangesMetadataBetween.mockResolvedValue([change()]);
    repo.storageStats.mockResolvedValue(stats);
    vi.mocked(logAlert).mockResolvedValue(true);
    vi.mocked(runIdentitySweep).mockResolvedValue({ scanned: 0, changed: 0 });
  });
  afterEach(() => vi.useRealTimers());

  const client = {} as Client;

  it('claims the day before running the sweep', async () => {
    await runIdentityDigestOnce(client);

    // Sweeping first means every dyno restart during the digest hour pays for
    // a redundant full 2,008-member pass that is then discarded at the claim.
    expect(cache.exclusive_set.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(runIdentitySweep).mock.invocationCallOrder[0],
    );
  });

  it('does no work at all when another dyno already claimed the day', async () => {
    cache.exclusive_set.mockResolvedValue(false);

    await runIdentityDigestOnce(client);

    expect(runIdentitySweep).not.toHaveBeenCalled();
    expect(logAlert).not.toHaveBeenCalled();
  });

  it('anchors since to the digest hour, not the last 24h from now', async () => {
    await runIdentityDigestOnce(client);

    const [since] = repo.listChangesMetadataBetween.mock.calls[0] as Date[];
    // System time is HH:05; a `now - 24h` window would carry those 5 minutes.
    expect(since.getUTCMinutes()).toBe(0);
  });

  it('extends until past the sweep so its own rows are captured', async () => {
    vi.mocked(runIdentitySweep).mockImplementation(async () => {
      // The sweep is a full-guild pass that takes real wall-clock time; a
      // change it detects gets `detected_at` stamped after the digest-hour
      // boundary the sweep just ran past.
      vi.setSystemTime(
        new Date(Date.UTC(2026, 7, 16, IDENTITY_DIGEST_UTC_HOUR, 12)),
      );
      return { scanned: 1, changed: 1 };
    });

    await runIdentityDigestOnce(client);

    const [, until] = repo.listChangesMetadataBetween.mock.calls[0] as Date[];
    // The fixed 18:00 boundary the sweep blew past is not enough; `until`
    // must reach at least as far as the moment the sweep actually finished.
    expect(until.getTime()).toBeGreaterThanOrEqual(
      Date.UTC(2026, 7, 16, IDENTITY_DIGEST_UTC_HOUR, 12),
    );
  });

  it('includes a change written during the sweep in the same digest', async () => {
    const sweepChange = change({
      id: 'sweep-1',
      detectedAt: at('2026-08-16T18:12:00Z'),
    });
    repo.listChangesMetadataBetween.mockImplementation(
      async (since: Date, until: Date) =>
        [sweepChange].filter(
          (c) => c.detectedAt >= since && c.detectedAt < until,
        ),
    );
    vi.mocked(runIdentitySweep).mockImplementation(async () => {
      vi.setSystemTime(
        new Date(Date.UTC(2026, 7, 16, IDENTITY_DIGEST_UTC_HOUR, 12, 5)),
      );
      return { scanned: 1, changed: 1 };
    });

    await runIdentityDigestOnce(client);

    // The change the sweep itself wrote must reach the same digest it ran
    // for, not disappear into tomorrow's window.
    const [, entry] = vi.mocked(logAlert).mock.calls[0];
    expect(entry.description).toContain('<@u1>');
  });

  it('keeps the claim when the digest posts successfully', async () => {
    await runIdentityDigestOnce(client);

    expect(logAlert).toHaveBeenCalledTimes(1);
    expect(cache.remove).not.toHaveBeenCalled();
  });

  it('releases the claim when the post did not land', async () => {
    vi.mocked(logAlert).mockResolvedValue(false);

    // logAlert swallows every error, so without checking its result a Discord
    // outage yields: claim consumed, success logged, no digest, no retry.
    await expect(runIdentityDigestOnce(client)).rejects.toThrow();
    expect(cache.remove).toHaveBeenCalledWith('identity-digest-2026-08-16');
  });

  it('releases the claim when the sweep throws', async () => {
    vi.mocked(runIdentitySweep).mockRejectedValue(new Error('db down'));

    await expect(runIdentityDigestOnce(client)).rejects.toThrow('db down');
    expect(cache.remove).toHaveBeenCalledWith('identity-digest-2026-08-16');
  });

  it('keeps the claim on a silent day, where nothing is posted', async () => {
    repo.listChangesMetadataBetween.mockResolvedValue([]);

    await runIdentityDigestOnce(client);

    expect(logAlert).not.toHaveBeenCalled();
    expect(cache.remove).not.toHaveBeenCalled();
  });
});
