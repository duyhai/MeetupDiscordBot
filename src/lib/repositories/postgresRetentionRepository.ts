import pg from 'pg';

import type {
  ActivityMonth,
  CohortMonth,
  RetentionAggregates,
  YearCell,
} from '../retention/retention.js';
import { dashboardPool } from './dashboardPool.js';

/** What the retention loader reads. */
export interface RetentionStore {
  /** `asOf`: a Pacific day, YYYY-MM-DD (the snapshot's day). */
  aggregates(asOf: string): Promise<RetentionAggregates>;
}

/**
 * The attended rule, as Wrapped's (countsAsAttended in
 * src/lib/helpers/countedEvents.ts): a YES or ATTENDED RSVP at a live PAST
 * event whose title does not say "cancelled". Open Houses count; WAITLIST
 * never does. The regex is CANCELLED_TITLE's.
 */
const ATTENDED = `r.status IN ('YES', 'ATTENDED')
     AND e.status = 'PAST' AND e.deleted_at IS NULL
     AND e.title !~* 'cancell?ed'`;

/**
 * One statement. `att` is every attended (member, event) with the event's
 * Pacific day, its place in the member's own order (rn) and the member's
 * first day: one hash join of the two tables and one sort by member. It is
 * MATERIALIZED so it is built once. Everything after it is a hash
 * aggregate small enough for the default work_mem: `members` is one row per
 * member, `member_months` one per member and month they attended. Rows
 * out: one per first-event month, one per month with attendance, one per
 * (first-event year, active year). No member id leaves the database.
 *
 * $1 is the as-of Pacific day: `recent` is an attended event in the 180
 * days up to it.
 */
const AGGREGATES = `
WITH att AS MATERIALIZED (
  SELECT r.member_id,
         d.day,
         row_number() OVER w AS rn,
         first_value(d.day) OVER w AS first_day
    FROM meetup_event_rsvps r
    JOIN meetup_events e USING (event_id)
   CROSS JOIN LATERAL
         (SELECT (e.date_time AT TIME ZONE 'America/Los_Angeles')::date AS day) d
   WHERE ${ATTENDED}
  WINDOW w AS (PARTITION BY r.member_id ORDER BY e.date_time, e.event_id)
),
members AS (
  SELECT member_id,
         min(first_day) AS first_day,
         count(*) AS total,
         min(day) FILTER (WHERE rn = 2) AS second_day,
         min(day) FILTER (WHERE rn = 3) AS third_day,
         coalesce(bool_or(day - first_day BETWEEN 271 AND 365), false) AS year_on,
         coalesce(bool_or(day > $1::date - 180), false) AS recent
    FROM att
   GROUP BY member_id
),
cohorts AS (
  SELECT to_char(first_day, 'YYYY-MM') AS month,
         count(*)::int AS members,
         count(*) FILTER (WHERE second_day - first_day <= 90)::int AS "second90",
         count(*) FILTER (WHERE third_day - first_day <= 90)::int AS "third90",
         count(*) FILTER (WHERE year_on)::int AS "yearOn",
         count(*) FILTER (WHERE total >= 2)::int AS "reached2",
         count(*) FILTER (WHERE total >= 3)::int AS "reached3",
         count(*) FILTER (WHERE total >= 4)::int AS "reached4",
         count(*) FILTER (WHERE total >= 5)::int AS "reached5",
         count(*) FILTER (WHERE total >= 6)::int AS "reached6",
         -- Sixth-and-later attendances, and those of them that had a next.
         coalesce(sum(greatest(total - 5, 0)), 0)::int AS "sixPlus",
         coalesce(sum(greatest(total - 6, 0)), 0)::int AS "sixPlusAgain",
         count(*) FILTER (WHERE recent AND total >= 3)::int AS "recentThree",
         count(*) FILTER (WHERE recent AND total < 3)::int AS "recentUnderThree"
    FROM members
   GROUP BY 1
),
member_months AS (
  SELECT DISTINCT member_id,
         date_trunc('month', day::timestamp)::date AS month,
         date_trunc('month', first_day::timestamp)::date AS first_month
    FROM att
),
months AS (
  SELECT to_char(month, 'YYYY-MM') AS month,
         count(*)::int AS active,
         count(*) FILTER (WHERE month = first_month)::int AS "firstTimers"
    FROM member_months
   GROUP BY member_months.month
),
years AS (
  SELECT cohort, year, count(*)::int AS members
    FROM (SELECT DISTINCT member_id,
                 extract(year FROM first_month)::int AS cohort,
                 extract(year FROM month)::int AS year
            FROM member_months) member_years
   GROUP BY 1, 2
)
SELECT (SELECT coalesce(json_agg(c ORDER BY c.month), '[]'::json) FROM cohorts c) AS cohorts,
       (SELECT coalesce(json_agg(m ORDER BY m.month), '[]'::json) FROM months m) AS months,
       (SELECT coalesce(json_agg(y ORDER BY y.cohort, y.year), '[]'::json) FROM years y) AS years`;

export class PostgresRetentionRepository implements RetentionStore {
  private static singleton: Promise<PostgresRetentionRepository> | undefined;

  constructor(private readonly pool: pg.Pool) {}

  static instance(): Promise<PostgresRetentionRepository> {
    if (this.singleton === undefined) {
      const pending = dashboardPool().then(
        (pool) => new PostgresRetentionRepository(pool),
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

  async aggregates(asOf: string): Promise<RetentionAggregates> {
    const result = await this.pool.query<{
      cohorts: CohortMonth[];
      months: ActivityMonth[];
      years: YearCell[];
    }>(AGGREGATES, [asOf]);
    const row = result.rows[0];
    return { cohorts: row.cohorts, months: row.months, years: row.years };
  }
}
