/**
 * The Hall of fame's all-time award boards (design note, PR 4): nine
 * boards, each the entries placed 10th or better under competition ranking
 * ("Ties A"), at most AWARD_MAX_ROWS rows. Pure, and computed once per
 * leaderboard load from what the loader already holds.
 */
import { EVENT_TYPE_LABELS, classifyEventType } from '../hosts/eventTypes.js';
import { HostStreaks, LeaderboardEvent, Medal, monthOf } from './standings.js';

/** A board shows every entry placed this or better… */
export const AWARD_TOP_PLACES = 10;
/** …but at most this many rows; the rest are "and N more tied". */
export const AWARD_MAX_ROWS = 25;

export type AwardKey =
  | 'attendees'
  | 'weeklyStreak'
  | 'dailyStreak'
  | 'golds'
  | 'medals'
  | 'bestMonth'
  | 'biggestEvent'
  | 'variety'
  | 'monthsActive';

export interface AwardEvent {
  id: string;
  title: string;
  eventUrl?: string;
  day: string;
}

export interface AwardRow {
  place: number;
  value: number;
  /** The host, or an event's hosts (deduped, in listing order). */
  memberIds: string[];
  /** Best month (YYYY-MM) or the event types hosted. */
  detail?: string;
  /** The biggest-event board's event. */
  event?: AwardEvent;
}

export interface AwardBoard {
  key: AwardKey;
  rows: AwardRow[];
  /** Entries placed 10th or better but past AWARD_MAX_ROWS… */
  moreTied: number;
  /** …all tied at this place. */
  morePlace?: number;
  /** Events left out for having no attendance data (attendance boards). */
  unknownAttendance?: number;
}

interface Entry {
  value: number;
  /** Tie order within a place: never changes the place. */
  order: string;
  row: Omit<AwardRow, 'place' | 'value'>;
}

/**
 * Competition ranking by value, highest first; zero never places. Keeps
 * every entry placed `top` or better, up to `maxRows`; the entries past the
 * cap are all tied with the last row (any later place would be past `top`).
 */
export function topPlaces(
  entries: Entry[],
  top = AWARD_TOP_PLACES,
  maxRows = AWARD_MAX_ROWS,
): Pick<AwardBoard, 'rows' | 'moreTied' | 'morePlace'> {
  const sorted = entries
    .filter((e) => e.value > 0)
    .sort((a, b) => b.value - a.value || a.order.localeCompare(b.order));
  const placed: AwardRow[] = [];
  let place = 0;
  sorted.forEach((e, i) => {
    if (i === 0 || sorted[i - 1].value !== e.value) {
      place = i + 1;
    }
    if (place <= top) {
      placed.push({ ...e.row, place, value: e.value });
    }
  });
  const rows = placed.slice(0, maxRows);
  const moreTied = placed.length - rows.length;
  return moreTied > 0
    ? { rows, moreTied, morePlace: rows[rows.length - 1].place }
    : { rows, moreTied: 0 };
}

export interface AwardInputs {
  /** Counted hosted events, oldest first. */
  events: LeaderboardEvent[];
  byHost: Map<string, LeaderboardEvent[]>;
  streaks: Map<string, HostStreaks>;
  /** Stored medals; empty when they could not be read. */
  medals: Medal[];
  names: Map<string, string>;
}

const uniqueHosts = (e: LeaderboardEvent) => [...new Set(e.hostIds)];

/** The nine boards, in display order. */
export function awardBoards(input: AwardInputs): AwardBoard[] {
  const { events, byHost, streaks, medals, names } = input;
  const nameOf = (id: string) => names.get(id) ?? '';
  const hostBoard = (
    key: AwardKey,
    valueOf: (id: string, hostEvents: LeaderboardEvent[]) => number,
    detailOf?: (id: string, hostEvents: LeaderboardEvent[]) => string,
  ): AwardBoard => ({
    key,
    ...topPlaces(
      [...byHost].map(([id, hostEvents]) => ({
        value: valueOf(id, hostEvents),
        order: `${nameOf(id)}\u0000${id}`,
        row: {
          memberIds: [id],
          ...(detailOf ? { detail: detailOf(id, hostEvents) } : {}),
        },
      })),
    ),
  });

  const unknownAttendance = events.filter(
    (e) => e.attendance === undefined,
  ).length;
  const attendees = {
    ...hostBoard('attendees', (_id, hostEvents) =>
      hostEvents.reduce((sum, e) => sum + (e.attendance ?? 0), 0),
    ),
    unknownAttendance,
  };

  const medalCount = (place?: number) => {
    const counts = new Map<string, number>();
    medals
      .filter((m) => place === undefined || m.place === place)
      .forEach((m) =>
        counts.set(m.memberId, (counts.get(m.memberId) ?? 0) + 1),
      );
    return counts;
  };
  const golds = medalCount(1);
  const all = medalCount();

  // A host's best month: most events; the earliest such month names it.
  const bestMonth = (hostEvents: LeaderboardEvent[]) => {
    const perMonth = new Map<string, number>();
    hostEvents.forEach((e) => {
      const m = monthOf(e);
      perMonth.set(m, (perMonth.get(m) ?? 0) + 1);
    });
    let best: [string, number] = ['', 0];
    [...perMonth]
      .sort(([a], [b]) => a.localeCompare(b))
      .forEach((entry) => {
        if (entry[1] > best[1]) {
          best = entry;
        }
      });
    return best;
  };

  const typeOf = new Map(events.map((e) => [e.id, classifyEventType(e.title)]));
  const typesOf = (hostEvents: LeaderboardEvent[]) => [
    ...new Set(
      hostEvents.map((e) => typeOf.get(e.id) ?? classifyEventType(e.title)),
    ),
  ];

  const biggest: AwardBoard = {
    key: 'biggestEvent',
    ...topPlaces(
      events
        .filter((e) => e.attendance !== undefined)
        .map((e) => ({
          value: e.attendance ?? 0,
          // Ties: the more recent event first.
          order: `${9999_99_99 - Number(e.day.replaceAll('-', ''))}\u0000${e.id}`,
          row: {
            memberIds: uniqueHosts(e),
            event: {
              id: e.id,
              title: e.title,
              eventUrl: e.eventUrl,
              day: e.day,
            },
          },
        })),
    ),
    unknownAttendance,
  };

  return [
    attendees,
    hostBoard('weeklyStreak', (id) => streaks.get(id)?.weekly.best ?? 0),
    hostBoard('dailyStreak', (id) => streaks.get(id)?.daily.best ?? 0),
    hostBoard('golds', (id) => golds.get(id) ?? 0),
    hostBoard('medals', (id) => all.get(id) ?? 0),
    hostBoard(
      'bestMonth',
      (_id, hostEvents) => bestMonth(hostEvents)[1],
      (_id, hostEvents) => bestMonth(hostEvents)[0],
    ),
    biggest,
    hostBoard(
      'variety',
      (_id, hostEvents) => typesOf(hostEvents).length,
      (_id, hostEvents) =>
        typesOf(hostEvents)
          .map((t) => EVENT_TYPE_LABELS[t])
          .sort()
          .join(', '),
    ),
    hostBoard(
      'monthsActive',
      (_id, hostEvents) => new Set(hostEvents.map(monthOf)).size,
    ),
  ];
}
