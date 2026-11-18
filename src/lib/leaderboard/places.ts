/**
 * Where hosted events happened, for the host maps: counts per ~1 km grid
 * cell and per city. The snapshot stores only the cell (snapshot/meetup.ts
 * toPlace), so nothing here can plot an exact venue.
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
  cells: MapCell[];
  cities: CityCount[];
  /** Events with no place: online, or no usable venue. */
  unplaced: number;
}

/** Rounds away float noise: 47.61 not 47.610000000000006. */
const degrees = (e2: number) => Number((e2 * PLACE_GRID).toFixed(2));

/** Cells and cities by event count, most first (ties: by place, for a stable order). */
export function eventPlaces(events: LeaderboardEvent[]): EventPlaces {
  const cells = new Map<string, MapCell>();
  const cities = new Map<string, number>();
  let unplaced = 0;
  events.forEach((e) => {
    if (!e.place) {
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
    }
  });
  return {
    cells: [...cells.values()].sort(
      (a, b) => b.events - a.events || a.lat - b.lat || a.lon - b.lon,
    ),
    cities: [...cities.entries()]
      .map(([city, n]) => ({ city, events: n }))
      .sort((a, b) => b.events - a.events || a.city.localeCompare(b.city)),
    unplaced,
  };
}
