import nock from 'nock';
import { afterEach, describe, expect, it } from 'vitest';

import {
  fetchBaselineThumbs,
  resolveChangeThumbs,
} from '../../../../src/lib/helpers/identity/thumbs.js';
import {
  IdentitySnapshot,
  StoredIdentitySnapshot,
} from '../../../../src/lib/repositories/identityTypes.js';

afterEach(() => nock.cleanAll());

/** Not all-ASCII: a byte-preserving round trip is the thing under test. */
const STORED_OLD = Buffer.from([0x52, 0x49, 0x46, 0x46, 0xff, 0xfe]);

function baseline(
  overrides: Partial<StoredIdentitySnapshot> = {},
): StoredIdentitySnapshot {
  return {
    scopeId: 'g1',
    discordUserId: 'u1',
    username: 'someone',
    globalName: 'Someone',
    nickname: 'Some One',
    userAvatarHash: 'aaa',
    memberAvatarHash: null,
    userAvatarThumb: STORED_OLD,
    memberAvatarThumb: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<IdentitySnapshot> = {}): IdentitySnapshot {
  return {
    scopeId: 'g1',
    discordUserId: 'u1',
    username: 'someone',
    globalName: 'Someone',
    nickname: 'Some One',
    userAvatarHash: 'aaa',
    memberAvatarHash: null,
    ...overrides,
  };
}

describe('resolveChangeThumbs', () => {
  it('takes the before image from the baseline and never fetches the old URL', async () => {
    const oldSide = nock('https://cdn.discordapp.com')
      .get('/avatars/u1/aaa.webp')
      .query({ size: '64' })
      .reply(200, Buffer.from([9, 9]));
    const newSide = nock('https://cdn.discordapp.com')
      .get('/avatars/u1/bbb.webp')
      .query({ size: '64' })
      .reply(200, Buffer.from([3, 4]));

    const { thumbs } = await resolveChangeThumbs(
      [
        {
          platform: 'discord',
          scopeId: 'g1',
          subjectId: 'u1',
          field: 'user_avatar',
          oldValue: 'aaa',
          newValue: 'bbb',
        },
      ],
      'g1',
      baseline(),
    );

    const entry = thumbs.get('discord:g1:u1:user_avatar');
    // Discord purges superseded avatars: by the time a sweep notices, the old
    // hash's URL may 404. The stored bytes are the only reliable before-image,
    // so this must be the baseline's copy and not a fresh CDN read.
    expect(entry?.oldThumb?.equals(STORED_OLD)).toBe(true);
    expect(oldSide.isDone()).toBe(false);
    expect(entry?.newThumb?.equals(Buffer.from([3, 4]))).toBe(true);
    expect(newSide.isDone()).toBe(true);
  });

  it('hands back the new image as the advanced baseline thumb', async () => {
    nock('https://cdn.discordapp.com')
      .get('/avatars/u1/bbb.webp')
      .query({ size: '64' })
      .reply(200, Buffer.from([3, 4]));

    const { baselineThumbs } = await resolveChangeThumbs(
      [
        {
          platform: 'discord',
          scopeId: 'g1',
          subjectId: 'u1',
          field: 'user_avatar',
          oldValue: 'aaa',
          newValue: 'bbb',
        },
      ],
      'g1',
      baseline(),
    );

    // Today's after-image is tomorrow's before-image. Without this the chain
    // breaks after one change and every later one is blind again.
    expect(baselineThumbs.userAvatarThumb?.equals(Buffer.from([3, 4]))).toBe(
      true,
    );
    // The field that did not change must stay absent, so the repository's
    // conditional SET leaves its stored thumb alone.
    expect('memberAvatarThumb' in baselineThumbs).toBe(false);
  });

  it('clears the baseline thumb when the new image cannot be fetched', async () => {
    nock('https://cdn.discordapp.com')
      .get('/avatars/u1/bbb.webp')
      .query({ size: '64' })
      .reply(404);

    const { thumbs, baselineThumbs } = await resolveChangeThumbs(
      [
        {
          platform: 'discord',
          scopeId: 'g1',
          subjectId: 'u1',
          field: 'user_avatar',
          oldValue: 'aaa',
          newValue: 'bbb',
        },
      ],
      'g1',
      baseline(),
    );

    // Evidence of the change still lands; only the picture is missing.
    expect(thumbs.get('discord:g1:u1:user_avatar')?.newThumb).toBeNull();
    // Present-and-null, not absent: the stored thumb describes the stored
    // hash, so leaving the superseded image under hash 'bbb' would make the
    // NEXT change's before-image wrong rather than merely missing.
    expect('userAvatarThumb' in baselineThumbs).toBe(true);
    expect(baselineThumbs.userAvatarThumb).toBeNull();
  });

  it('reads the guild-avatar path for a member_avatar change', async () => {
    const scope = nock('https://cdn.discordapp.com')
      .get('/guilds/g1/users/u1/avatars/bbb.webp')
      .query({ size: '64' })
      .reply(200, Buffer.from([5, 6]));

    const { thumbs } = await resolveChangeThumbs(
      [
        {
          platform: 'discord',
          scopeId: 'g1',
          subjectId: 'u1',
          field: 'member_avatar',
          oldValue: 'aaa',
          newValue: 'bbb',
        },
      ],
      'g1',
      baseline({ memberAvatarThumb: STORED_OLD, userAvatarThumb: null }),
    );

    const entry = thumbs.get('discord:g1:u1:member_avatar');
    // Guild avatars live under a different path; the per-field baseline
    // column has to match the field, not just "the member's avatar".
    expect(entry?.oldThumb?.equals(STORED_OLD)).toBe(true);
    expect(scope.isDone()).toBe(true);
  });

  it('records null rather than throwing when the fetch itself fails', async () => {
    nock('https://cdn.discordapp.com')
      .get('/avatars/u1/bbb.webp')
      .query({ size: '64' })
      .replyWithError('socket hang up');

    const { thumbs } = await resolveChangeThumbs(
      [
        {
          platform: 'discord',
          scopeId: 'g1',
          subjectId: 'u1',
          field: 'user_avatar',
          oldValue: 'aaa',
          newValue: 'bbb',
        },
      ],
      'g1',
      baseline(),
    );

    // A transport failure must not propagate: it would abandon the whole
    // change record, and the record is the evidence this feature exists for.
    expect(thumbs.get('discord:g1:u1:user_avatar')?.newThumb).toBeNull();
  });

  it('does not fetch anything for non-avatar fields', async () => {
    const { thumbs, baselineThumbs } = await resolveChangeThumbs(
      [
        {
          platform: 'discord',
          scopeId: 'g1',
          subjectId: 'u1',
          field: 'nickname',
          oldValue: 'A',
          newValue: 'B',
        },
      ],
      'g1',
      baseline(),
    );

    // A nickname has no image; hitting the CDN for one wastes a request, and
    // touching a thumb column would discard an avatar image for no reason.
    expect(thumbs.size).toBe(0);
    expect(baselineThumbs).toEqual({});
  });

  it('gives up on a stalled CDN instead of hanging', async () => {
    nock('https://cdn.discordapp.com')
      .get('/avatars/u1/bbb.webp')
      .query({ size: '64' })
      .delayConnection(10_000)
      .reply(200, Buffer.from([1, 2]));

    const { thumbs } = await resolveChangeThumbs(
      [
        {
          platform: 'discord',
          scopeId: 'g1',
          subjectId: 'u1',
          field: 'user_avatar',
          oldValue: 'aaa',
          newValue: 'bbb',
        },
      ],
      'g1',
      baseline(),
    );

    // This fetch runs inside the digest AFTER the day-claim is taken. A stall
    // hangs the digest without throwing, so the catch never releases the
    // claim: no digest, no error, no retry until a restart.
    expect(thumbs.get('discord:g1:u1:user_avatar')?.newThumb).toBeNull();
  }, 15_000);
});

describe('fetchBaselineThumbs', () => {
  it('captures both current avatars for a first sighting', async () => {
    const scope = nock('https://cdn.discordapp.com')
      .get('/avatars/u1/aaa.webp')
      .query({ size: '64' })
      .reply(200, Buffer.from([1, 2]))
      .get('/guilds/g1/users/u1/avatars/ggg.webp')
      .query({ size: '64' })
      .reply(200, Buffer.from([7, 8]));

    const thumbs = await fetchBaselineThumbs(
      snapshot({ memberAvatarHash: 'ggg' }),
      'g1',
    );

    // A first sighting records no change, but it is the only moment these
    // URLs are known to resolve. Skip it and the member's first real avatar
    // change has no before-image at all.
    expect(thumbs.userAvatarThumb?.equals(Buffer.from([1, 2]))).toBe(true);
    expect(thumbs.memberAvatarThumb?.equals(Buffer.from([7, 8]))).toBe(true);
    expect(scope.isDone()).toBe(true);
  });

  it('spends no request on a member with no avatar', async () => {
    const thumbs = await fetchBaselineThumbs(
      snapshot({ userAvatarHash: null, memberAvatarHash: null }),
      'g1',
    );

    // The backfill walks 2,008 members; a hash-less member has no URL to
    // build, so fetching one would be 5s of guaranteed failure each.
    expect(thumbs).toEqual({
      userAvatarThumb: null,
      memberAvatarThumb: null,
    });
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('stores null for an avatar the CDN refuses', async () => {
    nock('https://cdn.discordapp.com')
      .get('/avatars/u1/aaa.webp')
      .query({ size: '64' })
      .reply(500);

    const thumbs = await fetchBaselineThumbs(snapshot(), 'g1');

    // Best-effort: a baseline without a thumb is still a usable baseline.
    expect(thumbs.userAvatarThumb).toBeNull();
  });
});
