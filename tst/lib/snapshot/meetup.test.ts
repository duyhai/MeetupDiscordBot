import { describe, expect, it } from 'vitest';

import { parse, visit } from 'graphql';
import {
  getEventRsvpsForSnapshot,
  getGroupEventsForSnapshot,
} from '../../../src/lib/client/meetup/queries.js';

import { TITLE_MAX } from '../../../src/lib/eventAudit/meetup.js';
import { GQL_EXT_TYPES } from '../../fixtures/gqlExtFields.js';
import {
  HOST_NAME_MAX,
  toPlace,
  toSnapshotEvent,
  toSnapshotRsvp,
} from '../../../src/lib/snapshot/meetup.js';

const URL = 'https://www.meetup.com/some-group/events/301234567/';

const node = (over: Record<string, unknown> = {}) => ({
  id: '301234567',
  title: '  Board game night  ',
  dateTime: '2024-03-02T19:00:00-08:00',
  eventUrl: URL,
  status: 'PAST',
  eventHosts: [
    { member: { id: '111', name: ' Ana ' } },
    { member: { id: '222', name: 'Bo' } },
  ],
  attendance: { totalCount: 14 },
  waitlist: { totalCount: 2 },
  ...over,
});

describe('toSnapshotEvent', () => {
  it('keeps a well-formed node', () => {
    expect(toSnapshotEvent(node())).toEqual({
      eventId: '301234567',
      title: 'Board game night',
      dateTime: new Date('2024-03-03T03:00:00.000Z'),
      eventUrl: URL,
      status: 'PAST',
      hostIds: ['111', '222'],
      hostNames: { '111': 'Ana', '222': 'Bo' },
      yesCount: 14,
      waitlistCount: 2,
      place: null,
    });
  });

  it('drops a node without a digit id or a usable start', () => {
    expect(toSnapshotEvent(node({ id: 'abc' }))).toBeUndefined();
    expect(toSnapshotEvent(node({ dateTime: undefined }))).toBeUndefined();
    expect(toSnapshotEvent(node({ dateTime: 'not a date' }))).toBeUndefined();
    expect(toSnapshotEvent(null)).toBeUndefined();
  });

  it('nulls a foreign URL and bad counts, bounds the title, marks unknown statuses', () => {
    const event = toSnapshotEvent(
      node({
        eventUrl: 'javascript:alert(1)',
        title: 'x'.repeat(TITLE_MAX + 50),
        status: 'WEIRD',
        attendance: { totalCount: -1 },
        waitlist: { totalCount: 1.5 },
        eventHosts: [{ member: { id: 'nope' } }, { member: { id: '333' } }],
      }),
    );
    expect(event?.eventUrl).toBeNull();
    expect(event?.title).toHaveLength(TITLE_MAX);
    expect(event?.status).toBe('UNKNOWN');
    expect(event?.yesCount).toBeNull();
    expect(event?.waitlistCount).toBeNull();
    expect(event?.hostIds).toEqual(['333']);
  });

  it('keeps host names bounded and drops blank ones or unusable ids', () => {
    const event = toSnapshotEvent(
      node({
        eventHosts: [
          { member: { id: '111', name: 'n'.repeat(HOST_NAME_MAX + 9) } },
          { member: { id: '222', name: '   ' } },
          { member: { id: 'x', name: 'Eve' } },
          { member: { id: '333' } },
          { member: { id: '444', name: 'Ze\u0000ro\u0007 ' } },
        ],
      }),
    );
    expect(event?.hostIds).toEqual(['111', '222', '333', '444']);
    expect(event?.hostNames).toEqual({
      '111': 'n'.repeat(HOST_NAME_MAX),
      '444': 'Zero',
    });
  });

  it('tolerates missing hosts and counts', () => {
    const event = toSnapshotEvent(
      node({ eventHosts: null, attendance: null, waitlist: undefined }),
    );
    expect(event?.hostIds).toEqual([]);
    expect(event?.yesCount).toBeNull();
  });
});

describe('toSnapshotRsvp', () => {
  it('keeps YES, WAITLIST and ATTENDED', () => {
    for (const status of ['YES', 'WAITLIST', 'ATTENDED']) {
      expect(toSnapshotRsvp({ status, member: { id: '42' } })).toEqual({
        memberId: '42',
        status,
      });
    }
  });

  it('drops other statuses and unusable members', () => {
    expect(
      toSnapshotRsvp({ status: 'NO', member: { id: '42' } }),
    ).toBeUndefined();
    expect(toSnapshotRsvp({ status: 'YES', member: null })).toBeUndefined();
    expect(
      toSnapshotRsvp({ status: 'YES', member: { id: 'x' } }),
    ).toBeUndefined();
    expect(toSnapshotRsvp(undefined)).toBeUndefined();
  });
});

describe('toPlace', () => {
  const venue = (over: Record<string, unknown> = {}) => ({
    eventType: 'PHYSICAL',
    venue: { lat: 47.61234, lon: -122.33567, city: ' Seattle ' },
    ...over,
  });

  it('keeps only a ~1 km grid cell and the city, never the exact coordinates', () => {
    expect(toPlace(venue())).toEqual({
      latE2: 4761,
      lonE2: -12234,
      city: 'Seattle',
    });
    expect(toPlace(venue({ eventType: 'HYBRID' }))?.latE2).toBe(4761);
  });

  it('leaves out online events, missing venues, the 0,0 placeholder and bad coordinates', () => {
    // gql-ext has no isOnline: only the ONLINE type counts.
    expect(toPlace(venue({ isOnline: true }))).not.toBeNull();
    expect(toPlace(venue({ eventType: 'ONLINE' }))).toBeNull();
    expect(toPlace(venue({ venue: null }))).toBeNull();
    expect(toPlace(venue({ venue: { lat: 0, lon: 0, city: 'X' } }))).toBeNull();
    expect(toPlace(venue({ venue: { lat: 0.2, lon: -0.1 } }))).toBeNull();
    expect(toPlace(venue({ venue: { lat: 91, lon: 10 } }))).toBeNull();
    expect(toPlace(venue({ venue: { lat: '47.6', lon: -122.3 } }))).toBeNull();
    expect(
      toPlace(venue({ venue: { lat: Number.NaN, lon: -122.3 } })),
    ).toBeNull();
    expect(toPlace(null)).toBeNull();
  });

  it('strips C1 controls and bidi or zero-width format characters from the city', () => {
    const city = (raw: string) =>
      toPlace(venue({ venue: { lat: 47.6, lon: -122.3, city: raw } }))?.city;
    expect(city('\u202Eelttaes')).toBe('elttaes');
    expect(city('Sea\u0085ttle\u200B')).toBe('Seattle');
    expect(city('\u2066Seattle\u2069')).toBe('Seattle');
  });

  it('cleans the city: no control characters, bounded, null when blank', () => {
    expect(
      toPlace(
        venue({ venue: { lat: 47.6, lon: -122.3, city: 'Sea\u0000ttle' } }),
      )?.city,
    ).toBe('Seattle');
    expect(
      toPlace(
        venue({ venue: { lat: 47.6, lon: -122.3, city: 'x'.repeat(200) } }),
      )?.city,
    ).toHaveLength(80);
    expect(
      toPlace(venue({ venue: { lat: 47.6, lon: -122.3, city: '  ' } }))?.city,
    ).toBeNull();
  });
});

describe('snapshot queries', () => {
  const text = (doc: unknown) => String(doc);

  it("the listing asks for counts and host ids, and no name but the hosts'", () => {
    const q = text(getGroupEventsForSnapshot);
    expect(q).toMatch(
      /attendance: rsvps\(filter: \{ rsvpStatus: \[YES, ATTENDED\] \}\)/,
    );
    expect(q).toMatch(
      /waitlist: rsvps\(filter: \{ rsvpStatus: \[WAITLIST\] \}\)/,
    );
    expect(q).toMatch(/eventHosts \{\s*member \{\s*id\s*name\s*\}\s*\}/);
    expect(q.match(/\bname\b/g)).toHaveLength(1);
    // The venue: coordinates and city only (rounded at ingest), no address.
    expect(q).toMatch(/eventType\s*venue \{\s*lat\s*lon\s*city\s*\}/);
    expect(q).not.toMatch(/address|postalCode|googleMapsUrl/);
  });

  it('the RSVP read asks for member ids only', () => {
    const q = text(getEventRsvpsForSnapshot);
    expect(q).toMatch(/member \{\s*id\s*\}/);
    expect(q).not.toMatch(/\bname\b|UserDetails/);
  });

  describe('the snapshot queries against gql-ext', () => {
    /**
     * Every field of the document, with the gql-ext type it sits on, by
     * walking it with graphql's visit. Fragments are refused: they could
     * select a field on a type this walk does not follow.
     */
    function fieldsOf(document: unknown): string[] {
      const types: (string | null)[] = [];
      const seen: string[] = [];
      visit(parse(String(document)), {
        OperationDefinition: {
          enter: () => {
            types.push('Query');
          },
          leave: () => {
            types.pop();
          },
        },
        FragmentSpread: () => {
          throw new Error('fragment spread');
        },
        InlineFragment: () => {
          throw new Error('inline fragment');
        },
        FragmentDefinition: () => {
          throw new Error('fragment definition');
        },
        Field: {
          enter: (node) => {
            const parent = types[types.length - 1];
            const name = node.name.value;
            if (parent === null || parent === undefined) {
              throw new Error(`${name} selected under a leaf`);
            }
            const fields = GQL_EXT_TYPES[parent];
            if (!fields || !(name in fields)) {
              throw new Error(`${parent}.${name} is not a gql-ext field`);
            }
            seen.push(`${parent}.${name}`);
            types.push(node.selectionSet ? fields[name] : null);
          },
          leave: () => {
            types.pop();
          },
        },
      });
      return seen;
    }

    it('the listing asks only for gql-ext fields, all the way down', () => {
      const fields = fieldsOf(getGroupEventsForSnapshot);
      expect(fields).toContain('Event.venue');
      expect(fields).toContain('Venue.lat');
      expect(fields).not.toContain('Event.isOnline');
      expect(fields.filter((f) => f.startsWith('Venue.'))).toEqual([
        'Venue.lat',
        'Venue.lon',
        'Venue.city',
      ]);
    });

    it('the RSVP read asks only for gql-ext fields', () => {
      expect(fieldsOf(getEventRsvpsForSnapshot)).toContain('Rsvp.status');
    });

    it('the walk catches what a path check would miss', () => {
      expect(() =>
        fieldsOf('query { event(id: 1) { ... on Event { isOnline } } }'),
      ).toThrow('inline fragment');
      expect(() =>
        fieldsOf('query { event(id: 1) { rsvps { madeUp } } }'),
      ).toThrow('RsvpConnection.madeUp is not a gql-ext field');
      expect(() => fieldsOf('query { event(id: 1) { isOnline } }')).toThrow(
        'Event.isOnline is not a gql-ext field',
      );
      expect(() =>
        fieldsOf('query { event(id: 1) { title { nested } } }'),
      ).toThrow('nested selected under a leaf');
    });
  });
});
