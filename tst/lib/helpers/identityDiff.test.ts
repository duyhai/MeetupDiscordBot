import { describe, expect, it } from 'vitest';

import { diffIdentity } from '../../../src/lib/helpers/identityDiff.js';
import { IdentitySnapshot } from '../../../src/lib/repositories/identityTypes.js';

const base: IdentitySnapshot = {
  discordUserId: 'u1',
  username: 'someone',
  globalName: 'Someone',
  nickname: 'Some One',
  userAvatarHash: 'aaa',
  memberAvatarHash: null,
};

describe('diffIdentity', () => {
  it('reports nothing when nothing changed', () => {
    expect(diffIdentity(base, { ...base })).toEqual([]);
  });

  it('reports one change per changed field', () => {
    const after = { ...base, userAvatarHash: 'bbb', nickname: 'Someone Else' };

    expect(diffIdentity(base, after)).toEqual(
      expect.arrayContaining([
        {
          discordUserId: 'u1',
          field: 'user_avatar',
          oldValue: 'aaa',
          newValue: 'bbb',
        },
        {
          discordUserId: 'u1',
          field: 'nickname',
          oldValue: 'Some One',
          newValue: 'Someone Else',
        },
      ]),
    );
    expect(diffIdentity(base, after)).toHaveLength(2);
  });

  it('treats setting a server avatar as a change from null', () => {
    const after = { ...base, memberAvatarHash: 'ccc' };

    expect(diffIdentity(base, after)).toEqual([
      {
        discordUserId: 'u1',
        field: 'member_avatar',
        oldValue: null,
        newValue: 'ccc',
      },
    ]);
  });

  it('treats clearing a nickname as a change to null', () => {
    const after = { ...base, nickname: null };

    expect(diffIdentity(base, after)).toEqual([
      {
        discordUserId: 'u1',
        field: 'nickname',
        oldValue: 'Some One',
        newValue: null,
      },
    ]);
  });

  it('reports no changes for a member with no baseline yet', () => {
    // Backfill path: a first sighting is the baseline, not 5 changes. Without
    // this, enabling the feature reports 2,008 members as having "changed".
    expect(diffIdentity(undefined, base)).toEqual([]);
  });
});
