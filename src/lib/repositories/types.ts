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

export interface SuspensionRepository {
  insert(record: SuspensionInsert): Promise<SuspensionRecord>;
  insertMany(records: SuspensionInsert[]): Promise<SuspensionRecord[]>;
  countByMemberId(memberId: string): Promise<number>;
  listByMemberId(memberId: string): Promise<SuspensionRecord[]>;
  deleteAllForTest(): Promise<void>;
}
