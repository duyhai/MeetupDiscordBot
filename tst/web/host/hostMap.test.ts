import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { eventPlaces, total } from '../../../src/lib/leaderboard/places.js';
import { LeaderboardEvent } from '../../../src/lib/leaderboard/standings.js';
import {
  HALL_OF_FAME_PLACE_RULE,
  LEAFLET_VERSION,
  MAP_SCRIPT,
  PROFILE_MAP_MIN_EVENTS,
  PROFILE_PLACE_RULE,
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
  it('a profile map draws only areas with at least PROFILE_MAP_MIN_EVENTS, and names cities from those only', () => {
    const events = [
      ...Array.from({ length: PROFILE_MAP_MIN_EVENTS }, () => ev(seattle)),
      ev(home),
      ev(home),
      ev({ ...seattle, city: null }),
      ev(null),
      ev(undefined),
    ];
    const places = eventPlaces(events, PROFILE_PLACE_RULE);
    const out = hostMap(places, 'Bea has').value;
    expect(out).toContain(
      `data-map-cells="[[47.61,-122.33,4,&quot;4 events&quot;]]"`,
    );
    expect(out).not.toContain('47.7');
    expect(out).toContain('<li><bdi>Seattle</bdi>: 3 events</li>');
    // The undrawn home area is never named.
    expect(out).not.toContain('Shoreline');
    expect(out).toContain('<li>Elsewhere or unknown area: 1 event</li>');
    expect(out).toContain(
      '2 events in other areas (fewer than 3 events each) are not shown on the map or by city.',
    );
    expect(out).toContain(
      '1 event online or without a venue is not on the map.',
    );
    expect(out).toContain('Venue data for 1 event is still being collected.');
    expect(total(places)).toBe(events.length);
  });

  it('the hall of fame text says which areas are not drawn and why', () => {
    const out = hostMap(
      eventPlaces([ev(home), ev(home)], HALL_OF_FAME_PLACE_RULE),
      'the group has',
    ).value;
    expect(out).not.toContain('data-map-cells');
    // A sentence with no number, and every count a band.
    expect(out).toContain(
      'Areas with fewer than 3 events, or mostly one host’s, are not drawn; their events are counted above.',
    );
    expect(out).toContain('<li>Elsewhere or unknown area: up to 5 events</li>');
    expect(out).not.toContain('Shoreline');
    expect(out).not.toMatch(/\b2 events\b/);
  });

  it('the hall of fame lists same-band cells by position and cities by band then name, never exact counts', () => {
    const at = (latE2: number, city: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        ...ev({ latE2, lonE2: -12233, city }),
        hostIds: [String(i)],
      }));
    // 10, 8 and 6 events: all "6–10", listed north to south by latitude.
    const events = [
      ...at(4770, 'Kirkland', 10),
      ...at(4750, 'Burien', 6),
      ...at(4761, 'Seattle', 8),
      ...at(4780, 'Bothell', 30),
    ];
    const places = eventPlaces(events, HALL_OF_FAME_PLACE_RULE);
    expect(places.cells.map((c) => c.lat)).toEqual([47.5, 47.61, 47.7, 47.8]);
    const out = hostMap(places, 'the group has').value;
    expect(out).toContain(
      'data-map-cells="[[47.5,-122.33,2,&quot;6–10 events&quot;],[47.61,-122.33,2,&quot;6–10 events&quot;],' +
        '[47.7,-122.33,2,&quot;6–10 events&quot;],[47.8,-122.33,4,&quot;26+ events&quot;]]"',
    );
    const list = out.slice(out.indexOf('<ul class="map-cities">'));
    const order = ['Bothell', 'Burien', 'Kirkland', 'Seattle'].map((c) =>
      list.indexOf(c),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(list).toContain('<li><bdi>Kirkland</bdi>: 6–10 events</li>');
    expect(list).not.toMatch(/: (10|8|6|30) events/);
    // The buckets themselves stay exact and add up.
    expect(total(places)).toBe(events.length);
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

  it('the versioned asset URLs name the Leaflet actually installed', () => {
    const require = createRequire(import.meta.url);
    const pkg = require('leaflet/package.json') as { version: string };
    expect(LEAFLET_VERSION).toBe(pkg.version);
  });

  it('the hall of fame embeds count bands, never exact counts', () => {
    const many = Array.from({ length: 7 }, (_, n) => ({
      ...ev(seattle),
      hostIds: [String(n)],
    }));
    const out = hostMap(
      eventPlaces(many, HALL_OF_FAME_PLACE_RULE),
      'the group has',
    ).value;
    expect(out).toContain(
      'data-map-cells="[[47.61,-122.33,2,&quot;6–10 events&quot;]]"',
    );
    expect(out).not.toMatch(/data-map-cells="[^"]*\b7\b/);
  });
});
