import pg from 'pg';

import {
  parsePeriodKey,
  Period,
  periodDate,
  periodKey,
} from '../reports/period.js';
import {
  HallOfFamePayload,
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
}

export interface Snapshot extends SnapshotMeta {
  payload: unknown;
}

const BUILT_BY = /^(job|backfill|[0-9]{1,20})$/;
const DEFAULT_PAGE = 50;
const HISTORY_LIMIT = 100;

const META_COLUMNS = `id, report_type, to_char(period, 'YYYY-MM') AS period_key, built_at, built_by,
  source_complete, payload->'summary' AS summary`;

interface SnapshotRow {
  id: number;
  report_type: ReportType;
  period_key: string;
  built_at: Date;
  built_by: string;
  source_complete: boolean;
  summary: unknown;
  payload?: unknown;
  superseded_by?: number | null;
}

function toMeta(row: SnapshotRow): SnapshotMeta {
  const period = parsePeriodKey(row.period_key);
  if (period === undefined) {
    throw new Error(`report_snapshots row ${row.id} has an unreadable period`);
  }
  return {
    id: row.id,
    reportType: row.report_type,
    period,
    builtAt: row.built_at,
    builtBy: row.built_by,
    sourceComplete: row.source_complete,
    summary: row.summary,
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
}
