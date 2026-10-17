import { Response } from 'express';
import fs from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AttendanceEvidence } from '../../src/lib/reports/types.js';
import {
  COPY_SCRIPT,
  PAGE_LOAD_DEADLINE_MS,
  WORKSPACE_SCRIPT,
  builtByHtml,
  dashboardPage,
  load,
  pacificDate,
  pacificDateTime,
  parseRouteMonth,
  zeroNoShowNote,
} from '../../src/web/pageKit.js';
import { html, isSafeHtml } from '../../src/web/html.js';

const NOW = new Date('2026-10-05T16:15:00Z');

describe('pageKit', () => {
  it('parseRouteMonth uses parsePeriodKey', () => {
    expect(parseRouteMonth('2026-09', NOW)).toEqual({ year: 2026, month: 9 });
    for (const bad of [
      '2026-9',
      '2026-13',
      '../2026-09',
      '2026-09/',
      '',
      ' 2026-09',
    ]) {
      expect(parseRouteMonth(bad, NOW)).toBeUndefined();
    }
    expect(parseRouteMonth(['2026-09'], NOW)).toBeUndefined();
    expect(parseRouteMonth(undefined, NOW)).toBeUndefined();
  });

  it("parseRouteMonth refuses months before the group's first (2013-03)", () => {
    expect(parseRouteMonth('2013-02', NOW)).toBeUndefined();
    expect(parseRouteMonth('2001-01', NOW)).toBeUndefined();
    expect(parseRouteMonth('2013-03', NOW)).toEqual({ year: 2013, month: 3 });
  });

  it('parseRouteMonth refuses a future month', () => {
    expect(parseRouteMonth('2026-11', NOW)).toBeUndefined();
    expect(parseRouteMonth('2027-01', NOW)).toBeUndefined();
    expect(parseRouteMonth('2026-10', NOW)).toEqual({ year: 2026, month: 10 });
  });

  it('formats dates in Pacific time', () => {
    expect(pacificDateTime(new Date('2026-09-04T02:00:00Z'))).toBe(
      'Sep 3, 2026 7:00 PM',
    );
    expect(pacificDate('2026-09-04T02:00:00Z')).toBe('Sep 3, 2026');
  });

  it('date helpers render nothing for a missing or unreadable value, never "now"', () => {
    for (const value of [undefined, null, 42, {}, [], '', 'not a date']) {
      expect(pacificDate(value as never), String(value)).toBe('');
      expect(pacificDateTime(value as never), String(value)).toBe('');
    }
    expect(pacificDateTime(new Date('junk'))).toBe('');
  });

  describe('zeroNoShowNote only for finished months with RSVPs and no no-shows', () => {
    const missing: AttendanceEvidence = {
      pastEventsWithRsvps: 4,
      eventsWithNoShow: 0,
      noShows: 0,
    };

    it('a finished month with RSVPs and no no-shows gets the note', () => {
      const out = zeroNoShowNote({ year: 2026, month: 9 }, missing, NOW);
      expect(out).not.toBe('');
      // Whitespace collapsed, as a browser renders it.
      const text = (out as { value: string }).value.replace(/\s+/g, ' ');
      expect(text).toContain('No no-shows were recorded for September 2026');
      expect(text).toContain('4 past events with RSVPs');
      expect(text).toContain('Check that attendance was taken.');
      expect(text.toLowerCase()).not.toContain('incomplete');
    });

    it('the open month gets nothing', () => {
      expect(zeroNoShowNote({ year: 2026, month: 10 }, missing, NOW)).toBe('');
    });

    it('a month with no-shows gets nothing', () => {
      expect(
        zeroNoShowNote(
          { year: 2026, month: 9 },
          { pastEventsWithRsvps: 4, eventsWithNoShow: 1, noShows: 2 },
          NOW,
        ),
      ).toBe('');
    });

    it('a month without past events with RSVPs, or without evidence, gets nothing', () => {
      expect(
        zeroNoShowNote(
          { year: 2026, month: 9 },
          { pastEventsWithRsvps: 0, eventsWithNoShow: 0, noShows: 0 },
          NOW,
        ),
      ).toBe('');
      expect(zeroNoShowNote({ year: 2026, month: 9 }, null, NOW)).toBe('');
      expect(zeroNoShowNote({ year: 2026, month: 9 }, undefined, NOW)).toBe('');
    });
  });

  it('builtByHtml never echoes a non-digit builtBy as a link', () => {
    expect(builtByHtml('job').value).toBe('the daily job');
    expect(builtByHtml('backfill').value).toBe('the backfill');
    const staff = builtByHtml('123456789012345678').value;
    expect(staff).toContain(
      'href="https://discord.com/users/123456789012345678"',
    );
    for (const bad of [
      '<script>x</script>',
      'javascript:1',
      '12345',
      '../123456789012345678',
    ]) {
      const out = builtByHtml(bad).value;
      expect(out).not.toContain('<a');
      expect(out).not.toContain('<script');
      expect(out).not.toContain(bad);
      expect(out).toBe('a staff member');
    }
  });

  it('WORKSPACE_SCRIPT has no interpolation and finds its textarea by position', () => {
    const source = fs.readFileSync(
      new URL('../../src/web/pageKit.ts', import.meta.url),
      'utf8',
    );
    const start = source.indexOf('export const WORKSPACE_SCRIPT');
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('`;', start);
    const definition = source.slice(start, end + 2);
    expect(definition).not.toContain('${');
    expect(definition).toMatch(
      /^export const WORKSPACE_SCRIPT = staticRaw`[^`]*`;$/,
    );
    expect(isSafeHtml(WORKSPACE_SCRIPT)).toBe(true);
    expect(WORKSPACE_SCRIPT.value).toContain("closest('[data-copy-box]')");
    expect(WORKSPACE_SCRIPT.value).not.toContain('getElementById');
    // The clipboard fallback is COPY_SCRIPT's.
    expect(WORKSPACE_SCRIPT.value).toContain("'Select the text and copy it'");
  });

  it('COPY_SCRIPT has no interpolation', () => {
    const source = fs.readFileSync(
      new URL('../../src/web/pageKit.ts', import.meta.url),
      'utf8',
    );
    const start = source.indexOf('export const COPY_SCRIPT');
    expect(start).toBeGreaterThan(-1);
    // Up to the next top-level export, so a later line of the definition
    // cannot hide an interpolation.
    const end = source.indexOf('\nexport ', start + 1);
    expect(end).toBeGreaterThan(start);
    const definition = source.slice(start, end);
    expect(definition).toContain('COPY_SCRIPT');
    expect(definition).not.toContain('${');
    // One staticRaw template literal and nothing else.
    expect(definition).toMatch(
      /^export const COPY_SCRIPT = staticRaw`[^`]*`;\s*$/,
    );
    expect(isSafeHtml(COPY_SCRIPT)).toBe(true);
    expect(COPY_SCRIPT.value).toContain('button[data-copy]');
  });

  it('COPY_SCRIPT falls back when the clipboard API is missing', () => {
    expect(COPY_SCRIPT.value).toContain(
      "if(!navigator.clipboard){b.textContent='Select the text and copy it';return;}",
    );
  });

  it('dashboardPage embeds COPY_SCRIPT verbatim with the nonce', () => {
    const sent: { status?: number; body?: string } = {};
    const res = {
      locals: {
        nonce: 'N0NCE',
        sid: 'sid',
        session: { userId: '1', username: 'Mod', csrfToken: 't' },
      },
    } as unknown as Response;
    Object.assign(res, {
      status: (code: number) => {
        sent.status = code;
        return res;
      },
      type: () => res,
      send: (body: string) => {
        sent.body = body;
        return res;
      },
    });
    dashboardPage(res, {
      title: 'T',
      body: html`<p>x</p>`,
      script: true,
    });
    expect(sent.status).toBe(200);
    expect(sent.body).toContain(
      `<script nonce="N0NCE">${COPY_SCRIPT.value}</script>`,
    );
    expect(sent.body).toContain('<a href="/dashboard">Home</a>');
    expect(sent.body).toContain('<a href="/dashboard/sessions">Sessions</a>');
  });
});

function fakeResponse() {
  const sent: { status?: number; body?: string; count: number } = { count: 0 };
  const res = {
    locals: {
      nonce: 'N0NCE',
      sid: 'sid',
      session: { userId: '1', username: 'Mod', csrfToken: 't' },
    },
  } as unknown as Response;
  Object.assign(res, {
    status: (code: number) => {
      sent.status = code;
      return res;
    },
    type: () => res,
    send: (body: string) => {
      sent.body = body;
      sent.count += 1;
      return res;
    },
  });
  return { res, sent };
}

describe('load deadline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is about 10 seconds, inside Heroku's 30 s router timeout", () => {
    expect(PAGE_LOAD_DEADLINE_MS).toBe(10_000);
  });

  it('a read that never settles renders the 503 page at the deadline', async () => {
    vi.useFakeTimers();
    const { res, sent } = fakeResponse();
    const pending = load(
      res,
      'The suspension records',
      () => new Promise(() => undefined),
    );
    await vi.advanceTimersByTimeAsync(PAGE_LOAD_DEADLINE_MS - 1);
    expect(sent.count).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: false });
    expect(sent.status).toBe(503);
    expect(sent.body).toContain(
      'The suspension records cannot be loaded right now.',
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a read that settles in time clears its timer', async () => {
    vi.useFakeTimers();
    const { res, sent } = fakeResponse();
    expect(await load(res, 'X', () => Promise.resolve(42))).toEqual({
      ok: true,
      value: 42,
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(sent.count).toBe(0);
  });

  it('a read that fails after the deadline sends nothing more and is not unhandled', async () => {
    vi.useFakeTimers();
    const { res, sent } = fakeResponse();
    let fail: (error: Error) => void = () => undefined;
    const pending = load(
      res,
      'X',
      () =>
        new Promise<never>((_resolve, reject) => {
          fail = reject;
        }),
    );
    await vi.advanceTimersByTimeAsync(PAGE_LOAD_DEADLINE_MS);
    expect(await pending).toEqual({ ok: false });
    fail(new Error('pg finally answered'));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.count).toBe(1);
  });

  it('unrefs its timer, so it never holds the process open', async () => {
    const unref = vi.fn();
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms: number,
    ) => {
      const timer = realSetTimeout(fn, ms);
      timer.unref = unref.mockReturnValue(timer) as never;
      return timer;
    }) as never);
    const { res } = fakeResponse();
    await load(res, 'X', () => Promise.resolve(1));
    expect(spy).toHaveBeenCalledWith(
      expect.any(Function),
      PAGE_LOAD_DEADLINE_MS,
    );
    expect(unref).toHaveBeenCalled();
    spy.mockRestore();
  });
});
