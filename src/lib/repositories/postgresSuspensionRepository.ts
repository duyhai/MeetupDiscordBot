import pg from 'pg';
import { Logger } from 'tslog';

import { recommendedSuspensionDays } from '../helpers/noShowReport.js';
import { linkWindow } from '../workspace/months.js';
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
 * The one-time backfill of date_estimated (see SCHEMA_SQL). The spreadsheet
 * import of 2026-11-18 recorded 134 suspensions; 68 of them had no date in
 * the tracker and were all given 2026-09-30. Those are exactly the rows
 * with that date, created by that import, whose notes carry its provenance
 * line ("Imported from the <date> no-show tracker"). The notes text is read
 * here only, never by a query at page time.
 */
export const UNDATED_IMPORT_BACKFILL_SQL = `UPDATE suspension_records
       SET date_estimated = true
     WHERE suspended_at = TIMESTAMPTZ '2026-09-30T00:00:00Z'
       AND created_at >= TIMESTAMPTZ '2026-11-18T00:00:00Z'
       AND created_at <  TIMESTAMPTZ '2026-11-19T08:00:00Z'
       AND notes LIKE 'Imported from the % no-show tracker%'`;

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
  -- date_estimated: suspended_at is a placeholder because the real date is
  -- not known. The backfill runs only in the transaction that adds the
  -- column, so it happens once and never re-flags a record staff have fixed.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'suspension_records'
         AND column_name = 'date_estimated') THEN
    ALTER TABLE suspension_records
      ADD COLUMN date_estimated BOOLEAN NOT NULL DEFAULT false;
    ${UNDATED_IMPORT_BACKFILL_SQL};
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
  IF to_regclass(quote_ident(current_schema()) || '.suspension_date_edits') IS NULL THEN
    CREATE TABLE IF NOT EXISTS suspension_date_edits (
      id                SERIAL PRIMARY KEY,
      record_id         INTEGER NOT NULL REFERENCES suspension_records (id),
      old_suspended_at  TIMESTAMPTZ NOT NULL,
      new_suspended_at  TIMESTAMPTZ NOT NULL,
      old_duration_days INTEGER NOT NULL,
      new_duration_days INTEGER NOT NULL,
      edited_by         TEXT NOT NULL,
      edited_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  END IF;
  IF to_regclass(quote_ident(current_schema()) || '.suspension_date_edits_record_id_idx') IS NULL THEN
    CREATE INDEX IF NOT EXISTS suspension_date_edits_record_id_idx
      ON suspension_date_edits (record_id);
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

/** One date fix on a record (editDate): what it was, what it became, who and when. */
export interface SuspensionDateEdit {
  recordId: number;
  /** YYYY-MM-DD, the stored dates' UTC day. */
  oldDay: string;
  newDay: string;
  oldDurationDays: number;
  newDurationDays: number;
  /** Discord user id. */
  editedBy: string;
  editedAt: Date;
}

/** editDate's answer. */
export type EditDateOutcome =
  | { ok: true; before: SuspensionRecord; after: SuspensionRecord }
  | {
      ok: false;
      /**
       * Unknown or voided; the same day; another live record has that day;
       * the new days overlap another live record; the move would pass
       * another live record (changing the order the lengths count by); the
       * record backs a workspace card and the date leaves that card's month.
       */
      reason:
        | 'not-live'
        | 'unchanged'
        | 'date-taken'
        | 'overlaps'
        | 'reorders'
        | 'linked-month';
    };

/** The dashboard's three tabs: the command's active/past split of live rows, plus voided rows. */
export type SuspensionState = 'active' | 'past' | 'voided';

/** One row of the dashboard's suspension records page. */
export interface SuspensionPageRow extends SuspensionRecord {
  /** The date is a placeholder: the real one was not recorded. Cleared by editDate. */
  dateEstimated: boolean;
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
  date_estimated: boolean;
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
      dateEstimated: row.date_estimated === true,
      lastDay: row.last_day,
      voidedAt: row.voided_at,
      voidedBy: row.voided_by,
      voidReason: row.void_reason,
      linkedName: linked.get(row.member_id)?.name ?? null,
      linkedDiscordId: linked.get(row.member_id)?.discordId ?? null,
    }));
  }

  /**
   * Moves a live record to `suspendedAt` (a UTC midnight) and recalculates
   * its length the way recording does: recommendedSuspensionDays of the
   * member's live records before the new date (itself excluded). Other
   * records keep their lengths. Under the member lock the workspace and
   * bans take, in one dashboard transaction; the edit is kept in
   * suspension_date_edits.
   */
  async editDate(input: {
    id: number;
    suspendedAt: Date;
    editedBy: string;
  }): Promise<EditDateOutcome> {
    const { id, suspendedAt, editedBy } = input;
    if (!Number.isSafeInteger(id) || id < 1 || id > MAX_RECORD_ID) {
      return { ok: false, reason: 'not-live' };
    }
    return inDashboardTransaction(
      this.pool,
      'suspension date edit',
      async (client) => {
        const found = await client.query<{ member_id: string }>(
          'SELECT member_id FROM suspension_records WHERE id = $1 AND voided_at IS NULL',
          [id],
        );
        const memberId = found.rows[0]?.member_id;
        if (memberId === undefined) {
          return { ok: false, reason: 'not-live' } as const;
        }
        await client.query(
          `SELECT pg_advisory_xact_lock($1, hashtext('suspension:' || $2::text))`,
          [MEMBER_LOCK_CLASS, memberId],
        );
        // Read again under the lock: voided or moved meanwhile.
        const locked = await client.query<SuspensionRow>(
          'SELECT * FROM suspension_records WHERE id = $1 AND voided_at IS NULL FOR UPDATE',
          [id],
        );
        const row = locked.rows[0];
        if (!row) {
          return { ok: false, reason: 'not-live' } as const;
        }
        if (row.suspended_at.getTime() === suspendedAt.getTime()) {
          return { ok: false, reason: 'unchanged' } as const;
        }
        const taken = await client.query(
          `SELECT 1 FROM suspension_records
            WHERE member_id = $1 AND suspended_at = $2 AND voided_at IS NULL AND id <> $3`,
          [memberId, suspendedAt, id],
        );
        if (taken.rowCount) {
          return { ok: false, reason: 'date-taken' } as const;
        }
        // No other live record may start between the old and new dates:
        // a move past one would change which records count as earlier, and
        // so other records' lengths. Void and re-record for that.
        const [low, high] =
          row.suspended_at < suspendedAt
            ? [row.suspended_at, suspendedAt]
            : [suspendedAt, row.suspended_at];
        const crossing = await client.query(
          `SELECT 1 FROM suspension_records
            WHERE member_id = $1 AND voided_at IS NULL AND id <> $2
              AND suspended_at > $3 AND suspended_at < $4 LIMIT 1`,
          [memberId, id, low, high],
        );
        if (crossing.rowCount) {
          return { ok: false, reason: 'reorders' } as const;
        }
        const prior = await client.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM suspension_records
            WHERE member_id = $1 AND suspended_at < $2 AND voided_at IS NULL AND id <> $3`,
          [memberId, suspendedAt, id],
        );
        const durationDays = recommendedSuspensionDays(
          Number(prior.rows[0].count),
        );
        // As recording: never two live suspensions over the same day.
        const overlapping = await client.query(
          `SELECT 1 FROM suspension_records s
            WHERE s.member_id = $1 AND s.voided_at IS NULL AND s.id <> $4
              AND (s.suspended_at AT TIME ZONE 'UTC')::date
                  <= ($2::timestamptz AT TIME ZONE 'UTC')::date + $3::int - 1
              AND (s.suspended_at AT TIME ZONE 'UTC')::date + s.duration_days - 1
                  >= ($2::timestamptz AT TIME ZONE 'UTC')::date
            LIMIT 1`,
          [memberId, suspendedAt, durationDays, id],
        );
        if (overlapping.rowCount) {
          return { ok: false, reason: 'overlaps' } as const;
        }
        // A record a workspace card links stays inside that card's link
        // window, as recording and linking require.
        const workspace = await client.query<{ present: boolean }>(
          `SELECT to_regclass('noshow_workspace_rows') IS NOT NULL AS present`,
        );
        if (workspace.rows[0]?.present === true) {
          const card = await client.query<{ period_key: string }>(
            `SELECT to_char(period, 'YYYY-MM') AS period_key
               FROM noshow_workspace_rows WHERE suspension_record_id = $1 LIMIT 1`,
            [id],
          );
          const key = card.rows[0]?.period_key;
          if (key !== undefined) {
            const [year, month] = key.split('-').map(Number);
            const window = linkWindow({ year, month });
            if (suspendedAt < window.from || suspendedAt >= window.until) {
              return { ok: false, reason: 'linked-month' } as const;
            }
          }
        }
        const updated = await client.query<SuspensionRow>(
          // The date is now one a person chose: no longer a placeholder.
          `UPDATE suspension_records
              SET suspended_at = $2, duration_days = $3, date_estimated = false
            WHERE id = $1 RETURNING *`,
          [id, suspendedAt, durationDays],
        );
        await client.query(
          `INSERT INTO suspension_date_edits
             (record_id, old_suspended_at, new_suspended_at, old_duration_days, new_duration_days, edited_by)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            id,
            row.suspended_at,
            suspendedAt,
            row.duration_days,
            durationDays,
            editedBy,
          ],
        );
        return {
          ok: true,
          before: toRecord(row),
          after: toRecord(updated.rows[0]),
        } as const;
      },
    );
  }

  /**
   * The date fixes on these records, newest first, keyed by record id.
   * Ids outside 1..2^31-1 are dropped; at most 50.
   */
  async listDateEdits(
    ids: number[],
  ): Promise<Map<number, SuspensionDateEdit[]>> {
    const usable = [...new Set(ids)].filter(
      (id) => Number.isSafeInteger(id) && id >= 1 && id <= MAX_RECORD_ID,
    );
    if (usable.length > MAX_IDS) {
      throw new RangeError(`listDateEdits takes at most ${MAX_IDS} ids`);
    }
    const out = new Map<number, SuspensionDateEdit[]>();
    if (usable.length === 0) {
      return out;
    }
    const result = await this.pool.query<{
      record_id: number;
      old_day: string;
      new_day: string;
      old_duration_days: number;
      new_duration_days: number;
      edited_by: string;
      edited_at: Date;
    }>(
      `SELECT record_id,
              to_char(old_suspended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS old_day,
              to_char(new_suspended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS new_day,
              old_duration_days, new_duration_days, edited_by, edited_at
         FROM suspension_date_edits
        WHERE record_id = ANY($1::int[])
        ORDER BY edited_at DESC, id DESC`,
      [usable],
    );
    for (const r of result.rows) {
      const list = out.get(r.record_id) ?? [];
      list.push({
        recordId: r.record_id,
        oldDay: r.old_day,
        newDay: r.new_day,
        oldDurationDays: r.old_duration_days,
        newDurationDays: r.new_duration_days,
        editedBy: r.edited_by,
        editedAt: r.edited_at,
      });
      out.set(r.record_id, list);
    }
    return out;
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
   * row per month (trends asks for 240 months at most). Records whose date
   * is a placeholder (date_estimated) belong to no month and are left out;
   * countUndated counts them.
   */
  async countByMonth(from: Date): Promise<{ month: string; count: number }[]> {
    if (!(from instanceof Date) || Number.isNaN(from.getTime())) {
      throw new RangeError('from must be a valid Date');
    }
    const result = await this.pool.query<{ month: string; count: number }>(
      `SELECT to_char(date_trunc('month', suspended_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS month,
              count(*)::int AS count
         FROM suspension_records
        WHERE voided_at IS NULL AND NOT date_estimated AND suspended_at >= $1
        GROUP BY 1 ORDER BY 1`,
      [from],
    );
    return result.rows.map((row) => ({ month: row.month, count: row.count }));
  }

  /** Live (unvoided) records whose date is a placeholder: the ones countByMonth leaves out. */
  async countUndated(): Promise<number> {
    const result = await this.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM suspension_records
        WHERE voided_at IS NULL AND date_estimated`,
    );
    return result.rows[0].count;
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
    await this.pool.query('DELETE FROM suspension_date_edits');
    await this.pool.query('DELETE FROM suspension_records');
  }
}
