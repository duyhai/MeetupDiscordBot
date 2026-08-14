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
