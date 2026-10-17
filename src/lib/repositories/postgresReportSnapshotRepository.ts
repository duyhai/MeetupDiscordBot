import pg from 'pg';

import {
  parsePeriodKey,
  Period,
  periodDate,
  periodKey,
} from '../reports/period.js';
import {
  AttendanceEvidence,
  HallOfFamePayload,
  NoShowCasePayload,
  NoShowPayload,
  ReportType,
} from '../reports/types.js';
import {
  DASHBOARD_LOCK_CLASS,
  dashboardPool,
  DashboardTransactionOptions,
  inDashboardTransaction,
} from './dashboardPool.js';

/**
 * 'update-open': the open month's daily build overwrites its current row.
 * 'supersede': a finished month's rebuild adds a row and keeps the old one.
 */
export type SaveMode = 'update-open' | 'supersede';

export interface SnapshotWrite {
  reportType: ReportType;
  period: Period;
  builtAt: Date;
  /** 'job', 'backfill' or a Discord user id (digits). */
  builtBy: string;
  sourceComplete: boolean;
  payload: HallOfFamePayload | NoShowPayload;
  mode: SaveMode;
}

export interface SnapshotMeta {
  id: number;
  reportType: ReportType;
  period: Period;
  builtAt: Date;
  builtBy: string;
  sourceComplete: boolean;
  /** payload->'summary' */
  summary: unknown;
  /** payload->'attendance': the no-show evidence; null for Hall of Fame rows. */
  attendance?: AttendanceEvidence | null;
}

export interface Snapshot extends SnapshotMeta {
  payload: unknown;
}

/** One month whose current no-show snapshot mentions a member. */
export interface MemberNoShowMonth {
  period: Period;
  builtAt: Date;
  asOf: string;
  /** The member's case that month, or null when they were only cleared or departed. */
  noShowCase: NoShowCasePayload | null;
  cleared: boolean;
  departed: boolean;
}

const BUILT_BY = /^(job|backfill|[0-9]{1,20})$/;
const DEFAULT_PAGE = 50;
const HISTORY_LIMIT = 100;
const MEMBER_ID = /^[0-9]{1,20}$/;
const MAX_OFFSET = 10_000 * DEFAULT_PAGE;
export const SERIES_DEFAULT_MONTHS = 24;
export const SERIES_MAX_MONTHS = 240;

const META_COLUMNS = `id, report_type, to_char(period, 'YYYY-MM') AS period_key, built_at, built_by,
  source_complete, payload->'summary' AS summary, payload->'attendance' AS attendance`;

/**
 * Months whose current no-show snapshot mentions member $1 as a case ($2),
 * cleared ($3) or departed ($4), newest first; $5 limit, $6 offset. Only the
 * member's own case leaves the database. report_type and superseded_by are
 * literals, not parameters, so the partial GIN index
 * (report_snapshots_noshow_payload_idx) can apply; `payload @>` is on the
 * column itself, which that index serves.
 */
export const MEMBER_MONTHS_SQL = `SELECT to_char(period, 'YYYY-MM') AS period_key, built_at, payload->>'asOf' AS as_of,
    (SELECT c FROM jsonb_array_elements(payload->'cases') c
      WHERE c->'member'->>'id' = $1 LIMIT 1) AS no_show_case,
    EXISTS (SELECT 1 FROM jsonb_array_elements(payload->'cleared') c
             WHERE c->'member'->>'id' = $1) AS cleared,
    EXISTS (SELECT 1 FROM jsonb_array_elements(payload->'departed') d
             WHERE d->>'id' = $1) AS departed
  FROM report_snapshots
  WHERE report_type = 'no_show' AND superseded_by IS NULL
    AND (payload @> $2::jsonb OR payload @> $3::jsonb OR payload @> $4::jsonb)
  ORDER BY period DESC LIMIT $5 OFFSET $6`;

interface MemberMonthRow {
  period_key: string;
  built_at: Date;
  as_of: string;
  no_show_case: unknown;
  cleared: boolean;
  departed: boolean;
}

interface SnapshotRow {
  id: number;
  report_type: ReportType;
  period_key: string;
  built_at: Date;
  built_by: string;
  source_complete: boolean;
  summary: unknown;
  attendance?: unknown;
  payload?: unknown;
  superseded_by?: number | null;
}

function parsedPeriod(key: string, id?: number): Period {
  const period = parsePeriodKey(key);
  if (period === undefined) {
    const row = id === undefined ? 'row' : `row ${id}`;
    throw new Error(`report_snapshots ${row} has an unreadable period`);
  }
  return period;
}

function toMeta(row: SnapshotRow): SnapshotMeta {
  const period = parsedPeriod(row.period_key, row.id);
  return {
    id: row.id,
    reportType: row.report_type,
    period,
    builtAt: row.built_at,
    builtBy: row.built_by,
    sourceComplete: row.source_complete,
    summary: row.summary,
    attendance: (row.attendance ?? null) as AttendanceEvidence | null,
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_PAGE;
  }
  return Math.min(DEFAULT_PAGE, Math.max(1, Math.trunc(limit)));
}

/**
 * Stored month reports. Exactly one current row (superseded_by IS NULL) per
 * (report type, month); older builds of a finished month stay as history.
 */
export class PostgresReportSnapshotRepository {
  private static singleton:
    Promise<PostgresReportSnapshotRepository> | undefined;

  constructor(
    private readonly pool: pg.Pool,
    private readonly options: DashboardTransactionOptions = {},
  ) {}

  static instance(): Promise<PostgresReportSnapshotRepository> {
    if (this.singleton === undefined) {
      const pending = dashboardPool().then(
        (pool) => new PostgresReportSnapshotRepository(pool),
      );
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

  async save(write: SnapshotWrite): Promise<SnapshotMeta> {
    if (!BUILT_BY.test(write.builtBy)) {
      throw new RangeError(
        'builtBy must be job, backfill or a Discord user id',
      );
    }
    // Serialized before any query: node-pg would turn a JS array into a PG array, not JSON.
    const payloadJson = JSON.stringify(write.payload);
    return inDashboardTransaction(
      this.pool,
      'report snapshot save',
      async (client) => {
        // One writer per (type, month) at a time, across processes. The two-int
        // form keeps these keys apart from the credential lock's single bigint.
        await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
          DASHBOARD_LOCK_CLASS,
          `${write.reportType}:${periodKey(write.period)}`,
        ]);
        const current = await client.query<{ id: number }>(
          `SELECT id FROM report_snapshots
         WHERE report_type = $1 AND period = $2::date AND superseded_by IS NULL`,
          [write.reportType, periodDate(write.period)],
        );
        const currentId = current.rows[0]?.id;
        let saved: pg.QueryResult<SnapshotRow>;
        if (currentId !== undefined && write.mode === 'update-open') {
          // The open month: daily builds overwrite one row instead of piling up.
          saved = await client.query<SnapshotRow>(
            `UPDATE report_snapshots
           SET payload = $2::jsonb, built_at = $3, built_by = $4, source_complete = $5
           WHERE id = $1
           RETURNING ${META_COLUMNS}`,
            [
              currentId,
              payloadJson,
              write.builtAt,
              write.builtBy,
              write.sourceComplete,
            ],
          );
        } else {
          // A finished month (or the first build): a new row; the old one is kept
          // and points at it, so a build someone already acted on stays readable.
          const next = await client.query<{ id: number }>(
            `SELECT nextval(pg_get_serial_sequence('report_snapshots', 'id'))::int AS id`,
          );
          const newId = next.rows[0].id;
          if (currentId !== undefined) {
            // Before the INSERT, so the partial unique index never sees two
            // current rows; the FK to newId is checked at COMMIT (DEFERRABLE).
            await client.query(
              'UPDATE report_snapshots SET superseded_by = $1 WHERE id = $2',
              [newId, currentId],
            );
          }
          saved = await client.query<SnapshotRow>(
            `INSERT INTO report_snapshots (id, report_type, period, built_at, built_by, source_complete, payload)
           VALUES ($1, $2, $3::date, $4, $5, $6, $7::jsonb)
           RETURNING ${META_COLUMNS}`,
            [
              newId,
              write.reportType,
              periodDate(write.period),
              write.builtAt,
              write.builtBy,
              write.sourceComplete,
              payloadJson,
            ],
          );
        }
        return toMeta(saved.rows[0]);
      },
      this.options,
    );
  }

  async getCurrent(
    reportType: ReportType,
    period: Period,
  ): Promise<Snapshot | undefined> {
    const result = await this.pool.query<SnapshotRow>(
      `SELECT ${META_COLUMNS}, payload FROM report_snapshots
       WHERE report_type = $1 AND period = $2::date AND superseded_by IS NULL`,
      [reportType, periodDate(period)],
    );
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : { ...toMeta(row), payload: row.payload };
  }

  async getCurrentMeta(
    reportType: ReportType,
    period: Period,
  ): Promise<SnapshotMeta | undefined> {
    const result = await this.pool.query<SnapshotRow>(
      `SELECT ${META_COLUMNS} FROM report_snapshots
       WHERE report_type = $1 AND period = $2::date AND superseded_by IS NULL`,
      [reportType, periodDate(period)],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toMeta(row);
  }

  /** Current rows only, newest period first, without payloads. `before` pages: periods strictly earlier. */
  async listSummaries(
    reportType: ReportType,
    options: { limit?: number; before?: Period } = {},
  ): Promise<SnapshotMeta[]> {
    const result = await this.pool.query<SnapshotRow>(
      `SELECT ${META_COLUMNS} FROM report_snapshots
       WHERE report_type = $1 AND superseded_by IS NULL AND ($2::date IS NULL OR period < $2::date)
       ORDER BY period DESC LIMIT $3`,
      [
        reportType,
        options.before === undefined ? null : periodDate(options.before),
        clampLimit(options.limit),
      ],
    );
    return result.rows.map(toMeta);
  }

  /**
   * One month's rows, oldest first (history), without payloads: the newest
   * HISTORY_LIMIT of them, so a month rebuilt many times stays bounded.
   */
  async listHistory(
    reportType: ReportType,
    period: Period,
  ): Promise<(SnapshotMeta & { supersededBy: number | null })[]> {
    const result = await this.pool.query<SnapshotRow>(
      `SELECT * FROM (
         SELECT ${META_COLUMNS}, superseded_by FROM report_snapshots
         WHERE report_type = $1 AND period = $2::date
         ORDER BY id DESC LIMIT $3
       ) newest ORDER BY id`,
      [reportType, periodDate(period), HISTORY_LIMIT],
    );
    return result.rows.map((row) => ({
      ...toMeta(row),
      supersededBy: row.superseded_by ?? null,
    }));
  }

  /** Current rows of the newest `months` months, oldest first, without payloads (trends). */
  async listSummarySeries(
    reportType: ReportType,
    options: { months?: number } = {},
  ): Promise<SnapshotMeta[]> {
    const requested = options.months;
    const months =
      requested === undefined || !Number.isFinite(requested)
        ? SERIES_DEFAULT_MONTHS
        : Math.min(SERIES_MAX_MONTHS, Math.max(1, Math.trunc(requested)));
    const result = await this.pool.query<SnapshotRow>(
      `SELECT * FROM (
         SELECT ${META_COLUMNS} FROM report_snapshots
         WHERE report_type = $1 AND superseded_by IS NULL
         ORDER BY period DESC LIMIT $2
       ) newest ORDER BY period_key`,
      [reportType, months],
    );
    return result.rows.map(toMeta);
  }

  /**
   * Months whose current no-show snapshot mentions the member (as a case,
   * cleared or departed), newest first. Only the member's own case leaves the
   * database, never the whole payload.
   */
  async listMemberNoShowMonths(
    memberId: string,
    options: { offset?: number; limit?: number } = {},
  ): Promise<MemberNoShowMonth[]> {
    if (typeof memberId !== 'string' || !MEMBER_ID.test(memberId)) {
      throw new RangeError('memberId must be 1-20 digits');
    }
    const offset = Math.min(
      MAX_OFFSET,
      Math.max(0, Math.trunc(options.offset ?? 0) || 0),
    );
    const asCase = JSON.stringify({ cases: [{ member: { id: memberId } }] });
    const asCleared = JSON.stringify({
      cleared: [{ member: { id: memberId } }],
    });
    const asDeparted = JSON.stringify({ departed: [{ id: memberId }] });
    const result = await this.pool.query<MemberMonthRow>(MEMBER_MONTHS_SQL, [
      memberId,
      asCase,
      asCleared,
      asDeparted,
      clampLimit(options.limit),
      offset,
    ]);
    return result.rows.map((row) => ({
      period: parsedPeriod(row.period_key),
      builtAt: row.built_at,
      asOf: row.as_of,
      noShowCase: (row.no_show_case ?? null) as NoShowCasePayload | null,
      cleared: row.cleared,
      departed: row.departed,
    }));
  }
}
