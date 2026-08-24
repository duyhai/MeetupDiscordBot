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
});
