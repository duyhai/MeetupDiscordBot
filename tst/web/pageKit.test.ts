import { Response } from 'express';
import fs from 'fs';
import { describe, expect, it } from 'vitest';

import { AttendanceEvidence } from '../../src/lib/reports/types.js';
import {
  COPY_SCRIPT,
  builtByHtml,
  dashboardPage,
  pacificDate,
  pacificDateTime,
  parseRouteMonth,
  zeroNoShowNote,
} from '../../src/web/pageKit.js';
import { html } from '../../src/web/html.js';

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
    expect(definition).not.toContain('`');
    expect(COPY_SCRIPT).toContain('button[data-copy]');
  });

  it('COPY_SCRIPT falls back when the clipboard API is missing', () => {
    expect(COPY_SCRIPT).toContain(
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
      `<script nonce="N0NCE">${COPY_SCRIPT}</script>`,
    );
    expect(sent.body).toContain('<a href="/dashboard">Home</a>');
  });
});
