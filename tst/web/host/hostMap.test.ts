import { describe, expect, it } from 'vitest';

import { eventPlaces } from '../../../src/lib/leaderboard/places.js';
import { LeaderboardEvent } from '../../../src/lib/leaderboard/standings.js';
import {
  MAP_SCRIPT,
  PROFILE_MAP_MIN_EVENTS,
  hostMap,
} from '../../../src/web/host/hostMap.js';

let seq = 0;
const ev = (place: LeaderboardEvent['place']): LeaderboardEvent => {
  seq += 1;
  return {
    id: String(seq),
    title: 'Games',
    status: 'PAST',
    hostIds: ['1'],
    day: '2026-10-01',
    place,
  };
};
const seattle = { latE2: 4761, lonE2: -12233, city: 'Seattle' };
const home = { latE2: 4770, lonE2: -12240, city: 'Shoreline' };

describe('hostMap', () => {
  it('a profile map draws only areas with at least PROFILE_MAP_MIN_EVENTS; the text still counts every event', () => {
    const events = [
      ...Array.from({ length: PROFILE_MAP_MIN_EVENTS }, () => ev(seattle)),
      ev(home),
      ev(home),
      ev({ ...seattle, city: null }),
      ev(null),
      ev(undefined),
    ];
    const out = hostMap(
      eventPlaces(events, { minEventsPerCell: PROFILE_MAP_MIN_EVENTS }),
      'Bea has',
      PROFILE_MAP_MIN_EVENTS,
    ).value;
    expect(out).toContain(
      `data-map-cells="[[47.61,-122.33,${PROFILE_MAP_MIN_EVENTS + 1}]]"`,
    );
    expect(out).not.toContain('47.7');
    expect(out).toContain('<li><bdi>Seattle</bdi>: 3 events</li>');
    expect(out).toContain('<li><bdi>Shoreline</bdi>: 2 events</li>');
    expect(out).toContain('<li>Elsewhere or unknown area: 1 event</li>');
    expect(out).toContain(
      '2 events in other areas (fewer than 3 events each) are counted above but not drawn.',
    );
    expect(out).toContain(
      '1 event online or without a venue is not on the map.',
    );
    expect(out).toContain('Venue data for 1 event is still being collected.');
  });

  it('says venue data is still being collected when none has been yet', () => {
    const out = hostMap(eventPlaces([ev(undefined), ev(undefined)]), 'x').value;
    expect(out).toContain('Venue data is still being collected');
    expect(out).not.toContain('data-map-cells');
  });

  it('the map container is a labelled region, hidden until the script draws it', () => {
    const out = hostMap(eventPlaces([ev(seattle)]), 'the group has').value;
    expect(out).toMatch(
      /<div\s+class="map"\s+role="region"\s+aria-label="Map of hosted areas[^"]*"/,
    );
    expect(out).toMatch(/data-map-cells="[^"]*"\s+hidden/);
  });

  it('draws areas, not pins, and stops zooming at 13', () => {
    const script = MAP_SCRIPT.value;
    expect(script).toContain('L.rectangle(');
    expect(script).not.toContain('circleMarker');
    expect(script).toContain('maxZoom:13');
    expect(script).not.toMatch(/maxZoom:1[4-9]/);
    expect(script).toContain("referrerPolicy:'origin'");
    expect(script).toContain('openstreetmap.org/copyright');
  });
});
