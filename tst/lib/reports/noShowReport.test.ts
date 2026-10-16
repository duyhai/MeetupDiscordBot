import dayjs from 'dayjs';
import { describe, expect, it, vi } from 'vitest';

import {
  Event,
  EventSummary,
  MemberRsvpFilter,
  Rsvp,
} from '../../../src/lib/client/meetup/types.js';
import {
  buildNoShowCases,
  formatNoShowReport,
  formatSuspensionCsv,
  suspensionHistory,
  tallyNoShows,
} from '../../../src/lib/helpers/noShowReport.js';
import { MonthData } from '../../../src/lib/reports/meetupMonth.js';
import {
  NoShowBuildOptions,
  NoShowMeetup,
  buildNoShowReport,
  toNoShowCases,
} from '../../../src/lib/reports/noShowReport.js';
import {
  FakeSuspension,
  fakeSuspensionRepository,
} from '../../fixtures/meetup/fakeSuspensions.js';

const window = { year: 2026, month: 9 };
// periodEnd(September 2026) and suspensionCutoff(September 2026).
const ASOF = new Date('2026-10-01T07:00:00.000Z');
const CUTOFF = new Date('2026-10-01T00:00:00.000Z');
const GROUP_ID = 'group-1';

const member = (id: string, name = `Member ${id}`) => ({
  id,
  name,
  memberUrl: `https://www.meetup.com/members/${id}/`,
  gender: 'FEMALE' as const,
  description: 'private bio',
});

const toMemberRefOf = (id: string) => {
  const { gender: _gender, description: _description, ...ref } = member(id);
  return ref;
};

const event = (id: string, dateTime: string, title = `Event ${id}`) =>
  ({
    id,
    title,
    dateTime,
    eventUrl: `https://www.meetup.com/g/events/${id}/`,
    maxTickets: 10,
    status: 'PAST',
    description: 'Venmo me $20 to pay',
    feeSettings: { amount: 20, currency: 'USD' },
    eventHosts: [{ member: member('900') }],
  }) as unknown as Event;

const rsvp = (memberId: string, status: string) =>
  ({ member: member(memberId), status }) as unknown as Rsvp;

// Seattle evening events (UTC is the next day).
const SEPT_05 = event('s05', '2026-09-05T19:00:00-07:00');
const SEPT_12 = event('s12', '2026-09-12T19:00:00-07:00');
const SEPT_19 = event('s19', '2026-09-19T19:00:00-07:00');
const OCT_01_EVENING = event('o01', '2026-10-01T18:00:00-07:00');

/** No-show RSVPs per event; every past event also gets one ATTENDED. */
function monthData(noShows: Record<string, string[]>, events: Event[]) {
  const data: MonthData = { events, rsvps: new Map() };
  events.forEach((e) => {
    data.rsvps.set(e.id, [
      rsvp('800', 'ATTENDED'),
      ...(noShows[e.id] ?? []).map((id) => rsvp(id, 'NO_SHOW')),
    ]);
  });
  return data;
}

function fakeMeetup(
  histories: Record<string, EventSummary[] | undefined>,
  hostedCounts: Record<string, number> = {},
) {
  const getMemberRsvpEvents = vi.fn(
    (
      memberId: string,
      _groupId: string,
      _filter: MemberRsvpFilter,
      ..._rest: unknown[]
    ) => Promise.resolve(histories[memberId]),
  );
  const getGroupEventsCount = vi.fn(({ hostId }: { hostId?: string }) =>
    Promise.resolve(hostedCounts[hostId] ?? 0),
  );
  return {
    client: {
      getMemberRsvpEvents,
      getGroupEventsCount,
    } as unknown as NoShowMeetup,
    getMemberRsvpEvents,
    getGroupEventsCount,
  };
}

function options(
  suspensions: FakeSuspension[],
  overrides: Partial<NoShowBuildOptions> = {},
) {
  const repo = fakeSuspensionRepository(suspensions);
  const resolveGroupId = vi.fn(() => Promise.resolve(GROUP_ID));
  return {
    repo,
    resolveGroupId,
    options: {
      asOf: ASOF,
      suspensionCutoff: CUTOFF,
      resolveGroupId,
      suspensions: repo,
      ...overrides,
    },
  };
}

describe('buildNoShowReport', () => {
  it('classifies a finished month as of its end, ignoring later suspensions', async () => {
    const data = monthData({ s12: ['1'] }, [SEPT_12]);
    const { client } = fakeMeetup({ '1': [SEPT_12] });
    const { repo, options: opts } = options([
      { memberId: '1', suspendedDay: '2026-10-03', durationDays: 30 },
    ]);

    const payload = await buildNoShowReport(client, window, data, opts);

    expect(payload.cases).toHaveLength(1);
    expect(payload.cases[0]).toMatchObject({
      member: { id: '1' },
      classification: 'warning',
      priorSuspensions: 0,
    });
    expect(repo.calls).toEqual([
      { method: 'listByMemberIds', args: [['1'], CUTOFF] },
    ]);
  });

  it('refreshing a finished month after a new suspension still lists the member', async () => {
    const data = monthData({ s05: ['1'], s19: ['1'] }, [SEPT_05, SEPT_19]);
    const { client } = fakeMeetup({ '1': [SEPT_05, SEPT_19] });
    // Stored as UTC midnight: 2026-10-01T00:00Z is before asOf (07:00Z) but
    // is October's suspension, not a prior one.
    const { options: opts } = options([
      { memberId: '1', suspendedDay: '2026-10-01', durationDays: 30 },
      { memberId: '1', suspendedDay: '2026-10-03', durationDays: 60 },
    ]);

    const payload = await buildNoShowReport(client, window, data, opts);

    expect(payload.cleared).toEqual([]);
    expect(payload.cases).toHaveLength(1);
    expect(payload.cases[0]).toMatchObject({
      member: { id: '1' },
      classification: 'suspension',
      priorSuspensions: 0,
      recommendedDays: 30,
    });
  });

  it('counts no-shows only up to asOf', async () => {
    const data = monthData({ s12: ['1'] }, [SEPT_12]);
    // Oct 1 at 18:00 Seattle is the same calendar day as asOf, but later.
    const { client } = fakeMeetup({ '1': [SEPT_12, OCT_01_EVENING] });
    const { options: opts } = options([]);

    const payload = await buildNoShowReport(client, window, data, opts);

    expect(payload.cases).toHaveLength(1);
    expect(payload.cases[0].classification).toBe('warning');
    expect(payload.cases[0].counted.map((e) => e.id)).toEqual(['s12']);
    expect(JSON.stringify(payload)).not.toContain(OCT_01_EVENING.id);
  });

  it('drops month events from asOf onwards from the tally', async () => {
    const data = monthData({ s12: ['1'], o01: ['2'] }, [
      SEPT_12,
      OCT_01_EVENING,
    ]);
    const { client } = fakeMeetup({ '1': [SEPT_12], '2': [OCT_01_EVENING] });
    const { options: opts } = options([]);

    const payload = await buildNoShowReport(client, window, data, opts);

    expect(payload.summary.members).toBe(1);
    expect(payload.summary.noShows).toBe(1);
    expect(payload.cases.map((c) => c.member.id)).toEqual(['1']);
  });

  it('stores no upcoming RSVPs or descriptions', async () => {
    const data = monthData({ s05: ['1', '2'], s19: ['1'] }, [SEPT_05, SEPT_19]);
    const { client, getMemberRsvpEvents } = fakeMeetup({
      '1': [SEPT_05, SEPT_19],
      '2': [SEPT_05],
    });
    const { options: opts } = options([]);

    const payload = await buildNoShowReport(client, window, data, opts);

    expect(getMemberRsvpEvents).toHaveBeenCalled();
    getMemberRsvpEvents.mock.calls.forEach((call) => {
      expect(call).toHaveLength(3);
      expect(call[2].eventStatus).not.toContain('UPCOMING');
    });
    const json = JSON.stringify(payload);
    [
      'upcomingRsvps',
      'actBy',
      'actNow',
      'description',
      'feeSettings',
      'gender',
      'FEMALE',
      'private bio',
      'Venmo',
      '💵',
    ].forEach((forbidden) => {
      expect(json).not.toContain(forbidden);
    });
  });

  it('records the attendance evidence for the month', async () => {
    const noAttendance: MonthData = {
      events: [SEPT_05, SEPT_12],
      rsvps: new Map([
        ['s05', [rsvp('800', 'YES')]],
        ['s12', [rsvp('801', 'YES')]],
      ]),
    };
    const { client } = fakeMeetup({});

    const payload = await buildNoShowReport(
      client,
      window,
      noAttendance,
      options([]).options,
    );

    expect(payload.attendance).toEqual({
      pastEvents: 2,
      eventsWithAttendance: 0,
    });
  });

  it('adds prior suspensions to warnings', async () => {
    const data = monthData({ s12: ['1'] }, [SEPT_12]);
    const { client } = fakeMeetup({ '1': [SEPT_12] });
    const { options: opts } = options([
      { memberId: '1', suspendedDay: '2025-12-01', durationDays: 30 },
      { memberId: '1', suspendedDay: '2026-03-01', durationDays: 60 },
    ]);

    const payload = await buildNoShowReport(client, window, data, opts);

    expect(payload.cases[0]).toMatchObject({
      classification: 'warning',
      priorSuspensions: 2,
      recommendedDays: 120,
    });
  });

  it('flags members who hosted a past event', async () => {
    const data = monthData({ s12: ['1', '2'] }, [SEPT_12]);
    const { client, getGroupEventsCount } = fakeMeetup(
      { '1': [SEPT_12], '2': [SEPT_12] },
      { '1': 1, '2': 0 },
    );
    const { options: opts } = options([]);

    const payload = await buildNoShowReport(client, window, data, opts);

    expect(getGroupEventsCount).toHaveBeenCalledTimes(2);
    ['1', '2'].forEach((hostId) => {
      expect(getGroupEventsCount).toHaveBeenCalledWith({
        hostId,
        status: ['PAST'],
        beforeDateTime: '2026-10-01T07:00:00.000Z',
      });
    });
    expect(payload.cases.map((c) => [c.member.id, c.hostedPastEvent])).toEqual([
      ['1', true],
      ['2', false],
    ]);
  });

  it('the open month reads every suspension record', async () => {
    const data = monthData({ s12: ['1', '2'] }, [SEPT_12]);
    const { client } = fakeMeetup({ '1': [SEPT_12], '2': [SEPT_12] });
    const { repo, options: opts } = options([], {
      suspensionCutoff: undefined,
    });

    await buildNoShowReport(client, window, data, opts);

    expect(repo.calls).toEqual([
      { method: 'listByMemberIds', args: [['1', '2'], undefined] },
    ]);
  });

  it('a month without no-shows makes no member or group lookups', async () => {
    const data = monthData({}, [SEPT_05, SEPT_12]);
    const { client, getMemberRsvpEvents, getGroupEventsCount } = fakeMeetup({});
    const { repo, resolveGroupId, options: opts } = options([]);

    const payload = await buildNoShowReport(client, window, data, opts);

    expect(resolveGroupId).not.toHaveBeenCalled();
    expect(getMemberRsvpEvents).not.toHaveBeenCalled();
    expect(getGroupEventsCount).not.toHaveBeenCalled();
    expect(repo.calls).toEqual([]);
    expect(payload.summary).toEqual({
      noShows: 0,
      members: 0,
      warnings: 0,
      suspensionCandidates: 0,
      cleared: 0,
      departed: 0,
    });
    expect(payload.cases).toEqual([]);
    expect(payload.cleared).toEqual([]);
    expect(payload.departed).toEqual([]);
  });
});

/**
 * A warning (1), a suspension candidate (2, one prior suspension), a member
 * cleared by a September suspension (3) and one who left the group (4).
 */
function mixedMonth() {
  const data = monthData({ s05: ['1', '2', '3', '4'], s19: ['2'] }, [
    SEPT_05,
    SEPT_12,
    SEPT_19,
  ]);
  const histories: Record<string, EventSummary[] | undefined> = {
    '1': [SEPT_05],
    '2': [SEPT_05, SEPT_19],
    '3': [SEPT_05],
    '4': undefined,
  };
  const suspensions: FakeSuspension[] = [
    { memberId: '2', suspendedDay: '2026-02-01', durationDays: 30 },
    { memberId: '3', suspendedDay: '2026-09-20', durationDays: 30 },
  ];
  return { data, histories, suspensions };
}

describe('payload shape', () => {
  it('payload is JSON round-trippable', async () => {
    const { data, histories, suspensions } = mixedMonth();
    const { client } = fakeMeetup(histories);

    const payload = await buildNoShowReport(
      client,
      window,
      data,
      options(suspensions).options,
    );

    expect(payload.summary).toEqual({
      noShows: 5,
      members: 4,
      warnings: 1,
      suspensionCandidates: 1,
      cleared: 1,
      departed: 1,
    });
    expect(payload.period).toBe('2026-09');
    expect(payload.asOf).toBe('2026-10-01T07:00:00.000Z');
    expect(JSON.parse(JSON.stringify(payload))).toStrictEqual(payload);
  });

  it('leaves lastSuspendedDay out for a member cleared by age', async () => {
    // An old month run today: its no-shows are past the 12-month window.
    const old = event('a10', '2025-08-10T19:00:00-07:00');
    const data = monthData({ a10: ['1'] }, [old]);
    const { client } = fakeMeetup({ '1': [old] });

    const payload = await buildNoShowReport(
      client,
      { year: 2025, month: 8 },
      data,
      options([]).options,
    );

    expect(payload.cleared).toEqual([{ member: toMemberRefOf('1') }]);
    expect(Object.keys(payload.cleared[0])).toEqual(['member']);
    expect(JSON.parse(JSON.stringify(payload))).toStrictEqual(payload);
  });

  it('toNoShowCases restores what the formatters read', async () => {
    const { data, histories, suspensions } = mixedMonth();
    const { client } = fakeMeetup(histories);
    const repo = fakeSuspensionRepository(suspensions);

    const payload = await buildNoShowReport(client, window, data, {
      ...options(suspensions).options,
    });

    // The same inputs straight through the helper, as the command used to.
    const monthTally = tallyNoShows(
      data.events.map((e) => ({
        event: e,
        rsvps: data.rsvps.get(e.id).filter((r) => r.status === 'NO_SHOW'),
      })),
    );
    const ids = [...monthTally.keys()];
    const records = await repo.listByMemberIds(ids, CUTOFF);
    const direct = buildNoShowCases({
      monthTally,
      noShowsByMember: new Map(ids.map((id) => [id, histories[id]])),
      historyByMember: new Map(
        ids.map((id) => [
          id,
          suspensionHistory(records.filter((r) => r.memberId === id)),
        ]),
      ),
      now: dayjs(ASOF),
    });

    const restored = toNoShowCases(payload);
    expect(formatNoShowReport('x', restored)).toBe(
      formatNoShowReport('x', direct),
    );
    expect(formatSuspensionCsv(restored.cases)).toBe(
      formatSuspensionCsv(direct.cases),
    );
    // Same optional fields as the helper sets: prior/recommended on
    // suspension candidates only.
    expect(restored.cases.map((c) => Object.keys(c).sort())).toEqual(
      direct.cases.map((c) => Object.keys(c).sort()),
    );
  });
});
