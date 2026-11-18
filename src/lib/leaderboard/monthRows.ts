/**
 * One month's rows as the month page and the archive show them. For an
 * awarded month the stored medalists come first, with the place and count
 * they were awarded on (medals are kept whatever later corrections do);
 * everyone else follows, ranked live from the place after them. Otherwise,
 * the live standings.
 */
import { Medal, MedalPlace, byNameThenId, rank } from './standings.js';

export interface MonthRow {
  memberId: string;
  events: number;
  place: number;
  medal?: MedalPlace;
}

export interface MonthRowInputs {
  names: Map<string, string>;
  byMonth: Map<string, Map<string, number>>;
  medals: Medal[];
  awarded: Set<string>;
}

export function monthRows(data: MonthRowInputs, month: string): MonthRow[] {
  const nameOf = (id: string) => data.names.get(id) ?? '';
  const live = rank(
    data.byMonth.get(month) ?? new Map<string, number>(),
    nameOf,
  );
  if (!data.awarded.has(month)) {
    return live;
  }
  const stored = data.medals
    .filter((m) => m.month === month)
    .sort(
      (a, b) =>
        a.place - b.place ||
        byNameThenId(
          { name: nameOf(a.memberId), id: a.memberId },
          { name: nameOf(b.memberId), id: b.memberId },
        ),
    );
  const medalists = new Set(stored.map((m) => m.memberId));
  const rest = rank(
    new Map(
      live
        .filter((s) => !medalists.has(s.memberId))
        .map((s) => [s.memberId, s.events]),
    ),
    nameOf,
  );
  return [
    ...stored.map((m) => ({
      memberId: m.memberId,
      events: m.events,
      place: m.place,
      medal: m.place,
    })),
    ...rest.map((s) => ({ ...s, place: s.place + stored.length })),
  ];
}

/**
 * The archive's medalists per awarded month, exactly as monthRows gives
 * them: computed once per load, not per request.
 */
export function archiveMedalists(
  data: MonthRowInputs,
): Map<string, MonthRow[]> {
  const byMonth = new Map<string, Medal[]>();
  data.medals.forEach((m) => {
    byMonth.set(m.month, [...(byMonth.get(m.month) ?? []), m]);
  });
  const archive = new Map<string, MonthRow[]>();
  data.awarded.forEach((month) => {
    archive.set(
      month,
      monthRows({ ...data, medals: byMonth.get(month) ?? [] }, month).filter(
        (r) => r.medal !== undefined,
      ),
    );
  });
  return archive;
}
