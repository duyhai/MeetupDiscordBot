export type OnboardMethod = 'self_onboard' | 'sync_v2' | 'manual';

/**
 * Raised by upsert when the meetup id is already claimed by a different
 * Discord user (Postgres UNIQUE violation, or the in-memory equivalent).
 * Closes the check-then-write race in the duplicate pre-check.
 */
export class MeetupIdConflictError extends Error {}

export interface MemberRecord {
  discordUserId: string;
  meetupId: string | null;
  meetupName: string | null;
  meetupMemberUrl: string | null;
  onboardMethod: OnboardMethod;
  onboardedBy: string | null; // mod's Discord ID, manual onboards only
  firstOnboardedAt: Date;
  lastSyncedAt: Date;
}

export type MemberUpsert = Omit<
  MemberRecord,
  'firstOnboardedAt' | 'lastSyncedAt'
>;

export interface MemberRepository {
  upsert(member: MemberUpsert): Promise<MemberRecord>;
  findByDiscordId(discordUserId: string): Promise<MemberRecord | undefined>;
  findByMeetupId(meetupId: string): Promise<MemberRecord | undefined>;
  listAll(): Promise<MemberRecord[]>;
  remove(discordUserId: string): Promise<void>;
}

export interface SuspensionRecord {
  id: number;
  memberId: string;
  memberName: string | null;
  suspendedAt: Date;
  durationDays: number;
  notes: string | null;
  createdAt: Date;
}

export type SuspensionInsert = Omit<SuspensionRecord, 'id' | 'createdAt'>;

/**
 * A record taken out of effect by a moderator. Voided rows stay in the table
 * as the audit trail but are invisible to every read below.
 */
export interface VoidedSuspensionRecord extends SuspensionRecord {
  voidedAt: Date;
  /** Discord user ID of the moderator who voided it. */
  voidedBy: string;
  voidReason: string;
}

export interface InsertManyResult {
  inserted: SuspensionRecord[];
  /** Distinct member ids with an active (unlifted) ban: refused, not inserted. */
  banned: string[];
}

export interface SuspensionRepository {
  /**
   * Inserts a suspension record. Returns undefined instead of inserting when
   * a non-voided record for the same (memberId, suspendedAt) exists -- callers
   * retrying a partially-failed batch must not double a member's penalty.
   * A different suspendedAt for the same member always inserts: repeat
   * suspensions on different dates are expected.
   */
  insert(record: SuspensionInsert): Promise<SuspensionRecord | undefined>;
  /**
   * One transaction under each member's lock. Returns the rows actually
   * inserted (duplicates are silently skipped) and the distinct member ids
   * with an active ban, none of whose rows were inserted.
   */
  insertMany(records: SuspensionInsert[]): Promise<InsertManyResult>;
  /**
   * How many suspensions the member had strictly before `before` -- the
   * "prior suspensions" that double the next penalty. Deliberately takes a
   * date: counting all records would treat a later suspension as prior when
   * a moderator back-dates one, doubling a first offence.
   */
  countSuspensionsBefore(memberId: string, before: Date): Promise<number>;
  /** Newest first. Voided records are excluded, as they are from the count. */
  listByMemberId(memberId: string): Promise<SuspensionRecord[]>;
  /**
   * Live (non-voided) records for these members, newest first per member;
   * with `before`, only those with suspended_at < before. One query.
   */
  listByMemberIds(
    memberIds: string[],
    before?: Date,
  ): Promise<SuspensionRecord[]>;
  listAll(): Promise<SuspensionRecord[]>;
  /**
   * Marks a record void rather than deleting it: disciplinary history keeps
   * its audit trail. Returns undefined if the ID is unknown or already void.
   */
  void(
    id: number,
    voidedBy: string,
    reason: string,
  ): Promise<VoidedSuspensionRecord | undefined>;
  deleteAllForTest(): Promise<void>;
}
