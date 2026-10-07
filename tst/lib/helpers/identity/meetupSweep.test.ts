import { Client } from 'discord.js';
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

import Configuration from '../../../../src/configuration.js';
import { MeetupGroupMember } from '../../../../src/lib/client/meetup/types.js';
import { getPaginatedData } from '../../../../src/lib/client/meetup/paginationHelper.js';
import { refreshMeetupToken } from '../../../../src/lib/client/oauth/providers.js';
import { logAlert } from '../../../../src/lib/helpers/discordLogger.js';
import { runMeetupSweep } from '../../../../src/lib/helpers/identity/meetupSweep.js';

vi.mock('../../../../src/lib/client/oauth/providers.js', () => ({
  refreshMeetupToken: vi.fn(),
}));

vi.mock('../../../../src/lib/client/meetup/paginationHelper.js', () => ({
  getPaginatedData: vi.fn(),
}));

vi.mock('../../../../src/lib/helpers/discordLogger.js', () => ({
  logAlert: vi.fn().mockResolvedValue(true),
}));

const credentials = {
  get: vi.fn(),
  put: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../../../src/util/credentialRepository.js', () => ({
  ApplicationCredentialRepository: vi.fn(async () => credentials),
  MEETUP_ORGANIZER_CREDENTIAL_KEY: 'meetup_organizer',
}));

const repo = {
  getMeetupSnapshot: vi.fn(),
  putMeetupSnapshot: vi.fn().mockResolvedValue(undefined),
  recordChanges: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../../../src/util/identityRepository.js', () => ({
  ApplicationIdentityRepository: vi.fn(async () => repo),
}));

const SCOPE_ID = Configuration.meetup.groupId;

// Photo fetches are real HTTP through boundedFetch. Disabling net connect
// makes any request a test has not explicitly intercepted fail immediately --
// degrading to the documented null thumb -- instead of reaching Meetup's CDN.
beforeAll(() => nock.disableNetConnect());
afterAll(() => nock.enableNetConnect());

const PHOTO_HOST = 'https://secure.meetupstatic.com';
const PHOTO_PATH = '/photos/member/1/2/3/thumb.jpeg';
const PHOTO_URL = `${PHOTO_HOST}${PHOTO_PATH}`;

/** Not all-ASCII: JPEG bytes, so a coerced round trip could not slip by. */
const STORED_OLD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0xfe]);

function member(
  id: string,
  overrides: Partial<MeetupGroupMember> = {},
): MeetupGroupMember {
  return {
    id,
    name: 'Someone',
    username: 'someone',
    memberPhoto: null,
    ...overrides,
  };
}

function snapshotFor(
  memberId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    scopeId: SCOPE_ID,
    meetupMemberId: memberId,
    name: 'Someone',
    username: 'someone',
    photoId: null,
    ...overrides,
  };
}

function fakeClient() {
  return {} as Client;
}

describe('runMeetupSweep', () => {
  // Configuration is a module-level singleton shared by every test file in
  // the run. A test that sets the seed and returns early -- or throws --
  // leaks it into unrelated tests, so restore it unconditionally rather than
  // on the happy path of whichever test set it.
  afterEach(() => {
    Configuration.meetup.organizerRefreshToken = undefined;
    nock.cleanAll();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    credentials.put.mockResolvedValue(undefined);
    credentials.get.mockResolvedValue({
      accessToken: 'old-access',
      refreshToken: 'stored-refresh',
      expiresAt: Date.now() - 1000,
    });
    vi.mocked(refreshMeetupToken).mockResolvedValue({
      accessToken: 'fresh-access',
      refreshToken: 'stored-refresh',
      expiresAt: Date.now() + 3_600_000,
    });
    repo.getMeetupSnapshot.mockResolvedValue(undefined);
  });

  it('scans every member returned by the roster', async () => {
    vi.mocked(getPaginatedData).mockResolvedValue([
      member('a'),
      member('b'),
      member('c'),
    ]);

    const result = await runMeetupSweep('sweep');

    expect(result.scanned).toBe(3);
  });

  it('passes the requested source through to recordChanges', async () => {
    vi.mocked(getPaginatedData).mockResolvedValue([member('a')]);
    repo.getMeetupSnapshot.mockResolvedValue(
      snapshotFor('a', { name: 'Old Name' }),
    );

    await runMeetupSweep('backfill');

    expect(repo.recordChanges).toHaveBeenCalledTimes(1);
    expect(repo.recordChanges.mock.calls[0][1]).toBe('backfill');
  });

  it('counts only members that actually changed', async () => {
    vi.mocked(getPaginatedData).mockResolvedValue([member('a'), member('b')]);
    repo.getMeetupSnapshot.mockImplementation(async (_scopeId, memberId) => {
      return memberId === 'a'
        ? snapshotFor('a', { name: 'Old Name' })
        : snapshotFor('b');
    });

    const result = await runMeetupSweep('sweep');

    expect(result.changed).toBe(1);
  });

  it('continues past a member that throws', async () => {
    vi.mocked(getPaginatedData).mockResolvedValue([member('a'), member('b')]);
    repo.getMeetupSnapshot.mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    const result = await runMeetupSweep('sweep');

    // One bad member must not abandon the rest of the roster.
    expect(result.scanned).toBe(2);
  });

  it('records the change before advancing the baseline', async () => {
    vi.mocked(getPaginatedData).mockResolvedValue([member('a')]);
    repo.getMeetupSnapshot.mockResolvedValue(
      snapshotFor('a', { name: 'Old Name' }),
    );

    await runMeetupSweep('sweep');

    // Same crash-ordering rationale as the Discord monitor: recording before
    // advancing means a crash mid-way just re-diffs a harmless duplicate on
    // the next sweep, rather than losing the evidence for good.
    expect(repo.recordChanges.mock.invocationCallOrder[0]).toBeLessThan(
      repo.putMeetupSnapshot.mock.invocationCallOrder[0],
    );
  });

  it("uses the baseline's stored photo as the before image", async () => {
    const scope = nock(PHOTO_HOST)
      .get(PHOTO_PATH)
      .reply(200, Buffer.from([3, 4]));
    vi.mocked(getPaginatedData).mockResolvedValue([
      member('a', { memberPhoto: { id: 'new-photo', thumbUrl: PHOTO_URL } }),
    ]);
    repo.getMeetupSnapshot.mockResolvedValue(
      snapshotFor('a', { photoId: 'old-photo', photoThumb: STORED_OLD }),
    );

    await runMeetupSweep('sweep');

    const thumbs = repo.recordChanges.mock.calls[0][2] as Map<
      string,
      { oldThumb: Buffer | null; newThumb: Buffer | null }
    >;
    const entry = thumbs.get(`meetup:${SCOPE_ID}:a:photo`);
    // Meetup's baseline keeps a photo id, never the URL that served it, so
    // the superseded photo is unreachable the instant it changes. Before the
    // baseline stored bytes, oldThumb here was unconditionally null.
    expect(entry?.oldThumb?.equals(STORED_OLD)).toBe(true);
    expect(entry?.newThumb?.equals(Buffer.from([3, 4]))).toBe(true);
    // Exactly one fetch: the new photo. There is no old URL to fetch.
    expect(scope.isDone()).toBe(true);
  });

  it('stores the new photo as the advanced baseline thumb', async () => {
    nock(PHOTO_HOST)
      .get(PHOTO_PATH)
      .reply(200, Buffer.from([3, 4]));
    vi.mocked(getPaginatedData).mockResolvedValue([
      member('a', { memberPhoto: { id: 'new-photo', thumbUrl: PHOTO_URL } }),
    ]);
    repo.getMeetupSnapshot.mockResolvedValue(
      snapshotFor('a', { photoId: 'old-photo', photoThumb: STORED_OLD }),
    );

    await runMeetupSweep('sweep');

    const stored = repo.putMeetupSnapshot.mock.calls[0][1] as {
      photoThumb?: Buffer | null;
    };
    // Today's after-image is tomorrow's before-image; drop it and the chain
    // breaks after one change.
    expect(stored.photoThumb?.equals(Buffer.from([3, 4]))).toBe(true);
  });

  it('leaves the stored photo alone when only the name changed', async () => {
    vi.mocked(getPaginatedData).mockResolvedValue([
      member('a', { memberPhoto: { id: 'p1', thumbUrl: PHOTO_URL } }),
    ]);
    repo.getMeetupSnapshot.mockResolvedValue(
      snapshotFor('a', {
        name: 'Old Name',
        photoId: 'p1',
        photoThumb: STORED_OLD,
      }),
    );

    await runMeetupSweep('sweep');

    // No photo change, so no key -- the repository's conditional SET then
    // leaves the stored image where it is. Nothing was fetched either.
    expect(repo.putMeetupSnapshot.mock.calls[0][1]).toEqual({});
    expect(nock.pendingMocks()).toEqual([]);
  });

  it("captures a first sighting's current photo into the baseline", async () => {
    const scope = nock(PHOTO_HOST)
      .get(PHOTO_PATH)
      .reply(200, Buffer.from([1, 2]));
    vi.mocked(getPaginatedData).mockResolvedValue([
      member('a', { memberPhoto: { id: 'p1', thumbUrl: PHOTO_URL } }),
    ]);
    repo.getMeetupSnapshot.mockResolvedValue(undefined);

    const result = await runMeetupSweep('backfill');

    // Still records nothing -- the first sighting IS the baseline -- but the
    // bytes are captured now, because the moment the photo changes its URL is
    // gone and no before-image can ever be recovered.
    expect(repo.recordChanges).not.toHaveBeenCalled();
    expect(result.changed).toBe(0);
    expect(scope.isDone()).toBe(true);
    const stored = repo.putMeetupSnapshot.mock.calls[0][1] as {
      photoThumb?: Buffer | null;
    };
    expect(stored.photoThumb?.equals(Buffer.from([1, 2]))).toBe(true);
  });

  it('keeps fetching first-sighting photos across a whole backfill', async () => {
    // 20 first sightings: comfortably past the 10%-of-roster thumb budget if
    // that budget counted them. It must not -- a backfill is 100% first
    // sightings, and gating them would leave every member without the
    // before-image the whole feature depends on.
    const roster = Array.from({ length: 20 }, (_, i) =>
      member(`m${i}`, { memberPhoto: { id: 'p1', thumbUrl: PHOTO_URL } }),
    );
    const scope = nock(PHOTO_HOST)
      .get(PHOTO_PATH)
      .times(20)
      .reply(200, Buffer.from([1, 2]));
    vi.mocked(getPaginatedData).mockResolvedValue(roster);
    repo.getMeetupSnapshot.mockResolvedValue(undefined);

    await runMeetupSweep('backfill', fakeClient());

    expect(scope.isDone()).toBe(true);
    expect(
      repo.putMeetupSnapshot.mock.calls.every((call) =>
        (call[1] as { photoThumb?: Buffer | null }).photoThumb?.equals(
          Buffer.from([1, 2]),
        ),
      ),
    ).toBe(true);
    // And no systemic-change alert: nothing changed, so nothing tripped.
    expect(logAlert).not.toHaveBeenCalled();
  });

  it('still captures a new joiner after the systemic cap has fired', async () => {
    // A roster where a systemic photo-id re-issue has already exhausted the
    // thumb budget (ceil(20 * 0.1) = 2) before a genuinely new member is
    // reached. The cap governs CHANGE-time fetches; a first sighting is
    // exempt, or the one member whose before-image is still capturable would
    // be the one member who never gets one.
    const roster = [
      ...Array.from({ length: 19 }, (_, i) =>
        member(`m${i}`, {
          memberPhoto: { id: 'new-photo', thumbUrl: PHOTO_URL },
        }),
      ),
      member('joiner', { memberPhoto: { id: 'p1', thumbUrl: PHOTO_URL } }),
    ];
    const joinerPhoto = nock(PHOTO_HOST)
      .get(PHOTO_PATH)
      .times(20)
      .reply(200, Buffer.from([1, 2]));
    vi.mocked(getPaginatedData).mockResolvedValue(roster);
    repo.getMeetupSnapshot.mockImplementation(async (_scope, id: string) => {
      return id === 'joiner'
        ? undefined
        : snapshotFor(id, { photoId: 'old-photo', photoThumb: STORED_OLD });
    });

    await runMeetupSweep('sweep', fakeClient());

    expect(joinerPhoto.isDone()).toBe(false); // the cap did skip most of them
    const joinerPut = repo.putMeetupSnapshot.mock.calls.find(
      (call) =>
        (call[0] as { meetupMemberId: string }).meetupMemberId === 'joiner',
    );
    expect(
      (joinerPut?.[1] as { photoThumb?: Buffer | null }).photoThumb?.equals(
        Buffer.from([1, 2]),
      ),
    ).toBe(true);
  });

  it('alerts and stops when the credential cannot be refreshed', async () => {
    vi.mocked(refreshMeetupToken).mockRejectedValue(new Error('invalid_grant'));

    await runMeetupSweep('sweep', fakeClient());

    // A silently dead sweep is the worst outcome: monitoring looks healthy
    // while watching nothing. This alert is the only way expiry is visible.
    expect(logAlert).toHaveBeenCalledTimes(1);
    const [, entry] = vi.mocked(logAlert).mock.calls[0];
    expect(entry.description).toContain('MEETUP_ORGANIZER_REFRESH_TOKEN');
  });

  it('logs instead of alerting when there is no client', async () => {
    vi.mocked(refreshMeetupToken).mockRejectedValue(new Error('invalid_grant'));

    const result = await runMeetupSweep('backfill');

    // The backfill script has no Discord connection; it must not attempt to
    // post an alert, and surfaces failure through its own exit code instead.
    expect(logAlert).not.toHaveBeenCalled();
    expect(result).toEqual({ scanned: 0, changed: 0 });
  });

  it('never lets the raw refresh error reach the Discord alert', async () => {
    vi.mocked(refreshMeetupToken).mockRejectedValue(
      new Error('invalid_grant: {"secret":"do-not-leak"}'),
    );

    await runMeetupSweep('sweep', fakeClient());

    const [, entry] = vi.mocked(logAlert).mock.calls[0];
    expect(entry.description).not.toContain('do-not-leak');
  });

  it('falls back to the config seed when the stored token fails', async () => {
    Configuration.meetup.organizerRefreshToken = 'seed-refresh';
    credentials.get.mockResolvedValue({
      accessToken: 'x',
      refreshToken: 'stored-refresh',
      expiresAt: Date.now() - 1000,
    });
    vi.mocked(refreshMeetupToken).mockImplementation(async (token: string) => {
      if (token === 'stored-refresh') {
        throw new Error('invalid_grant');
      }
      return {
        accessToken: 'fresh-access',
        refreshToken: 'seed-refresh',
        expiresAt: Date.now() + 3_600_000,
      };
    });
    vi.mocked(getPaginatedData).mockResolvedValue([member('a')]);

    const result = await runMeetupSweep('sweep');

    expect(result.scanned).toBe(1);
    expect(credentials.put).toHaveBeenCalledWith(
      'meetup_organizer',
      expect.objectContaining({ refreshToken: 'seed-refresh' }),
    );
  });

  it('proceeds with the refreshed tokens when storing them fails', async () => {
    credentials.put.mockRejectedValue(new Error('postgres unavailable'));
    vi.mocked(getPaginatedData).mockResolvedValue([member('a')]);

    const result = await runMeetupSweep('sweep', fakeClient());

    // The credential refresh SUCCEEDED. Only the write to Postgres failed, and
    // under rotation the refreshed token is now the only valid one -- so
    // discarding it and falling through to the (just-invalidated) seed would
    // kill the credential permanently and alert the wrong remedy.
    expect(result.scanned).toBe(1);
    expect(logAlert).not.toHaveBeenCalled();
  });

  it('does not fall through to the seed when only the store failed', async () => {
    Configuration.meetup.organizerRefreshToken = 'seed-refresh';
    credentials.put.mockRejectedValue(new Error('postgres unavailable'));
    vi.mocked(getPaginatedData).mockResolvedValue([member('a')]);

    await runMeetupSweep('sweep');

    // One refresh, of the stored token. Retrying with the seed here would
    // burn a second credential against a fault that has nothing to do with
    // either of them.
    expect(refreshMeetupToken).toHaveBeenCalledTimes(1);
    expect(refreshMeetupToken).toHaveBeenCalledWith('stored-refresh');
  });

  it('skips thumbnails once a systemic share of the roster has changed', async () => {
    // 20 members, all changed: far past the 10% ceiling. Thumb fetches are
    // sequential with a 5s ceiling each, so a real 6,000-member systemic
    // change -- Meetup re-issuing photo ids -- is an eight-hour marathon
    // inside the digest, holding the day.
    const roster = Array.from({ length: 20 }, (_, i) =>
      member(`m${i}`, { memberPhoto: { id: 'new-photo', thumbUrl: 'u' } }),
    );
    vi.mocked(getPaginatedData).mockResolvedValue(roster);
    repo.getMeetupSnapshot.mockImplementation(async (_scope, id: string) =>
      snapshotFor(id, { photoId: 'old-photo' }),
    );

    const result = await runMeetupSweep('sweep', fakeClient());

    // Every change is still recorded -- the changes are the evidence; the
    // thumbnails only help read them.
    expect(result.changed).toBe(20);
    const thumbMaps = repo.recordChanges.mock.calls.map(
      (call) => call[2] as Map<string, unknown>,
    );
    expect(thumbMaps.at(-1)?.size).toBe(0);
  });

  it('keeps the stored photo when a systemic change skips thumbnails', async () => {
    const roster = Array.from({ length: 20 }, (_, i) =>
      member(`m${i}`, {
        memberPhoto: { id: 'new-photo', thumbUrl: PHOTO_URL },
      }),
    );
    vi.mocked(getPaginatedData).mockResolvedValue(roster);
    repo.getMeetupSnapshot.mockImplementation(async (_scope, id: string) =>
      snapshotFor(id, { photoId: 'old-photo', photoThumb: STORED_OLD }),
    );

    await runMeetupSweep('sweep', fakeClient());

    // Skipping the fetch leaves no new image, and clearing the column would
    // destroy thousands of good before-images. A mass id re-issue does not
    // change the pictures themselves, so the stored one is still the right
    // one: pass no key and let the baseline keep it.
    expect(repo.putMeetupSnapshot.mock.calls.at(-1)?.[1]).toEqual({});
  });

  it('alerts once when it skips thumbnails for a systemic change', async () => {
    const roster = Array.from({ length: 20 }, (_, i) =>
      member(`m${i}`, { memberPhoto: { id: 'new-photo', thumbUrl: 'u' } }),
    );
    vi.mocked(getPaginatedData).mockResolvedValue(roster);
    repo.getMeetupSnapshot.mockImplementation(async (_scope, id: string) =>
      snapshotFor(id, { photoId: 'old-photo' }),
    );

    await runMeetupSweep('sweep', fakeClient());

    expect(logAlert).toHaveBeenCalledTimes(1);
    const [, entry] = vi.mocked(logAlert).mock.calls[0];
    expect(entry.description).toContain('Systemic photo-id change');
  });

  it('still fetches thumbnails for an ordinary handful of changes', async () => {
    const roster = Array.from({ length: 20 }, (_, i) => member(`m${i}`));
    vi.mocked(getPaginatedData).mockResolvedValue(roster);
    repo.getMeetupSnapshot.mockImplementation(async (_scope, id: string) => {
      return id === 'm0'
        ? snapshotFor(id, { name: 'Old Name' })
        : snapshotFor(id);
    });

    await runMeetupSweep('sweep', fakeClient());

    // The guard must not fire on a normal day; one change in twenty is well
    // under the ceiling, and no alert should reach the organizers.
    expect(logAlert).not.toHaveBeenCalled();
  });

  it('tries a shared stored/seed token only once', async () => {
    // Steady state: the seed was pasted into Heroku and then stored verbatim,
    // so both candidates are the same string. Trying it twice means two
    // identical failed refreshes and two identical warnings for one problem.
    Configuration.meetup.organizerRefreshToken = 'same-token';
    credentials.get.mockResolvedValue({
      accessToken: 'x',
      refreshToken: 'same-token',
      expiresAt: Date.now() - 1000,
    });
    vi.mocked(refreshMeetupToken).mockRejectedValue(new Error('invalid_grant'));

    await runMeetupSweep('sweep');

    expect(refreshMeetupToken).toHaveBeenCalledTimes(1);
  });
});

describe('runMeetupSweep baseline photo healing', () => {
  const HEALED = Buffer.from([0xff, 0xd8, 0x00, 0x89, 0xfe]);

  afterEach(() => {
    nock.cleanAll();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    credentials.get.mockResolvedValue({
      accessToken: 'old-access',
      refreshToken: 'stored-refresh',
      expiresAt: Date.now() - 1000,
    });
    vi.mocked(refreshMeetupToken).mockResolvedValue({
      accessToken: 'fresh-access',
      refreshToken: 'stored-refresh',
      expiresAt: Date.now() + 3_600_000,
    });
  });

  /** An unchanged member whose baseline has a photo id but no stored bytes. */
  function unhealed(id: string) {
    return snapshotFor(id, { photoId: 'p1', photoThumb: null });
  }

  const withPhoto = (id: string) =>
    member(id, { memberPhoto: { id: 'p1', thumbUrl: PHOTO_URL } });

  it('fetches and stores the missing photo of an unchanged member', async () => {
    const scope = nock(PHOTO_HOST).get(PHOTO_PATH).reply(200, HEALED);
    vi.mocked(getPaginatedData).mockResolvedValue([withPhoto('a')]);
    repo.getMeetupSnapshot.mockResolvedValue(unhealed('a'));

    const result = await runMeetupSweep('sweep');

    expect(scope.isDone()).toBe(true);
    expect(repo.putMeetupSnapshot).toHaveBeenCalledTimes(1);
    const [snapshot, thumbs] = repo.putMeetupSnapshot.mock.calls[0] as [
      { photoId: string },
      Record<string, Buffer>,
    ];
    expect(snapshot.photoId).toBe('p1');
    // Only the photo key: the conditional upsert leaves the rest alone.
    expect(Object.keys(thumbs)).toEqual(['photoThumb']);
    expect(thumbs.photoThumb.equals(HEALED)).toBe(true);
    // A heal is not a change.
    expect(repo.recordChanges).not.toHaveBeenCalled();
    expect(result.changed).toBe(0);
  });

  it('neither fetches nor writes when the photo is already stored', async () => {
    const scope = nock(PHOTO_HOST).get(PHOTO_PATH).reply(200, HEALED);
    vi.mocked(getPaginatedData).mockResolvedValue([withPhoto('a')]);
    repo.getMeetupSnapshot.mockResolvedValue(
      snapshotFor('a', { photoId: 'p1', photoThumb: STORED_OLD }),
    );

    await runMeetupSweep('sweep');

    expect(scope.isDone()).toBe(false);
    expect(repo.putMeetupSnapshot).not.toHaveBeenCalled();
  });

  it('does not try to heal a member with no photo', async () => {
    const scope = nock(PHOTO_HOST).get(PHOTO_PATH).reply(200, HEALED);
    vi.mocked(getPaginatedData).mockResolvedValue([member('a')]);
    repo.getMeetupSnapshot.mockResolvedValue(
      snapshotFor('a', { photoId: null, photoThumb: null }),
    );

    await runMeetupSweep('sweep');

    expect(scope.isDone()).toBe(false);
    expect(repo.putMeetupSnapshot).not.toHaveBeenCalled();
  });

  it('writes nothing when the heal fetch fails', async () => {
    nock(PHOTO_HOST).get(PHOTO_PATH).reply(404);
    vi.mocked(getPaginatedData).mockResolvedValue([withPhoto('a')]);
    repo.getMeetupSnapshot.mockResolvedValue(unhealed('a'));

    const result = await runMeetupSweep('sweep');

    // Nothing to store; the next sweep simply tries again.
    expect(repo.putMeetupSnapshot).not.toHaveBeenCalled();
    expect(result.scanned).toBe(1);
  });

  it('stops healing for the rest of the run once the time budget is spent', async () => {
    // Each heal fetch "takes" 61s of clock: two exhaust the 120s budget, so
    // the third and fourth members are left for a later day.
    let clock = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const scope = nock(PHOTO_HOST)
      .get(PHOTO_PATH)
      .times(4)
      .reply(() => {
        clock += 61_000;
        return [200, HEALED];
      });
    vi.mocked(getPaginatedData).mockResolvedValue(
      ['a', 'b', 'c', 'd'].map(withPhoto),
    );
    repo.getMeetupSnapshot.mockImplementation(async (_scope, id: string) =>
      unhealed(id),
    );

    const result = await runMeetupSweep('sweep');

    expect(repo.putMeetupSnapshot).toHaveBeenCalledTimes(2);
    expect(scope.pendingMocks()).toHaveLength(1);
    // Every member was still scanned: the budget limits healing, not the sweep.
    expect(result.scanned).toBe(4);
  });

  it('heals independently of the systemic-change thumbnail cap', async () => {
    // 19 changed members trip the 10% cap (ceil(20 * 0.1) = 2) well before
    // the last, unchanged member is reached. Heals are not changes: the cap
    // must not stop this one, and it must not count toward `changed`.
    const roster = [
      ...Array.from({ length: 19 }, (_, i) =>
        member(`m${i}`, { memberPhoto: { id: 'new-photo', thumbUrl: 'u' } }),
      ),
      withPhoto('last'),
    ];
    const heal = nock(PHOTO_HOST).get(PHOTO_PATH).reply(200, HEALED);
    vi.mocked(getPaginatedData).mockResolvedValue(roster);
    repo.getMeetupSnapshot.mockImplementation(async (_scope, id: string) => {
      return id === 'last'
        ? unhealed(id)
        : snapshotFor(id, { photoId: 'old-photo', photoThumb: STORED_OLD });
    });

    const result = await runMeetupSweep('sweep', fakeClient());

    expect(heal.isDone()).toBe(true);
    expect(result.changed).toBe(19);
    const lastWrite = repo.putMeetupSnapshot.mock.calls.at(-1) as [
      { meetupMemberId: string },
      { photoThumb?: Buffer },
    ];
    expect(lastWrite[0].meetupMemberId).toBe('last');
    expect(lastWrite[1].photoThumb?.equals(HEALED)).toBe(true);
  });

  it('does not trip the systemic-change cap however many members heal', async () => {
    const roster = Array.from({ length: 20 }, (_, i) => withPhoto(`m${i}`));
    nock(PHOTO_HOST).get(PHOTO_PATH).times(20).reply(200, HEALED);
    vi.mocked(getPaginatedData).mockResolvedValue(roster);
    repo.getMeetupSnapshot.mockImplementation(async (_scope, id: string) =>
      unhealed(id),
    );

    const result = await runMeetupSweep('sweep', fakeClient());

    expect(result.changed).toBe(0);
    expect(repo.putMeetupSnapshot).toHaveBeenCalledTimes(20);
    expect(logAlert).not.toHaveBeenCalled();
  });
});
