/** A stored ban photo is at most this many bytes (150 KB). */
export const BAN_PHOTO_MAX_BYTES = 153_600;
/** An uploaded ban photo is at most this many pixels on either side. */
export const BAN_PHOTO_MAX_SIDE = 512;
/** Code points. */
export const BAN_NAME_MAX = 500;
/** Code points. */
export const BAN_NOTES_MAX = 2000;
/** Code points. */
export const BAN_LIFT_REASON_MAX = 500;
/** Rows one CSV import may carry. */
export const BAN_IMPORT_MAX_ROWS = 200;
/** Bans the sweep fill looks at in one run. */
export const BAN_FILL_MAX_PER_RUN = 50;

export type BanState = 'active' | 'lifted';
export type BanPhotoSource = 'upload' | 'profile';

/** One member_bans row without its photo bytes. */
export interface BanRow {
  id: number;
  /** Meetup member id, digits only. */
  memberId: string;
  memberName: string;
  /** 'YYYY-MM-DD'; null = date unknown. */
  bannedOn: string | null;
  notes: string;
  /** Discord id of the staff member who recorded it. */
  recordedBy: string;
  createdAt: Date;
  hasPhoto: boolean;
  photoSource: BanPhotoSource | null;
  photoUpdatedAt: Date | null;
  /** Discord id of the uploader; null when the sweep filled it. */
  photoUpdatedBy: string | null;
  liftedAt: Date | null;
  liftedBy: string | null;
  liftReason: string | null;
}

export interface BanInsert {
  memberId: string;
  memberName: string;
  bannedOn: string | null;
  notes: string;
  recordedBy: string;
}

export type BanRecordOutcome =
  { ok: true; ban: BanRow } | { ok: false; reason: 'already-banned' };

export type BanImportOutcome =
  | { ok: true; count: number }
  /** `index` is the 0-based input that collided. */
  | { ok: false; reason: 'already-banned'; index: number };
