import { Client } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  IDENTITY_DIGEST_UTC_HOUR,
  annotateReverts,
  formatIdentityDigest,
  identityDigestWindow,
  runIdentityDigestOnce,
} from '../../../../src/lib/helpers/identity/digest.js';
import { logAlert } from '../../../../src/lib/helpers/discordLogger.js';
import { runMeetupSweep } from '../../../../src/lib/helpers/identity/meetupSweep.js';
import { runIdentitySweep } from '../../../../src/lib/helpers/identity/sweep.js';
import { IdentityChangeRecord } from '../../../../src/lib/repositories/identityTypes.js';

const repo = vi.hoisted(() => ({
  listChangesMetadataAfterId: vi.fn(),
  maxChangeId: vi.fn(),
  changeIdBefore: vi.fn(),
  getDigestCursor: vi.fn(),
  setDigestCursor: vi.fn(),
  storageStats: vi.fn(),
}));
const cache = vi.hoisted(() => ({
  exclusive_set: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn().mockResolvedValue(undefined),
}));
const memberRepo = vi.hoisted(() => ({
  listAll: vi.fn(),
}));

vi.mock('../../../../src/util/identityRepository.js', () => ({
  ApplicationIdentityRepository: vi.fn(async () => repo),
}));
vi.mock('../../../../src/util/cache.js', () => ({
  ApplicationCache: vi.fn(async () => cache),
}));
vi.mock('../../../../src/util/memberRepository.js', () => ({
  ApplicationMemberRepository: vi.fn(async () => memberRepo),
}));
vi.mock('../../../../src/lib/helpers/discordLogger.js', () => ({
  logAlert: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../../../src/lib/helpers/identity/sweep.js', () => ({
  runIdentitySweep: vi.fn().mockResolvedValue({ scanned: 0, changed: 0 }),
}));
vi.mock('../../../../src/lib/helpers/identity/meetupSweep.js', () => ({
  runMeetupSweep: vi.fn().mockResolvedValue({ scanned: 0, changed: 0 }),
}));

const at = (iso: string) => new Date(iso);

const change = (
  over: Partial<IdentityChangeRecord> = {},
): IdentityChangeRecord => ({
  id: '1',
  platform: 'discord',
  scopeId: 'g1',
  subjectId: 'u1',
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

  it("does not treat another platform's change as a revert", () => {
    const out = annotateReverts([
      change({
        id: '1',
        platform: 'discord',
        subjectId: '12345',
        field: 'username',
      }),
      change({
        id: '2',
        platform: 'meetup',
        subjectId: '12345',
        field: 'username',
        oldValue: 'bbb',
        newValue: 'aaa',
        detectedAt: at('2026-08-16T18:31:00Z'),
      }),
    ]);

    // Meetup member ids and Discord user ids are both opaque numeric strings
    // from separate namespaces, and `username` exists on both sides -- so
    // without the platform check a collision reports one platform's change as
    // a revert of the other's.
    expect(out[0].revertedAt).toBeUndefined();
  });

  it("does not treat another member's change as a revert", () => {
    const out = annotateReverts([
      change({ id: '1', subjectId: 'u1' }),
      change({
        id: '2',
        subjectId: 'u2',
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
    expect(formatIdentityDigest([], stats, new Map())).toBeUndefined();
  });

  it('lists each change and reports storage', () => {
    const entry = formatIdentityDigest([change()], stats, new Map());

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
      new Map(),
    );

    expect(entry?.description).toContain('reverted');
  });

  it('truncates a flood rather than exceeding the embed limit', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      change({ id: String(i), subjectId: `u${i}` }),
    );

    const entry = formatIdentityDigest(many, stats, new Map());

    // Discord rejects descriptions over 4096 characters outright, which would
    // turn a busy day into no digest at all.
    expect((entry?.description ?? '').length).toBeLessThanOrEqual(4096);
    expect(entry?.description).toContain('more');
  });

  it('labels which platform each change came from', () => {
    const entry = formatIdentityDigest(
      [
        change({ platform: 'discord', subjectId: 'u1' }),
        change({ platform: 'meetup', subjectId: 'm1', field: 'photo' }),
      ],
      stats,
      new Map(),
    );

    // Without the label an organizer cannot tell which profile to go look at.
    expect(entry?.description).toContain('Discord');
    expect(entry?.description).toContain('Meetup');
  });

  it('names the linked Discord member for a Meetup change', () => {
    const entry = formatIdentityDigest(
      [change({ platform: 'meetup', subjectId: 'm1', field: 'photo' })],
      stats,
      new Map([['m1', 'u1']]),
    );

    // 'member m1 changed their photo' is unactionable; '@someone' is not.
    expect(entry?.description).toContain('<@u1>');
  });

  it('falls back to the raw Meetup id when no link exists', () => {
    const entry = formatIdentityDigest(
      [change({ platform: 'meetup', subjectId: 'm1', field: 'photo' })],
      stats,
      new Map(),
    );

    // Only 9 members are linked today, so this is the common case for now.
    expect(entry?.description).toContain('m1');
    // A missing link must never render as a broken mention.
    expect(entry?.description).not.toContain('<@undefined>');
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
    cache.get.mockResolvedValue(undefined);
    cache.set.mockResolvedValue(undefined);
    cache.remove.mockResolvedValue(undefined);
    repo.getDigestCursor.mockResolvedValue('100');
    repo.changeIdBefore.mockResolvedValue('0');
    repo.maxChangeId.mockResolvedValue('140');
    repo.setDigestCursor.mockResolvedValue(undefined);
    repo.listChangesMetadataAfterId.mockResolvedValue([change()]);
    repo.storageStats.mockResolvedValue(stats);
    memberRepo.listAll.mockResolvedValue([]);
    vi.mocked(logAlert).mockResolvedValue(true);
    vi.mocked(runIdentitySweep).mockResolvedValue({ scanned: 0, changed: 0 });
    vi.mocked(runMeetupSweep).mockResolvedValue({ scanned: 0, changed: 0 });
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
    expect(runMeetupSweep).not.toHaveBeenCalled();
    expect(logAlert).not.toHaveBeenCalled();
  });

  it('runs the Meetup sweep after the Discord sweep, in the same claim', async () => {
    await runIdentityDigestOnce(client);

    // Both sweeps must land inside the try, after the Discord sweep, before
    // `until` is computed -- so a failure in either releases the claim, and
    // both sweeps' findings can reach today's digest.
    expect(
      vi.mocked(runIdentitySweep).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(runMeetupSweep).mock.invocationCallOrder[0]);
    expect(runMeetupSweep).toHaveBeenCalledWith('sweep', client);
  });

  it('still posts the digest when the Meetup sweep throws', async () => {
    vi.mocked(runMeetupSweep).mockRejectedValue(new Error('meetup api down'));

    await runIdentityDigestOnce(client);

    // A reconciliation failure must DEGRADE the digest, not cancel it. The
    // old behaviour let one 502 on one roster page propagate out, release the
    // claim, and get swallowed by the scheduler -- no digest for either
    // platform, no alert, and no later report, because the reporting window
    // only moves forward.
    const titles = vi
      .mocked(logAlert)
      .mock.calls.map(([, entry]) => entry.title);
    expect(titles).toContain('Meetup identity sweep failed');
    expect(titles.some((title) => title.startsWith('Identity changes'))).toBe(
      true,
    );
  });

  it('still posts the digest when the Discord sweep throws', async () => {
    vi.mocked(runIdentitySweep).mockRejectedValue(new Error('discord down'));

    await runIdentityDigestOnce(client);

    const titles = vi
      .mocked(logAlert)
      .mock.calls.map(([, entry]) => entry.title);
    expect(titles).toContain('Discord identity sweep failed');
    expect(titles.some((title) => title.startsWith('Identity changes'))).toBe(
      true,
    );
  });

  it('runs the Meetup sweep even after the Discord sweep threw', async () => {
    vi.mocked(runIdentitySweep).mockRejectedValue(new Error('discord down'));

    await runIdentityDigestOnce(client);

    // Independently guarded, not one shared try: the first platform failing
    // must not skip the second platform's reconciliation.
    expect(runMeetupSweep).toHaveBeenCalledTimes(1);
  });

  it('names which sweep failed and says the rest is unaffected', async () => {
    vi.mocked(runMeetupSweep).mockRejectedValue(new Error('meetup api down'));

    await runIdentityDigestOnce(client);

    const failure = vi
      .mocked(logAlert)
      .mock.calls.map(([, entry]) => entry)
      .find((entry) => entry.title === 'Meetup identity sweep failed');
    expect(failure?.description).toContain('unaffected');
  });

  it('keeps a raw upstream error body out of the sweep-failure alert', async () => {
    vi.mocked(runMeetupSweep).mockRejectedValue(
      new Error('502: {"token":"do-not-leak"}'),
    );

    await runIdentityDigestOnce(client);

    // graphql-request's ClientError embeds the whole upstream response. Only
    // errors this codebase composes itself are quoted verbatim; everything
    // else is reduced to its class name.
    const failure = vi
      .mocked(logAlert)
      .mock.calls.map(([, entry]) => entry)
      .find((entry) => entry.title === 'Meetup identity sweep failed');
    expect(failure?.description).not.toContain('do-not-leak');
    expect(failure?.description).toContain('Error');
  });

  it('quotes the message of an error it composed itself', async () => {
    const actionable = Object.assign(
      new Error('the organizer token cannot read this group'),
      { organizerSafeMessage: true },
    );
    vi.mocked(runMeetupSweep).mockRejectedValue(actionable);

    await runIdentityDigestOnce(client);

    // The whole value of the named errors is that they name the remedy;
    // reducing them to "Error" too would throw that away.
    const failure = vi
      .mocked(logAlert)
      .mock.calls.map(([, entry]) => entry)
      .find((entry) => entry.title === 'Meetup identity sweep failed');
    expect(failure?.description).toContain('cannot read this group');
  });

  it('resolves a Meetup change to its linked Discord member in the digest', async () => {
    repo.listChangesMetadataAfterId.mockResolvedValue([
      change({ platform: 'meetup', subjectId: 'm1', field: 'photo' }),
    ]);
    memberRepo.listAll.mockResolvedValue([
      { discordUserId: 'u1', meetupId: 'm1' },
    ]);

    await runIdentityDigestOnce(client);

    const [, entry] = vi.mocked(logAlert).mock.calls[0];
    expect(entry.description).toContain('<@u1>');
  });

  it('reads from the stored high-water mark, not from a time window', async () => {
    await runIdentityDigestOnce(client);

    const [afterId] = repo.listChangesMetadataAfterId.mock.calls[0] as string[];
    expect(afterId).toBe('100');
  });

  it('does not report a change that a previous digest already reported', async () => {
    // The bug this replaces: `since` was pinned to the fixed digest hour while
    // `until` ran on to whenever the sweeps finished, so the span
    // [boundary, sweep-finish] belonged to two consecutive digests. Meetup
    // rows are 100% sweep-detected and land exactly there, so every Meetup
    // change was reported twice. An id mark has no such overlap.
    const log = [
      change({ id: '100', subjectId: 'yesterday' }),
      change({ id: '101', subjectId: 'today' }),
    ];
    repo.listChangesMetadataAfterId.mockImplementation(
      async (afterId: string, throughId: string) =>
        log.filter(
          (row) =>
            Number(row.id) > Number(afterId) &&
            Number(row.id) <= Number(throughId),
        ),
    );
    repo.maxChangeId.mockResolvedValue('101');

    await runIdentityDigestOnce(client);

    const [, entry] = vi.mocked(logAlert).mock.calls[0];
    expect(entry.description).toContain('today');
    expect(entry.description).not.toContain('yesterday');
  });

  it('leaves no gap: the next run starts exactly where this one stopped', async () => {
    await runIdentityDigestOnce(client);

    // Consecutive coverage is (mark, ceiling] then (ceiling, next-ceiling].
    // Storing anything other than the ceiling that was actually read opens
    // either a gap or an overlap.
    const stored = repo.setDigestCursor.mock.calls[0][0] as string;
    const [, through] = repo.listChangesMetadataAfterId.mock
      .calls[0] as string[];
    expect(stored).toBe(through);
  });

  it('captures rows the sweeps themselves wrote', async () => {
    // The ceiling has to be read AFTER the sweeps, or the sweeps' own
    // findings -- the changes least likely to have been caught any other way
    // -- would sit above it and wait a full day.
    expect(true).toBe(true);
    await runIdentityDigestOnce(client);

    expect(repo.maxChangeId.mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(runMeetupSweep).mock.invocationCallOrder[0],
    );
  });

  it('does not skip a change recorded while the digest was being built', async () => {
    // A gateway event landing between the read and the mark being stored must
    // not be swallowed. Advancing to a ceiling fixed before the read means
    // anything later simply waits for tomorrow.
    repo.maxChangeId.mockResolvedValue('140');
    repo.listChangesMetadataAfterId.mockImplementation(async () => {
      repo.maxChangeId.mockResolvedValue('999'); // an event lands mid-digest
      return [change()];
    });

    await runIdentityDigestOnce(client);

    expect(repo.setDigestCursor).toHaveBeenCalledWith('140');
  });

  it('falls back to the hour boundary on the very first run', async () => {
    repo.getDigestCursor.mockResolvedValue(undefined);
    repo.changeIdBefore.mockResolvedValue('57');

    await runIdentityDigestOnce(client);

    // With no mark and no fallback the first digest after deploy would report
    // the entire backfill -- thousands of rows -- as today's news.
    const [boundary] = repo.changeIdBefore.mock.calls[0] as Date[];
    expect(boundary.getUTCMinutes()).toBe(0);
    expect(boundary.getUTCHours()).toBe(IDENTITY_DIGEST_UTC_HOUR);
    const [afterId] = repo.listChangesMetadataAfterId.mock.calls[0] as string[];
    expect(afterId).toBe('57');
  });

  it('does not advance the mark when the post did not land', async () => {
    vi.mocked(logAlert).mockResolvedValue(false);

    await expect(runIdentityDigestOnce(client)).rejects.toThrow();

    // Advancing on an undelivered digest loses those rows permanently: the
    // next run starts above them and no later digest ever looks back.
    expect(repo.setDigestCursor).not.toHaveBeenCalled();
  });

  it('titles the digest with the range of the rows it actually contains', async () => {
    repo.listChangesMetadataAfterId.mockResolvedValue([
      change({ id: '101', detectedAt: at('2026-08-16T02:15:00Z') }),
      change({ id: '102', detectedAt: at('2026-08-16T17:45:00Z') }),
    ]);

    await runIdentityDigestOnce(client);

    // The digest no longer selects by time, so quoting a notional 24h window
    // would describe something other than what was queried.
    const [, entry] = vi.mocked(logAlert).mock.calls[0];
    expect(entry.title).toContain('2026-08-16 02:15');
    expect(entry.title).toContain('2026-08-16 17:45');
  });

  it('posts nothing and stores nothing when the change log is empty', async () => {
    repo.maxChangeId.mockResolvedValue(undefined);

    await runIdentityDigestOnce(client);

    expect(logAlert).not.toHaveBeenCalled();
    expect(repo.setDigestCursor).not.toHaveBeenCalled();
  });

  it('keeps the claim when the digest posts successfully', async () => {
    await runIdentityDigestOnce(client);

    expect(logAlert).toHaveBeenCalledTimes(1);
    expect(cache.remove).not.toHaveBeenCalled();
  });

  it('marks the day done once the digest has posted', async () => {
    await runIdentityDigestOnce(client);

    // Completion is a separate fact from "someone is working on this". Only
    // this marker makes a finished day un-repeatable; the claim is a lease.
    expect(cache.set).toHaveBeenCalledWith(
      'identity-digest-done-2026-08-16',
      '1',
      expect.any(Number),
    );
  });

  it('does no work at all when the day is already done', async () => {
    cache.get.mockResolvedValue('1');

    await runIdentityDigestOnce(client);

    // Checked BEFORE the claim: with ticks now arriving four times an hour, a
    // finished day would otherwise be re-swept and re-posted the moment the
    // lease expired.
    expect(cache.exclusive_set).not.toHaveBeenCalled();
    expect(runIdentitySweep).not.toHaveBeenCalled();
    expect(runMeetupSweep).not.toHaveBeenCalled();
    expect(logAlert).not.toHaveBeenCalled();
  });

  it('checks the done marker before attempting the claim', async () => {
    await runIdentityDigestOnce(client);

    expect(cache.get.mock.invocationCallOrder[0]).toBeLessThan(
      cache.exclusive_set.mock.invocationCallOrder[0],
    );
  });

  it('takes the claim as a short lease, not for the rest of the day', async () => {
    await runIdentityDigestOnce(client);

    // SIGTERM does not throw, so a killed run releases nothing. The lease
    // expiring is the only thing that lets a later tick pick the day back up;
    // a day-long claim means a deploy at 18:05 silently costs the whole day.
    const [, , ttl] = cache.exclusive_set.mock.calls[0] as [
      string,
      string,
      number,
    ];
    expect(ttl).toBeLessThanOrEqual(30 * 60);
    expect(ttl).toBeGreaterThan(0);
  });

  it('does not mark the day done when the post did not land', async () => {
    vi.mocked(logAlert).mockResolvedValue(false);

    await expect(runIdentityDigestOnce(client)).rejects.toThrow();

    // The done marker is what makes a day un-retryable. Writing it on a run
    // that failed to post would consume the day exactly as the old
    // never-released claim did.
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('does not mark the day done when the digest query failed', async () => {
    repo.listChangesMetadataAfterId.mockRejectedValue(new Error('db down'));

    await expect(runIdentityDigestOnce(client)).rejects.toThrow('db down');

    expect(cache.set).not.toHaveBeenCalled();
  });

  it('releases the claim when the post did not land', async () => {
    vi.mocked(logAlert).mockResolvedValue(false);

    // logAlert swallows every error, so without checking its result a Discord
    // outage yields: claim consumed, success logged, no digest, no retry.
    await expect(runIdentityDigestOnce(client)).rejects.toThrow();
    expect(cache.remove).toHaveBeenCalledWith('identity-digest-2026-08-16');
  });

  it('releases the claim when the digest query itself fails', async () => {
    // Not a sweep failure -- those degrade now. This is the digest proper
    // failing, which still has to release the day so a restart retries.
    repo.listChangesMetadataAfterId.mockRejectedValue(new Error('db down'));

    await expect(runIdentityDigestOnce(client)).rejects.toThrow('db down');
    expect(cache.remove).toHaveBeenCalledWith('identity-digest-2026-08-16');
  });

  it('surfaces the original error, not a claim-release failure', async () => {
    repo.listChangesMetadataAfterId.mockRejectedValue(new Error('db down'));
    cache.remove.mockRejectedValue(new Error('cache unavailable'));

    // A cache outage during release must not mask the real cause, and the
    // claim staying consumed either way should not turn into the wrong error.
    await expect(runIdentityDigestOnce(client)).rejects.toThrow('db down');
  });

  it('keeps the claim on a silent day, where nothing is posted', async () => {
    repo.listChangesMetadataAfterId.mockResolvedValue([]);

    await runIdentityDigestOnce(client);

    expect(logAlert).not.toHaveBeenCalled();
    expect(cache.remove).not.toHaveBeenCalled();
  });

  it('marks a silent day done so its sweeps are not repeated', async () => {
    repo.listChangesMetadataAfterId.mockResolvedValue([]);

    await runIdentityDigestOnce(client);

    // Nothing was posted, but the work was done. Re-running two full roster
    // passes to rediscover that nothing changed is pure waste.
    expect(cache.set).toHaveBeenCalledWith(
      'identity-digest-done-2026-08-16',
      '1',
      expect.any(Number),
    );
  });

  it('lets a later tick retry after a failed run released the lease', async () => {
    repo.listChangesMetadataAfterId.mockRejectedValueOnce(
      new Error('transient db blip'),
    );

    await expect(runIdentityDigestOnce(client)).rejects.toThrow();
    expect(cache.remove).toHaveBeenCalledWith('identity-digest-2026-08-16');

    // Second tick, same hour: the lease is gone and the day is not marked
    // done, so the run happens again and this time posts.
    vi.clearAllMocks();
    cache.exclusive_set.mockResolvedValue(true);
    cache.get.mockResolvedValue(undefined);
    repo.listChangesMetadataAfterId.mockResolvedValue([change()]);
    repo.storageStats.mockResolvedValue(stats);
    memberRepo.listAll.mockResolvedValue([]);
    vi.mocked(logAlert).mockResolvedValue(true);
    vi.mocked(runIdentitySweep).mockResolvedValue({ scanned: 0, changed: 0 });
    vi.mocked(runMeetupSweep).mockResolvedValue({ scanned: 0, changed: 0 });

    await runIdentityDigestOnce(client);

    expect(logAlert).toHaveBeenCalledTimes(1);
  });
});
