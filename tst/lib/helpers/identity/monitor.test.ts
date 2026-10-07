import { GuildMember } from 'discord.js';
import nock from 'nock';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { HealBudget } from '../../../../src/lib/helpers/identity/healBudget.js';
import {
  recordIdentityFor,
  updateBaselineSilently,
} from '../../../../src/lib/helpers/identity/monitor.js';

const repo = {
  getSnapshot: vi.fn(),
  putSnapshot: vi.fn().mockResolvedValue(undefined),
  recordChanges: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../../../src/util/identityRepository.js', () => ({
  ApplicationIdentityRepository: vi.fn(async () => repo),
}));

// The thumbnail helper is deliberately NOT mocked here: which URL is fetched
// and which is read from the baseline is the behaviour these tests exist to
// pin, and a mock would assert only that monitor called a function. Net
// connections are disabled so any request this file does not explicitly
// intercept fails fast (and degrades to the documented null thumb) rather
// than reaching the real CDN from a test run.
beforeAll(() => nock.disableNetConnect());
afterAll(() => nock.enableNetConnect());
afterEach(() => nock.cleanAll());

/** Not all-ASCII, so a byte-mangling round trip could not pass unnoticed. */
const STORED_OLD = Buffer.from([0x52, 0x49, 0x46, 0x46, 0xff, 0xfe]);

function fakeMember(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    nickname: 'Some One',
    avatar: null,
    guild: { id: 'g1' },
    user: {
      username: 'someone',
      globalName: 'Someone',
      avatar: 'aaa',
      bot: false,
    },
    ...overrides,
  } as unknown as GuildMember;
}

/** A member whose global avatar hash has moved from 'aaa' to 'bbb'. */
function memberWithNewAvatar() {
  return fakeMember({
    user: {
      username: 'someone',
      globalName: 'Someone',
      avatar: 'bbb',
      bot: false,
    },
  });
}

describe('recordIdentityFor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repo.getSnapshot.mockResolvedValue({
      scopeId: 'g1',
      discordUserId: 'u1',
      username: 'someone',
      globalName: 'Someone',
      nickname: 'Some One',
      userAvatarHash: 'aaa',
      memberAvatarHash: null,
      userAvatarThumb: STORED_OLD,
      memberAvatarThumb: null,
    });
  });

  it('records nothing and writes no baseline when nothing changed', async () => {
    const changes = await recordIdentityFor(fakeMember(), 'sweep');

    expect(changes).toEqual([]);
    expect(repo.recordChanges).not.toHaveBeenCalled();
    // An unchanged member must not cost a write; the sweep hits 2,008 of them.
    expect(repo.putSnapshot).not.toHaveBeenCalled();
  });

  it('records the change and advances the baseline', async () => {
    const changes = await recordIdentityFor(memberWithNewAvatar(), 'sweep');

    expect(changes).toHaveLength(1);
    expect(changes[0].field).toBe('user_avatar');
    expect(repo.recordChanges).toHaveBeenCalledTimes(1);
    // Baseline must advance, or the same change re-reports on every sweep.
    expect(repo.putSnapshot).toHaveBeenCalledTimes(1);
  });

  it('records the change before advancing the baseline', async () => {
    await recordIdentityFor(memberWithNewAvatar(), 'sweep');

    // Load-bearing and previously untested: swapping these two writes left
    // every test in the branch green. Crash between them in this order and
    // the next sweep re-records a harmless duplicate; reversed, the baseline
    // advances while the evidence is lost for good.
    expect(repo.recordChanges.mock.invocationCallOrder[0]).toBeLessThan(
      repo.putSnapshot.mock.invocationCallOrder[0],
    );
  });

  it("uses the baseline's stored thumb as the before image, fetching only the new one", async () => {
    const oldSide = nock('https://cdn.discordapp.com')
      .get('/avatars/u1/aaa.webp')
      .query({ size: '64' })
      .reply(200, Buffer.from([9, 9]));
    const newSide = nock('https://cdn.discordapp.com')
      .get('/avatars/u1/bbb.webp')
      .query({ size: '64' })
      .reply(200, Buffer.from([3, 4]));

    await recordIdentityFor(memberWithNewAvatar(), 'sweep');

    const thumbs = repo.recordChanges.mock.calls[0][2] as Map<
      string,
      { oldThumb: Buffer | null; newThumb: Buffer | null }
    >;
    const entry = thumbs.get('discord:g1:u1:user_avatar');
    // Discord purges the superseded image, so re-fetching hash 'aaa' at
    // change time is exactly the request that 404s months later. The stored
    // baseline copy is the whole reason this column exists.
    expect(entry?.oldThumb?.equals(STORED_OLD)).toBe(true);
    expect(oldSide.isDone()).toBe(false);
    expect(entry?.newThumb?.equals(Buffer.from([3, 4]))).toBe(true);
    expect(newSide.isDone()).toBe(true);
  });

  it('stores the new image as the advanced baseline thumb', async () => {
    nock('https://cdn.discordapp.com')
      .get('/avatars/u1/bbb.webp')
      .query({ size: '64' })
      .reply(200, Buffer.from([3, 4]));

    await recordIdentityFor(memberWithNewAvatar(), 'sweep');

    const stored = repo.putSnapshot.mock.calls[0][1] as {
      userAvatarThumb?: Buffer | null;
    };
    // Today's after-image has to become tomorrow's before-image, or the chain
    // breaks after the first change and every later one is blind.
    expect(stored.userAvatarThumb?.equals(Buffer.from([3, 4]))).toBe(true);
  });

  it('leaves avatar thumbs untouched when only a nickname changed', async () => {
    await recordIdentityFor(fakeMember({ nickname: 'Someone Else' }), 'sweep');

    // Absent, not null: the repository only writes a thumb column whose key
    // is present, so a nickname edit must not discard a stored avatar image.
    expect(repo.putSnapshot.mock.calls[0][1]).toEqual({});
  });

  it('writes a baseline but no change for a first sighting', async () => {
    repo.getSnapshot.mockResolvedValue(undefined);

    const changes = await recordIdentityFor(fakeMember(), 'backfill');

    expect(changes).toEqual([]);
    expect(repo.recordChanges).not.toHaveBeenCalled();
    // Backfill must persist the baseline, else day one reports 2,008 changes.
    expect(repo.putSnapshot).toHaveBeenCalledTimes(1);
  });

  it("captures the member's current thumbs on a first sighting", async () => {
    repo.getSnapshot.mockResolvedValue(undefined);
    const scope = nock('https://cdn.discordapp.com')
      .get('/avatars/u1/aaa.webp')
      .query({ size: '64' })
      .reply(200, Buffer.from([1, 2]));

    await recordIdentityFor(fakeMember(), 'backfill');

    // The first sighting records no change, but it is the last chance to
    // capture this image while its URL resolves. Skip the fetch and the
    // member's first real avatar change has a blank before-image forever.
    expect(scope.isDone()).toBe(true);
    const stored = repo.putSnapshot.mock.calls[0][1] as {
      userAvatarThumb?: Buffer | null;
    };
    expect(stored.userAvatarThumb?.equals(Buffer.from([1, 2]))).toBe(true);
  });

  it('ignores bots entirely', async () => {
    const bot = fakeMember({
      user: { username: 'bot', globalName: null, avatar: 'x', bot: true },
    });

    await recordIdentityFor(bot, 'sweep');

    expect(repo.putSnapshot).not.toHaveBeenCalled();
    expect(repo.recordChanges).not.toHaveBeenCalled();
  });
});

describe('recordIdentityFor baseline thumbnail healing', () => {
  const HEALED = Buffer.from([0x52, 0x49, 0x46, 0x46, 0xff, 0x00, 0x89, 0xfe]);

  /** An unchanged member whose baseline names avatar 'aaa' but has no image. */
  function unhealedBaseline(overrides: Record<string, unknown> = {}) {
    return {
      scopeId: 'g1',
      discordUserId: 'u1',
      username: 'someone',
      globalName: 'Someone',
      nickname: 'Some One',
      userAvatarHash: 'aaa',
      memberAvatarHash: null,
      userAvatarThumb: null,
      memberAvatarThumb: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    repo.getSnapshot.mockResolvedValue(unhealedBaseline());
  });

  it('fetches and stores a missing thumb for an unchanged member', async () => {
    const scope = nock('https://cdn.discordapp.com')
      .get('/avatars/u1/aaa.webp')
      .query({ size: '64' })
      .reply(200, HEALED);

    const changes = await recordIdentityFor(
      fakeMember(),
      'sweep',
      new HealBudget(),
    );

    expect(changes).toEqual([]);
    expect(scope.isDone()).toBe(true);
    expect(repo.recordChanges).not.toHaveBeenCalled();
    expect(repo.putSnapshot).toHaveBeenCalledTimes(1);
    const [snapshot, thumbs] = repo.putSnapshot.mock.calls[0] as [
      { userAvatarHash: string },
      Record<string, Buffer>,
    ];
    // Filed under the hash it was fetched for, and ONLY that thumb key, so
    // the conditional upsert leaves the other column alone.
    expect(snapshot.userAvatarHash).toBe('aaa');
    expect(Object.keys(thumbs)).toEqual(['userAvatarThumb']);
    expect(thumbs.userAvatarThumb.equals(HEALED)).toBe(true);
  });

  it('heals a missing guild-avatar thumb the same way', async () => {
    repo.getSnapshot.mockResolvedValue(
      unhealedBaseline({ memberAvatarHash: 'ggg', userAvatarThumb: HEALED }),
    );
    const scope = nock('https://cdn.discordapp.com')
      .get('/guilds/g1/users/u1/avatars/ggg.webp')
      .query({ size: '64' })
      .reply(200, HEALED);

    await recordIdentityFor(
      fakeMember({ avatar: 'ggg' }),
      'sweep',
      new HealBudget(),
    );

    expect(scope.isDone()).toBe(true);
    expect(Object.keys(repo.putSnapshot.mock.calls[0][1] as object)).toEqual([
      'memberAvatarThumb',
    ]);
  });

  it('neither fetches nor writes when the thumbs are already stored', async () => {
    repo.getSnapshot.mockResolvedValue(
      unhealedBaseline({ userAvatarThumb: STORED_OLD }),
    );
    const scope = nock('https://cdn.discordapp.com')
      .get('/avatars/u1/aaa.webp')
      .query({ size: '64' })
      .reply(200, HEALED);

    await recordIdentityFor(fakeMember(), 'sweep', new HealBudget());

    // The sweep walks every member daily: a healed member must cost nothing.
    expect(scope.isDone()).toBe(false);
    expect(repo.putSnapshot).not.toHaveBeenCalled();
  });

  it('does not try to heal a member with no avatar', async () => {
    repo.getSnapshot.mockResolvedValue(
      unhealedBaseline({ userAvatarHash: null }),
    );
    const noAvatar = fakeMember({
      user: {
        username: 'someone',
        globalName: 'Someone',
        avatar: null,
        bot: false,
      },
    });

    // Catches ANY CDN request, so an attempt to fetch a "null" avatar would
    // be served and observed rather than silently failing on disabled net.
    const anyFetch = nock('https://cdn.discordapp.com')
      .get(/.*/)
      .query(true)
      .reply(200, HEALED);

    await recordIdentityFor(noAvatar, 'sweep', new HealBudget());

    expect(anyFetch.isDone()).toBe(false);
    expect(repo.putSnapshot).not.toHaveBeenCalled();
  });

  it('writes nothing when the heal fetch fails', async () => {
    nock('https://cdn.discordapp.com')
      .get('/avatars/u1/aaa.webp')
      .query({ size: '64' })
      .reply(404);

    await recordIdentityFor(fakeMember(), 'sweep', new HealBudget());

    // Nothing to store; the next sweep simply tries again.
    expect(repo.putSnapshot).not.toHaveBeenCalled();
  });

  it('does not heal without a budget', async () => {
    const scope = nock('https://cdn.discordapp.com')
      .get('/avatars/u1/aaa.webp')
      .query({ size: '64' })
      .reply(200, HEALED);

    await recordIdentityFor(fakeMember(), 'sweep');

    expect(scope.isDone()).toBe(false);
    expect(repo.putSnapshot).not.toHaveBeenCalled();
  });

  it('stops healing once the run budget is spent', async () => {
    // Injected clock: each heal fetch "takes" 61s, so two exhaust 120s and
    // the third member is left for a later sweep.
    let clock = 0;
    const budget = new HealBudget(120_000, () => clock);
    const scope = nock('https://cdn.discordapp.com')
      .get('/avatars/u1/aaa.webp')
      .query({ size: '64' })
      .times(3)
      .reply(() => {
        clock += 61_000;
        return [200, HEALED];
      });

    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await recordIdentityFor(fakeMember(), 'sweep', budget);
    }

    expect(repo.putSnapshot).toHaveBeenCalledTimes(2);
    expect(scope.pendingMocks()).toHaveLength(1);
    expect(budget.exhausted).toBe(true);
  });

  it('still records a change when the budget is already spent', async () => {
    let clock = 0;
    const budget = new HealBudget(1, () => clock);
    await budget.spend(async () => {
      clock += 10;
    });

    const changes = await recordIdentityFor(
      memberWithNewAvatar(),
      'sweep',
      budget,
    );

    // Healing is best-effort and separate: it must never block recording.
    expect(changes).toHaveLength(1);
    expect(repo.recordChanges).toHaveBeenCalledTimes(1);
  });
});

describe('updateBaselineSilently', () => {
  beforeEach(() => vi.clearAllMocks());

  it('advances the baseline without recording a change', async () => {
    await updateBaselineSilently(fakeMember());

    // The bot sets nicknames during onboarding; without this its own writes
    // would show up in the digest as suspicious name changes.
    expect(repo.putSnapshot).toHaveBeenCalledTimes(1);
    expect(repo.recordChanges).not.toHaveBeenCalled();
    // No thumbs argument: this runs inline in an onboarding interaction, and
    // an omitted key leaves whatever the baseline already stores alone.
    expect(repo.putSnapshot.mock.calls[0][1]).toBeUndefined();
  });

  it('clears the stored thumb when the silent advance moves its hash', async () => {
    // A member changes their avatar between sweeps and then onboards. The
    // silent advance writes the new hash; if the old thumb survives under it,
    // the thumb is non-null so needsThumbHeal never fires, and the member's
    // NEXT avatar change records the wrong before-image -- silently corrupted
    // impersonation evidence. The stale thumb must be cleared (explicit null)
    // so the heal path repairs it on the next sweep. No network fetch is
    // allowed here: this is inline in an onboarding interaction.
    repo.getSnapshot.mockResolvedValue({
      scopeId: 'g1',
      discordUserId: 'u1',
      username: 'someone',
      globalName: 'Someone',
      nickname: 'Some One',
      userAvatarHash: 'aaa',
      memberAvatarHash: null,
      userAvatarThumb: STORED_OLD,
      memberAvatarThumb: null,
    });

    await updateBaselineSilently(memberWithNewAvatar());

    expect(repo.putSnapshot).toHaveBeenCalledTimes(1);
    // Explicit null (clear), not undefined/absent (preserve), and NOT the
    // stale buffer.
    expect(repo.putSnapshot.mock.calls[0][1]).toEqual({
      userAvatarThumb: null,
    });
    // nock.disableNetConnect() is active file-wide, so reaching this point
    // also proves no thumbnail fetch was attempted.
  });

  it('leaves stored thumbs alone when the hashes did not move', async () => {
    repo.getSnapshot.mockResolvedValue({
      scopeId: 'g1',
      discordUserId: 'u1',
      username: 'someone',
      globalName: 'Someone',
      nickname: 'Old Nick',
      userAvatarHash: 'aaa',
      memberAvatarHash: null,
      userAvatarThumb: STORED_OLD,
      memberAvatarThumb: null,
    });

    await updateBaselineSilently(fakeMember());

    // Nickname-only advance: the avatar images are still correct for their
    // hashes, so no key may be passed that would clear them.
    expect(repo.putSnapshot.mock.calls[0][1]).toBeUndefined();
  });
});
