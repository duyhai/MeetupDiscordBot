export type IdentityPlatform = 'discord' | 'meetup';

export type IdentityField =
  'user_avatar' | 'member_avatar' | 'nickname' | 'username' | 'global_name';

export interface IdentitySnapshot {
  scopeId: string;
  discordUserId: string;
  username: string | null;
  globalName: string | null;
  nickname: string | null;
  userAvatarHash: string | null;
  memberAvatarHash: string | null;
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

/**
 * How a change was detected.
 *
 * `'event'` is HISTORICAL: it was written by the gateway listeners of the
 * first deployment, which have since been removed, and ~125 production rows
 * still carry it. No code writes it any more and nothing should start to --
 * it stays in the union only so the type is honest about rows the digest and
 * report read back.
 */
export type ChangeSource = 'sweep' | 'backfill' | 'event';

/** The sources current code may write. Excludes the historical `'event'`. */
export type WritableChangeSource = Exclude<ChangeSource, 'event'>;

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
