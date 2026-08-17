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
