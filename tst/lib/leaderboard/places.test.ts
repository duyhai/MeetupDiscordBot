import { describe, expect, it } from 'vitest';

import { eventPlaces } from '../../../src/lib/leaderboard/places.js';
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

describe('eventPlaces', () => {
  it('counts events per grid cell and per city, most first; counts the unplaced', () => {
    const places = eventPlaces([
      ev('1', { latE2: 4761, lonE2: -12233, city: 'Seattle' }),
      ev('2', { latE2: 4761, lonE2: -12233, city: 'Seattle' }),
      ev('3', { latE2: 4762, lonE2: -12220, city: 'Bellevue' }),
      ev('4', { latE2: 4766, lonE2: -12231, city: 'Seattle' }),
      ev('5', { latE2: 4700, lonE2: -12200, city: null }),
      ev('6', null),
      ev('7', undefined),
    ]);
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
    expect(places.unplaced).toBe(2);
  });

  it('is empty with no events', () => {
    expect(eventPlaces([])).toEqual({ cells: [], cities: [], unplaced: 0 });
  });
});
