import { describe, expect, it } from 'vitest';

import { countMemberEventsInGroup } from '../../../src/lib/helpers/eventStats.js';

const OUR_GROUP = '7595882';
const PAST = '2020-01-01T18:00:00-08:00';
const FUTURE = '2999-01-01T18:00:00-08:00';

const ev = (id: string, groupId: string, dateTime: string) => ({
  id,
  dateTime,
  group: { id: groupId },
});

describe('countMemberEventsInGroup', () => {
  it('counts only past events belonging to our group', () => {
    const events = [
      ev('a', OUR_GROUP, PAST),
      ev('b', OUR_GROUP, PAST),
      // memberEvents spans every group the member belongs to -- a probe
      // against the live API returned a Godot Seattle event (group 1518941)
      // alongside ours, so the group filter is load-bearing, not defensive.
      ev('c', '1518941', PAST),
      // Upcoming events must not earn a badge yet.
      ev('d', OUR_GROUP, FUTURE),
    ];

    expect(countMemberEventsInGroup(events, OUR_GROUP)).toBe(2);
  });

  it('returns zero when the member has no events in our group', () => {
    expect(
      countMemberEventsInGroup([ev('c', '1518941', PAST)], OUR_GROUP),
    ).toBe(0);
    expect(countMemberEventsInGroup([], OUR_GROUP)).toBe(0);
  });

  it('does not double-count a repeated event id', () => {
    const events = [
      ev('a', OUR_GROUP, PAST),
      ev('a', OUR_GROUP, PAST),
      ev('b', OUR_GROUP, PAST),
    ];

    expect(countMemberEventsInGroup(events, OUR_GROUP)).toBe(2);
  });

  it('treats a missing group as not ours rather than throwing', () => {
    const events = [
      { id: 'x', dateTime: PAST } as unknown as ReturnType<typeof ev>,
      ev('a', OUR_GROUP, PAST),
    ];

    expect(countMemberEventsInGroup(events, OUR_GROUP)).toBe(1);
  });
});
