import { MeetupGroupMember } from '../../client/meetup/types.js';
import {
  IdentityChange,
  IdentityField,
} from '../../repositories/identityTypes.js';

export interface MeetupSnapshot {
  scopeId: string;
  meetupMemberId: string;
  name: string | null;
  username: string | null;
  photoId: string | null;
}

/**
 * A Meetup baseline row as stored: the pure snapshot plus the thumbnail kept
 * alongside it. Meetup's stored baseline keeps a photo *id*, not the URL that
 * produced it, so once a photo changes the superseded URL is unrecoverable --
 * storing the bytes at first sighting is the only way a change can ever show
 * a real before-image.
 */
export interface StoredMeetupSnapshot extends MeetupSnapshot {
  photoThumb: Buffer | null;
}

/**
 * Thumbnail to write alongside a Meetup baseline. Absent leaves the stored
 * column untouched; present-with-null clears it. Same rule as the Discord
 * side's IdentityBaselineThumbs, for the same reason.
 */
export interface MeetupBaselineThumbs {
  photoThumb?: Buffer | null;
}

export function snapshotMeetupMember(
  member: MeetupGroupMember,
  scopeId: string,
): MeetupSnapshot {
  return {
    scopeId,
    meetupMemberId: member.id,
    name: member.name ?? null,
    username: member.username ?? null,
    photoId: member.memberPhoto?.id ?? null,
  };
}

const FIELDS: { field: IdentityField; key: keyof MeetupSnapshot }[] = [
  { field: 'photo', key: 'photoId' },
  { field: 'name', key: 'name' },
  { field: 'username', key: 'username' },
];

/**
 * Field-by-field comparison of a stored Meetup baseline against a current
 * snapshot. Mirrors diffIdentity's absent-baseline rule: an undefined
 * baseline yields no changes, because the first sighting of a member IS the
 * baseline. Without this, enabling the feature would report all ~6,000
 * members of the group as having changed identity on day one.
 */
export function diffMeetupIdentity(
  before: MeetupSnapshot | undefined,
  after: MeetupSnapshot,
): IdentityChange[] {
  if (!before) {
    return [];
  }
  return FIELDS.filter(({ key }) => before[key] !== after[key]).map(
    ({ field, key }) => ({
      platform: 'meetup',
      scopeId: after.scopeId,
      subjectId: after.meetupMemberId,
      field,
      oldValue: before[key] ?? null,
      newValue: after[key] ?? null,
    }),
  );
}
