import { Client } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
