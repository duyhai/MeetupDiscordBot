import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';

import {
  BaseUserInfo,
  EventSummary,
} from '../../../src/lib/client/meetup/types.js';
import {
  NoShowCase,
  actByDate,
  buildNoShowCases,
  classifyNoShowCount,
  countableNoShows,
  formatNoShowReport,
  formatSuspensionCsv,
  nextEvent,
  recommendedSuspensionDays,
  suspensionHistory,
  tallyNoShows,
} from '../../../src/lib/helpers/noShowReport.js';
import { parseSuspensionCsv } from '../../../src/lib/helpers/suspensionCsv.js';
import { SuspensionRecord } from '../../../src/lib/repositories/types.js';

function member(id: string, name = `Member ${id}`): BaseUserInfo {
  return {
    id,
    name,
    gender: 'NONE',
    memberUrl: `https://meetup.com/members/${id}`,
  };
}

let nextId = 0;
function event(dateTime: string, title = 'Event'): EventSummary {
  nextId += 1;
  return {
    id: `e${nextId}`,
    title,
    dateTime,
    eventUrl: `https://meetup.com/e${nextId}`,
  };
}

function suspension(memberId: string, day: string): SuspensionRecord {
  return {
    id: 1,
    memberId,
    memberName: null,
    suspendedAt: new Date(`${day}T00:00:00Z`),
    durationDays: 30,
    notes: null,
    createdAt: new Date(),
  };
}

// 2026-09-28, mid-afternoon in Seattle.
const now = dayjs('2026-09-28T22:00:00Z');

describe('classifyNoShowCount', () => {
  it('warns at exactly one and suspends at two or more', () => {
    expect(classifyNoShowCount(1)).toBe('warning');
    expect(classifyNoShowCount(2)).toBe('suspension');
    expect(classifyNoShowCount(5)).toBe('suspension');
  });

  it('refuses a count below one rather than warning someone with no no-shows', () => {
    expect(() => classifyNoShowCount(0)).toThrow(RangeError);
    expect(() => classifyNoShowCount(-1)).toThrow(RangeError);
  });
});

describe('recommendedSuspensionDays', () => {
  it('starts at 30 and doubles per prior suspension', () => {
    expect(recommendedSuspensionDays(0)).toBe(30);
    expect(recommendedSuspensionDays(1)).toBe(60);
    expect(recommendedSuspensionDays(3)).toBe(240);
  });
});

describe('suspensionHistory', () => {
  it('counts every record and finds the most recent suspension day', () => {
    expect(
      suspensionHistory([
        suspension('1', '2026-02-01'),
        suspension('1', '2026-06-15'),
      ]),
    ).toEqual({ priorCount: 2, lastSuspendedDay: '2026-06-15' });
  });

  it('has no last suspension for a member never suspended', () => {
    expect(suspensionHistory([])).toEqual({ priorCount: 0 });
  });
});

describe('countableNoShows', () => {
  it('counts only the last 12 months, measured back from today', () => {
    const tooOld = event('2025-09-27T18:00:00-07:00');
    const justInside = event('2025-09-29T18:00:00-07:00');
    const recent = event('2026-09-12T18:00:00-07:00');

    const { counted, since } = countableNoShows(
      [recent, tooOld, justInside],
      { priorCount: 0 },
      now,
    );

    expect(counted.map((e) => e.id)).toEqual([justInside.id, recent.id]);
    expect(since).toEqual({ day: '2025-09-28', reason: 'twelve-months' });
  });

  it('counts only no-shows after the most recent suspension', () => {
    const before = event('2026-06-01T18:00:00-07:00');
    const after = event('2026-08-01T18:00:00-07:00');

    const { counted, since } = countableNoShows(
      [before, after],
      { priorCount: 1, lastSuspendedDay: '2026-07-01' },
      now,
    );

    expect(counted.map((e) => e.id)).toEqual([after.id]);
    expect(since).toEqual({ day: '2026-07-01', reason: 'last-suspension' });
  });

  it('compares Seattle calendar days, not UTC days', () => {
    // 7pm Sept 10 in Seattle is already Sept 11 in UTC. A suspension dated
    // Sept 10 must still cover that evening's no-show.
    const suspensionEvening = event('2026-09-10T19:00:00-07:00');
    const dayAfter = event('2026-09-11T19:00:00-07:00');

    const { counted } = countableNoShows(
      [suspensionEvening, dayAfter],
      { priorCount: 1, lastSuspendedDay: '2026-09-10' },
      now,
    );

    expect(counted.map((e) => e.id)).toEqual([dayAfter.id]);
  });

  it('does not count anything dated after today', () => {
    const tomorrow = event('2026-09-29T18:00:00-07:00');
    const { counted } = countableNoShows([tomorrow], { priorCount: 0 }, now);
    expect(counted).toEqual([]);
  });

  it('ignores the same event reported twice', () => {
    const e = event('2026-09-12T18:00:00-07:00');
    const { counted } = countableNoShows([e, { ...e }], { priorCount: 0 }, now);
    expect(counted).toHaveLength(1);
  });
});

describe('buildNoShowCases', () => {
  const sept = (day: number) =>
    event(`2026-09-${String(day).padStart(2, '0')}T18:00:00-07:00`);

  function build({
    monthNoShows,
    memberNoShows,
    records = [],
  }: {
    monthNoShows: EventSummary[];
    memberNoShows: EventSummary[] | undefined;
    records?: SuspensionRecord[];
  }) {
    const alice = member('1', 'Alice');
    return buildNoShowCases({
      monthTally: new Map([['1', { member: alice, events: monthNoShows }]]),
      noShowsByMember: new Map([['1', memberNoShows]]),
      historyByMember: new Map([['1', suspensionHistory(records)]]),
      now,
    });
  }

  it('suspends at two countable no-shows, doubled per prior suspension', () => {
    const [a, b] = [sept(5), sept(12)];
    const result = build({
      monthNoShows: [a, b],
      memberNoShows: [a, b],
      records: [suspension('1', '2025-01-10')],
    });

    expect(result.cases).toEqual([
      expect.objectContaining({
        classification: 'suspension',
        priorSuspensions: 1,
        recommendedDays: 60,
      }),
    ]);
    expect(result.cases[0].counted.map((e) => e.id)).toEqual([a.id, b.id]);
  });

  it('does not re-suspend for the no-shows that led to the last suspension', () => {
    const [a, b] = [sept(5), sept(12)];
    const result = build({
      monthNoShows: [a, b],
      memberNoShows: [a, b],
      records: [suspension('1', '2026-09-20')],
    });

    expect(result.cases).toEqual([]);
    expect(result.cleared).toEqual([
      expect.objectContaining({ lastSuspendedDay: '2026-09-20' }),
    ]);
  });

  it('warns, not suspends, for one no-show after a suspension', () => {
    const [old, fresh] = [sept(1), sept(25)];
    const result = build({
      monthNoShows: [old, fresh],
      memberNoShows: [old, fresh],
      records: [suspension('1', '2026-09-10')],
    });

    expect(result.cases.map((c) => c.classification)).toEqual(['warning']);
    expect(result.cases[0].counted.map((e) => e.id)).toEqual([fresh.id]);
  });

  it("counts a month no-show missing from the member's own RSVP list", () => {
    const [a, b] = [sept(5), sept(12)];
    const result = build({ monthNoShows: [a, b], memberNoShows: [a] });

    expect(result.cases[0].classification).toBe('suspension');
  });

  it('lists members who have left the group without classifying them', () => {
    const result = build({ monthNoShows: [sept(5)], memberNoShows: undefined });

    expect(result.cases).toEqual([]);
    expect(result.departed.map((m) => m.id)).toEqual(['1']);
  });
});

describe('actByDate', () => {
  it('is three Seattle calendar days before the next event', () => {
    // 8pm Oct 9 in Seattle is Oct 10 in UTC; act by Oct 6, not Oct 7.
    const { actBy, actNow } = actByDate(
      '2026-10-10T03:00:00Z',
      dayjs('2026-10-01T18:00:00Z'),
    );
    expect(actBy).toBe('2026-10-06');
    expect(actNow).toBe(false);
  });

  it('flags act-now when the act-by day is today or past', () => {
    expect(
      actByDate('2026-10-05T18:00:00Z', dayjs('2026-10-02T18:00:00Z')).actNow,
    ).toBe(true);
  });
});

describe('nextEvent', () => {
  it('picks the earliest event still ahead, whatever order Meetup returns', () => {
    const past = event('2026-09-27T18:00:00-07:00');
    const later = event('2026-11-01T18:00:00-07:00');
    const sooner = event('2026-10-03T18:00:00-07:00');
    expect(nextEvent([later, past, sooner], now)?.id).toBe(sooner.id);
  });

  it('is undefined with nothing upcoming', () => {
    expect(nextEvent([], now)).toBeUndefined();
  });
});

describe('tallyNoShows', () => {
  it('accumulates events per member across events', () => {
    const alice = member('1');
    const bob = member('2');
    const e1 = event('2026-09-05T18:00:00-07:00');
    const e2 = event('2026-09-06T18:00:00-07:00');
    const tally = tallyNoShows([
      { event: e1, rsvps: [{ member: alice }, { member: bob }] },
      { event: e2, rsvps: [{ member: alice }] },
    ]);
    expect(tally.get('1')?.events).toHaveLength(2);
    expect(tally.get('2')?.events).toHaveLength(1);
  });
});

const warningCase: NoShowCase = {
  member: member('1001', 'Alice'),
  counted: [event('2026-09-05T18:00:00-07:00', 'Trivia')],
  since: { day: '2025-09-28', reason: 'twelve-months' },
  classification: 'warning',
};
const suspensionCase: NoShowCase = {
  member: member('1002', 'Bob'),
  counted: [
    event('2026-08-01T18:00:00-07:00', 'Hike'),
    event('2026-09-05T18:00:00-07:00', 'Picnic'),
  ],
  since: { day: '2026-03-01', reason: 'last-suspension' },
  classification: 'suspension',
  priorSuspensions: 1,
  recommendedDays: 60,
  nextRsvpEvent: event('2026-10-10T18:00:00-07:00', 'Bowling'),
  actBy: '2026-10-07',
  actNow: false,
};

describe('formatNoShowReport', () => {
  const report = (cases: NoShowCase[], extra = {}) =>
    formatNoShowReport('2026 September', {
      cases,
      cleared: [],
      departed: [],
      ...extra,
    });

  it('groups warnings and suspension candidates separately', () => {
    const text = report([warningCase, suspensionCase]);
    expect(text).toMatch(
      /Warnings[\s\S]*Alice[\s\S]*Suspension candidates[\s\S]*Bob/,
    );
  });

  it('says what each count covers and lists the counted events', () => {
    const text = report([warningCase, suspensionCase]);
    expect(text).toContain('1 no-show since 2025-09-28 (12 months ago)');
    expect(text).toContain('2 no-shows since 2026-03-01 (last suspension)');
    expect(text).toContain('Hike');
    expect(text).toContain('Picnic');
  });

  it('shows the penalty math, act-by date, and timing guidance', () => {
    const text = report([suspensionCase]);
    expect(text).toContain('prior suspensions: 1 → recommended: 60 days');
    expect(text).toContain('act by Oct 7, 2026');
    expect(text).toContain('3–5 days before');
  });

  it('says ACT NOW when the act-by day has come', () => {
    expect(report([{ ...suspensionCase, actNow: true }])).toContain('ACT NOW');
  });

  it('notes when a candidate has no upcoming RSVPs', () => {
    const text = report([
      { ...suspensionCase, nextRsvpEvent: undefined, actBy: undefined },
    ]);
    expect(text).toContain('no upcoming RSVPs');
  });

  it('lists members with nothing countable and members who left', () => {
    const text = report([], {
      cleared: [
        { member: member('3', 'Cara'), lastSuspendedDay: '2026-09-20' },
      ],
      departed: [member('4', 'Dan')],
    });
    expect(text).toMatch(/No action needed[\s\S]*Cara[\s\S]*2026-09-20/);
    expect(text).toMatch(/No longer in the group[\s\S]*Dan/);
  });
});

describe('formatSuspensionCsv', () => {
  it('emits only suspension candidates, with the date left for the moderator', () => {
    expect(formatSuspensionCsv([warningCase, suspensionCase])).toBe(
      'member_id,member_name,duration_days,suspended_at,notes\n' +
        '"1002","Bob","60","","act by 2026-10-07; 2 no-shows since 2026-03-01; prior suspensions: 1"',
    );
  });

  it('returns undefined when there are no suspension candidates', () => {
    expect(formatSuspensionCsv([warningCase])).toBeUndefined();
  });

  it('is refused by the recorder until the moderator fills in the date', () => {
    expect(() =>
      parseSuspensionCsv(formatSuspensionCsv([suspensionCase]) ?? ''),
    ).toThrow(/suspended_at/);
  });

  it('round-trips names with quotes and commas once the date is filled in', () => {
    const tricky: NoShowCase = {
      ...suspensionCase,
      member: member('1003', 'Bob "BJ" Smith, Jr.'),
    };
    const csv = (formatSuspensionCsv([tricky]) ?? '').replace(
      ',"",',
      ',"2026-10-05",',
    );

    expect(parseSuspensionCsv(csv)).toEqual([
      {
        memberId: '1003',
        memberName: 'Bob "BJ" Smith, Jr.',
        durationDays: 60,
        suspendedAt: new Date('2026-10-05T00:00:00Z'),
        notes:
          'act by 2026-10-07; 2 no-shows since 2026-03-01; prior suspensions: 1',
        rowNumber: 2,
      },
    ]);
  });

  it('defuses names a spreadsheet would run as a formula', () => {
    const csv = formatSuspensionCsv([
      { ...suspensionCase, member: member('1004', '=HYPERLINK("x")') },
    ]);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });
});
