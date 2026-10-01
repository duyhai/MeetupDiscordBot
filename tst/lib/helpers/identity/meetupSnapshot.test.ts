import { describe, expect, it } from 'vitest';

import { MeetupGroupMember } from '../../../../src/lib/client/meetup/types.js';
import {
  MeetupSnapshot,
  diffMeetupIdentity,
  snapshotMeetupMember,
} from '../../../../src/lib/helpers/identity/meetupSnapshot.js';

function fakeMember(
  overrides: Partial<MeetupGroupMember> = {},
): MeetupGroupMember {
  return {
    id: 'm1',
    name: 'Jane D.',
    username: 'janed',
    memberPhoto: { id: 'p1', thumbUrl: 'https://x/p1.jpg' },
    ...overrides,
  };
}

describe('snapshotMeetupMember', () => {
  it('reads every tracked field off the member', () => {
    expect(snapshotMeetupMember(fakeMember(), '7595882')).toEqual({
      scopeId: '7595882',
      meetupMemberId: 'm1',
      name: 'Jane D.',
      username: 'janed',
      photoId: 'p1',
    });
  });

  it('yields a null photoId for a member with no photo', () => {
    const snap = snapshotMeetupMember(
      fakeMember({ memberPhoto: null }),
      '7595882',
    );

    expect(snap.photoId).toBeNull();
  });
});

const base: MeetupSnapshot = {
  scopeId: '7595882',
  meetupMemberId: 'm1',
  name: 'Jane D.',
  username: 'janed',
  photoId: 'p1',
};

describe('diffMeetupIdentity', () => {
  it('emits no changes for a first sighting', () => {
    // Backfill: the first sighting IS the baseline. Otherwise enabling the
    // feature reports ~6,000 Meetup members as having changed.
    expect(diffMeetupIdentity(undefined, base)).toEqual([]);
  });

  it('reports nothing when nothing changed', () => {
    expect(diffMeetupIdentity(base, { ...base })).toEqual([]);
  });

  it('stamps meetup platform and the group scope', () => {
    const out = diffMeetupIdentity(base, { ...base, photoId: 'p2' });

    expect(out).toEqual([
      {
        platform: 'meetup',
        scopeId: '7595882',
        subjectId: 'm1',
        field: 'photo',
        oldValue: 'p1',
        newValue: 'p2',
      },
    ]);
  });

  it('emits a name change', () => {
    const out = diffMeetupIdentity(base, { ...base, name: 'Jane S.' });

    expect(out).toEqual([
      {
        platform: 'meetup',
        scopeId: '7595882',
        subjectId: 'm1',
        field: 'name',
        oldValue: 'Jane D.',
        newValue: 'Jane S.',
      },
    ]);
  });

  it('emits a username change', () => {
    const out = diffMeetupIdentity(base, { ...base, username: 'janed2' });

    expect(out).toEqual([
      {
        platform: 'meetup',
        scopeId: '7595882',
        subjectId: 'm1',
        field: 'username',
        oldValue: 'janed',
        newValue: 'janed2',
      },
    ]);
  });
});
