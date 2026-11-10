import { describe, expect, it } from 'vitest';

import {
  announceDueAt,
  dueLabel,
  isFarOut,
  isHeldHour,
  isImmediate,
  pastMeetupCutoff,
  rsvpsOpen,
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

  it('isImmediate: now or within a minute', () => {
    const now = at('2026-11-10T19:30:00');
    expect(isImmediate(now, now)).toBe(true);
    expect(isImmediate(at('2026-11-10T19:31:30'), now)).toBe(false);
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

  it('reads Meetup’s rsvpState: not open yet or closed means not open', () => {
    expect(rsvpsOpen('NOT_OPEN_YET')).toBe(false);
    expect(rsvpsOpen('CLOSED')).toBe(false);
    expect(rsvpsOpen('RSVP')).toBe(true);
    expect(rsvpsOpen('YES')).toBe(true);
    expect(rsvpsOpen('FULL')).toBe(true);
    expect(rsvpsOpen(null)).toBe(true);
  });

  it('labels a due time in Pacific', () => {
    expect(dueLabel(at('2026-11-10T16:00:00'))).toBe('Tue, Nov 10 at 4:00 PM');
  });
});
