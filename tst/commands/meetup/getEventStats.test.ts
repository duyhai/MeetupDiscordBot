import { describe, expect, it, vi } from 'vitest';

import { getEventsYearMonth } from '../../../src/commands/meetup/getEventStats.js';
import { GqlMeetupClient } from '../../../src/lib/client/meetup/gqlClient.js';
import { GroupEventFilter } from '../../../src/lib/client/meetup/types.js';

describe('getEventsYearMonth', () => {
  // A recurring series can generate a copy of an event that already exists:
  // same title, time, and hosts, status AUTOSCHED, never becoming PAST. The
  // Hall of Fame credited Howard with two Sept 5 strolls because of one.
  // Every report built on this query should see each real event once.
  it('does not fetch auto-scheduled copies of events', async () => {
    const filters: GroupEventFilter[] = [];
    const client = {
      getGroupEvents: vi.fn((_page: unknown, filter: GroupEventFilter) => {
        filters.push(filter);
        return Promise.resolve({
          groupByUrlname: {
            events: {
              edges: [],
              pageInfo: { hasNextPage: false, endCursor: '' },
              totalCount: 0,
            },
          },
        });
      }),
    } as unknown as GqlMeetupClient;

    await getEventsYearMonth(client, 2026, 9);

    expect(filters).toHaveLength(1);
    expect(filters[0].status).toEqual(['PAST', 'ACTIVE']);
  });
});
