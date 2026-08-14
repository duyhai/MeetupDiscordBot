/* eslint-disable typescript-sort-keys/interface */
import pg from 'pg';
import { Logger } from 'tslog';

import {
  MemberRecord,
  MemberRepository,
  MemberUpsert,
  OnboardMethod,
} from './types.js';

const logger = new Logger({ name: 'PostgresMemberRepository' });

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS members (
  discord_user_id    TEXT PRIMARY KEY,
  meetup_id          TEXT UNIQUE,
  meetup_name        TEXT,
  meetup_member_url  TEXT,
  onboard_method     TEXT NOT NULL,
  onboarded_by       TEXT,
  first_onboarded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

interface MemberRow {
  discord_user_id: string;
  meetup_id: string | null;
  meetup_name: string | null;
  meetup_member_url: string | null;
  onboard_method: OnboardMethod;
  onboarded_by: string | null;
  first_onboarded_at: Date;
  last_synced_at: Date;
}

function toRecord(row: MemberRow): MemberRecord {
  return {
    discordUserId: row.discord_user_id,
    meetupId: row.meetup_id,
    meetupName: row.meetup_name,
    meetupMemberUrl: row.meetup_member_url,
    onboardMethod: row.onboard_method,
    onboardedBy: row.onboarded_by,
    firstOnboardedAt: row.first_onboarded_at,
    lastSyncedAt: row.last_synced_at,
  };
}

/**
 * Postgres-backed MemberRepository. Used when DATABASE_URL is set (Heroku
 * Postgres injects it). Schema is ensured once, lazily, on instance().
 */
export class PostgresMemberRepository implements MemberRepository {
  private pool: pg.Pool;

  private schemaEnsured: Promise<void> | undefined;

  private static singleton: PostgresMemberRepository;

  private constructor() {
    const connectionString = process.env.DATABASE_URL;
    const isLocal =
      connectionString.includes('localhost') ||
      connectionString.includes('127.0.0.1');
    this.pool = new pg.Pool({
      connectionString,
      max: 5, // Essential-0 allows 20 connections total; leave headroom
      // Heroku Postgres requires TLS but uses certs node rejects by default
      ssl: isLocal ? undefined : { rejectUnauthorized: false },
      allowExitOnIdle: true, // lets test processes exit cleanly instead of waiting on idle clients
    });
    // Heroku recycles idle connections; without a listener the resulting
    // pool 'error' event would crash the process.
    this.pool.on('error', (error) => {
      logger.error(`Postgres pool error: ${String(error)}`);
    });
  }

  public static async instance(): Promise<PostgresMemberRepository> {
    if (this.singleton === undefined) {
      this.singleton = new PostgresMemberRepository();
    }
    const repo = this.singleton;
    if (repo.schemaEnsured === undefined) {
      repo.schemaEnsured = (async () => {
        await repo.pool.query(CREATE_TABLE_SQL);
      })();
    }
    try {
      await repo.schemaEnsured;
    } catch (error) {
      repo.schemaEnsured = undefined; // retry on next call
      throw error;
    }
    return repo;
  }

  async upsert(member: MemberUpsert): Promise<MemberRecord> {
    const result = await this.pool.query<MemberRow>(
      `INSERT INTO members
         (discord_user_id, meetup_id, meetup_name, meetup_member_url, onboard_method, onboarded_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (discord_user_id) DO UPDATE SET
         meetup_id = EXCLUDED.meetup_id,
         meetup_name = EXCLUDED.meetup_name,
         meetup_member_url = EXCLUDED.meetup_member_url,
         onboard_method = EXCLUDED.onboard_method,
         onboarded_by = EXCLUDED.onboarded_by,
         last_synced_at = now()
       RETURNING *`,
      [
        member.discordUserId,
        member.meetupId,
        member.meetupName,
        member.meetupMemberUrl,
        member.onboardMethod,
        member.onboardedBy,
      ]
    );
    return toRecord(result.rows[0]);
  }

  async findByDiscordId(
    discordUserId: string
  ): Promise<MemberRecord | undefined> {
    const result = await this.pool.query<MemberRow>(
      'SELECT * FROM members WHERE discord_user_id = $1',
      [discordUserId]
    );
    return result.rows[0] ? toRecord(result.rows[0]) : undefined;
  }

  async findByMeetupId(meetupId: string): Promise<MemberRecord | undefined> {
    const result = await this.pool.query<MemberRow>(
      'SELECT * FROM members WHERE meetup_id = $1',
      [meetupId]
    );
    return result.rows[0] ? toRecord(result.rows[0]) : undefined;
  }

  async listAll(): Promise<MemberRecord[]> {
    const result = await this.pool.query<MemberRow>('SELECT * FROM members');
    return result.rows.map(toRecord);
  }

  async remove(discordUserId: string): Promise<void> {
    await this.pool.query('DELETE FROM members WHERE discord_user_id = $1', [
      discordUserId,
    ]);
  }
}
