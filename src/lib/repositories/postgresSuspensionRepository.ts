import pg from 'pg';
import { Logger } from 'tslog';

import {
  DASHBOARD_LOCK_CLASS,
  DASHBOARD_LOCK_TIMEOUT_MS,
  MEMBER_LOCK_CLASS,
  DashboardTransactionOptions,
  inDashboardTransaction,
} from './dashboardPool.js';
import {
  InsertManyResult,
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
 *
 * A boot on an upgraded table only reads the catalog. CREATE TABLE IF NOT
 * EXISTS returns before locking anything, but ALTER TABLE takes an ACCESS
 * EXCLUSIVE lock (even when every ADD COLUMN IF NOT EXISTS is a no-op) and
 * CREATE INDEX IF NOT EXISTS a SHARE lock (blocking writes) before either
 * notices there is nothing to do. So each upgrade step sits behind a
 * catalog check scoped to current_schema(), and runs exactly the statement
 * it always ran. ensureSuspensionSchema runs this under an advisory lock
 * with a lock_timeout.
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
DO $do$
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'suspension_records'
         AND column_name IN ('voided_at', 'voided_by', 'void_reason')) < 3 THEN
    ALTER TABLE suspension_records
      ADD COLUMN IF NOT EXISTS voided_at   TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS voided_by   TEXT,
      ADD COLUMN IF NOT EXISTS void_reason TEXT;
  END IF;
  IF to_regclass(quote_ident(current_schema()) || '.suspension_records_member_id_idx') IS NULL THEN
    CREATE INDEX IF NOT EXISTS suspension_records_member_id_idx
      ON suspension_records (member_id);
  END IF;
  IF to_regclass(quote_ident(current_schema()) || '.suspension_records_member_suspended_at_idx') IS NOT NULL THEN
    DROP INDEX IF EXISTS suspension_records_member_suspended_at_idx;
  END IF;
  IF to_regclass(quote_ident(current_schema()) || '.suspension_records_live_member_suspended_at_idx') IS NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS suspension_records_live_member_suspended_at_idx
      ON suspension_records (member_id, suspended_at)
      WHERE voided_at IS NULL;
  END IF;
END
$do$;
`;

/** (DASHBOARD_LOCK_CLASS, SUSPENSION_SCHEMA_LOCK_KEY) serializes SCHEMA_SQL across processes. */
export const SUSPENSION_SCHEMA_LOCK_KEY = 1;

/**
 * SCHEMA_SQL in one transaction, under its advisory lock, with the dashboard
 * transaction's lock_timeout: a first boot's ALTER waiting behind a long
 * query fails (and is retried on the next instance() call) instead of
 * queueing every later query on the table behind it.
 */
export async function ensureSuspensionSchema(
  pool: pg.Pool,
  options: DashboardTransactionOptions = {},
): Promise<void> {
  await inDashboardTransaction(
    pool,
    'suspension schema transaction',
    async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
        DASHBOARD_LOCK_CLASS,
        SUSPENSION_SCHEMA_LOCK_KEY,
      ]);
      await client.query(SCHEMA_SQL);
    },
    options,
  );
}

// Must name the partial index's predicate, or Postgres can't match it.
export const INSERT_SQL = `INSERT INTO suspension_records
  (member_id, member_name, suspended_at, duration_days, notes)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (member_id, suspended_at) WHERE voided_at IS NULL DO NOTHING
RETURNING *`;

export const VOID_SQL = `UPDATE suspension_records
       SET voided_at = now(), voided_by = $2, void_reason = $3
       WHERE id = $1 AND voided_at IS NULL
       RETURNING *`;

export const COUNT_BEFORE_SQL = `SELECT COUNT(*) AS count FROM suspension_records
       WHERE member_id = $1 AND suspended_at < $2 AND voided_at IS NULL`;

/**
 * The member lock keys of a batch, distinct and ascending: the key the
 * workspace's record/link and the ban repository take (D9), so the three
 * writers serialise per member and two batches never deadlock.
 */
export const MEMBER_LOCK_KEYS_SQL = `SELECT DISTINCT hashtext('suspension:' || m) AS k
  FROM unnest($1::text[]) m ORDER BY k`;

/** insertMany's lock_timeout: the dashboard transactions' value. */
export const INSERT_MANY_LOCK_TIMEOUT_SQL = `SET LOCAL lock_timeout = '${DASHBOARD_LOCK_TIMEOUT_MS}ms'`;

/**
 * Whether member_bans exists where an unqualified name resolves: a database
 * whose dashboard never ran has no bans, and the command must still work.
 */
export const BANS_TABLE_PRESENT_SQL = `SELECT to_regclass('member_bans') IS NOT NULL AS present`;

/** The batch's members with an active (unlifted) ban; a lifted ban does not block. */
export const ACTIVE_BANNED_SQL = `SELECT DISTINCT member_id FROM member_bans
  WHERE lifted_at IS NULL AND member_id = ANY($1::text[]) ORDER BY member_id`;

/** A pool or a checked-out client: the SQL below runs the same on either. */
export type Queryable = Pick<pg.PoolClient, 'query'>;

/** The web dyno's suspension pool (PG_POOL_MAX unset). */
const DEFAULT_SUSPENSION_POOL_SIZE = 5;

/**
 * PG_POOL_MAX (an integer 1-10) when set, else 5. Only the backfill dyno
 * sets it (to 1); it must never be an app config var, or it would shrink the
 * web dyno's suspension and dashboard pools.
 */
export function suspensionPoolSize(
  env: Record<string, string | undefined> = process.env,
): number {
  const requested = Number(env.PG_POOL_MAX);
  return Number.isInteger(requested) && requested >= 1 && requested <= 10
    ? requested
    : DEFAULT_SUSPENSION_POOL_SIZE;
}

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

/** A record live or voided: the void columns are null while it is live. */
export interface SuspensionRecordState extends SuspensionRecord {
  voidedAt: Date | null;
  voidedBy: string | null;
  voidReason: string | null;
}

/** A suspension_records row as SELECT * reads it. */
export type SuspensionRecordRow = SuspensionRow;

export function toStateRecord(row: SuspensionRow): SuspensionRecordState {
  return {
    ...toRecord(row),
    voidedAt: row.voided_at,
    voidedBy: row.voided_by,
    voidReason: row.void_reason,
  };
}

/**
 * INSERT_SQL on `db`: the command's insert (the pool, or insertMany's
 * client) and the workspace's (its transaction's client) are one statement.
 * Undefined when a live record for the member and date already exists.
 */
export async function insertSuspensionInTx(
  db: Queryable,
  record: SuspensionInsert,
): Promise<SuspensionRecord | undefined> {
  const result = await db.query<SuspensionRow>(INSERT_SQL, [
    record.memberId,
    record.memberName,
    record.suspendedAt,
    record.durationDays,
    record.notes,
  ]);
  return result.rows[0] ? toRecord(result.rows[0]) : undefined;
}

/** VOID_SQL on `db`. Undefined when the id is unknown or already void. */
export async function voidSuspensionInTx(
  db: Queryable,
  id: number,
  voidedBy: string,
  reason: string,
): Promise<VoidedSuspensionRecord | undefined> {
  const result = await db.query<SuspensionRow>(VOID_SQL, [
    id,
    voidedBy,
    reason,
  ]);
  return result.rows[0] ? toVoidedRecord(result.rows[0]) : undefined;
}

/** COUNT_BEFORE_SQL on `db`: live records strictly before `before`. */
export async function countSuspensionsBeforeInTx(
  db: Queryable,
  memberId: string,
  before: Date,
): Promise<number> {
  const result = await db.query<{ count: string }>(COUNT_BEFORE_SQL, [
    memberId,
    before,
  ]);
  return Number(result.rows[0].count);
}

const MAX_RECORD_ID = 2 ** 31 - 1;
const MAX_IDS = 50;

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
      max: suspensionPoolSize(),
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
      repo.schemaEnsured = ensureSuspensionSchema(repo.pool);
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
    return insertSuspensionInTx(this.pool, record);
  }

  /**
   * Takes every member's lock (sorted keys), then reads active bans, so a
   * ban committed while this waited is seen; a banned member's rows are
   * refused and the rest of the batch is inserted (Hai, 2026-10-22).
   */
  async insertMany(records: SuspensionInsert[]): Promise<InsertManyResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // A member lock held too long fails the import instead of queueing it.
      await client.query(INSERT_MANY_LOCK_TIMEOUT_SQL);
      const memberIds = [...new Set(records.map((r) => r.memberId))];
      const keys = await client.query<{ k: number }>(MEMBER_LOCK_KEYS_SQL, [
        memberIds,
      ]);
      for (const { k } of keys.rows) {
        // Sequential on one client, in key order.
        // eslint-disable-next-line no-await-in-loop
        await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
          MEMBER_LOCK_CLASS,
          k,
        ]);
      }
      const present = await client.query<{ present: boolean }>(
        BANS_TABLE_PRESENT_SQL,
      );
      const banned =
        present.rows[0]?.present === true
          ? (
              await client.query<{ member_id: string }>(ACTIVE_BANNED_SQL, [
                memberIds,
              ])
            ).rows.map((r) => r.member_id)
          : [];
      const refused = new Set(banned);
      const inserted: SuspensionRecord[] = [];
      for (const record of records) {
        if (refused.has(record.memberId)) {
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const row = await insertSuspensionInTx(client, record);
        if (row) {
          inserted.push(row);
        }
      }
      await client.query('COMMIT');
      return { inserted, banned };
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
    return countSuspensionsBeforeInTx(this.pool, memberId, before);
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
    return voidSuspensionInTx(this.pool, id, voidedBy, reason);
  }

  /**
   * Records by id, voided ones included, oldest id first: the workspace
   * shows a record voided with /meetup_void_suspension. Ids that are not
   * 1..2^31-1 are dropped; none left runs no query; more than 50 is refused.
   */
  async listByIds(ids: number[]): Promise<SuspensionRecordState[]> {
    const usable = [...new Set(ids)].filter(
      (id) => Number.isSafeInteger(id) && id >= 1 && id <= MAX_RECORD_ID,
    );
    if (usable.length > MAX_IDS) {
      throw new RangeError(`listByIds takes at most ${MAX_IDS} ids`);
    }
    if (usable.length === 0) {
      return [];
    }
    const result = await this.pool.query<SuspensionRow>(
      'SELECT * FROM suspension_records WHERE id = ANY($1::int[]) ORDER BY id',
      [usable],
    );
    return result.rows.map(toStateRecord);
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
   * Live (unvoided) records per UTC month of suspended_at, from `from` on,
   * oldest first; months with none are absent. suspended_at is UTC midnight
   * of a calendar date, so the UTC month is the date's month. At most one
   * row per month (trends asks for 240 months at most).
   */
  async countByMonth(from: Date): Promise<{ month: string; count: number }[]> {
    if (!(from instanceof Date) || Number.isNaN(from.getTime())) {
      throw new RangeError('from must be a valid Date');
    }
    const result = await this.pool.query<{ month: string; count: number }>(
      `SELECT to_char(date_trunc('month', suspended_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS month,
              count(*)::int AS count
         FROM suspension_records
        WHERE voided_at IS NULL AND suspended_at >= $1
        GROUP BY 1 ORDER BY 1`,
      [from],
    );
    return result.rows.map((row) => ({ month: row.month, count: row.count }));
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
