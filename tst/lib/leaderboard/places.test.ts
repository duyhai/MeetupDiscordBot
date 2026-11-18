import { describe, expect, it } from 'vitest';

import {
  EventPlaces,
  eventPlaces,
} from '../../../src/lib/leaderboard/places.js';
import { LeaderboardEvent } from '../../../src/lib/leaderboard/standings.js';

const ev = (
  id: string,
  place: LeaderboardEvent['place'],
): LeaderboardEvent => ({
  id,
  title: 'Games',
  status: 'PAST',
  hostIds: ['1'],
  day: '2026-10-01',
  place,
});

const EVENTS = [
  ev('1', { latE2: 4761, lonE2: -12233, city: 'Seattle' }),
  ev('2', { latE2: 4761, lonE2: -12233, city: 'Seattle' }),
  ev('3', { latE2: 4762, lonE2: -12220, city: 'Bellevue' }),
  ev('4', { latE2: 4766, lonE2: -12231, city: 'Seattle' }),
  ev('5', { latE2: 4700, lonE2: -12200, city: null }),
  ev('6', null),
  ev('7', undefined),
];

/** Every event is in exactly one bucket. */
const total = (p: EventPlaces) =>
  p.cities.reduce((sum, c) => sum + c.events, 0) +
  p.unknownCity +
  p.unplaced +
  p.pending;

describe('eventPlaces', () => {
  it('counts events per grid cell and per city; online and not-yet-collected apart', () => {
    const places = eventPlaces(EVENTS);
    expect(places.cells).toEqual([
      { lat: 47.61, lon: -122.33, events: 2 },
      { lat: 47, lon: -122, events: 1 },
      { lat: 47.62, lon: -122.2, events: 1 },
      { lat: 47.66, lon: -122.31, events: 1 },
    ]);
    expect(places.cities).toEqual([
      { city: 'Seattle', events: 3 },
      { city: 'Bellevue', events: 1 },
    ]);
    expect(places.unknownCity).toBe(1);
    expect(places.unplaced).toBe(1);
    expect(places.pending).toBe(1);
    expect(places.inSmallCells).toBe(0);
    expect(total(places)).toBe(EVENTS.length);
  });

  it('a threshold keeps small areas off the map but in the counts', () => {
    const places = eventPlaces(EVENTS, { minEventsPerCell: 2 });
    expect(places.cells).toEqual([{ lat: 47.61, lon: -122.33, events: 2 }]);
    expect(places.inSmallCells).toBe(3);
    expect(total(places)).toBe(EVENTS.length);
  });

  it('is empty with no events', () => {
    const places = eventPlaces([]);
    expect(places).toEqual({
      cells: [],
      inSmallCells: 0,
      cities: [],
      unknownCity: 0,
      unplaced: 0,
      pending: 0,
    });
  });
});
