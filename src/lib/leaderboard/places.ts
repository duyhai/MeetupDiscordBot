/**
 * Where hosted events happened, for the host maps: counts per ~1 km grid
 * cell and per city. The snapshot stores only the cell (snapshot/meetup.ts
 * toPlace), so nothing here can plot an exact venue.
 *
 * Every event lands in exactly one bucket, so the page's numbers add up:
 * cities + unknownCity = placed; placed + unplaced + pending = all.
 */
import { PLACE_GRID } from '../snapshot/meetup.js';
import { LeaderboardEvent } from './standings.js';

export interface MapCell {
  /** The cell's centre, degrees. */
  lat: number;
  lon: number;
  events: number;
}

export interface CityCount {
  city: string;
  events: number;
}

export interface EventPlaces {
  /** Cells drawn on the map: those with at least `minEventsPerCell`. */
  cells: MapCell[];
  /** Placed events in cells below `minEventsPerCell` (shown as text only). */
  inSmallCells: number;
  cities: CityCount[];
  /** Placed events whose venue has no city. */
  unknownCity: number;
  /** Events with no place: online, or no usable venue. */
  unplaced: number;
  /** Events whose place the snapshot has not collected yet. */
  pending: number;
}

/** Rounds away float noise: 47.61 not 47.610000000000006. */
const degrees = (e2: number) => Number((e2 * PLACE_GRID).toFixed(2));

/**
 * Cells and cities by event count, most first (ties: by place, for a
 * stable order). A profile map passes `minEventsPerCell` so no single area
 * of one person's hosting (a home, say) is drawn.
 */
export function eventPlaces(
  events: LeaderboardEvent[],
  { minEventsPerCell = 1 }: { minEventsPerCell?: number } = {},
): EventPlaces {
  const cells = new Map<string, MapCell>();
  const cities = new Map<string, number>();
  let unknownCity = 0;
  let unplaced = 0;
  let pending = 0;
  events.forEach((e) => {
    if (e.place === undefined) {
      pending += 1;
      return;
    }
    if (e.place === null) {
      unplaced += 1;
      return;
    }
    const key = `${e.place.latE2},${e.place.lonE2}`;
    const cell = cells.get(key) ?? {
      lat: degrees(e.place.latE2),
      lon: degrees(e.place.lonE2),
      events: 0,
    };
    cell.events += 1;
    cells.set(key, cell);
    if (e.place.city) {
      cities.set(e.place.city, (cities.get(e.place.city) ?? 0) + 1);
    } else {
      unknownCity += 1;
    }
  });
  const all = [...cells.values()];
  const shown = all.filter((c) => c.events >= minEventsPerCell);
  return {
    cells: shown.sort(
      (a, b) => b.events - a.events || a.lat - b.lat || a.lon - b.lon,
    ),
    inSmallCells: all
      .filter((c) => c.events < minEventsPerCell)
      .reduce((sum, c) => sum + c.events, 0),
    cities: [...cities.entries()]
      .map(([city, n]) => ({ city, events: n }))
      .sort((a, b) => b.events - a.events || a.city.localeCompare(b.city)),
    unknownCity,
    unplaced,
    pending,
  };
}
