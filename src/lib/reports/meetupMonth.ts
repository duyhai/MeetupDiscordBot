import dayjs from 'dayjs';

import { GqlMeetupClient } from '../client/meetup/gqlClient.js';
import {
  getPaginatedData,
  mapWithConcurrency,
} from '../client/meetup/paginationHelper.js';
import { Event, Rsvp, RsvpFilter } from '../client/meetup/types.js';
import { isCancelledEvent } from '../helpers/hallOfFame.js';
import { tz } from '../../util/timezone.js';
import { periodKey, periodStart } from './period.js';
import { AttendanceEvidence } from './types.js';

// Bounds parallel RSVP-fetch fan-outs so a month with many events doesn't
// fire dozens of paginated requests at Meetup simultaneously.
export const RSVP_FETCH_CONCURRENCY = 5;

export const MONTH_RSVP_STATUSES: RsvpFilter['rsvpStatus'] = [
  'ATTENDED',
  'YES',
  'NO_SHOW',
];

/** month 0 = whole year (commands only); a Period is a ReportWindow. */
export interface ReportWindow {
  year: number;
  month: number;
}

/** eventId -> RSVPs with MONTH_RSVP_STATUSES. */
export interface MonthData {
  events: Event[];
  rsvps: Map<string, Rsvp[]>;
}

export async function getEventsYearMonth(
  meetupClient: GqlMeetupClient,
  year: number,
  month: number,
) {
  let startDate = tz(dayjs()).set('year', year).startOf('year');
  let endDate = startDate.endOf('year');
  if (month !== 0) {
    startDate = startDate.set('month', month - 1).startOf('month');
    endDate = startDate.endOf('month');
  }

  return getPaginatedData(async (paginationInput) => {
    const result = await meetupClient.getGroupEvents(paginationInput, {
      // No AUTOSCHED: a recurring series can generate a copy of an event
      // that already exists (same title, time, and hosts), and the copy stays
      // AUTOSCHED instead of becoming PAST. Checked 2026-09-28: all 11
      // past-dated AUTOSCHED events in 2026 were such copies, and no real
      // event was left AUTOSCHED.
      status: ['PAST', 'ACTIVE'],
      afterDateTime: startDate.toISOString(),
      beforeDateTime: endDate.toISOString(),
    });
    return result.groupByUrlname.events;
  });
}

// Whole-year windows (month 0) are for the slash command only; the build job always passes a single month.
export async function fetchMonthData(
  meetupClient: GqlMeetupClient,
  window: ReportWindow,
): Promise<MonthData> {
  const events = await getEventsYearMonth(
    meetupClient,
    window.year,
    window.month,
  );
  // One pass per event serves both reports: Hall of Fame counts ATTENDED+YES,
  // the no-show report reads NO_SHOW, and the attendance check reads both.
  const perEvent = await mapWithConcurrency(
    events,
    RSVP_FETCH_CONCURRENCY,
    (event) =>
      getPaginatedData(async (paginationInput) => {
        const result = await meetupClient.getEventRsvps(
          event.id,
          paginationInput,
          { rsvpStatus: MONTH_RSVP_STATUSES },
        );
        return result.event.rsvps;
      }),
  );
  return {
    events,
    rsvps: new Map(events.map((event, i) => [event.id, perEvent[i]])),
  };
}

/** ATTENDED + YES. */
export function attendanceCount(rsvps: Rsvp[]): number {
  return rsvps.filter((r) => r.status === 'ATTENDED' || r.status === 'YES')
    .length;
}

export function attendanceEvidence(
  data: MonthData,
  asOf: Date,
): AttendanceEvidence {
  const past = data.events.filter(
    (e) => Date.parse(e.dateTime) < asOf.getTime() && !isCancelledEvent(e),
  );
  return {
    pastEvents: past.length,
    eventsWithAttendance: past.filter((e) =>
      (data.rsvps.get(e.id) ?? []).some(
        (r) => r.status === 'ATTENDED' || r.status === 'NO_SHOW',
      ),
    ).length,
  };
}

export function isAttendanceRecorded(evidence: AttendanceEvidence): boolean {
  return evidence.pastEvents === 0 || evidence.eventsWithAttendance > 0;
}

export function windowKey(w: ReportWindow): string {
  return w.month === 0 ? String(w.year) : periodKey(w);
}

export function windowStart(w: ReportWindow): Date {
  return periodStart({ year: w.year, month: w.month === 0 ? 1 : w.month });
}
