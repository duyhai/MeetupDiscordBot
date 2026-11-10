import { describe, expect, it, vi } from 'vitest';

import { GET_VERIFIED_CHANNEL_ID } from '../../../src/constants.js';
import {
  announceDueAt,
  announceSchedule,
  announceYear,
  isAnnounceDue,
  WRAPPED_ANNOUNCE_DEFAULT_DATE,
  WRAPPED_ANNOUNCE_DEFAULT_HOUR,
  wrappedAnnounceConfig,
  wrappedAnnounceEntry,
} from '../../../src/lib/wrapped/announce.js';

const CHANNEL = '123456789012345678';

describe('wrappedAnnounceConfig', () => {
  it('defaults to 2026-12-01 at 17:00 Pacific with no channel, warning once about the channel', () => {
    const warn = vi.fn();
    const config = wrappedAnnounceConfig({}, warn);
    expect(config).toEqual({
      date: WRAPPED_ANNOUNCE_DEFAULT_DATE,
      hour: WRAPPED_ANNOUNCE_DEFAULT_HOUR,
      channelId: undefined,
    });
    expect(config.date).toBe('2026-12-01');
    expect(config.hour).toBe(17);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(
      'WRAPPED_ANNOUNCE_CHANNEL_ID',
    );
  });

  it('reads the date, hour and channel from the environment', () => {
    const warn = vi.fn();
    expect(
      wrappedAnnounceConfig(
        {
          WRAPPED_ANNOUNCE_DATE: ' 2026-12-03 ',
          WRAPPED_ANNOUNCE_HOUR: '9',
          WRAPPED_ANNOUNCE_CHANNEL_ID: CHANNEL,
        },
        warn,
      ),
    ).toEqual({ date: '2026-12-03', hour: 9, channelId: CHANNEL });
    expect(warn).not.toHaveBeenCalled();
  });

  it('a malformed date disables the post (no default date nobody chose); hour falls back; channel disables', () => {
    const warn = vi.fn();
    expect(
      wrappedAnnounceConfig(
        {
          WRAPPED_ANNOUNCE_DATE: '2026-13-40',
          WRAPPED_ANNOUNCE_HOUR: '24',
          WRAPPED_ANNOUNCE_CHANNEL_ID: 'general',
        },
        warn,
      ),
    ).toEqual({
      date: undefined,
      hour: WRAPPED_ANNOUNCE_DEFAULT_HOUR,
      channelId: undefined,
    });
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages).toHaveLength(3);
    expect(messages.some((m) => m.includes('WRAPPED_ANNOUNCE_DATE'))).toBe(
      true,
    );
    expect(messages.some((m) => m.includes('WRAPPED_ANNOUNCE_HOUR'))).toBe(
      true,
    );
    expect(
      messages.some((m) => m.includes('WRAPPED_ANNOUNCE_CHANNEL_ID')),
    ).toBe(true);
    for (const m of messages) {
      expect(m).not.toContain('2026-13-40');
      expect(m).not.toContain('general');
    }
  });

  it('a date that looks right but does not exist (Feb 30) disables the post', () => {
    const warn = vi.fn();
    expect(
      wrappedAnnounceConfig(
        {
          WRAPPED_ANNOUNCE_DATE: '2026-02-30',
          WRAPPED_ANNOUNCE_CHANNEL_ID: CHANNEL,
        },
        warn,
      ).date,
    ).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('WRAPPED_ANNOUNCE_DATE');
  });

  it('a well-formed date in a past Pacific year is kept but warns at boot (it can never post)', () => {
    const warn = vi.fn();
    const config = wrappedAnnounceConfig(
      {
        WRAPPED_ANNOUNCE_DATE: '2025-12-01',
        WRAPPED_ANNOUNCE_CHANNEL_ID: CHANNEL,
      },
      warn,
      new Date('2026-11-10T20:00:00Z'),
    );
    expect(config.date).toBe('2025-12-01');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(
      /WRAPPED_ANNOUNCE_DATE.*past year/,
    );
    // Not for this year's date, and not for the default.
    expect(
      wrappedAnnounceConfig(
        { WRAPPED_ANNOUNCE_CHANNEL_ID: CHANNEL },
        warn,
        new Date('2026-11-10T20:00:00Z'),
      ).date,
    ).toBe(WRAPPED_ANNOUNCE_DEFAULT_DATE);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('the past-year check is Pacific: 31 Dec 2026 23:30 Pacific is still 2026', () => {
    const warn = vi.fn();
    wrappedAnnounceConfig(
      {
        WRAPPED_ANNOUNCE_DATE: '2026-12-01',
        WRAPPED_ANNOUNCE_CHANNEL_ID: CHANNEL,
      },
      warn,
      new Date('2027-01-01T07:30:00Z'),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('announceSchedule is defined only with both a date and a channel', () => {
    expect(
      announceSchedule({ date: '2026-12-01', hour: 17, channelId: CHANNEL }),
    ).toEqual({ date: '2026-12-01', hour: 17, channelId: CHANNEL });
    expect(
      announceSchedule({ date: undefined, hour: 17, channelId: CHANNEL }),
    ).toBeUndefined();
    expect(
      announceSchedule({ date: '2026-12-01', hour: 17, channelId: undefined }),
    ).toBeUndefined();
  });
});

describe('announceDueAt', () => {
  const at = (date: string, hour = 17) =>
    announceDueAt({ date, hour }).toISOString();

  it('is the configured hour on the configured date in Pacific time', () => {
    // 1 Dec 2026 is PST (UTC-8): 17:00 Pacific is 01:00 UTC the next day.
    expect(at('2026-12-01')).toBe('2026-12-02T01:00:00.000Z');
    expect(at('2026-12-01', 9)).toBe('2026-12-01T17:00:00.000Z');
  });

  it('follows daylight saving on either side of the spring-forward day', () => {
    // 7 Mar 2026 is still PST; 8 Mar (02:00 skipped) is PDT (UTC-7).
    expect(at('2026-03-07')).toBe('2026-03-08T01:00:00.000Z');
    expect(at('2026-03-08')).toBe('2026-03-09T00:00:00.000Z');
    // 31 Oct 2026 is PDT; 1 Nov 2026 (01:00 repeated) is PST again.
    expect(at('2026-10-31')).toBe('2026-11-01T00:00:00.000Z');
    expect(at('2026-11-01')).toBe('2026-11-02T01:00:00.000Z');
  });

  it('a DST-change hour is one instant: the repeated 01:00 is its second (standard-time) occurrence, the skipped 02:00 is 03:00', () => {
    // 1 Nov 2026: 01:00 PDT is 08:00Z and 01:00 PST is 09:00Z. One of them,
    // never both, and dayjs picks the second: an hour late, never twice.
    expect(at('2026-11-01', 1)).toBe('2026-11-01T09:00:00.000Z');
    // 8 Mar 2026: 02:00 does not exist; it lands on 03:00 PDT.
    expect(at('2026-03-08', 2)).toBe('2026-03-08T10:00:00.000Z');
  });

  it('the announced year is the configured date’s year', () => {
    expect(announceYear({ date: '2026-12-01' })).toBe(2026);
    expect(announceYear({ date: '2027-01-02' })).toBe(2027);
  });
});

describe('isAnnounceDue', () => {
  const config = { date: '2026-12-01', hour: 17, channelId: CHANNEL };

  it('not before the due instant, due from it on', () => {
    expect(isAnnounceDue(new Date('2026-12-02T00:59:59Z'), config)).toBe(false);
    expect(isAnnounceDue(new Date('2026-12-02T01:00:00Z'), config)).toBe(true);
    expect(isAnnounceDue(new Date('2026-12-15T12:00:00Z'), config)).toBe(true);
  });

  it('stays due for the rest of that Pacific year (a bot down on the day posts when back)', () => {
    // 31 Dec 2026 23:30 Pacific is 1 Jan 2027 07:30 UTC: still 2026 in Pacific.
    expect(isAnnounceDue(new Date('2027-01-01T07:30:00Z'), config)).toBe(true);
    // 1 Jan 2027 00:30 Pacific: a stale date from last year posts nothing.
    expect(isAnnounceDue(new Date('2027-01-01T08:30:00Z'), config)).toBe(false);
  });
});

describe('wrappedAnnounceEntry', () => {
  const entry = wrappedAnnounceEntry(2026, 'https://example.test');

  it('names the year, the command, the website page and how to link', () => {
    expect(entry.title).toBe('Your 1.5 Gen Wrapped 2026 is ready');
    expect(entry.description).toContain('`/wrapped`');
    expect(entry.description).toContain('https://example.test/host/wrapped');
    expect(entry.description).toContain('linked members');
    expect(entry.description).toContain('**Verify**');
    expect(entry.description).toContain(`<#${GET_VERIFIED_CHANNEL_ID}>`);
  });

  it('pings nobody: no @everyone, @here or role mention', () => {
    const text = `${entry.title}\n${entry.description ?? ''}`;
    expect(text).not.toMatch(/@everyone|@here|<@&/);
  });

  it('defaults to the public app origin', () => {
    expect(wrappedAnnounceEntry(2026).description).toContain(
      'https://meetup-discord-bot.herokuapp.com/host/wrapped',
    );
  });
});
