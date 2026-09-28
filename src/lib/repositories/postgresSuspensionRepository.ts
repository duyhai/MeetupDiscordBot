import pg from 'pg';
import { Logger } from 'tslog';

import {
  SuspensionInsert,
  SuspensionRecord,
  SuspensionRepository,
} from './types.js';

const logger = new Logger({ name: 'PostgresSuspensionRepository' });

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS suspension_records (
  id            SERIAL PRIMARY KEY,
  member_id     TEXT NOT NULL,
  member_name   TEXT,
  suspended_at  TIMESTAMPTZ NOT NULL,
  duration_days INTEGER NOT NULL,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS suspension_records_member_id_idx
  ON suspension_records (member_id);
CREATE UNIQUE INDEX IF NOT EXISTS suspension_records_member_suspended_at_idx
  ON suspension_records (member_id, suspended_at);
`;

interface SuspensionRow {
  id: number;
  member_id: string;
  member_name: string | null;
  suspended_at: Date;
  duration_days: number;
  notes: string | null;
  created_at: Date;
}

function toRecord(row: SuspensionRow): SuspensionRecord {
  return {
    id: row.id,
    memberId: row.member_id,
    memberName: row.member_name,
    suspendedAt: row.suspended_at,
    durationDays: row.duration_days,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

/**
 * Postgres-backed suspension history. Same lifecycle conventions as
 * PostgresMemberRepository: singleton, lazy schema ensure, Heroku TLS.
 */
export class PostgresSuspensionRepository implements SuspensionRepository {
  private pool: pg.Pool;

  private schemaEnsured: Promise<void> | undefined;

  private static singleton: PostgresSuspensionRepository;

  private constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'PostgresSuspensionRepository requires DATABASE_URL to be set',
      );
    }
    const isLocal =
      connectionString.includes('localhost') ||
      connectionString.includes('127.0.0.1');
    this.pool = new pg.Pool({
      connectionString,
      max: 5,
      ssl: isLocal ? undefined : { rejectUnauthorized: false },
      allowExitOnIdle: true,
    });
    this.pool.on('error', (error) => {
      logger.error(`Postgres pool error: ${String(error)}`);
    });
  }

  public static async instance(): Promise<PostgresSuspensionRepository> {
    if (this.singleton === undefined) {
      this.singleton = new PostgresSuspensionRepository();
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

  async insert(
    record: SuspensionInsert,
  ): Promise<SuspensionRecord | undefined> {
    const result = await this.pool.query<SuspensionRow>(
      `INSERT INTO suspension_records
         (member_id, member_name, suspended_at, duration_days, notes)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (member_id, suspended_at) DO NOTHING
       RETURNING *`,
      [
        record.memberId,
        record.memberName,
        record.suspendedAt,
        record.durationDays,
        record.notes,
      ],
    );
    return result.rows[0] ? toRecord(result.rows[0]) : undefined;
  }

  async insertMany(records: SuspensionInsert[]): Promise<SuspensionRecord[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted: SuspensionRecord[] = [];
      for (const record of records) {
        // eslint-disable-next-line no-await-in-loop
        const result = await client.query<SuspensionRow>(
          `INSERT INTO suspension_records
             (member_id, member_name, suspended_at, duration_days, notes)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (member_id, suspended_at) DO NOTHING
           RETURNING *`,
          [
            record.memberId,
            record.memberName,
            record.suspendedAt,
            record.durationDays,
            record.notes,
          ],
        );
        if (result.rows[0]) {
          inserted.push(toRecord(result.rows[0]));
        }
      }
      await client.query('COMMIT');
      return inserted;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async countSuspensionsBefore(
    memberId: string,
    before: Date,
  ): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM suspension_records
       WHERE member_id = $1 AND suspended_at < $2`,
      [memberId, before],
    );
    return Number(result.rows[0].count);
  }

  async listByMemberId(memberId: string): Promise<SuspensionRecord[]> {
    const result = await this.pool.query<SuspensionRow>(
      `SELECT * FROM suspension_records
       WHERE member_id = $1
       ORDER BY suspended_at DESC`,
      [memberId],
    );
    return result.rows.map(toRecord);
  }

  async listAll(): Promise<SuspensionRecord[]> {
    const result = await this.pool.query<SuspensionRow>(
      'SELECT * FROM suspension_records ORDER BY suspended_at DESC',
    );
    return result.rows.map(toRecord);
  }

  /** Test-only cleanup, mirroring the member repository's test hooks. */
  async deleteAllForTest(): Promise<void> {
    await this.pool.query('DELETE FROM suspension_records');
  }
}
