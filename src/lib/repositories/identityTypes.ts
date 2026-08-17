export type IdentityField =
  'user_avatar' | 'member_avatar' | 'nickname' | 'username' | 'global_name';

export interface IdentitySnapshot {
  discordUserId: string;
  username: string | null;
  globalName: string | null;
  nickname: string | null;
  userAvatarHash: string | null;
  memberAvatarHash: string | null;
}

export interface IdentityChange {
  discordUserId: string;
  field: IdentityField;
  oldValue: string | null;
  newValue: string | null;
}

export type ChangeSource = 'event' | 'sweep' | 'backfill';

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
