import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';

import { BaseUserInfo, Event } from '../../../src/lib/client/meetup/types.js';
import {
  NoShowCase,
  actByDate,
  classifyNoShowCount,
  formatNoShowReport,
  formatSuspensionCsv,
  recommendedSuspensionDays,
  tallyNoShows,
} from '../../../src/lib/helpers/noShowReport.js';

function member(id: string, name = `Member ${id}`): BaseUserInfo {
  return {
    id,
    name,
    gender: 'NONE',
    memberUrl: `https://meetup.com/members/${id}`,
  };
}

let nextId = 0;
function event(title = 'Event', dateTime = '2026-09-05T18:00:00Z'): Event {
  nextId += 1;
  return {
    id: `e${nextId}`,
    title,
    dateTime,
    eventUrl: `https://meetup.com/e${nextId}`,
    eventHosts: [],
    maxTickets: 10,
    status: 'PAST',
  };
}

describe('classifyNoShowCount', () => {
  it('warns at exactly one and suspends at two or more', () => {
    expect(classifyNoShowCount(1)).toBe('warning');
    expect(classifyNoShowCount(2)).toBe('suspension');
    expect(classifyNoShowCount(5)).toBe('suspension');
  });
});

describe('recommendedSuspensionDays', () => {
  it('starts at 30 and doubles per prior suspension', () => {
    expect(recommendedSuspensionDays(0)).toBe(30);
    expect(recommendedSuspensionDays(1)).toBe(60);
    expect(recommendedSuspensionDays(3)).toBe(240);
  });
});

describe('actByDate', () => {
  it('is three days before the next event', () => {
    const { actBy, actNow } = actByDate(
      '2026-10-10T18:00:00Z',
      dayjs('2026-10-01T00:00:00Z'),
    );
    expect(actBy.isSame(dayjs('2026-10-07T18:00:00Z'))).toBe(true);
    expect(actNow).toBe(false);
  });

  it('flags act-now when the window has already opened', () => {
    const { actNow } = actByDate(
      '2026-10-03T18:00:00Z',
      dayjs('2026-10-02T00:00:00Z'),
    );
    expect(actNow).toBe(true);
  });
});

describe('tallyNoShows', () => {
  it('accumulates events per member across events', () => {
    const alice = member('a');
    const bob = member('b');
    const e1 = event();
    const e2 = event();
    const tally = tallyNoShows([
      { event: e1, rsvps: [{ member: alice }, { member: bob }] },
      { event: e2, rsvps: [{ member: alice }] },
    ]);
    expect(tally.get('a')?.events).toHaveLength(2);
    expect(tally.get('b')?.events).toHaveLength(1);
  });
});

describe('formatNoShowReport', () => {
  const warning: NoShowCase = {
    member: member('a', 'Alice'),
    monthEvents: [event('Trivia')],
    twelveMonthCount: 1,
    classification: 'warning',
  };
  const suspension: NoShowCase = {
    member: member('b', 'Bob'),
    monthEvents: [event('Hike')],
    twelveMonthCount: 3,
    classification: 'suspension',
    priorSuspensions: 1,
    recommendedDays: 60,
    nextRsvpEvent: event('Picnic', '2026-10-10T18:00:00Z'),
    actBy: 'Oct 7',
    actNow: false,
  };

  it('groups warnings and suspension candidates separately', () => {
    const report = formatNoShowReport('2026 September', [warning, suspension]);
    expect(report).toMatch(/Warnings[\s\S]*Alice/);
    expect(report).toMatch(/Suspension candidates[\s\S]*Bob/);
  });

  it('shows the penalty math and act-by date for candidates', () => {
    const report = formatNoShowReport('2026 September', [suspension]);
    expect(report).toContain('prior suspensions: 1');
    expect(report).toContain('recommended: 60 days');
    expect(report).toContain('act by Oct 7');
  });

  it('says ACT NOW when the window has opened', () => {
    const report = formatNoShowReport('2026 September', [
      { ...suspension, actNow: true },
    ]);
    expect(report).toContain('ACT NOW');
  });

  it('notes when a candidate has no upcoming RSVPs', () => {
    const report = formatNoShowReport('2026 September', [
      {
        ...suspension,
        nextRsvpEvent: undefined,
        actBy: undefined,
        actNow: undefined,
      },
    ]);
    expect(report).toContain('no upcoming RSVPs');
  });
});

describe('formatSuspensionCsv', () => {
  const warningCase: NoShowCase = {
    member: member('a', 'Alice'),
    monthEvents: [event('Trivia')],
    twelveMonthCount: 1,
    classification: 'warning',
  };
  const suspensionCase: NoShowCase = {
    member: member('b', 'Bob'),
    monthEvents: [event('Hike')],
    twelveMonthCount: 3,
    classification: 'suspension',
    priorSuspensions: 1,
    recommendedDays: 60,
  };

  it('emits only suspension candidates in the record_suspension format', () => {
    const csv = formatSuspensionCsv(
      [warningCase, suspensionCase],
      '2026-09-26',
    );
    expect(csv).toBe(
      'member_id,member_name,duration_days,suspended_at,notes\n' +
        'b,Bob,60,2026-09-26,3 no-shows in 12 months; prior suspensions: 1',
    );
  });

  it('strips commas out of member names so columns stay aligned', () => {
    const csv = formatSuspensionCsv(
      [{ ...suspensionCase, member: member('c', 'Kim, MD') }],
      '2026-09-26',
    );
    expect(csv).toContain('c,Kim  MD,60');
  });

  it('returns undefined when there are no suspension candidates', () => {
    expect(formatSuspensionCsv([warningCase], '2026-09-26')).toBeUndefined();
  });

  it('round-trips through parseSuspensionCsv', async () => {
    const { parseSuspensionCsv } =
      await import('../../../src/lib/helpers/suspensionCsv.js');
    const csv = formatSuspensionCsv([suspensionCase], '2026-09-26');
    const rows = parseSuspensionCsv(csv);
    expect(rows).toEqual([
      {
        memberId: 'b',
        memberName: 'Bob',
        durationDays: 60,
        suspendedAt: new Date('2026-09-26T00:00:00Z'),
        notes: '3 no-shows in 12 months; prior suspensions: 1',
      },
    ]);
  });
});
