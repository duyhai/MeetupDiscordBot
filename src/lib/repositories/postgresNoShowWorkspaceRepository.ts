import pg from 'pg';

import {
  parsePeriodKey,
  Period,
  periodDate,
  periodKey,
} from '../reports/period.js';
import {
  Classification,
  MEMBER_NAME_MAX,
  NOTES_MAX,
  SyncCase,
  SyncOutcome,
  WorkspaceEvent,
  WorkspaceMonthState,
  WorkspaceRow,
  WorkspaceStatus,
} from '../workspace/types.js';
import {
  DASHBOARD_LOCK_CLASS,
  dashboardPool,
  DashboardTransactionOptions,
  inDashboardTransaction,
  SCHEMA_LOCK_KEY,
} from './dashboardPool.js';
import { PostgresSuspensionRepository } from './postgresSuspensionRepository.js';

const STATUS_LIST = `'new','warning_copied','warning_sent','on_hold','suspended','skipped','voided'`;
const ACTION_LIST = `'copy_warning','mark_sent','hold','skip','reopen','record_suspension','link_suspension',
  'void','edit_notes','sync_created','sync_reclassified','sync_dropped','sync_returned'`;

/**
 * The no-show workspace. Needs suspension_records (FK), so it is ensured by
 * ensureWorkspaceSchema after the suspension repository, never inside
 * DASHBOARD_SCHEMA_SQL (the backfill and the build job ensure that without
 * the suspension table). Idempotent; runs under the dashboard schema lock.
 *
 * A boot on an existing schema only reads the catalog: CREATE TABLE IF NOT
 * EXISTS returns before locking anything, but CREATE INDEX IF NOT EXISTS
 * takes a ShareLock on its table (blocking writes) before it notices the
 * index exists, and CREATE TRIGGER needs a table lock, so both are behind
 * catalog checks scoped to current_schema().
 */
export const WORKSPACE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS noshow_workspace_months (
  period            DATE PRIMARY KEY CHECK (EXTRACT(DAY FROM period) = 1),
  snapshot_id       INTEGER NOT NULL,
  snapshot_built_at TIMESTAMPTZ NOT NULL,
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS noshow_workspace_rows (
  id                   SERIAL PRIMARY KEY,
  period               DATE NOT NULL REFERENCES noshow_workspace_months(period),
  meetup_member_id     TEXT NOT NULL CHECK (meetup_member_id ~ '^[0-9]{1,20}$'),
  member_name          TEXT NOT NULL DEFAULT '' CHECK (length(member_name) <= ${MEMBER_NAME_MAX}),
  classification       TEXT NOT NULL CHECK (classification IN ('warning', 'suspension')),
  status               TEXT NOT NULL DEFAULT 'new' CHECK (status IN (${STATUS_LIST})),
  notes                TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= ${NOTES_MAX}),
  suspension_record_id INTEGER REFERENCES suspension_records(id),
  in_latest_snapshot   BOOLEAN NOT NULL DEFAULT true,
  version              INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by           TEXT CHECK (updated_by IS NULL OR updated_by = 'sync' OR updated_by ~ '^[0-9]{17,20}$'),
  UNIQUE (period, meetup_member_id),
  CHECK (status <> 'suspended' OR suspension_record_id IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS noshow_workspace_events (
  id                   BIGSERIAL PRIMARY KEY,
  row_id               INTEGER NOT NULL REFERENCES noshow_workspace_rows(id),
  actor                TEXT NOT NULL CHECK (actor = 'sync' OR actor ~ '^[0-9]{17,20}$'),
  action               TEXT NOT NULL CHECK (action IN (${ACTION_LIST})),
  old_status           TEXT NOT NULL CHECK (old_status IN (${STATUS_LIST})),
  new_status           TEXT NOT NULL CHECK (new_status IN (${STATUS_LIST})),
  note                 TEXT CHECK (note IS NULL OR length(note) <= ${NOTES_MAX}),
  suspension_record_id INTEGER,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
DO $do$
BEGIN
  -- One suspension record backs at most one workspace row.
  IF to_regclass(quote_ident(current_schema()) || '.noshow_workspace_rows_suspension_idx') IS NULL THEN
    CREATE UNIQUE INDEX noshow_workspace_rows_suspension_idx
      ON noshow_workspace_rows (suspension_record_id) WHERE suspension_record_id IS NOT NULL;
  END IF;
  IF to_regclass(quote_ident(current_schema()) || '.noshow_workspace_rows_member_idx') IS NULL THEN
    CREATE INDEX noshow_workspace_rows_member_idx ON noshow_workspace_rows (meetup_member_id);
  END IF;
  IF to_regclass(quote_ident(current_schema()) || '.noshow_workspace_events_row_idx') IS NULL THEN
    CREATE INDEX noshow_workspace_events_row_idx ON noshow_workspace_events (row_id, id);
  END IF;
  -- The audit trail is append-only: UPDATE and DELETE are refused (TRUNCATE,
  -- test-only, is not a row event).
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'noshow_workspace_events_append_only'
       AND p.pronamespace = current_schema()::regnamespace
  ) THEN
    CREATE FUNCTION noshow_workspace_events_append_only() RETURNS trigger
      LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'noshow_workspace_events is append-only'; END $fn$;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE t.tgname = 'noshow_workspace_events_append_only'
       AND c.relname = 'noshow_workspace_events'
       AND c.relnamespace = current_schema()::regnamespace
  ) THEN
    CREATE TRIGGER noshow_workspace_events_append_only
      BEFORE UPDATE OR DELETE ON noshow_workspace_events
      FOR EACH ROW EXECUTE FUNCTION noshow_workspace_events_append_only();
  END IF;
END
$do$;
`;

/**
 * suspension_records first (FK target; its own pool, its own ensure), then
 * ours under the dashboard schema lock.
 */
export async function ensureWorkspaceSchema(
  pool: pg.Pool,
  ensureSuspensions: () => Promise<unknown> = () =>
    PostgresSuspensionRepository.instance(),
): Promise<void> {
  await ensureSuspensions();
  await inDashboardTransaction(
    pool,
    'workspace schema transaction',
    async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
        DASHBOARD_LOCK_CLASS,
        SCHEMA_LOCK_KEY,
      ]);
      await client.query(WORKSPACE_SCHEMA_SQL);
    },
  );
}

export type WorkspaceRepositoryOptions = DashboardTransactionOptions;

const ROW_COLUMNS = `id, to_char(period, 'YYYY-MM') AS period_key, meetup_member_id, member_name, classification,
  status, notes, suspension_record_id, in_latest_snapshot, version, updated_at, updated_by`;

const MONTH_COLUMNS = `to_char(period, 'YYYY-MM') AS period_key, snapshot_id, snapshot_built_at, synced_at`;

const MAX_PAGE_ROWS = 50;
const MAX_MONTHS = 240;
const MAX_EVENTS_PER_ROW = 10;
const MAX_EVENT_ROWS = 50;
const MAX_COUNT_PERIODS = 24;
const MAX_ROW_ID = 2 ** 31 - 1;
const MEMBER_ID = /^[0-9]{1,20}$/;

interface RowRecord {
  id: number;
  period_key: string;
  meetup_member_id: string;
  member_name: string;
  classification: Classification;
  status: WorkspaceStatus;
  notes: string;
  suspension_record_id: number | null;
  in_latest_snapshot: boolean;
  version: number;
  updated_at: Date;
  updated_by: string | null;
}

interface MonthRecord {
  period_key: string;
  snapshot_id: number;
  snapshot_built_at: Date;
  synced_at: Date;
}

interface EventRecord {
  id: string;
  row_id: number;
  actor: string;
  action: string;
  old_status: WorkspaceStatus;
  new_status: WorkspaceStatus;
  note: string | null;
  suspension_record_id: number | null;
  created_at: Date;
}

/** A stored period the CHECK guarantees; anything else is a corrupt row. */
function periodFrom(key: string): Period {
  const period = parsePeriodKey(key);
  if (period === undefined) {
    throw new Error('Workspace row has an unreadable period');
  }
  return period;
}

function toRow(r: RowRecord): WorkspaceRow {
  return {
    id: r.id,
    period: periodFrom(r.period_key),
    memberId: r.meetup_member_id,
    memberName: r.member_name,
    classification: r.classification,
    status: r.status,
    notes: r.notes,
    suspensionRecordId: r.suspension_record_id,
    inLatestSnapshot: r.in_latest_snapshot,
    version: r.version,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

function toMonth(r: MonthRecord): WorkspaceMonthState {
  return {
    period: periodFrom(r.period_key),
    snapshotId: r.snapshot_id,
    snapshotBuiltAt: r.snapshot_built_at,
    syncedAt: r.synced_at,
  };
}

function toEvent(r: EventRecord): WorkspaceEvent {
  return {
    id: r.id,
    rowId: r.row_id,
    actor: r.actor,
    action: r.action,
    oldStatus: r.old_status,
    newStatus: r.new_status,
    note: r.note,
    suspensionRecordId: r.suspension_record_id,
    createdAt: r.created_at,
  };
}

/** `value` truncated into lo..hi; junk and infinities become `fallback`. */
function clampInt(
  value: number,
  lo: number,
  hi: number,
  fallback: number,
): number {
  const n = Math.trunc(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(hi, Math.max(lo, n));
}

const isRowId = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 1 && value <= MAX_ROW_ID;

/**
 * The month-by-month no-show workspace: one row per member per month,
 * synced from the stored no-show report, plus an append-only event trail.
 * Uses the dashboard pool; suspension SQL inside its transactions (Task 5)
 * runs on the same client.
 */
export class PostgresNoShowWorkspaceRepository {
  private static singleton:
    Promise<PostgresNoShowWorkspaceRepository> | undefined;

  constructor(
    private readonly pool: pg.Pool,
    private readonly options: WorkspaceRepositoryOptions = {},
  ) {}

  static instance(): Promise<PostgresNoShowWorkspaceRepository> {
    if (this.singleton === undefined) {
      const pending = dashboardPool().then(async (pool) => {
        await ensureWorkspaceSchema(pool);
        return new PostgresNoShowWorkspaceRepository(pool);
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

  /**
   * Brings the month's rows in line with one stored no-show build, in one
   * transaction. Never changes status, notes or suspension_record_id: edited
   * rows keep what staff did. 'current' when this build (id and built_at:
   * the open month is rebuilt in place) is already synced; 'older' when a
   * later build is.
   */
  async syncFromSnapshot(input: {
    period: Period;
    snapshotId: number;
    snapshotBuiltAt: Date;
    cases: SyncCase[];
  }): Promise<SyncOutcome> {
    const outcome: SyncOutcome = {
      status: 'synced',
      created: 0,
      reclassified: 0,
      dropped: 0,
      returned: 0,
    };
    const day = periodDate(input.period);
    return inDashboardTransaction(
      this.pool,
      'workspace sync',
      async (client) => {
        // One sync per month at a time, across dynos.
        await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
          DASHBOARD_LOCK_CLASS,
          `noshow_workspace:${periodKey(input.period)}`,
        ]);
        const state = await client.query<{
          snapshot_id: number;
          snapshot_built_at: Date;
        }>(
          'SELECT snapshot_id, snapshot_built_at FROM noshow_workspace_months WHERE period = $1::date',
          [day],
        );
        const stored = state.rows[0];
        if (
          stored &&
          stored.snapshot_id === input.snapshotId &&
          stored.snapshot_built_at.getTime() === input.snapshotBuiltAt.getTime()
        ) {
          return { ...outcome, status: 'current' };
        }
        if (
          stored &&
          stored.snapshot_built_at.getTime() > input.snapshotBuiltAt.getTime()
        ) {
          // Never regress to an older build.
          return { ...outcome, status: 'older' };
        }
        await client.query(
          `INSERT INTO noshow_workspace_months (period, snapshot_id, snapshot_built_at)
           VALUES ($1::date, $2, $3)
           ON CONFLICT (period) DO UPDATE SET snapshot_id = EXCLUDED.snapshot_id,
             snapshot_built_at = EXCLUDED.snapshot_built_at, synced_at = now()`,
          [day, input.snapshotId, input.snapshotBuiltAt],
        );
        const existing = await client.query<RowRecord>(
          `SELECT ${ROW_COLUMNS} FROM noshow_workspace_rows WHERE period = $1::date FOR UPDATE`,
          [day],
        );
        const byMember = new Map(
          existing.rows.map((r) => [r.meetup_member_id, r]),
        );
        const event = (
          rowId: number,
          action: string,
          status: string,
          note: string | null,
        ) =>
          client.query(
            `INSERT INTO noshow_workspace_events (row_id, actor, action, old_status, new_status, note)
             VALUES ($1, 'sync', $2, $3, $3, $4)`,
            [rowId, action, status, note],
          );
        for (const c of input.cases) {
          const row = byMember.get(c.memberId);
          byMember.delete(c.memberId);
          if (row === undefined) {
            // eslint-disable-next-line no-await-in-loop -- one month's cases, in one transaction
            const inserted = await client.query<{ id: number }>(
              `INSERT INTO noshow_workspace_rows (period, meetup_member_id, member_name, classification, updated_by)
               VALUES ($1::date, $2, $3, $4, 'sync') RETURNING id`,
              [day, c.memberId, c.memberName, c.classification],
            );
            // eslint-disable-next-line no-await-in-loop -- as above
            await event(inserted.rows[0].id, 'sync_created', 'new', null);
            outcome.created += 1;
            continue;
          }
          const reclassified = row.classification !== c.classification;
          const returned = !row.in_latest_snapshot;
          if (!reclassified && !returned) {
            if (row.member_name !== c.memberName) {
              // A renamed member: cosmetic, so no version bump and no event.
              // eslint-disable-next-line no-await-in-loop -- as above
              await client.query(
                'UPDATE noshow_workspace_rows SET member_name = $2 WHERE id = $1',
                [row.id, c.memberName],
              );
            }
            continue;
          }
          // eslint-disable-next-line no-await-in-loop -- as above
          await client.query(
            `UPDATE noshow_workspace_rows SET member_name = $2, classification = $3, in_latest_snapshot = true,
               version = version + 1, updated_at = now(), updated_by = 'sync' WHERE id = $1`,
            [row.id, c.memberName, c.classification],
          );
          if (reclassified) {
            // eslint-disable-next-line no-await-in-loop -- as above
            await event(
              row.id,
              'sync_reclassified',
              row.status,
              `${row.classification} → ${c.classification}`,
            );
            outcome.reclassified += 1;
          }
          if (returned) {
            // eslint-disable-next-line no-await-in-loop -- as above
            await event(row.id, 'sync_returned', row.status, null);
            outcome.returned += 1;
          }
        }
        const dropped = [...byMember.values()].filter(
          (r) => r.in_latest_snapshot,
        );
        if (dropped.length > 0) {
          await client.query(
            `UPDATE noshow_workspace_rows SET in_latest_snapshot = false, version = version + 1,
               updated_at = now(), updated_by = 'sync' WHERE id = ANY($1::int[])`,
            [dropped.map((r) => r.id)],
          );
          for (const r of dropped) {
            // eslint-disable-next-line no-await-in-loop -- as above
            await event(r.id, 'sync_dropped', r.status, null);
          }
          outcome.dropped = dropped.length;
        }
        return outcome;
      },
      this.options,
    );
  }

  async monthState(period: Period): Promise<WorkspaceMonthState | undefined> {
    const result = await this.pool.query<MonthRecord>(
      `SELECT ${MONTH_COLUMNS} FROM noshow_workspace_months WHERE period = $1::date`,
      [periodDate(period)],
    );
    return result.rows[0] === undefined ? undefined : toMonth(result.rows[0]);
  }

  /** Synced months, newest first. */
  async listMonths(): Promise<WorkspaceMonthState[]> {
    const result = await this.pool.query<MonthRecord>(
      `SELECT ${MONTH_COLUMNS} FROM noshow_workspace_months ORDER BY period DESC LIMIT ${MAX_MONTHS}`,
    );
    return result.rows.map(toMonth);
  }

  /** One page (at most 50): in-report rows first, suspension candidates first, then by name. */
  async listRows(
    period: Period,
    page: { offset: number; limit: number },
  ): Promise<WorkspaceRow[]> {
    const limit = clampInt(page.limit, 1, MAX_PAGE_ROWS, MAX_PAGE_ROWS);
    const offset = clampInt(page.offset, 0, Number.MAX_SAFE_INTEGER, 0);
    const result = await this.pool.query<RowRecord>(
      `SELECT ${ROW_COLUMNS} FROM noshow_workspace_rows WHERE period = $1::date
        ORDER BY in_latest_snapshot DESC, (classification = 'suspension') DESC, lower(member_name), id
        LIMIT $2 OFFSET $3`,
      [periodDate(period), limit, offset],
    );
    return result.rows.map(toRow);
  }

  async countRows(
    period: Period,
  ): Promise<{ total: number; inLatest: number }> {
    const result = await this.pool.query<{ total: number; in_latest: number }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE in_latest_snapshot)::int AS in_latest
         FROM noshow_workspace_rows WHERE period = $1::date`,
      [periodDate(period)],
    );
    return {
      total: result.rows[0].total,
      inLatest: result.rows[0].in_latest,
    };
  }

  /** The row, only if it belongs to `period`; a junk id runs no query. */
  async getRow(
    period: Period,
    rowId: number,
  ): Promise<WorkspaceRow | undefined> {
    if (!isRowId(rowId)) {
      return undefined;
    }
    const result = await this.pool.query<RowRecord>(
      `SELECT ${ROW_COLUMNS} FROM noshow_workspace_rows WHERE id = $1 AND period = $2::date`,
      [rowId, periodDate(period)],
    );
    return result.rows[0] === undefined ? undefined : toRow(result.rows[0]);
  }

  /** Each row's latest events (newest first, 1..10 per row) for at most 50 rows. */
  async listRecentEvents(
    rowIds: number[],
    perRow = MAX_EVENTS_PER_ROW,
  ): Promise<Map<number, WorkspaceEvent[]>> {
    const ids = [...new Set(rowIds)].filter(isRowId);
    const byRow = new Map<number, WorkspaceEvent[]>();
    if (ids.length === 0) {
      return byRow;
    }
    if (ids.length > MAX_EVENT_ROWS) {
      throw new RangeError(
        `listRecentEvents takes at most ${MAX_EVENT_ROWS} rows`,
      );
    }
    const limit = clampInt(perRow, 1, MAX_EVENTS_PER_ROW, MAX_EVENTS_PER_ROW);
    const result = await this.pool.query<EventRecord>(
      // ORDER BY t.id, the bigint: a bare `id` would name the text output
      // column and sort '9' after '10'.
      `SELECT t.id::text AS id, row_id, actor, action, old_status, new_status, note, suspension_record_id, created_at
         FROM (
           SELECT e.*, row_number() OVER (PARTITION BY row_id ORDER BY id DESC) AS rn
             FROM noshow_workspace_events e WHERE row_id = ANY($1::int[])
         ) t
        WHERE rn <= $2 ORDER BY t.row_id, t.id DESC`,
      [ids, limit],
    );
    for (const record of result.rows) {
      const list = byRow.get(record.row_id) ?? [];
      list.push(toEvent(record));
      byRow.set(record.row_id, list);
    }
    return byRow;
  }

  /** Status counts per 'YYYY-MM' (at most 24 months), in-report rows only. */
  async statusCounts(
    periods: Period[],
  ): Promise<Map<string, Partial<Record<WorkspaceStatus, number>>>> {
    const counts = new Map<string, Partial<Record<WorkspaceStatus, number>>>();
    if (periods.length === 0) {
      return counts;
    }
    if (periods.length > MAX_COUNT_PERIODS) {
      throw new RangeError(
        `statusCounts takes at most ${MAX_COUNT_PERIODS} months`,
      );
    }
    const result = await this.pool.query<{
      period_key: string;
      status: WorkspaceStatus;
      count: number;
    }>(
      `SELECT to_char(period, 'YYYY-MM') AS period_key, status, count(*)::int AS count
         FROM noshow_workspace_rows
        WHERE period = ANY($1::date[]) AND in_latest_snapshot
        GROUP BY 1, 2`,
      [periods.map(periodDate)],
    );
    for (const r of result.rows) {
      const month = counts.get(r.period_key) ?? {};
      month[r.status] = r.count;
      counts.set(r.period_key, month);
    }
    return counts;
  }

  /** The month's status per Meetup member id. */
  async statusesByMember(
    period: Period,
  ): Promise<Map<string, WorkspaceStatus>> {
    const result = await this.pool.query<{
      meetup_member_id: string;
      status: WorkspaceStatus;
    }>(
      'SELECT meetup_member_id, status FROM noshow_workspace_rows WHERE period = $1::date',
      [periodDate(period)],
    );
    return new Map(result.rows.map((r) => [r.meetup_member_id, r.status]));
  }

  /** The member's status per 'YYYY-MM', newest first; a non-digit id runs no query. */
  async statusesForMember(
    memberId: string,
  ): Promise<Map<string, WorkspaceStatus>> {
    if (typeof memberId !== 'string' || !MEMBER_ID.test(memberId)) {
      return new Map();
    }
    const result = await this.pool.query<{
      period_key: string;
      status: WorkspaceStatus;
    }>(
      `SELECT to_char(period, 'YYYY-MM') AS period_key, status FROM noshow_workspace_rows
        WHERE meetup_member_id = $1 ORDER BY period DESC LIMIT ${MAX_MONTHS}`,
      [memberId],
    );
    return new Map(result.rows.map((r) => [r.period_key, r.status]));
  }
}
