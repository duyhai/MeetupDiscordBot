import pg from 'pg';

import {
  BAN_FILL_MAX_PER_RUN,
  BAN_LIFT_REASON_MAX,
  BAN_NAME_MAX,
  BAN_NOTES_MAX,
  BAN_PHOTO_MAX_BYTES,
  BanImportOutcome,
  BanInsert,
  BanPhotoSource,
  BanRecordOutcome,
  BanRow,
  BanState,
} from '../bans/types.js';
import {
  DASHBOARD_LOCK_CLASS,
  dashboardPool,
  DashboardTransactionOptions,
  inDashboardTransaction,
  MEMBER_LOCK_CLASS,
  SCHEMA_LOCK_KEY,
} from './dashboardPool.js';

const DISCORD_ID = `'^[0-9]{17,20}$'`;

/**
 * Idempotent; runs under the dashboard schema lock. A boot on an existing
 * schema only reads the catalog: CREATE TABLE IF NOT EXISTS returns before
 * locking anything, but CREATE INDEX IF NOT EXISTS takes a ShareLock on the
 * table (blocking writes) before it notices the index exists, so the index
 * sits behind a to_regclass check scoped to current_schema().
 *
 * One active (unlifted) ban per member. A lifted row keeps its photo, so the
 * person can still be recognised.
 */
export const BAN_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS member_bans (
  id               SERIAL PRIMARY KEY,
  member_id        TEXT NOT NULL CHECK (member_id ~ '^[1-9][0-9]{0,19}$'),
  member_name      TEXT NOT NULL DEFAULT '' CHECK (length(member_name) <= ${BAN_NAME_MAX}),
  banned_on        DATE,
  notes            TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= ${BAN_NOTES_MAX}),
  recorded_by      TEXT NOT NULL CHECK (recorded_by ~ ${DISCORD_ID}),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  photo            BYTEA CHECK (photo IS NULL OR octet_length(photo) BETWEEN 1 AND ${BAN_PHOTO_MAX_BYTES}),
  photo_source     TEXT CHECK (photo_source IN ('upload', 'profile')),
  photo_updated_at TIMESTAMPTZ,
  photo_updated_by TEXT CHECK (photo_updated_by IS NULL OR photo_updated_by ~ ${DISCORD_ID}),
  lifted_at        TIMESTAMPTZ,
  lifted_by        TEXT CHECK (lifted_by IS NULL OR lifted_by ~ ${DISCORD_ID}),
  lift_reason      TEXT CHECK (length(lift_reason) BETWEEN 1 AND ${BAN_LIFT_REASON_MAX}),
  CHECK ((photo IS NULL) = (photo_source IS NULL)
     AND (photo IS NULL) = (photo_updated_at IS NULL)),
  CHECK (photo_source IS DISTINCT FROM 'upload' OR photo_updated_by IS NOT NULL),
  CHECK (photo_source IS DISTINCT FROM 'profile' OR photo_updated_by IS NULL),
  CHECK ((lifted_at IS NULL) = (lifted_by IS NULL)
     AND (lifted_at IS NULL) = (lift_reason IS NULL))
);
DO $do$
BEGIN
  IF to_regclass(quote_ident(current_schema()) || '.member_bans_active_member_idx') IS NULL THEN
    CREATE UNIQUE INDEX member_bans_active_member_idx
      ON member_bans (member_id) WHERE lifted_at IS NULL;
  END IF;
END
$do$;
`;

/**
 * BAN_SCHEMA_SQL in one dashboard transaction under the dashboard schema
 * advisory lock, with its lock_timeout.
 */
export async function ensureBanSchema(
  pool: pg.Pool,
  options: DashboardTransactionOptions = {},
): Promise<void> {
  await inDashboardTransaction(
    pool,
    'ban schema transaction',
    async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
        DASHBOARD_LOCK_CLASS,
        SCHEMA_LOCK_KEY,
      ]);
      await client.query(BAN_SCHEMA_SQL);
    },
    options,
  );
}

/**
 * Every column a read returns. The photo bytes are never among them: only
 * whether there is one. banned_on is read as text (node-pg would parse a
 * DATE at local midnight).
 */
function banColumns(table = ''): string {
  const t = table === '' ? '' : `${table}.`;
  return `${t}id, ${t}member_id, ${t}member_name,
  to_char(${t}banned_on, 'YYYY-MM-DD') AS banned_on, ${t}notes, ${t}recorded_by,
  ${t}created_at, ${t}photo IS NOT NULL AS has_photo, ${t}photo_source,
  ${t}photo_updated_at, ${t}photo_updated_by, ${t}lifted_at, ${t}lifted_by,
  ${t}lift_reason`;
}

const BAN_COLUMNS = banColumns();

/**
 * One new ban; a re-ban starts with the member's latest lifted photo (all
 * four photo columns, copied in SQL so the bytes never pass through Node).
 * Must name the partial index's predicate, or Postgres can't match it. No
 * row back means the member already has an active ban.
 */
const INSERT_BAN_SQL = `INSERT INTO member_bans
  (member_id, member_name, banned_on, notes, recorded_by,
   photo, photo_source, photo_updated_at, photo_updated_by)
SELECT $1::text, $2::text, $3::date, $4::text, $5::text,
       l.photo, l.photo_source, l.photo_updated_at, l.photo_updated_by
  FROM (SELECT 1) one
  LEFT JOIN LATERAL (
    SELECT p.photo, p.photo_source, p.photo_updated_at, p.photo_updated_by
      FROM member_bans p
     WHERE p.member_id = $1::text AND p.lifted_at IS NOT NULL AND p.photo IS NOT NULL
     ORDER BY p.lifted_at DESC, p.id DESC
     LIMIT 1
  ) l ON true
ON CONFLICT (member_id) WHERE lifted_at IS NULL DO NOTHING
RETURNING ${BAN_COLUMNS}`;

const LIFT_SQL = `UPDATE member_bans
   SET lifted_at = now(), lifted_by = $2, lift_reason = $3
 WHERE id = $1 AND lifted_at IS NULL
RETURNING ${BAN_COLUMNS}`;

/** A staff upload: active bans only; `had` says whether it replaced a photo. */
export const UPLOAD_PHOTO_SQL = `WITH old AS (
  SELECT id, photo IS NOT NULL AS had FROM member_bans
   WHERE id = $1 AND lifted_at IS NULL
   FOR UPDATE
)
UPDATE member_bans b
   SET photo = $2, photo_source = 'upload', photo_updated_at = now(),
       photo_updated_by = $3
  FROM old
 WHERE b.id = old.id
RETURNING ${banColumns('b')}, old.had`;

/**
 * The sweep's fill: only into an active ban with no photo, so it never
 * replaces one (re-checked after waiting on a concurrent upload's row lock).
 */
export const FILL_PHOTO_SQL = `UPDATE member_bans
   SET photo = $2, photo_source = 'profile', photo_updated_at = now(),
       photo_updated_by = NULL
 WHERE id = $1 AND photo IS NULL AND lifted_at IS NULL`;

const LIST_ORDER: Record<BanState, { where: string; order: string }> = {
  active: { where: 'lifted_at IS NULL', order: 'created_at DESC, id DESC' },
  lifted: { where: 'lifted_at IS NOT NULL', order: 'lifted_at DESC, id DESC' },
};

const MAX_PAGE_ROWS = 50;
const MAX_ACTIVE_LOOKUP = 1000;
const MAX_SERIAL = 2 ** 31 - 1;
/** 1-20 ASCII digits, no leading zero (PR review M4): `0123` is not member 123. */
const MEMBER_ID = /^[1-9][0-9]{0,19}$/;
const UTC_DAY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

const isState = (value: unknown): value is BanState =>
  value === 'active' || value === 'lifted';

const isSerialId = (id: number): boolean =>
  Number.isInteger(id) && id >= 1 && id <= MAX_SERIAL;

/** A whole, non-negative number: junk, negatives and infinities become `fallback`. */
function wholeCount(value: number, fallback: number): number {
  const n = Math.trunc(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

/** A row limit 1..max; 0 or junk is max. */
function rowLimit(value: number, max: number): number {
  const n = wholeCount(value, 0);
  return n === 0 ? max : Math.min(n, max);
}

interface BanDbRow {
  id: number;
  member_id: string;
  member_name: string;
  banned_on: string | null;
  notes: string;
  recorded_by: string;
  created_at: Date;
  has_photo: boolean;
  photo_source: BanPhotoSource | null;
  photo_updated_at: Date | null;
  photo_updated_by: string | null;
  lifted_at: Date | null;
  lifted_by: string | null;
  lift_reason: string | null;
}

function toBan(row: BanDbRow): BanRow {
  return {
    id: row.id,
    memberId: row.member_id,
    memberName: row.member_name,
    bannedOn: row.banned_on,
    notes: row.notes,
    recordedBy: row.recorded_by,
    createdAt: row.created_at,
    hasPhoto: row.has_photo,
    photoSource: row.photo_source,
    photoUpdatedAt: row.photo_updated_at,
    photoUpdatedBy: row.photo_updated_by,
    liftedAt: row.lifted_at,
    liftedBy: row.lifted_by,
    liftReason: row.lift_reason,
  };
}

/** A collision inside record/importMany: rolls the transaction back. */
class BanRefusal extends Error {
  constructor(readonly index: number) {
    super('ban refused');
    this.name = 'BanRefusal';
  }
}

/** member_bans on the dashboard pool. */
export class PostgresBanRepository {
  private static singleton: Promise<PostgresBanRepository> | undefined;

  constructor(
    private readonly pool: pg.Pool,
    private readonly options: DashboardTransactionOptions = {},
  ) {}

  static instance(): Promise<PostgresBanRepository> {
    if (this.singleton === undefined) {
      const pending = dashboardPool().then(async (pool) => {
        await ensureBanSchema(pool);
        return new PostgresBanRepository(pool);
      });
      this.singleton = pending;
      // A failed schema ensure is retried on the next call.
      pending.catch(() => {
        if (this.singleton === pending) {
          this.singleton = undefined;
        }
      });
    }
    return this.singleton;
  }

  async record(input: BanInsert): Promise<BanRecordOutcome> {
    try {
      const [ban] = await this.insertAll([input]);
      return { ok: true, ban };
    } catch (error) {
      if (error instanceof BanRefusal) {
        return { ok: false, reason: 'already-banned' };
      }
      throw error;
    }
  }

  /** All rows or none: one collision (with a stored ban or an earlier input) writes nothing. */
  async importMany(inputs: BanInsert[]): Promise<BanImportOutcome> {
    try {
      const rows = await this.insertAll(inputs);
      return { ok: true, count: rows.length };
    } catch (error) {
      if (error instanceof BanRefusal) {
        return { ok: false, reason: 'already-banned', index: error.index };
      }
      throw error;
    }
  }

  /**
   * One transaction. Takes each member's suspension lock first (the key
   * applyAction takes for record/link: hashtext('suspension:' || id)),
   * deduped and in ascending key order, so a ban and a suspension cannot
   * interleave and two imports cannot deadlock.
   */
  private insertAll(inputs: BanInsert[]): Promise<BanRow[]> {
    return inDashboardTransaction(
      this.pool,
      'ban insert transaction',
      async (client) => {
        // Lock keys distinct and ascending: two writers always take
        // shared keys in the same order, even when two members' keys
        // collide, so they can never deadlock.
        const keys = await client.query<{ k: number }>(
          `SELECT DISTINCT hashtext('suspension:' || m) AS k
             FROM unnest($1::text[]) m ORDER BY k`,
          [inputs.map((i) => i.memberId)],
        );
        for (const { k } of keys.rows) {
          // Sequential on one client, in key order.
          // eslint-disable-next-line no-await-in-loop
          await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
            MEMBER_LOCK_CLASS,
            k,
          ]);
        }
        const rows: BanRow[] = [];
        for (const [index, input] of inputs.entries()) {
          // eslint-disable-next-line no-await-in-loop
          const result = await client.query<BanDbRow>(INSERT_BAN_SQL, [
            input.memberId,
            input.memberName,
            input.bannedOn,
            input.notes,
            input.recordedBy,
          ]);
          if (result.rows.length === 0) {
            throw new BanRefusal(index);
          }
          rows.push(toBan(result.rows[0]));
        }
        return rows;
      },
      this.options,
    );
  }

  /** Undefined when the ban is unknown or already lifted. Photo columns stay. */
  async lift(
    id: number,
    liftedBy: string,
    reason: string,
  ): Promise<BanRow | undefined> {
    if (!isSerialId(id)) return undefined;
    const result = await this.pool.query<BanDbRow>(LIFT_SQL, [
      id,
      liftedBy,
      reason,
    ]);
    return result.rows[0] === undefined ? undefined : toBan(result.rows[0]);
  }

  /** Active bans only; undefined when the ban is unknown or lifted. */
  async setUploadedPhoto(
    id: number,
    photo: Buffer,
    by: string,
  ): Promise<{ ban: BanRow; replaced: boolean } | undefined> {
    if (!isSerialId(id)) return undefined;
    const result = await this.pool.query<BanDbRow & { had: boolean }>(
      UPLOAD_PHOTO_SQL,
      [id, photo, by],
    );
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : { ban: toBan(row), replaced: row.had };
  }

  /** True only when this call stored the photo (active, and none before). */
  async fillProfilePhoto(id: number, photo: Buffer): Promise<boolean> {
    if (!isSerialId(id)) return false;
    const result = await this.pool.query(FILL_PHOTO_SQL, [id, photo]);
    return result.rowCount === 1;
  }

  /**
   * Active bans with no photo, in an order fixed for `day` (the run's UTC
   * 'YYYY-MM-DD', from the caller's clock) that changes the next day: bans
   * with no usable photo source cannot hold the first places every run and
   * keep the rest from ever being reached.
   */
  async listPhotoFillCandidates(
    limit: number,
    day: string,
  ): Promise<{ id: number; memberId: string }[]> {
    if (typeof day !== 'string' || !UTC_DAY.test(day)) {
      throw new RangeError('bad fill day');
    }
    const result = await this.pool.query<{ id: number; member_id: string }>(
      `SELECT id, member_id FROM member_bans
        WHERE lifted_at IS NULL AND photo IS NULL
        ORDER BY hashtext(id::text || ':' || $2::text), id
        LIMIT least($1::int, ${BAN_FILL_MAX_PER_RUN})`,
      [rowLimit(limit, BAN_FILL_MAX_PER_RUN), day],
    );
    return result.rows.map((r) => ({ id: r.id, memberId: r.member_id }));
  }

  async listPage(options: {
    state: BanState;
    offset: number;
    limit: number;
  }): Promise<BanRow[]> {
    if (!isState(options.state)) {
      throw new RangeError('unknown ban state');
    }
    const { where, order } = LIST_ORDER[options.state];
    const result = await this.pool.query<BanDbRow>(
      `SELECT ${BAN_COLUMNS} FROM member_bans
        WHERE ${where}
        ORDER BY ${order}
        LIMIT $1 OFFSET $2`,
      [rowLimit(options.limit, MAX_PAGE_ROWS), wholeCount(options.offset, 0)],
    );
    return result.rows.map(toBan);
  }

  async countByState(): Promise<Record<BanState, number>> {
    const result = await this.pool.query<{ active: number; lifted: number }>(
      `SELECT count(*) FILTER (WHERE lifted_at IS NULL)::int AS active,
              count(*) FILTER (WHERE lifted_at IS NOT NULL)::int AS lifted
         FROM member_bans`,
    );
    const row = result.rows[0];
    return { active: row?.active ?? 0, lifted: row?.lifted ?? 0 };
  }

  /** One ban's photo bytes, or undefined (unknown id, no photo, or over the cap). */
  async getPhoto(id: number): Promise<Buffer | undefined> {
    if (!isSerialId(id)) return undefined;
    const result = await this.pool.query<{ photo: Buffer | null }>(
      `SELECT CASE WHEN octet_length(photo) <= ${BAN_PHOTO_MAX_BYTES} THEN photo END AS photo
         FROM member_bans WHERE id = $1`,
      [id],
    );
    return result.rows[0]?.photo ?? undefined;
  }

  /**
   * Which of these Meetup ids have an active ban. Only digit ids count; more
   * than 1000 distinct ones is a RangeError and none left runs no query.
   */
  async activeMemberIds(memberIds: string[]): Promise<Set<string>> {
    const ids = [...new Set(memberIds)].filter((id) => MEMBER_ID.test(id));
    if (ids.length > MAX_ACTIVE_LOOKUP) {
      throw new RangeError('too many member ids');
    }
    if (ids.length === 0) return new Set();
    const result = await this.pool.query<{ member_id: string }>(
      `SELECT member_id FROM member_bans
        WHERE lifted_at IS NULL AND member_id = ANY($1::text[])`,
      [ids],
    );
    return new Set(result.rows.map((r) => r.member_id));
  }

  async deleteAllForTest(): Promise<void> {
    await this.pool.query('DELETE FROM member_bans');
  }
}
