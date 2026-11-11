import { describe, expect, it } from 'vitest';

import { PaginatedData } from '../../../src/lib/client/meetup/types.js';
import {
  SnapshotMeetup,
  listAllEvents,
  readEventRsvps,
} from '../../../src/lib/snapshot/read.js';

function page<T>(nodes: T[], next: string | undefined): PaginatedData<T> {
  return {
    edges: nodes.map((node) => ({ node })),
    pageInfo: {
      hasNextPage: next !== undefined,
      hasPreviousPage: false,
      startCursor: '',
      endCursor: next ?? '',
    },
    totalCount: nodes.length,
  };
}

const ev = (id: string, status = 'PAST') => ({
  id,
  title: `E${id}`,
  status,
  dateTime: '2025-05-01T18:00:00Z',
  eventUrl: `https://www.meetup.com/g/events/${id}/`,
  eventHosts: [],
  attendance: { totalCount: 1 },
  waitlist: { totalCount: 0 },
});

describe('listAllEvents', () => {
  it('pages PAST and CANCELLED, then ACTIVE, counting each call, deduped', async () => {
    const filters: unknown[] = [];
    const meetup: SnapshotMeetup = {
      getGroupEventsForSnapshot: async (input, filter) => {
        filters.push({ after: input.after, status: filter.status });
        if (filter.status?.includes('ACTIVE')) {
          return page([ev('3', 'ACTIVE'), ev('2', 'ACTIVE')], undefined);
        }
        return input.after
          ? page([ev('2'), { id: 'bad' }], undefined)
          : page([ev('1')], 'c1');
      },
      getEventRsvpsForSnapshot: async () => null,
    };
    const calls = { n: 0 };
    const result = await listAllEvents(meetup, calls);
    expect(calls.n).toBe(3);
    expect(filters).toEqual([
      { after: undefined, status: ['PAST', 'CANCELLED'] },
      { after: 'c1', status: ['PAST', 'CANCELLED'] },
      { after: undefined, status: ['ACTIVE'] },
    ]);
    expect(result.events.map((e) => [e.eventId, e.status])).toEqual([
      ['1', 'PAST'],
      ['2', 'ACTIVE'],
      ['3', 'ACTIVE'],
    ]);
    expect(result.pastSeen).toBe(1);
    expect(result.dropped).toBe(1);
  });
});

describe('readEventRsvps', () => {
  it('reads every page and drops other statuses', async () => {
    const rsvp = (id: number, status = 'YES') => ({
      status,
      member: { id: String(id) },
    });
    const pages = [
      page(
        Array.from({ length: 100 }, (_, i) => rsvp(i + 1)),
        'p1',
      ),
      page(
        Array.from({ length: 100 }, (_, i) => rsvp(i + 101, 'ATTENDED')),
        'p2',
      ),
      page(
        [
          ...Array.from({ length: 50 }, (_, i) => rsvp(i + 201, 'WAITLIST')),
          rsvp(999, 'NO'),
        ],
        undefined,
      ),
    ];
    let i = 0;
    const meetup: SnapshotMeetup = {
      getGroupEventsForSnapshot: async () => page([], undefined),
      getEventRsvpsForSnapshot: async () => pages[i++],
    };
    const calls = { n: 0 };
    const rsvps = await readEventRsvps(meetup, '7', calls);
    expect(calls.n).toBe(3);
    expect(rsvps).toHaveLength(250);
    expect(rsvps?.some((r) => r.memberId === '999')).toBe(false);
  });

  it('answers null when Meetup has no such event', async () => {
    const meetup: SnapshotMeetup = {
      getGroupEventsForSnapshot: async () => page([], undefined),
      getEventRsvpsForSnapshot: async () => null,
    };
    expect(await readEventRsvps(meetup, '7', { n: 0 })).toBeNull();
  });

  it('propagates an error', async () => {
    const meetup: SnapshotMeetup = {
      getGroupEventsForSnapshot: async () => page([], undefined),
      getEventRsvpsForSnapshot: async () => {
        throw new TypeError('boom');
      },
    };
    await expect(readEventRsvps(meetup, '7', { n: 0 })).rejects.toThrow(
      TypeError,
    );
  });
});
