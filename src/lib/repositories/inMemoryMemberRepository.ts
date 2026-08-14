import {
  MeetupIdConflictError,
  MemberRecord,
  MemberRepository,
  MemberUpsert,
} from './types.js';

/**
 * Map-backed MemberRepository used for local development (no DATABASE_URL)
 * and unit tests. Mirrors the InMemoryCache/RedisCache split.
 */
export class InMemoryMemberRepository implements MemberRepository {
  private members = new Map<string, MemberRecord>();

  private static singleton: InMemoryMemberRepository;

  public static instance(): InMemoryMemberRepository {
    if (this.singleton === undefined) {
      this.singleton = new InMemoryMemberRepository();
    }
    return this.singleton;
  }

  async upsert(member: MemberUpsert): Promise<MemberRecord> {
    // Mirror the members.meetup_id UNIQUE constraint in Postgres.
    if (member.meetupId !== null) {
      const claimedBy = Array.from(this.members.values()).find(
        (record) => record.meetupId === member.meetupId,
      );
      if (claimedBy && claimedBy.discordUserId !== member.discordUserId) {
        throw new MeetupIdConflictError(
          `meetup id ${member.meetupId} is already linked to another member`,
        );
      }
    }
    const existing = this.members.get(member.discordUserId);
    const now = new Date();
    const record: MemberRecord = {
      ...member,
      firstOnboardedAt: existing?.firstOnboardedAt ?? now,
      lastSyncedAt: now,
    };
    this.members.set(member.discordUserId, record);
    return { ...record };
  }

  async findByDiscordId(
    discordUserId: string,
  ): Promise<MemberRecord | undefined> {
    const record = this.members.get(discordUserId);
    return record ? { ...record } : undefined;
  }

  async findByMeetupId(meetupId: string): Promise<MemberRecord | undefined> {
    const record = Array.from(this.members.values()).find(
      (r) => r.meetupId === meetupId,
    );
    return record ? { ...record } : undefined;
  }

  async listAll(): Promise<MemberRecord[]> {
    return [...this.members.values()].map((record) => ({ ...record }));
  }

  async remove(discordUserId: string): Promise<void> {
    this.members.delete(discordUserId);
  }
}
