/**
 * Where hosted events happened, for the host maps: counts per ~1 km grid
 * cell and per city. The snapshot stores only the cell (snapshot/meetup.ts
 * toPlace), so nothing here can plot an exact venue.
 *
 * What is shown is decided here, on the server, before anything reaches a
 * page: a cell is drawn only with at least `minEvents` events from at least
 * `minHosts` hosts, and a city is named only under the same rule. Profile
 * maps also take their city list from drawn cells only, so a profile never
 * names the city of an area it does not draw. Every event is counted in
 * exactly one of the totals (`total` checks it).
 */
import { EventPlace, PLACE_GRID } from '../snapshot/meetup.js';
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

export interface PlaceRule {
  /** A cell (or city) needs at least this many events to be shown. */
  minEvents: number;
  /** …and events from at least this many distinct hosts. */
  minHosts: number;
  /**
   * Cities only from drawn cells (a profile); otherwise from every placed
   * event, each city under the same rule (the hall of fame).
   */
  citiesFromDrawnCells: boolean;
}

export interface EventPlaces {
  rule: PlaceRule;
  /** Cells shown on the map. */
  cells: MapCell[];
  /** Placed events in cells that are not drawn. */
  notDrawn: number;
  /** Named cities, most events first. */
  cities: CityCount[];
  /**
   * Placed events counted under no city: no city given, or a city not
   * named under the rule. With citiesFromDrawnCells, drawn cells only.
   */
  otherArea: number;
  /** Events with no place: online, or no usable venue. */
  unplaced: number;
  /** Events whose place the snapshot has not collected yet. */
  pending: number;
}

/** Every event once: on a profile, undrawn events are in no city row. */
export function total(p: EventPlaces): number {
  return (
    p.cities.reduce((sum, c) => sum + c.events, 0) +
    p.otherArea +
    (p.rule.citiesFromDrawnCells ? p.notDrawn : 0) +
    p.unplaced +
    p.pending
  );
}

/** Rounds away float noise: 47.61 not 47.610000000000006. */
const degrees = (e2: number) => Number((e2 * PLACE_GRID).toFixed(2));

interface Bucket {
  events: LeaderboardEvent[];
  hosts: Set<string>;
}

function bucketBy(
  events: LeaderboardEvent[],
  key: (e: LeaderboardEvent) => string | null,
): Map<string, Bucket> {
  const buckets = new Map<string, Bucket>();
  events.forEach((e) => {
    const k = key(e);
    if (k === null) {
      return;
    }
    const bucket = buckets.get(k) ?? { events: [], hosts: new Set<string>() };
    bucket.events.push(e);
    e.hostIds.forEach((id) => bucket.hosts.add(id));
    buckets.set(k, bucket);
  });
  return buckets;
}

export function eventPlaces(
  events: LeaderboardEvent[],
  rule: PlaceRule = { minEvents: 1, minHosts: 1, citiesFromDrawnCells: false },
): EventPlaces {
  const shows = (b: Bucket) =>
    b.events.length >= rule.minEvents && b.hosts.size >= rule.minHosts;
  type Placed = LeaderboardEvent & { place: EventPlace };
  const placed = events.filter((e): e is Placed => Boolean(e.place));
  function cellKey(e: LeaderboardEvent): string | null {
    return e.place ? `${e.place.latE2},${e.place.lonE2}` : null;
  }
  const cellBuckets = bucketBy(placed, cellKey);
  const drawnKeys = new Set<string>();
  const cells: MapCell[] = [];
  cellBuckets.forEach((bucket, key) => {
    if (shows(bucket)) {
      drawnKeys.add(key);
      const [latE2, lonE2] = key.split(',').map(Number);
      cells.push({
        lat: degrees(latE2),
        lon: degrees(lonE2),
        events: bucket.events.length,
      });
    }
  });
  cells.sort((a, b) => b.events - a.events || a.lat - b.lat || a.lon - b.lon);
  const drawn = placed.filter((e) => drawnKeys.has(cellKey(e) ?? ''));
  const notDrawn = placed.length - drawn.length;

  // On a profile, a city of an undrawn area is never named.
  const forCities = rule.citiesFromDrawnCells ? drawn : placed;
  const cityBuckets = bucketBy(forCities, (e) => e.place?.city ?? null);
  const cities = [...cityBuckets]
    .filter(([, b]) => rule.citiesFromDrawnCells || shows(b))
    .map(([city, b]) => ({ city, events: b.events.length }))
    .sort((a, b) => b.events - a.events || a.city.localeCompare(b.city));
  const named = cities.reduce((sum, c) => sum + c.events, 0);
  return {
    rule,
    cells,
    notDrawn,
    cities,
    otherArea: forCities.length - named,
    unplaced: events.filter((e) => e.place === null).length,
    pending: events.filter((e) => e.place === undefined).length,
  };
}
