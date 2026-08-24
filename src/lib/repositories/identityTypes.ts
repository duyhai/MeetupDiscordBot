export type IdentityPlatform = 'discord' | 'meetup';

export type IdentityField =
  | 'user_avatar'
  | 'member_avatar'
  | 'nickname'
  | 'username'
  | 'global_name'
  | 'photo'
  | 'name';

export interface IdentitySnapshot {
  scopeId: string;
  discordUserId: string;
  username: string | null;
  globalName: string | null;
  nickname: string | null;
  userAvatarHash: string | null;
  memberAvatarHash: string | null;
}

/**
 * A baseline row as it is stored: the pure snapshot plus the 64px thumbnails
 * kept alongside it.
 *
 * The thumbs live here rather than on `IdentitySnapshot` because a snapshot is
 * built from a live `GuildMember` and describes only what Discord told us.
 * The stored thumbs are ours -- fetched once and kept so that the *before*
 * image of a future change survives Discord purging the superseded avatar.
 */
export interface StoredIdentitySnapshot extends IdentitySnapshot {
  userAvatarThumb: Buffer | null;
  memberAvatarThumb: Buffer | null;
}

/**
 * Thumbnails to write alongside a baseline.
 *
 * Presence is meaningful and distinct from the value. A key that is ABSENT
 * leaves the stored column untouched -- a nickname-only change must not
 * discard an avatar thumb it knows nothing about. A key present with `null`
 * clears the column, which is what an avatar change whose fetch failed (or
 * whose new avatar is "none") has to do: the thumb column describes the hash
 * column beside it, and leaving the superseded image there would make the
 * next change's before-image a lie.
 */
export interface IdentityBaselineThumbs {
  userAvatarThumb?: Buffer | null;
  memberAvatarThumb?: Buffer | null;
}

export interface IdentityChange {
  platform: IdentityPlatform;
  scopeId: string;
  subjectId: string;
  field: IdentityField;
  oldValue: string | null;
  newValue: string | null;
}

/** The before/after images recorded with one change row. */
export interface ChangeThumbs {
  oldThumb: Buffer | null;
  newThumb: Buffer | null;
}

/**
 * Thumbnails keyed by `${platform}:${scopeId}:${subjectId}:${field}` -- the
 * four parts that pick exactly one change row out of a member's change set.
 */
export type ChangeThumbMap = Map<string, ChangeThumbs>;

export type ChangeSource = 'sweep' | 'backfill';

export interface IdentityChangeRecord extends IdentityChange {
  id: string;
  detectedAt: Date;
  source: ChangeSource;
  oldThumb: Buffer | null;
  newThumb: Buffer | null;
}

/**
 * A change row without its thumbnails. The digest renders text only, and the
 * BYTEA thumbs dominate row size (~2-4 KB each, two per avatar change), so
 * fetching them for a text digest pulls megabytes into a 512 MB dyno for
 * nothing. Distinct from IdentityChangeRecord on purpose: the absence of the
 * fields is a fact about the query, not a null thumbnail.
 */
export type IdentityChangeMetadata = Omit<
  IdentityChangeRecord,
  'oldThumb' | 'newThumb'
>;
