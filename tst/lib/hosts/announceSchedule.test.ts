import { describe, expect, it } from 'vitest';

import {
  announceDueAt,
  dueLabel,
  isFarOut,
  isHeldHour,
  isImmediate,
  pastMeetupCutoff,
  rsvpOpenness,
} from '../../../src/lib/hosts/announceSchedule.js';

// Tue 10 Nov 2026: PST (UTC-8).
const at = (local: string) => new Date(`${local}-08:00`);
const START = at('2026-12-05T19:00:00');

describe('isHeldHour', () => {
  it('is weekdays 10:00 to 15:59 Pacific', () => {
    expect(isHeldHour(at('2026-11-10T09:59:00'))).toBe(false);
    expect(isHeldHour(at('2026-11-10T10:00:00'))).toBe(true);
    expect(isHeldHour(at('2026-11-10T15:59:00'))).toBe(true);
    expect(isHeldHour(at('2026-11-10T16:00:00'))).toBe(false);
    // Saturday and Sunday.
    expect(isHeldHour(at('2026-11-14T12:00:00'))).toBe(false);
    expect(isHeldHour(at('2026-11-15T12:00:00'))).toBe(false);
  });

  it('reads the hour in Pacific time, whatever the process clock', () => {
    // 10:30 PST is 18:30 UTC.
    expect(isHeldHour(new Date('2026-11-10T18:30:00Z'))).toBe(true);
    // 16:30 PST is 00:30 UTC the next day.
    expect(isHeldHour(new Date('2026-11-11T00:30:00Z'))).toBe(false);
  });
});

describe('announceDueAt', () => {
  it('goes at once outside work hours', () => {
    const now = at('2026-11-10T19:30:00');
    expect(announceDueAt(now, START, [])).toEqual(now);
  });

  it('holds a work-hours request until 16:00 Pacific that day', () => {
    const now = at('2026-11-10T11:15:00');
    expect(announceDueAt(now, START, [])).toEqual(at('2026-11-10T16:00:00'));
  });

  it('pushes 30 minutes past another announcement within 30 minutes, repeatedly', () => {
    const now = at('2026-11-10T19:30:00');
    const others = [at('2026-11-10T19:20:00'), at('2026-11-10T19:50:00')];
    // 19:30 is within 30 min of 19:20 → 19:50; that is on the next → 20:20.
    expect(announceDueAt(now, START, others)).toEqual(
      at('2026-11-10T20:20:00'),
    );
  });

  it('a held one is spaced from the others at 16:00 too', () => {
    const now = at('2026-11-10T11:15:00');
    expect(announceDueAt(now, START, [at('2026-11-10T16:00:00')])).toEqual(
      at('2026-11-10T16:30:00'),
    );
  });

  it('exactly 30 minutes apart is fine', () => {
    const now = at('2026-11-10T19:30:00');
    expect(announceDueAt(now, START, [at('2026-11-10T19:00:00')])).toEqual(now);
  });

  it('an event within 3 days skips the hold and the spacing', () => {
    const now = at('2026-11-10T11:15:00');
    const soon = at('2026-11-12T19:00:00');
    expect(announceDueAt(now, soon, [at('2026-11-10T11:15:00')])).toEqual(now);
    const notSoon = at('2026-11-13T12:00:00');
    expect(announceDueAt(now, notSoon, [])).toEqual(at('2026-11-10T16:00:00'));
  });

  it('a push that lands inside work hours is held, then spaced again', () => {
    // 09:45 Tue, another at 09:50: pushed to 10:20, inside the hold → 16:00.
    const now = at('2026-11-10T09:45:00');
    expect(announceDueAt(now, START, [at('2026-11-10T09:50:00')])).toEqual(
      at('2026-11-10T16:00:00'),
    );
    // And one already at 16:00 that day pushes it to 16:30.
    expect(
      announceDueAt(now, START, [
        at('2026-11-10T09:50:00'),
        at('2026-11-10T16:00:00'),
      ]),
    ).toEqual(at('2026-11-10T16:30:00'));
  });

  it('isImmediate: now, never a push', () => {
    const now = at('2026-11-10T19:30:00');
    expect(isImmediate(now, now)).toBe(true);
    expect(isImmediate(at('2026-11-10T19:30:30'), now)).toBe(false);
  });

  it('holds across DST: spring forward and fall back days', () => {
    // Sun 8 Mar 2026 02:00 PST → PDT. Mon 9 Mar 11:00 PDT is UTC-7.
    const springMonday = new Date('2026-03-09T18:00:00Z'); // 11:00 PDT
    expect(isHeldHour(springMonday)).toBe(true);
    expect(announceDueAt(springMonday, START, [])).toEqual(
      new Date('2026-03-09T23:00:00Z'), // 16:00 PDT
    );
    // Sun 1 Nov 2026 02:00 PDT → PST. Mon 2 Nov 11:00 PST is UTC-8.
    const fallMonday = new Date('2026-11-02T19:00:00Z'); // 11:00 PST
    expect(isHeldHour(fallMonday)).toBe(true);
    expect(announceDueAt(fallMonday, START, [])).toEqual(
      new Date('2026-11-03T00:00:00Z'), // 16:00 PST
    );
    // The 7-day cutoff is 7×24 h, so a DST day counts the same.
    expect(
      pastMeetupCutoff(
        new Date('2026-11-01T12:00:00Z'),
        new Date('2026-11-07T12:00:00Z'),
        new Date('2026-10-01T12:00:00Z'),
      ),
    ).toBe(true);
  });
});

describe('pastMeetupCutoff', () => {
  const created = at('2026-11-01T12:00:00');

  it('within 7 days of the start, for an event created earlier than 7 days before it', () => {
    expect(pastMeetupCutoff(at('2026-11-29T12:00:00'), START, created)).toBe(
      true,
    );
    expect(pastMeetupCutoff(at('2026-11-27T12:00:00'), START, created)).toBe(
      false,
    );
  });

  it('an event created within 7 days of its start may still be announced', () => {
    const lateCreated = at('2026-11-30T12:00:00');
    expect(
      pastMeetupCutoff(at('2026-12-01T12:00:00'), START, lateCreated),
    ).toBe(false);
  });
});

describe('advice', () => {
  it('warns beyond 3 weeks', () => {
    expect(isFarOut(at('2026-11-10T12:00:00'), START)).toBe(true);
    expect(isFarOut(at('2026-11-20T12:00:00'), START)).toBe(false);
  });

  it('RSVPs are open only when neither rsvpsClosed nor rsvpState says closed; neither known is unknown', () => {
    const o = (rsvpsClosed: boolean | null, rsvpState: string | null) =>
      rsvpOpenness({ rsvpsClosed, rsvpState });
    expect(o(false, 'RSVP')).toBe('open');
    expect(o(false, 'YES')).toBe('open');
    expect(o(false, 'FULL')).toBe('open');
    expect(o(true, 'RSVP')).toBe('closed');
    expect(o(false, 'NOT_OPEN_YET')).toBe('closed');
    expect(o(false, 'CLOSED')).toBe('closed');
    expect(o(null, 'RSVP')).toBe('open');
    expect(o(false, null)).toBe('open');
    expect(o(null, null)).toBe('unknown');
  });

  it('labels a due time in Pacific', () => {
    expect(dueLabel(at('2026-11-10T16:00:00'))).toBe('Tue, Nov 10 at 4:00 PM');
  });
});
