import { describe, expect, it } from 'vitest';

import {
  AWARD_MAX_ROWS,
  AwardBoard,
  awardBoards,
  topPlaces,
} from '../../../src/lib/leaderboard/awards.js';
import {
  HostStreaks,
  LeaderboardEvent,
  Medal,
  eventsByHost,
} from '../../../src/lib/leaderboard/standings.js';

const entry = (id: string, value: number) => ({
  value,
  order: { name: id, id },
  row: { memberIds: [id] },
});

describe('topPlaces (Ties A)', () => {
  it('competition ranking; a tie for 10th runs the board past 10 rows', () => {
    const entries = [
      ...Array.from({ length: 9 }, (_, i) => entry(`a${i}`, 100 - i)),
      ...Array.from({ length: 4 }, (_, i) => entry(`t${i}`, 50)),
      entry('z', 10),
    ];
    const { rows, moreTied } = topPlaces(entries);
    expect(rows).toHaveLength(13);
    expect(rows.slice(9).map((r) => r.place)).toEqual([10, 10, 10, 10]);
    expect(moreTied).toBe(0);
  });

  it('a tie that starts above 10th but ends past it is kept whole; the next place is not', () => {
    const entries = [
      ...Array.from({ length: 8 }, (_, i) => entry(`a${i}`, 100 - i)),
      ...Array.from({ length: 5 }, (_, i) => entry(`t${i}`, 50)), // places 9
      entry('z', 10), // place 14
    ];
    const { rows } = topPlaces(entries);
    expect(rows.map((r) => r.place)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 9, 9,
    ]);
  });

  it('caps a mass tie at AWARD_MAX_ROWS and says how many more, at which place', () => {
    const entries = Array.from({ length: 40 }, (_, i) =>
      entry(`h${String(i).padStart(2, '0')}`, 1),
    );
    const { rows, moreTied, morePlace } = topPlaces(entries);
    expect(rows).toHaveLength(AWARD_MAX_ROWS);
    expect(moreTied).toBe(40 - AWARD_MAX_ROWS);
    expect(morePlace).toBe(1);
  });

  it('never places zero, and orders ties by the given key', () => {
    const { rows } = topPlaces([entry('b', 2), entry('a', 2), entry('c', 0)]);
    expect(rows.map((r) => [r.memberIds[0], r.place])).toEqual([
      ['a', 1],
      ['b', 1],
    ]);
  });
});

let seq = 0;
const ev = (
  day: string,
  hostIds: string[],
  title: string,
  attendance?: number,
): LeaderboardEvent => {
  seq += 1;
  return {
    id: String(seq),
    title,
    status: 'PAST',
    hostIds,
    day,
    eventUrl: `https://www.meetup.com/g/events/${seq}/`,
    attendance,
  };
};

const streak = (weekly: number, daily: number): HostStreaks => ({
  weekly: { current: 0, best: weekly },
  daily: { current: 0, best: daily },
});

describe('awardBoards', () => {
  const events = [
    ev('2026-09-01', ['1'], 'Board game night', 10),
    ev('2026-09-02', ['1'], 'Hot pot dinner', 20),
    ev('2026-09-03', ['1', '2', '1'], 'Hike at Mission Peak', 30),
    ev('2026-10-01', ['2'], 'Karaoke night', undefined),
    ev('2026-10-02', ['2'], 'Board game night', 30),
  ];
  const medals: Medal[] = [
    { month: '2026-08', memberId: '1', place: 1, events: 3 },
    { month: '2026-09', memberId: '1', place: 1, events: 3 },
    { month: '2026-09', memberId: '2', place: 2, events: 1 },
    { month: '2026-10', memberId: '2', place: 1, events: 2 },
  ];
  const boards = awardBoards({
    events,
    byHost: eventsByHost(events),
    streaks: new Map([
      ['1', streak(2, 3)],
      ['2', streak(4, 1)],
    ]),
    medals,
    names: new Map([
      ['1', 'Bea'],
      ['2', 'Bo'],
    ]),
  });
  const board = (key: AwardBoard['key']) => boards.find((b) => b.key === key);
  const table = (key: AwardBoard['key']) =>
    board(key).rows.map((r) => [r.memberIds.join('+'), r.value, r.place]);

  it('has the nine boards, in order', () => {
    expect(boards.map((b) => b.key)).toEqual([
      'attendees',
      'weeklyStreak',
      'dailyStreak',
      'golds',
      'medals',
      'bestMonth',
      'biggestEvent',
      'variety',
      'monthsActive',
    ]);
  });

  it('attendees: known attendance only, every co-host gets the event, and it says how many were left out', () => {
    expect(table('attendees')).toEqual([
      ['1', 60, 1],
      ['2', 60, 1],
    ]);
    expect(board('attendees').unknownAttendance).toBe(1);
  });

  it('streaks and medals', () => {
    expect(table('weeklyStreak')).toEqual([
      ['2', 4, 1],
      ['1', 2, 2],
    ]);
    expect(table('dailyStreak')).toEqual([
      ['1', 3, 1],
      ['2', 1, 2],
    ]);
    expect(table('golds')).toEqual([
      ['1', 2, 1],
      ['2', 1, 2],
    ]);
    expect(table('medals')).toEqual([
      ['1', 2, 1],
      ['2', 2, 1],
    ]);
  });

  it('best month names the month; months active counts distinct months', () => {
    expect(
      board('bestMonth').rows.map((r) => [r.memberIds[0], r.value, r.detail]),
    ).toEqual([
      ['1', 3, '2026-09'],
      ['2', 2, '2026-10'],
    ]);
    expect(table('monthsActive')).toEqual([
      ['2', 2, 1],
      ['1', 1, 2],
    ]);
  });

  it('biggest event: known attendance only, hosts deduped, ties the more recent first', () => {
    const rows = board('biggestEvent').rows;
    expect(rows.map((r) => [r.event?.title, r.memberIds, r.place])).toEqual([
      ['Board game night', ['2'], 1],
      ['Hike at Mission Peak', ['1', '2'], 1],
      ['Hot pot dinner', ['1'], 3],
      ['Board game night', ['1'], 4],
    ]);
    expect(rows[0].event?.eventUrl).toMatch(/\/events\/\d+\/$/);
  });

  it('variety counts distinct types and lists them', () => {
    expect(
      board('variety').rows.map((r) => [r.memberIds[0], r.value, r.detail]),
    ).toEqual([
      ['1', 3, 'Food & drink, Games, Outdoors'],
      ['2', 3, 'Games, Nightlife, Outdoors'],
    ]);
  });

  it('a medalist with no counted events stays on the medal boards', () => {
    // Host 9 won gold in 2025-03; their events were later cancelled.
    const withLapsed = awardBoards({
      events,
      byHost: eventsByHost(events),
      streaks: new Map(),
      medals: [
        ...medals,
        { month: '2025-03', memberId: '9', place: 1, events: 4 },
        { month: '2025-04', memberId: '9', place: 1, events: 3 },
        { month: '2025-05', memberId: '9', place: 1, events: 2 },
      ],
      names: new Map([['9', 'Cy']]),
    });
    const golds = withLapsed.find((b) => b.key === 'golds');
    expect(golds.rows[0]).toMatchObject({
      memberIds: ['9'],
      value: 3,
      place: 1,
    });
    const all = withLapsed.find((b) => b.key === 'medals');
    expect(all.rows.map((r) => r.memberIds[0])).toContain('9');
    // Not on boards that need counted events.
    const months = withLapsed.find((b) => b.key === 'monthsActive');
    expect(months.rows.map((r) => r.memberIds[0])).not.toContain('9');
  });

  it('ties go by name, then id, as rank() does ("Ann" before "Ann Lee")', () => {
    const tied = [
      ev('2026-09-01', ['10'], 'Games', 5),
      ev('2026-09-02', ['2'], 'Games', 5),
    ];
    const boardsByName = awardBoards({
      events: tied,
      byHost: eventsByHost(tied),
      streaks: new Map(),
      medals: [],
      names: new Map([
        ['10', 'Ann'],
        ['2', 'Ann Lee'],
      ]),
    });
    expect(
      boardsByName
        .find((b) => b.key === 'attendees')
        .rows.map((r) => r.memberIds[0]),
    ).toEqual(['10', '2']);
  });
});
