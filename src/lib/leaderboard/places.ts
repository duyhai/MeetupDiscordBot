/**
 * Where hosted events happened, for the host maps: counts per ~1 km grid
 * cell and per city. The snapshot stores only the cell (snapshot/meetup.ts
 * toPlace), so nothing here can plot an exact venue.
 *
 * What is shown is decided here, on the server, before anything reaches a
 * page: a cell is drawn only with at least `minEvents` events, and (on the
 * hall of fame) only if no single host dominates it: removing any one
 * host's events leaves at least `minEventsWithoutAnyHost`. A city is named
 * only if it contains a drawn cell. Profile maps take their city list from
 * drawn cells only, so a profile never names the city of an area it does
 * not draw. Every event is counted in
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

/**
 * How a hall of fame cell's count is shown: a band, not the exact number,
 * so a count ticking up after a known event cannot place that event in the
 * cell. Bands start at the drawing threshold.
 */
export const COUNT_BANDS = [
  { min: 26, label: '26+ events', weight: 4 },
  { min: 11, label: '11–25 events', weight: 3 },
  { min: 6, label: '6–10 events', weight: 2 },
  { min: 0, label: 'up to 5 events', weight: 1 },
] as const;

export function countBand(events: number): { label: string; weight: number } {
  const band = COUNT_BANDS.find((b) => events >= b.min) ?? COUNT_BANDS[3];
  return { label: band.label, weight: band.weight };
}

export interface CityCount {
  city: string;
  events: number;
}

export interface PlaceRule {
  /** A cell needs at least this many events to be drawn. */
  minEvents: number;
  /**
   * Dominance: removing all events of any one host must leave at least
   * this many events in the cell, so no single host (alone, with a regular
   * co-host, or plus one other event) can make an area appear. 0 for a
   * profile, whose cells are one host's by definition.
   */
  minEventsWithoutAnyHost: number;
  /**
   * A profile: cities only from drawn cells, and every other placed event
   * in one line with no city. Otherwise (the hall of fame) a city is named
   * when it contains a drawn cell, its count including its undrawn events.
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
  rule: PlaceRule = {
    minEvents: 1,
    minEventsWithoutAnyHost: 0,
    citiesFromDrawnCells: false,
  },
): EventPlaces {
  const shows = (b: Bucket) =>
    b.events.length >= rule.minEvents &&
    [...b.hosts].every(
      (h) =>
        b.events.filter((e) => !e.hostIds.includes(h)).length >=
        rule.minEventsWithoutAnyHost,
    );
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
  // A profile lists its own cells by count; the hall of fame by position,
  // so the order of same-band cells never gives their exact counts away.
  const byPosition = (a: MapCell, b: MapCell) => a.lat - b.lat || a.lon - b.lon;
  if (rule.citiesFromDrawnCells) {
    cells.sort((a, b) => b.events - a.events || byPosition(a, b));
  } else {
    cells.sort(byPosition);
  }
  const drawn = placed.filter((e) => drawnKeys.has(cellKey(e) ?? ''));
  const notDrawn = placed.length - drawn.length;

  // A city is named only where an area of it is drawn: on a profile from
  // drawn cells alone; on the hall of fame, any city with a drawn cell.
  const forCities = rule.citiesFromDrawnCells ? drawn : placed;
  const citiesWithDrawnCell = new Set<string>();
  drawn.forEach((e) => {
    if (e.place.city) {
      citiesWithDrawnCell.add(e.place.city);
    }
  });
  const cityBuckets = bucketBy(forCities, (e) => e.place?.city ?? null);
  const cities = [...cityBuckets]
    .filter(([city]) => citiesWithDrawnCell.has(city))
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
