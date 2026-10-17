import { describe, expect, it } from 'vitest';
import {
  NO_SHOW_APPEAL_URL,
  NO_SHOW_POLICY_URL,
} from '../../../src/constants.js';
import {
  feeDollars,
  firstName,
  suspensionMessage,
  warningMessage,
} from '../../../src/lib/workspace/templates.js';

const ev = { title: 'Board Games Night', dateTime: '2026-09-04T01:30:00Z' };
const warn = (over = {}) =>
  warningMessage({
    memberName: 'Ana María Lee',
    event: ev,
    priorSuspensions: 0,
    hostWaiver: false,
    ...over,
  });
const susp = (over = {}) =>
  suspensionMessage({
    memberName: 'Ana María Lee',
    counted: [ev, { title: 'Hike', dateTime: '2026-09-20T17:00:00Z' }],
    priorSuspensions: 0,
    hostWaiver: false,
    suspendedOn: '2026-10-01',
    ...over,
  });

describe('constants', () => {
  it('are the public policy and appeal links', () => {
    expect(NO_SHOW_POLICY_URL).toBe(
      'https://15genasian.notion.site/1b1176bcb5de453687cd7aa5c0cd239b',
    );
    expect(NO_SHOW_APPEAL_URL).toBe('https://forms.gle/tPiPYQ2DpAVZPL1T9');
  });
});

describe('fee and days', () => {
  it('fee doubles: $10, $20, $40', () => {
    expect([0, 1, 2].map(feeDollars)).toEqual([10, 20, 40]);
    expect(warn({ priorSuspensions: 1 })).toContain('$20 admin fee');
    expect(warn({ priorSuspensions: 2 })).toContain('$40 admin fee');
    expect(susp({ priorSuspensions: 2 })).toContain('$40 admin fee');
  });
  it('days double: 30, 60, 120', () => {
    expect(warn()).toContain('a 30-day suspension');
    expect(warn({ priorSuspensions: 1 })).toContain('a 60-day suspension');
    expect(warn({ priorSuspensions: 2 })).toContain('a 120-day suspension');
    expect(susp({ priorSuspensions: 2 })).toContain('for 120 days.');
  });
  it('host waiver omits the fee sentence', () => {
    for (const text of [
      warn({ hostWaiver: true }),
      susp({ hostWaiver: true }),
    ]) {
      expect(text).not.toContain('$');
      expect(text).not.toContain('admin fee');
      expect(text).not.toContain('donate');
    }
    expect(warn({ hostWaiver: true })).toContain(
      'results in a 30-day suspension from the group. Our Attendance',
    );
  });
});

describe('names and dates', () => {
  it('first name is the first word of the Meetup name, falls back to "there"', () => {
    expect(firstName('Ana María Lee')).toBe('Ana');
    expect(firstName('  Bo  ')).toBe('Bo');
    expect(firstName('  ')).toBe('there');
    expect(firstName('')).toBe('there');
    expect(firstName(undefined as never)).toBe('there');
    expect(warn({ memberName: '' })).toMatch(/^Hello there, /);
  });
  it('no-show list uses Pacific dates', () => {
    const text = susp({
      counted: [{ title: 'X', dateTime: '2026-09-01T05:00:00Z' }],
    });
    expect(text).toContain('- X, August 31, 2026');
    expect(
      warn({ event: { title: 'X', dateTime: '2026-09-01T05:00:00Z' } }),
    ).toContain('X on August 31, 2026');
  });
  it('end_date is the last suspended day (date + days - 1)', () => {
    expect(susp()).toContain('After October 30, 2026, you can reapply');
    expect(susp({ priorSuspensions: 1 })).toContain(
      'After November 29, 2026, you can reapply',
    );
  });
  it('suspensionMessage refuses a bad date', () => {
    for (const bad of ['2026-02-30', 'tomorrow', '', '2026-1-1']) {
      expect(() => susp({ suspendedOn: bad })).toThrow(RangeError);
    }
  });
});

describe('links and plain text', () => {
  it('links use NO_SHOW_POLICY_URL and NO_SHOW_APPEAL_URL', () => {
    for (const text of [warn(), susp()]) {
      expect(text).toContain(NO_SHOW_POLICY_URL);
      expect(text).toContain(NO_SHOW_APPEAL_URL);
    }
  });
  it('text is plain (escaped only when rendered)', () => {
    expect(
      warn({ event: { title: '<b>&amp;', dateTime: ev.dateTime } }),
    ).toContain("RSVP'd to <b>&amp; on");
    expect(susp({ memberName: '<b>&amp; x' })).toMatch(/^Hello <b>&amp;, /);
  });
  it('member-supplied values cannot ping when pasted into a DM', () => {
    const w = warn({
      memberName: '@everyone',
      event: { title: '@here <@123> <#9> </cmd:1>', dateTime: ev.dateTime },
    });
    const s = susp({
      memberName: '@everyone',
      counted: [{ title: '@here <@123> <#9> </cmd:1>', dateTime: ev.dateTime }],
    });
    for (const text of [w, s]) {
      expect(text).not.toMatch(/@(?!\u200b)/);
      expect(text).not.toMatch(/<#(?!\u200b)/);
      expect(text).not.toMatch(/<\/(?!\u200b)/);
      expect(text).toContain('@\u200bhere');
    }
    // The signature and fixed wording carry no mention characters, so nothing else changed.
    expect(warn().includes('\u200b')).toBe(false);
    expect(susp().includes('\u200b')).toBe(false);
  });
});

describe('input guards', () => {
  it('refuse an invalid dateTime instead of rendering "Invalid Date"', () => {
    for (const dateTime of ['', 'not a date', undefined as never]) {
      expect(() => warn({ event: { title: 'X', dateTime } })).toThrow(
        RangeError,
      );
      expect(() => susp({ counted: [ev, { title: 'X', dateTime }] })).toThrow(
        RangeError,
      );
    }
  });
  it('refuse a priorSuspensions that is not a non-negative integer', () => {
    for (const priorSuspensions of [
      -1,
      1.5,
      NaN,
      Infinity,
      '1' as never,
      undefined as never,
    ]) {
      expect(() => warn({ priorSuspensions })).toThrow(RangeError);
      expect(() => susp({ priorSuspensions })).toThrow(RangeError);
    }
  });
  it('refuse an empty or missing counted list', () => {
    expect(() => susp({ counted: [] })).toThrow(RangeError);
    expect(() => susp({ counted: undefined as never })).toThrow(RangeError);
  });
});

describe('verbatim', () => {
  it('warning text matches the spec verbatim', () => {
    expect(warn()).toBe(
      [
        "Hello Ana, our records show you RSVP'd to Board Games Night on September 3, 2026 but were marked as a no-show. " +
          'Cancellations within 48 hours also count as no-shows, so please update your RSVP at least 2 days ahead if your plans change. ' +
          'This is a friendly warning: a second no-show results in a 30-day suspension from the group and a $10 admin fee to rejoin, ' +
          'which you can donate to any Asian charity of your choice (or pay to 1.5 Gen Asians). ' +
          'Our Attendance & No-Show Policy: https://15genasian.notion.site/1b1176bcb5de453687cd7aa5c0cd239b. ' +
          'If you think this was a mistake, you can appeal here: https://forms.gle/tPiPYQ2DpAVZPL1T9. Thank you!',
        '1.5 Gen Asians Organizers',
      ].join('\n'),
    );
  });
  it('suspension text matches the spec verbatim', () => {
    expect(susp()).toBe(
      [
        'Hello Ana, our records show 2 no-shows:',
        '- Board Games Night, September 3, 2026',
        '- Hike, September 20, 2026',
        '',
        'Under our Attendance & No-Show Policy (https://15genasian.notion.site/1b1176bcb5de453687cd7aa5c0cd239b), ' +
          'you are being suspended from the group for 30 days. Your current RSVPs will be removed. ' +
          'After October 30, 2026, you can reapply to join on Meetup. ' +
          'Rejoining requires a $10 admin fee, which you can donate to any Asian charity of your choice (or pay to 1.5 Gen Asians). ' +
          'If you think this was a mistake, you can appeal here: https://forms.gle/tPiPYQ2DpAVZPL1T9. Thank you for understanding.',
        '1.5 Gen Asians Organizers',
      ].join('\n'),
    );
  });
});
