import pg from 'pg';
import { Logger } from 'tslog';

import {
  SuspensionInsert,
  SuspensionRecord,
  SuspensionRepository,
  VoidedSuspensionRecord,
} from './types.js';

const logger = new Logger({ name: 'PostgresSuspensionRepository' });

/**
 * Idempotent, so it runs on every boot and also upgrades tables created
 * before voiding existed. The pair is unique only among live rows: once a
 * wrong record is voided, the corrected one can be recorded on the same
 * date. The old full index is dropped by name; the partial one has a new
 * name so CREATE ... IF NOT EXISTS can't mistake one for the other.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS suspension_records (
  id            SERIAL PRIMARY KEY,
  member_id     TEXT NOT NULL,
  member_name   TEXT,
  suspended_at  TIMESTAMPTZ NOT NULL,
  duration_days INTEGER NOT NULL,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE suspension_records
  ADD COLUMN IF NOT EXISTS voided_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by   TEXT,
  ADD COLUMN IF NOT EXISTS void_reason TEXT;
CREATE INDEX IF NOT EXISTS suspension_records_member_id_idx
  ON suspension_records (member_id);
DROP INDEX IF EXISTS suspension_records_member_suspended_at_idx;
CREATE UNIQUE INDEX IF NOT EXISTS suspension_records_live_member_suspended_at_idx
  ON suspension_records (member_id, suspended_at)
  WHERE voided_at IS NULL;
`;

// Must name the partial index's predicate, or Postgres can't match it.
const INSERT_SQL = `INSERT INTO suspension_records
  (member_id, member_name, suspended_at, duration_days, notes)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (member_id, suspended_at) WHERE voided_at IS NULL DO NOTHING
RETURNING *`;

interface SuspensionRow {
  id: number;
  member_id: string;
  member_name: string | null;
  suspended_at: Date;
  duration_days: number;
  notes: string | null;
  created_at: Date;
  voided_at: Date | null;
  voided_by: string | null;
  void_reason: string | null;
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

function toVoidedRecord(row: SuspensionRow): VoidedSuspensionRecord {
  return {
    ...toRecord(row),
    voidedAt: row.voided_at,
    voidedBy: row.voided_by,
    voidReason: row.void_reason,
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
        await repo.pool.query(SCHEMA_SQL);
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
    const result = await this.pool.query<SuspensionRow>(INSERT_SQL, [
      record.memberId,
      record.memberName,
      record.suspendedAt,
      record.durationDays,
      record.notes,
    ]);
    return result.rows[0] ? toRecord(result.rows[0]) : undefined;
  }

  async insertMany(records: SuspensionInsert[]): Promise<SuspensionRecord[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted: SuspensionRecord[] = [];
      for (const record of records) {
        // eslint-disable-next-line no-await-in-loop
        const result = await client.query<SuspensionRow>(INSERT_SQL, [
          record.memberId,
          record.memberName,
          record.suspendedAt,
          record.durationDays,
          record.notes,
        ]);
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
       WHERE member_id = $1 AND suspended_at < $2 AND voided_at IS NULL`,
      [memberId, before],
    );
    return Number(result.rows[0].count);
  }

  async listByMemberId(memberId: string): Promise<SuspensionRecord[]> {
    const result = await this.pool.query<SuspensionRow>(
      `SELECT * FROM suspension_records
       WHERE member_id = $1 AND voided_at IS NULL
       ORDER BY suspended_at DESC`,
      [memberId],
    );
    return result.rows.map(toRecord);
  }

  async listAll(): Promise<SuspensionRecord[]> {
    const result = await this.pool.query<SuspensionRow>(
      `SELECT * FROM suspension_records
       WHERE voided_at IS NULL
       ORDER BY suspended_at DESC`,
    );
    return result.rows.map(toRecord);
  }

  async void(
    id: number,
    voidedBy: string,
    reason: string,
  ): Promise<VoidedSuspensionRecord | undefined> {
    const result = await this.pool.query<SuspensionRow>(
      `UPDATE suspension_records
       SET voided_at = now(), voided_by = $2, void_reason = $3
       WHERE id = $1 AND voided_at IS NULL
       RETURNING *`,
      [id, voidedBy, reason],
    );
    return result.rows[0] ? toVoidedRecord(result.rows[0]) : undefined;
  }

  /** Test-only cleanup, mirroring the member repository's test hooks. */
  async deleteAllForTest(): Promise<void> {
    await this.pool.query('DELETE FROM suspension_records');
  }
}
