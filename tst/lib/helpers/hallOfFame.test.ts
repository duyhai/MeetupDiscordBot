import { describe, expect, it } from 'vitest';

import { Event } from '../../../src/lib/client/meetup/types.js';
import {
  collectHostStats,
  isCancelledEvent,
  formatHallOfFamePost,
} from '../../../src/lib/helpers/hallOfFame.js';

let nextId = 0;
export function makeEvent(overrides: Partial<Event> = {}): Event {
  nextId += 1;
  return {
    id: `e${nextId}`,
    title: `Event ${nextId}`,
    dateTime: '2026-09-05T18:00:00Z',
    eventUrl: `https://meetup.com/e${nextId}`,
    eventHosts: [],
    maxTickets: 10,
    status: 'PAST',
    ...overrides,
  };
}

export function host(id: string, name = `Host ${id}`) {
  return {
    member: {
      id,
      name,
      gender: 'NONE',
      memberUrl: `https://meetup.com/members/${id}`,
    },
  };
}

describe('isCancelledEvent', () => {
  it('matches cancelled titles in either spelling, any case', () => {
    expect(isCancelledEvent(makeEvent({ title: 'CANCELED: Hike' }))).toBe(true);
    expect(isCancelledEvent(makeEvent({ title: 'Trivia (cancelled)' }))).toBe(
      true,
    );
    expect(isCancelledEvent(makeEvent({ title: 'Trivia Night' }))).toBe(false);
  });

  it('matches cancelled statuses', () => {
    expect(isCancelledEvent(makeEvent({ status: 'CANCELLED' }))).toBe(true);
    expect(isCancelledEvent(makeEvent({ status: 'CANCELLED_PERM' }))).toBe(
      true,
    );
    expect(isCancelledEvent(makeEvent({ status: 'AUTOSCHED_CANCELLED' }))).toBe(
      true,
    );
    expect(isCancelledEvent(makeEvent({ status: 'PAST' }))).toBe(false);
  });

  it('does not match titles merely containing "cancel"', () => {
    expect(isCancelledEvent(makeEvent({ title: 'How to cancel plans' }))).toBe(
      false,
    );
  });
});

describe('collectHostStats', () => {
  it('groups events by host, sorted by count descending', () => {
    const events = [
      makeEvent({ eventHosts: [host('a')] }),
      makeEvent({ eventHosts: [host('b')] }),
      makeEvent({ eventHosts: [host('b')] }),
    ];
    const { hostStats, totalEvents } = collectHostStats(events);
    expect(totalEvents).toBe(3);
    expect(hostStats.map((s) => s.host.id)).toEqual(['b', 'a']);
    expect(hostStats[0].events).toHaveLength(2);
  });

  it('excludes cancelled and [Open House] events from stats and totals', () => {
    const events = [
      makeEvent({ eventHosts: [host('a')] }),
      makeEvent({ title: 'Canceled: Hike', eventHosts: [host('a')] }),
      makeEvent({ title: '[Open House] Social', eventHosts: [host('a')] }),
    ];
    const { hostStats, totalEvents } = collectHostStats(events);
    expect(totalEvents).toBe(1);
    expect(hostStats[0].events).toHaveLength(1);
  });

  it('counts a co-hosted event once in the total but once per host', () => {
    const events = [makeEvent({ eventHosts: [host('a'), host('b')] })];
    const { hostStats, totalEvents } = collectHostStats(events);
    expect(totalEvents).toBe(1);
    expect(hostStats).toHaveLength(2);
  });

  it('dedupes a host listed twice on one event', () => {
    const events = [makeEvent({ eventHosts: [host('a'), host('a')] })];
    const { hostStats } = collectHostStats(events);
    expect(hostStats[0].events).toHaveLength(1);
  });
});

describe('formatHallOfFamePost', () => {
  const events = [
    makeEvent({
      title: 'Trivia Night',
      dateTime: '2026-09-03T18:00:00Z',
      eventHosts: [host('a', 'Alice')],
    }),
    makeEvent({
      title: 'Trivia Night',
      dateTime: '2026-09-10T18:00:00Z',
      eventHosts: [host('a', 'Alice')],
    }),
    makeEvent({
      title: 'Hike',
      dateTime: '2026-09-06T09:00:00Z',
      eventHosts: [host('a', 'Alice'), host('b', 'Bob')],
    }),
  ];

  function post(newHostIds = new Set<string>()) {
    const { hostStats, totalEvents } = collectHostStats(events);
    return formatHallOfFamePost({
      periodLabel: 'September 2026',
      hostStats,
      totalEvents,
      newHostIds,
    });
  }

  it('collapses recurring titles with a count while still counting every occurrence', () => {
    const result = post();
    expect(result).toContain('Trivia Night ×2');
    expect(result).not.toMatch(/Trivia Night ×2[\s\S]*Trivia Night/);
    expect(result).toContain('#1: Alice — 3 events');
  });

  it('does not add ×1 to one-off events', () => {
    expect(post()).toContain('Hike (');
    expect(post()).not.toContain('Hike ×1');
  });

  it('flags new hosts and lists their co-hosts', () => {
    const result = post(new Set(['b']));
    expect(result).toContain('🆕');
    expect(result).toContain('New hosts: Bob (co-hosts: Alice)');
  });

  it('omits the new host section when there are none', () => {
    expect(post()).not.toContain('New hosts');
  });

  it('quotes totals computed from the data', () => {
    expect(post()).toContain('Hosts: 2');
    expect(post()).toContain('Events: 3');
  });
});
