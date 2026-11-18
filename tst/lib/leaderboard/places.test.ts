import { describe, expect, it } from 'vitest';

import { eventPlaces, total } from '../../../src/lib/leaderboard/places.js';
import { LeaderboardEvent } from '../../../src/lib/leaderboard/standings.js';
import {
  HALL_OF_FAME_PLACE_RULE,
  PROFILE_PLACE_RULE,
} from '../../../src/web/host/hostMap.js';

let seq = 0;
const ev = (
  hostIds: string[],
  place: LeaderboardEvent['place'],
): LeaderboardEvent => {
  seq += 1;
  return {
    id: String(seq),
    title: 'Games',
    status: 'PAST',
    hostIds,
    day: '2026-10-01',
    place,
  };
};

const SEATTLE = { latE2: 4761, lonE2: -12233, city: 'Seattle' };
const BELLEVUE = { latE2: 4762, lonE2: -12220, city: 'Bellevue' };
/** One host's home area: 2 events, below every threshold. */
const SMALLVILLE = { latE2: 4790, lonE2: -12250, city: 'Smallville' };

const EVENTS = [
  ev(['1'], SEATTLE),
  ev(['2'], SEATTLE),
  ev(['3'], SEATTLE),
  ev(['1'], BELLEVUE),
  ev(['1'], BELLEVUE),
  ev(['1'], BELLEVUE),
  ev(['9'], SMALLVILLE),
  ev(['9'], SMALLVILLE),
  ev(['2'], { ...SEATTLE, city: null }),
  ev(['1'], null),
  ev(['1'], undefined),
];

describe('eventPlaces', () => {
  it('with no rule: every cell and city, and every event in one bucket', () => {
    const places = eventPlaces(EVENTS);
    expect(places.cells).toHaveLength(3);
    expect(places.cities.map((c) => c.city)).toEqual([
      'Bellevue',
      'Seattle',
      'Smallville',
    ]);
    expect(places.otherArea).toBe(1);
    expect(places.unplaced).toBe(1);
    expect(places.pending).toBe(1);
    expect(total(places)).toBe(EVENTS.length);
  });

  it('hall of fame: an area or city needs 3+ events from 2+ hosts', () => {
    const places = eventPlaces(EVENTS, HALL_OF_FAME_PLACE_RULE);
    // Seattle: 4 events from 3 hosts. Bellevue: 3 events, one host.
    // Smallville: 2 events, one host.
    expect(places.cells).toEqual([{ lat: 47.61, lon: -122.33, events: 4 }]);
    expect(places.notDrawn).toBe(5);
    expect(places.cities).toEqual([{ city: 'Seattle', events: 3 }]);
    // Bellevue (3) and Smallville (2) folded, plus the Seattle event with no city.
    expect(places.otherArea).toBe(6);
    expect(total(places)).toBe(EVENTS.length);
  });

  it('profile: cities only from drawn areas; the rest in no city', () => {
    const host9 = EVENTS.filter((e) => e.hostIds.includes('9'));
    const places = eventPlaces(host9, PROFILE_PLACE_RULE);
    expect(places.cells).toEqual([]);
    expect(places.cities).toEqual([]);
    expect(places.notDrawn).toBe(2);
    expect(total(places)).toBe(host9.length);

    const host1 = EVENTS.filter((e) => e.hostIds.includes('1'));
    const one = eventPlaces(host1, PROFILE_PLACE_RULE);
    expect(one.cells).toEqual([{ lat: 47.62, lon: -122.2, events: 3 }]);
    expect(one.cities).toEqual([{ city: 'Bellevue', events: 3 }]);
    expect(one.notDrawn).toBe(1); // the single Seattle event
    expect(total(one)).toBe(host1.length);
  });

  it('a co-hosted event counts each host toward an area’s distinct hosts', () => {
    const places = eventPlaces(
      [
        ev(['1', '2'], SMALLVILLE),
        ev(['1'], SMALLVILLE),
        ev(['1'], SMALLVILLE),
      ],
      HALL_OF_FAME_PLACE_RULE,
    );
    expect(places.cells).toHaveLength(1);
    expect(places.cities).toEqual([{ city: 'Smallville', events: 3 }]);
  });

  it('is empty with no events', () => {
    const places = eventPlaces([], HALL_OF_FAME_PLACE_RULE);
    expect(places.cells).toEqual([]);
    expect(places.cities).toEqual([]);
    expect(total(places)).toBe(0);
  });
});
