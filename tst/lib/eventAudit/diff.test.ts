import { describe, expect, it } from 'vitest';

import {
  deletionChange,
  diffEvent,
  isRsvpDrop,
} from '../../../src/lib/eventAudit/diff.js';
import { EventObservation } from '../../../src/lib/eventAudit/types.js';

const START = new Date('2026-12-05T19:00:00-08:00');

export const obs = (
  overrides: Partial<EventObservation> = {},
): EventObservation => ({
  eventId: '311000001',
  title: 'Board games',
  status: 'ACTIVE',
  startAt: START,
  duration: 'PT2H',
  eventUrl: 'https://www.meetup.com/g/events/311000001/',
  venueId: '27',
  photoId: '500',
  hosts: [{ id: '4242', name: 'Hana' }],
  rsvpYes: 20,
  waitlist: 2,
  rsvpsClosed: false,
  lastEditedAt: null,
  ...overrides,
});

describe('isRsvpDrop', () => {
  it.each([
    [20, 16, false],
    [100, 95, true],
    [10, 7, true],
    [0, 0, false],
    [null, 3, false],
    [20, null, false],
    [4, 0, true],
  ])('%s -> %s is %s', (prev, next, expected) => {
    expect(isRsvpDrop(prev, next)).toBe(expected);
  });
});

describe('diffEvent', () => {
  const live = { baseline: false };

  it('a new event is created, unless this is the baseline run', () => {
    const next = obs();
    expect(diffEvent(undefined, next, live)).toEqual([
      expect.objectContaining({
        kind: 'created',
        eventId: '311000001',
        oldValue: null,
        newValue: {
          title: 'Board games',
          startAt: START.toISOString(),
          hosts: [{ id: '4242', name: 'Hana' }],
        },
        hosts: [{ id: '4242', name: 'Hana' }],
        rsvpYes: 20,
        waitlist: 2,
      }),
    ]);
    expect(diffEvent(undefined, next, { baseline: true })).toEqual([]);
  });

  it('nothing for an unchanged event', () => {
    expect(diffEvent(obs(), obs(), live)).toEqual([]);
  });

  it('cancelled once, never again', () => {
    const changes = diffEvent(obs(), obs({ status: 'CANCELLED' }), live);
    expect(changes).toEqual([
      expect.objectContaining({
        kind: 'cancelled',
        oldValue: { status: 'ACTIVE' },
        newValue: { status: 'CANCELLED' },
      }),
    ]);
    expect(
      diffEvent(
        obs({ status: 'CANCELLED' }),
        obs({ status: 'CANCELLED_PERM' }),
        live,
      ),
    ).toEqual([]);
  });

  it('host changes carry both lists and the union as the likely actors; order is ignored', () => {
    const ken = { id: '5151', name: 'Ken' };
    const hana = { id: '4242', name: 'Hana' };
    const changes = diffEvent(obs(), obs({ hosts: [hana, ken] }), live);
    expect(changes).toEqual([
      expect.objectContaining({
        kind: 'host_changed',
        oldValue: { hosts: [hana] },
        newValue: { hosts: [hana, ken] },
        hosts: [hana, ken],
      }),
    ]);
    expect(
      diffEvent(obs({ hosts: [hana, ken] }), obs({ hosts: [ken, hana] }), live),
    ).toEqual([]);
    const removed = diffEvent(
      obs({ hosts: [hana, ken] }),
      obs({ hosts: [ken] }),
      live,
    );
    expect(removed[0].hosts).toEqual([hana, ken]);
  });

  it('a moved start and a changed title, with ISO strings', () => {
    const later = new Date('2026-12-05T20:00:00-08:00');
    expect(diffEvent(obs(), obs({ startAt: later }), live)).toEqual([
      expect.objectContaining({
        kind: 'start_moved',
        oldValue: { startAt: START.toISOString() },
        newValue: { startAt: later.toISOString() },
        startAt: later,
      }),
    ]);
    expect(diffEvent(obs(), obs({ title: 'Card games' }), live)).toEqual([
      expect.objectContaining({
        kind: 'title_changed',
        oldValue: { title: 'Board games' },
        newValue: { title: 'Card games' },
        title: 'Card games',
      }),
    ]);
  });

  it('an RSVP drop of 5 or 25 %, not less', () => {
    expect(diffEvent(obs(), obs({ rsvpYes: 14, waitlist: 0 }), live)).toEqual([
      expect.objectContaining({
        kind: 'rsvp_drop',
        oldValue: { rsvpYes: 20, waitlist: 2 },
        newValue: { rsvpYes: 14, waitlist: 0 },
        rsvpYes: 14,
      }),
    ]);
    expect(diffEvent(obs(), obs({ rsvpYes: 17 }), live)).toEqual([]);
  });

  it('RSVPs closing, not opening or unknown', () => {
    expect(diffEvent(obs(), obs({ rsvpsClosed: true }), live)).toEqual([
      expect.objectContaining({
        kind: 'rsvps_closed',
        oldValue: { rsvpsClosed: false },
        newValue: { rsvpsClosed: true },
      }),
    ]);
    expect(
      diffEvent(obs({ rsvpsClosed: true }), obs({ rsvpsClosed: false }), live),
    ).toEqual([]);
    expect(
      diffEvent(obs({ rsvpsClosed: null }), obs({ rsvpsClosed: true }), live),
    ).toEqual([]);
  });

  it('several changes at once, in table order', () => {
    const later = new Date('2026-12-06T19:00:00-08:00');
    const kinds = diffEvent(
      obs(),
      obs({ startAt: later, hosts: [{ id: '5151', name: 'Ken' }] }),
      live,
    ).map((c) => c.kind);
    expect(kinds).toEqual(['host_changed', 'start_moved']);
  });
});

describe('deletionChange', () => {
  it('records what was last known', () => {
    expect(deletionChange(obs())).toEqual({
      eventId: '311000001',
      kind: 'deleted',
      oldValue: { status: 'ACTIVE', startAt: START.toISOString(), rsvpYes: 20 },
      newValue: null,
      title: 'Board games',
      startAt: START,
      eventUrl: 'https://www.meetup.com/g/events/311000001/',
      hosts: [{ id: '4242', name: 'Hana' }],
      rsvpYes: 20,
      waitlist: 2,
    });
  });
});
