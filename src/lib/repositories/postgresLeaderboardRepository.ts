/**
 * The host leaderboard's reads and its one write (awarding a month's
 * medals). Events come from the group snapshot (meetup_events), names from
 * meetup_host_names; no Meetup call.
 */
import pg from 'pg';

import { EventStatus } from '../client/meetup/types.js';
import {
  LeaderboardEvent,
  Medal,
  MedalPlace,
} from '../leaderboard/standings.js';
import {
  DASHBOARD_LOCK_CLASS,
  dashboardPool,
  inDashboardTransaction,
} from './dashboardPool.js';

/** hashtext key for the awarding lock inside DASHBOARD_LOCK_CLASS. */
const AWARD_LOCK = 'host-medals';

export interface LeaderboardStore {
  /** Live PAST events with at least one host. */
  hostedEvents(): Promise<LeaderboardEvent[]>;
  hostNames(): Promise<Map<string, string>>;
  medals(): Promise<Medal[]>;
  awardedMonths(): Promise<Set<string>>;
  /**
   * Records each month as awarded with its medals, under one lock; a month
   * another process awarded first keeps its medals untouched.
   */
  award(months: { month: string; medals: Medal[] }[]): Promise<void>;
}

export class PostgresLeaderboardRepository implements LeaderboardStore {
  private static singleton: Promise<PostgresLeaderboardRepository> | undefined;

  constructor(private readonly pool: pg.Pool) {}

  static instance(): Promise<PostgresLeaderboardRepository> {
    if (this.singleton === undefined) {
      const pending = dashboardPool().then(
        (pool) => new PostgresLeaderboardRepository(pool),
      );
      this.singleton = pending;
      pending.catch(() => {
        if (this.singleton === pending) {
          this.singleton = undefined;
        }
      });
    }
    return this.singleton;
  }

  async hostedEvents(): Promise<LeaderboardEvent[]> {
    // The Pacific day is computed here, once per event, so the page never
    // formats a time zone per event.
    const result = await this.pool.query<{
      event_id: string;
      title: string;
      status: string;
      host_ids: string[];
      day: string;
    }>(
      `SELECT event_id, title, status, host_ids,
              to_char(date_time AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD') AS day
         FROM meetup_events
        WHERE status = 'PAST' AND deleted_at IS NULL AND cardinality(host_ids) > 0
        ORDER BY date_time, event_id`,
    );
    return result.rows.map((row) => ({
      id: row.event_id,
      title: row.title,
      status: row.status as EventStatus,
      hostIds: row.host_ids,
      day: row.day,
    }));
  }

  async hostNames(): Promise<Map<string, string>> {
    const result = await this.pool.query<{ member_id: string; name: string }>(
      'SELECT member_id, name FROM meetup_host_names',
    );
    return new Map(result.rows.map((r) => [r.member_id, r.name]));
  }

  async medals(): Promise<Medal[]> {
    const result = await this.pool.query<{
      month: string;
      member_id: string;
      place: number;
      events: number;
    }>(
      'SELECT month, member_id, place, events FROM host_medals ORDER BY month, place, member_id',
    );
    return result.rows.map((r) => ({
      month: r.month,
      memberId: r.member_id,
      place: r.place as MedalPlace,
      events: r.events,
    }));
  }

  async awardedMonths(): Promise<Set<string>> {
    const result = await this.pool.query<{ month: string }>(
      'SELECT month FROM host_medal_months',
    );
    return new Set(result.rows.map((r) => r.month));
  }

  async award(months: { month: string; medals: Medal[] }[]): Promise<void> {
    if (months.length === 0) {
      return;
    }
    await inDashboardTransaction(
      this.pool,
      'host medal award',
      async (client) => {
        await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
          DASHBOARD_LOCK_CLASS,
          AWARD_LOCK,
        ]);
        const inserted = await client.query<{ month: string }>(
          `INSERT INTO host_medal_months (month) SELECT unnest($1::text[])
         ON CONFLICT (month) DO NOTHING RETURNING month`,
          [months.map((m) => m.month)],
        );
        const fresh = new Set(inserted.rows.map((r) => r.month));
        const medals = months
          .filter((m) => fresh.has(m.month))
          .flatMap((m) => m.medals);
        if (medals.length > 0) {
          await client.query(
            `INSERT INTO host_medals (month, member_id, place, events)
           SELECT * FROM unnest($1::text[], $2::text[], $3::smallint[], $4::int[])`,
            [
              medals.map((m) => m.month),
              medals.map((m) => m.memberId),
              medals.map((m) => m.place),
              medals.map((m) => m.events),
            ],
          );
        }
      },
    );
  }
}
