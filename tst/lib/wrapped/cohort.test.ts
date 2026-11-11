import { describe, expect, it } from 'vitest';

import {
  earlyEventIdsToFetch,
  rankCohort,
} from '../../../src/lib/wrapped/cohort.js';
import { Companion, WrappedEvent } from '../../../src/lib/wrapped/stats.js';

function ev(id: string): WrappedEvent {
  return {
    id,
    title: `Event ${id}`,
    dateTime: '2023-01-05T19:00:00-08:00',
    eventUrl: `https://www.meetup.com/e/${id}/`,
  };
}

const companion = (meetupId: string, sharedCount: number): Companion => ({
  meetupId,
  sharedCount,
  sharedEventIds: Array.from({ length: sharedCount }, (_, i) => `y${i}`),
});

describe('rankCohort', () => {
  it('ranks early-event people who also shared an event this year', () => {
    const ranked = rankCohort(
      [ev('e1'), ev('e2')],
      { e1: ['self', 'a', 'b'], e2: ['a', 'c'] },
      [companion('a', 3), companion('b', 1)],
      'self',
    );

    expect(ranked).toEqual([
      { meetupId: 'a', earlyCount: 2, sharedCount: 3 },
      { meetupId: 'b', earlyCount: 1, sharedCount: 1 },
    ]);
  });

  it('excludes self and dedupes within an event', () => {
    const ranked = rankCohort(
      [ev('e1')],
      { e1: ['self', 'self', 'a', 'a'] },
      [companion('a', 1), companion('self', 9)],
      'self',
    );

    expect(ranked).toEqual([{ meetupId: 'a', earlyCount: 1, sharedCount: 1 }]);
  });

  it('breaks ties by shared count, then numeric id', () => {
    const ranked = rankCohort(
      [ev('e1')],
      { e1: ['10', '9', '7'] },
      [companion('10', 2), companion('9', 2), companion('7', 5)],
      'self',
    );

    expect(ranked.map((c) => c.meetupId)).toEqual(['7', '9', '10']);
  });

  it('is empty when nobody from the early events shared an event this year', () => {
    expect(rankCohort([ev('e1')], { e1: ['a'] }, [], 'self')).toEqual([]);
  });
});

describe('earlyEventIdsToFetch', () => {
  it('lists every type’s first events once, skipping ones fetched this year', () => {
    const ids = earlyEventIdsToFetch(
      [
        { firstEvents: [ev('a'), ev('b'), ev('y1')] },
        { firstEvents: [ev('b'), ev('c')] },
      ],
      ['y1', 'y2'],
    );

    expect(ids).toEqual(['a', 'b', 'c']);
  });
});
