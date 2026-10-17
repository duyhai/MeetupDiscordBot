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

/** The dashboard's three tabs: the command's active/past split of live rows, plus voided rows. */
export type SuspensionState = 'active' | 'past' | 'voided';

/** One row of the dashboard's suspension records page. */
export interface SuspensionPageRow extends SuspensionRecord {
  /** lastSuspendedDay (suspensionList.ts), computed in SQL: 'YYYY-MM-DD'. */
  lastDay: string;
  voidedAt: Date | null;
  /** Discord user id of the moderator who voided it. */
  voidedBy: string | null;
  voidReason: string | null;
  /** From the members table when the Meetup id is linked; null otherwise. */
  linkedName: string | null;
  linkedDiscordId: string | null;
}

/**
 * The SQL form of lastSuspendedDay (suspensionList.ts): suspended_at is the
 * UTC midnight of the chosen date, so its UTC date is that date, and the
 * last day is inclusive.
 */
const LAST_DAY = `((suspended_at AT TIME ZONE 'UTC')::date + duration_days - 1)`;

/**
 * isSuspensionActive in SQL: $1 is pacificToday(now), so the database clock
 * never decides. Voided rows never reach active or past, as in listAll.
 */
const STATE_WHERE: Record<SuspensionState, string> = {
  active: `voided_at IS NULL AND ${LAST_DAY} >= $1::date`,
  past: `voided_at IS NULL AND ${LAST_DAY} < $1::date`,
  // $1 kept so every state takes the same parameter list.
  voided: 'voided_at IS NOT NULL AND $1::date IS NOT NULL',
};

/** listAll's order (newest suspended first) for the command's tabs; newest void first for voided. */
const STATE_ORDER: Record<SuspensionState, string> = {
  active: 'suspended_at DESC, id DESC',
  past: 'suspended_at DESC, id DESC',
  voided: 'voided_at DESC, id DESC',
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PAGE_ROWS = 50;

const STATES: readonly SuspensionState[] = ['active', 'past', 'voided'];

const isState = (value: unknown): value is SuspensionState =>
  STATES.some((state) => state === value);

/** A whole, non-negative number of rows: junk, negatives and infinities become `fallback`. */
function wholeCount(value: number, fallback: number): number {
  const n = Math.trunc(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

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

  async listByMemberIds(
    memberIds: string[],
    before?: Date,
  ): Promise<SuspensionRecord[]> {
    if (memberIds.length === 0) {
      return [];
    }
    const result = await this.pool.query<SuspensionRow>(
      `SELECT * FROM suspension_records
       WHERE member_id = ANY($1::text[]) AND voided_at IS NULL
         AND ($2::timestamptz IS NULL OR suspended_at < $2::timestamptz)
       ORDER BY member_id, suspended_at DESC`,
      [memberIds, before ?? null],
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

  /**
   * One page of one dashboard tab, at most 50 rows. `today` is
   * pacificToday(now): the active/past split is the command's.
   */
  async listPage(options: {
    state: SuspensionState;
    today: string;
    offset: number;
    limit: number;
  }): Promise<SuspensionPageRow[]> {
    const { state, today } = options;
    if (!isState(state) || typeof today !== 'string' || !DAY.test(today)) {
      throw new RangeError('bad suspension page query');
    }
    // 0 or junk is a full page, as in the brief; never more than 50.
    const limit = Math.min(
      MAX_PAGE_ROWS,
      wholeCount(options.limit, MAX_PAGE_ROWS) || MAX_PAGE_ROWS,
    );
    const offset = wholeCount(options.offset, 0);
    const result = await this.pool.query<SuspensionRow & { last_day: string }>(
      `SELECT *, to_char(${LAST_DAY}, 'YYYY-MM-DD') AS last_day
         FROM suspension_records
        WHERE ${STATE_WHERE[state]}
        ORDER BY ${STATE_ORDER[state]}
        LIMIT $2 OFFSET $3`,
      [today, limit, offset],
    );
    const linked = await this.linkedMembers([
      ...new Set(result.rows.map((row) => row.member_id)),
    ]);
    return result.rows.map((row) => ({
      ...toRecord(row),
      lastDay: row.last_day,
      voidedAt: row.voided_at,
      voidedBy: row.voided_by,
      voidReason: row.void_reason,
      linkedName: linked.get(row.member_id)?.name ?? null,
      linkedDiscordId: linked.get(row.member_id)?.discordId ?? null,
    }));
  }

  /** Rows per dashboard tab, with listPage's split for the same `today`. */
  async countByState(today: string): Promise<Record<SuspensionState, number>> {
    if (typeof today !== 'string' || !DAY.test(today)) {
      throw new RangeError('today must be YYYY-MM-DD');
    }
    const result = await this.pool.query<Record<SuspensionState, number>>(
      `SELECT count(*) FILTER (WHERE ${STATE_WHERE.active})::int AS active,
              count(*) FILTER (WHERE ${STATE_WHERE.past})::int AS past,
              count(*) FILTER (WHERE ${STATE_WHERE.voided})::int AS voided
         FROM suspension_records`,
      [today],
    );
    const row = result.rows[0];
    return { active: row.active, past: row.past, voided: row.voided };
  }

  /**
   * Names and Discord ids of linked members, for at most one page of ids. The
   * members table is the member repository's; a database without it yields none.
   */
  private async linkedMembers(
    ids: string[],
  ): Promise<Map<string, { name: string | null; discordId: string }>> {
    if (ids.length === 0) {
      return new Map();
    }
    try {
      const result = await this.pool.query<{
        meetup_id: string;
        meetup_name: string | null;
        discord_user_id: string;
      }>(
        `SELECT meetup_id, meetup_name, discord_user_id FROM members
          WHERE meetup_id = ANY($1::text[])`,
        [ids],
      );
      return new Map(
        result.rows.map((row) => [
          row.meetup_id,
          { name: row.meetup_name, discordId: row.discord_user_id },
        ]),
      );
    } catch (error) {
      if ((error as { code?: string }).code === '42P01') {
        // undefined_table. No ids in the message.
        logger.warn(
          'members table missing; suspension page shows no linked names',
        );
        return new Map();
      }
      throw error;
    }
  }

  /** Test-only cleanup, mirroring the member repository's test hooks. */
  async deleteAllForTest(): Promise<void> {
    await this.pool.query('DELETE FROM suspension_records');
  }
}
