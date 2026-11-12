import { describe, expect, it } from 'vitest';

import {
  getEventRsvpsForSnapshot,
  getGroupEventsForSnapshot,
} from '../../../src/lib/client/meetup/queries.js';
import { TITLE_MAX } from '../../../src/lib/eventAudit/meetup.js';
import {
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
  eventHosts: [{ member: { id: '111' } }, { member: { id: '222' } }],
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
      yesCount: 14,
      waitlistCount: 2,
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

describe('snapshot queries', () => {
  const text = (doc: unknown) => String(doc);

  it('the listing asks for counts and host ids, never names', () => {
    const q = text(getGroupEventsForSnapshot);
    expect(q).toMatch(
      /attendance: rsvps\(filter: \{ rsvpStatus: \[YES, ATTENDED\] \}\)/,
    );
    expect(q).toMatch(
      /waitlist: rsvps\(filter: \{ rsvpStatus: \[WAITLIST\] \}\)/,
    );
    expect(q).toMatch(/eventHosts \{\s*member \{\s*id\s*\}\s*\}/);
    expect(q).not.toMatch(/\bname\b/);
  });

  it('the RSVP read asks for member ids only', () => {
    const q = text(getEventRsvpsForSnapshot);
    expect(q).toMatch(/member \{\s*id\s*\}/);
    expect(q).not.toMatch(/\bname\b|UserDetails/);
  });
});
