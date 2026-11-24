import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RetentionData } from '../../../src/lib/retention/retention.js';
import {
  DashboardPageDeps,
  registerAllProtectedRoutes,
} from '../../../src/web/routes/dashboardPages.js';
import { closeServers, makeApp, signIn } from '../dashboardHarness.js';
import {
  PAGE_NOW,
  cohortMonth,
  fakeOrganizerDeps,
  fakePageDeps,
  retentionView,
} from './pageFakes.js';

afterEach(closeServers);

const PAGE = '/dashboard/retention';

async function setup(
  data: RetentionData = retentionView(),
  pages: Partial<DashboardPageDeps> = {},
) {
  const retention = vi.fn(async () => data);
  const { req } = await makeApp({
    now: () => PAGE_NOW.getTime(),
    protectedRoutes: (r) =>
      registerAllProtectedRoutes(r, {
        organizer: fakeOrganizerDeps(),
        pages: fakePageDeps({ retention, ...pages }),
      }),
  });
  const cookie = await signIn(req);
  const get = (path: string) => req.get(path).set('Cookie', cookie);
  return { retention, get, req };
}

const words = (body: string) =>
  body
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** A chart's data table, by the chart's aria-label: rows of cell text. */
function dataTable(body: string, title: string): string[][] {
  const start = body.indexOf(`aria-label="${title}"`);
  if (start < 0) {
    return [];
  }
  const tbody = /<tbody>([\s\S]*?)<\/tbody>/.exec(body.slice(start))?.[1] ?? '';
  return [...tbody.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((row) =>
    [...row[1].matchAll(/<td>([^<]*)<\/td>/g)].map((m) => m[1]),
  );
}

/** A plain table under an h2, by the heading text: rows of cell words. */
function sectionTable(body: string, heading: string): string[][] {
  const start = body.indexOf(`<h2 class="chart-title">${heading}</h2>`);
  if (start < 0) {
    return [];
  }
  const tbody = /<tbody>([\s\S]*?)<\/tbody>/.exec(body.slice(start))?.[1] ?? '';
  return [...tbody.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((row) =>
    [...row[1].matchAll(/<td>([\s\S]*?)<\/td>/g)].map((m) => words(m[1])),
  );
}

/** The headline tiles: [label, number, note]. */
function tiles(body: string): string[][] {
  return [...body.matchAll(/<div class="stat">([\s\S]*?)<\/div>/g)].map((m) => [
    words(/<dt>([\s\S]*?)<\/dt>/.exec(m[1])?.[1] ?? ''),
    words(/<dd>([\s\S]*?)<\/dd>/.exec(m[1])?.[1] ?? ''),
    words(/<dd class="stat-note">([\s\S]*?)<\/dd>/.exec(m[1])?.[1] ?? ''),
  ]);
}

const LADDER = 'Share who came to another event, by events attended';
const BY_MONTH = 'Second and third event within 90 days, by first-event month';
const ACTIVE = 'Members attending each month, new and returning';
const STEPS = 'The first steps, by first-event year';
const YEARLY = 'Yearly cohorts';

describe('retention page', () => {
  it('shows when the snapshot was updated and what "attended" means', async () => {
    const { retention, get } = await setup();
    const res = await get(PAGE);
    expect(res.status).toBe(200);
    expect(retention).toHaveBeenCalledTimes(1);
    const text = words(res.text);
    expect(text).toContain('Updated Oct 5, 2026 9:15 AM Pacific');
    expect(text).toContain(
      'A member attended an event when they said yes to it and it has happened: Meetup’s no-show marks are not in this data.',
    );
    expect(text).toContain('Cancelled events do not count.');
    expect(text).toContain(
      'People who joined the group and never attended are not on this page.',
    );
  });

  it('headline tiles: the latest 12 matured months, with the 12 before', async () => {
    const { get } = await setup(
      retentionView({
        cohorts: retentionView().cohorts.map((c) => {
          // A weaker earlier year, and unmatured months that must not count.
          if (c.month >= '2024-07' && c.month <= '2025-06') {
            return cohortMonth(c.month, { third90: 35 });
          }
          return c.month > '2026-06'
            ? cohortMonth(c.month, { third90: 100, second90: 100 })
            : c;
        }),
      }),
    );
    expect(tiles((await get(PAGE)).text)).toEqual([
      [
        'Third event within 90 days',
        '40%',
        '480 of 1,200 members whose first event was July 2025 to June 2026. ' +
          'Before that, July 2024 to June 2025: 35% (420 of 1,200).',
      ],
      [
        'Second event within 90 days',
        '60%',
        '720 of 1,200 members whose first event was July 2025 to June 2026. ' +
          'Before that, July 2024 to June 2025: 60% (720 of 1,200).',
      ],
      [
        'Still coming a year on',
        '30%',
        '360 of 1,200 members whose first event was October 2024 to September 2025. ' +
          'Before that, October 2023 to September 2024: 30% (360 of 1,200).',
      ],
    ]);
  });

  it('tiles with fewer than 12 matured months say which months they cover', async () => {
    // Data from September 2025 only: ten months have had 90 days, one a year.
    const view = retentionView();
    const { get } = await setup(
      retentionView({
        cohorts: view.cohorts.filter((c) => c.month >= '2025-09'),
      }),
    );
    expect(tiles((await get(PAGE)).text)).toEqual([
      [
        'Third event within 90 days',
        '40%',
        '400 of 1,000 members whose first event was September 2025 to June 2026 (10 months only). ' +
          'No earlier months to compare.',
      ],
      [
        'Second event within 90 days',
        '60%',
        '600 of 1,000 members whose first event was September 2025 to June 2026 (10 months only). ' +
          'No earlier months to compare.',
      ],
      [
        'Still coming a year on',
        '30%',
        '30 of 100 members whose first event was September 2025 (1 month only). ' +
          'No earlier months to compare.',
      ],
    ]);
  });

  it('says what the tiles count', async () => {
    const { get } = await setup();
    expect(words((await get(PAGE)).text)).toContain(
      'Each number is for the latest 12 months of first-timers who have all had the full time ' +
        '(fewer months when the data does not go back that far): 90 days after their first event ' +
        'for the first two, 365 days for the third. “Still coming a year on” is the share who ' +
        'attended an event roughly 9 to 12 months after their first (days 271 to 365).',
    );
  });

  it("shows each chart's and table's title as a real heading, and the charts keep their names", async () => {
    const { get } = await setup();
    const res = await get(PAGE);
    const headings = [
      ...res.text.matchAll(/<h2 class="chart-title">([^<]*)<\/h2>/g),
    ].map((m) => m[1]);
    expect(headings).toEqual([LADDER, STEPS, BY_MONTH, ACTIVE, YEARLY]);
    for (const title of [LADDER, BY_MONTH, ACTIVE]) {
      expect(res.text).toContain(`aria-label="${title}"`);
    }
    expect(res.text.match(/<svg\s+class="chart"/g)).toHaveLength(3);
    expect(res.text).not.toMatch(/style\s*=/i);
    expect(res.text).not.toMatch(/<script(?![^>]*nonce=)/);
  });

  it('every chart and table has its one plain-words note', async () => {
    const { get } = await setup();
    const text = words((await get(PAGE)).text);
    expect(text).toContain(
      'Of members who attended that many events, the share who went on to attend one more, ' +
        'at any time since. Counts members whose first event was November 2024 to June 2026. ' +
        'First-timers after June 2026 are left out: not all of them have had 90 days to come back.',
    );
    expect(text).toContain(
      'For members whose first event was in each year: the share who attended a second event, ' +
        'then of those the share who attended a third, then a fourth. Numbers marked “so far” are ' +
        'for a year that still has first-timers with less than 90 days behind them: they will change.',
    );
    expect(text).toContain(
      'Of members whose first event was in each month, the share who attended a second event, ' +
        'and a third, within 90 days of the first. A month appears once all its first-timers have ' +
        'had the full 90 days; a month with no first-timers is left out.',
    );
    expect(text).toContain(
      'Members who attended at least one event that month. New: it was their first event with ' +
        'the group. Returning: they had attended before. The latest month is still filling in.',
    );
    expect(text).toContain(
      'Each row is the members whose first event was in that year.',
    );
    expect(text).toContain(
      '“1 year later” is the share who attended at least one event in the next calendar year, ' +
        'and so on. A year that is not over, and the own numbers of a year whose first-timers ' +
        'have not all had 90 days, are marked “so far”.',
    );
  });

  it('the ladder: of members with N events, the share with one more, as percentages', async () => {
    const { get } = await setup();
    expect(dataTable((await get(PAGE)).text, LADDER)).toEqual([
      ['1', '70%'],
      ['2', '80%'],
      ['3', '88%'],
      ['4', '86%'],
      ['5', '90%'],
      // Members who reached a seventh event, of those who reached a sixth.
      ['6', '92%'],
    ]);
  });

  it('an early third event and staying: only members who came back within 90 days, worded as an association', async () => {
    const { get } = await setup();
    const text = words((await get(PAGE)).text);
    // December 2025 is the last month whose members have all had 270 days.
    // Per month: 60 came back within 90 days; 40 reached a third in that
    // time (30 back later), 20 stopped at two (6 back later).
    expect(text).toContain(
      'Among members who came back within 90 days of their first event ' +
        '(first events November 2024 to December 2025): 75% (420 of 560) of those who reached ' +
        'a third event in that time also attended on days 91 to 270 after their first, against ' +
        '30% (84 of 280) of those who stopped at two. ' +
        'The two go together; this does not show that one causes the other.',
    );
    expect(text).not.toMatch(/why the third/i);
  });

  it('the comparison is left out when either group has under 20 members or no month has had 270 days', async () => {
    const view = retentionView();
    const shown = async (cohorts: typeof view.cohorts) => {
      const { get } = await setup(retentionView({ cohorts }));
      const text = words((await get(PAGE)).text);
      expect(text).not.toMatch(/– of those/);
      return text.includes('Among members who came back within 90 days');
    };
    // Everyone who came back reached a third event: nobody stopped at two.
    expect(
      await shown(view.cohorts.map((c) => ({ ...c, third90: c.second90 }))),
    ).toBe(false);
    // 19 members stopped at two over the 14 months (one month has 6, the
    // rest 1 each): one short.
    const few = (extra: number) =>
      view.cohorts.map((c) => ({
        ...c,
        second90: c.third90 + (c.month === '2025-01' ? extra : 1),
        laterTwo90: 0,
      }));
    expect(await shown(few(6))).toBe(false);
    // 20 is enough.
    expect(await shown(few(7))).toBe(true);
    // Too few with an early third event, the other way round.
    expect(
      await shown(
        view.cohorts.map((c) => ({ ...c, third90: 1, laterThird90: 0 })),
      ),
    ).toBe(false);
    // Data from March 2026 only: no month is 270 days old.
    expect(await shown(view.cohorts.filter((c) => c.month >= '2026-03'))).toBe(
      false,
    );
  });

  it('the notes name months that have data when the range starts before it', async () => {
    const view = retentionView();
    // Data from September 2025; the default range starts in November 2024,
    // and 5 years in November 2021.
    const { get } = await setup(
      retentionView({
        cohorts: view.cohorts.filter((c) => c.month >= '2025-09'),
      }),
    );
    for (const query of ['', '?months=60', '?months=all']) {
      // eslint-disable-next-line no-await-in-loop
      const text = words((await get(`${PAGE}${query}`)).text);
      expect(text, query).toContain(
        'Counts members whose first event was September 2025 to June 2026.',
      );
      expect(text, query).toContain(
        '(first events September 2025 to December 2025)',
      );
    }
  });

  it('a step nobody reached is a dash with no bar, not 0%', async () => {
    const view = retentionView();
    const { get } = await setup(
      retentionView({
        cohorts: view.cohorts.map((c) => ({ ...c, reached6: 0, reached7: 0 })),
      }),
    );
    const res = await get(PAGE);
    expect(dataTable(res.text, LADDER).slice(4)).toEqual([
      ['5', '0%'],
      ['6', '–'],
    ]);
    const start = res.text.indexOf(`aria-label="${LADDER}"`);
    const svg = res.text.slice(start, res.text.indexOf('</svg>', start));
    expect(svg.match(/<rect/g)).toHaveLength(5);
  });

  it('the monthly line has matured months only, and skips a month with no first-timers', async () => {
    const view = retentionView();
    const { get } = await setup(
      retentionView({
        cohorts: view.cohorts.map((c) => {
          return c.month === '2025-03'
            ? cohortMonth(c.month, { members: 0 })
            : c;
        }),
      }),
    );
    const rows = dataTable((await get(PAGE)).text, BY_MONTH);
    const months = rows.map((r) => r[0]);
    // 24 months back from October 2026 is November 2024; June 2026 is the
    // last month whose first-timers have all had 90 days.
    expect(months[0]).toBe('2024-11');
    expect(months[months.length - 1]).toBe('2026-06');
    expect(months).not.toContain('2025-03');
    expect(months).toHaveLength(19);
    expect(rows[0]).toEqual(['2024-11', '60%', '40%']);
  });

  it('members per month: new and returning, every month of the range, zero where nobody came', async () => {
    const view = retentionView();
    const { get } = await setup(
      retentionView({
        months: view.months.filter((m) => m.month !== '2025-12'),
      }),
    );
    const rows = dataTable((await get(PAGE)).text, ACTIVE);
    expect(rows).toHaveLength(24);
    expect(rows[0]).toEqual(['2024-11', '100', '250']);
    expect(rows[23]).toEqual(['2026-10', '100', '250']);
    expect(rows.find((r) => r[0] === '2025-12')).toEqual(['2025-12', '0', '0']);
  });

  it('the first steps by year, with the year still filling marked', async () => {
    const { get } = await setup();
    expect(sectionTable((await get(PAGE)).text, STEPS)).toEqual([
      ['2023', '1,200', '70%', '80%', '88%'],
      ['2024', '1,200', '70%', '80%', '88%'],
      ['2025', '1,200', '70%', '80%', '88%'],
      ['2026', '1,000 so far', '70% so far', '80% so far', '88% so far'],
    ]);
  });

  it('the yearly cohort triangle: finished years plain, the current year so far, later years blank', async () => {
    const { get } = await setup();
    expect(sectionTable((await get(PAGE)).text, YEARLY)).toEqual([
      ['2023', '1,200', '30%', '42%', '40%', '40%', '40% so far', '', ''],
      ['2024', '1,200', '30%', '42%', '40%', '40% so far', '', '', ''],
      ['2025', '1,200', '30%', '42%', '40% so far', '', '', '', ''],
      // The newest year's own numbers are still filling too.
      ['2026', '1,000 so far', '30% so far', '42% so far', '', '', '', '', ''],
    ]);
  });

  describe('range picker', () => {
    it('offers the four ranges, 24 months current by default', async () => {
      const { get } = await setup();
      const res = await get(PAGE);
      const nav =
        /<nav class="pager choices" aria-label="First events in">([\s\S]*?)<\/nav>/.exec(
          res.text,
        )?.[1];
      expect(words(nav ?? '')).toBe('12 months 24 months 5 years All');
      expect(nav).toContain('<strong>24 months</strong>');
      expect(nav).toContain('href="/dashboard/retention?months=12"');
      expect(nav).toContain('href="/dashboard/retention?months=all"');
    });

    it.each([
      ['12', '2025-11', 12],
      ['60', '2021-11', 60],
      // All: from the first month with anyone attending.
      ['all', '2023-01', 46],
      // Anything else is the default.
      ['7', '2024-11', 24],
      ['all&months=12', '2024-11', 24],
    ])('months=%s starts at %s', async (months, first, count) => {
      const { get } = await setup();
      const rows = dataTable(
        (await get(`${PAGE}?months=${months}`)).text,
        ACTIVE,
      );
      expect(rows[0][0]).toBe(first);
      expect(rows).toHaveLength(count);
    });

    it('the ladder follows the range; the tiles and yearly tables do not', async () => {
      const view = retentionView();
      const data = retentionView({
        cohorts: view.cohorts.map((c) => {
          return c.month < '2025-11'
            ? cohortMonth(c.month, { reached2: 50 })
            : c;
        }),
      });
      const { get } = await setup(data);
      const year = await get(`${PAGE}?months=12`);
      const all = await get(`${PAGE}?months=all`);
      expect(dataTable(year.text, LADDER)[0]).toEqual(['1', '70%']);
      expect(dataTable(all.text, LADDER)[0]).toEqual(['1', '54%']);
      expect(tiles(year.text)).toEqual(tiles(all.text));
      expect(sectionTable(year.text, YEARLY)).toEqual(
        sectionTable(all.text, YEARLY),
      );
    });
  });

  it('before the first full snapshot: says so, with no charts', async () => {
    const { get } = await setup({ ready: false });
    const res = await get(PAGE);
    expect(res.status).toBe(200);
    expect(words(res.text)).toContain(
      'Nothing to show yet. This page fills in once the first full copy of the group’s events has finished.',
    );
    expect(res.text).not.toContain('<svg class="chart"');
    expect(res.text).not.toContain('class="stat"');
  });

  it('a snapshot with nobody attending yet: dashes and no charts, never NaN', async () => {
    const { get } = await setup(
      retentionView({ cohorts: [], months: [], years: [] }),
    );
    const res = await get(PAGE);
    expect(res.status).toBe(200);
    expect(tiles(res.text).map((t) => t[1])).toEqual(['–', '–', '–']);
    expect(res.text).not.toMatch(/NaN|undefined|Infinity/);
  });

  it('never says RSVP, and shows no member id', async () => {
    const { get } = await setup();
    for (const path of [PAGE, `${PAGE}?months=all`]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await get(path);
      expect(res.text).not.toMatch(/RSVP/i);
      // Every run of digits on the page is short: a count, a year or a
      // percentage, never a Meetup or Discord id. (The nonce and CSRF token
      // are not digit-only; asset hashes sit in attributes.)
      expect(words(res.text)).not.toMatch(/\d{7,}/);
    }
  });

  it('503 when the read fails, without the error text', async () => {
    const { get } = await setup(undefined, {
      retention: vi.fn().mockRejectedValue(new Error('hunter2')),
    });
    const res = await get(PAGE);
    expect(res.status).toBe(503);
    expect(res.text).not.toContain('hunter2');
    expect(words(res.text)).toContain('Retention cannot be loaded');
  });

  it('is in the Analytics group, after Trends, and marks itself current', async () => {
    const { get } = await setup();
    const res = await get(PAGE);
    expect(res.text).toMatch(
      /href="\/dashboard\/trends"[^>]*>Trends<\/a>[\s\S]{0,200}href="\/dashboard\/retention"[^>]*aria-current="page"[^>]*>Retention<\/a>/,
    );
  });

  it('signed out: sent to the login page, and nothing is read', async () => {
    const { retention, req } = await setup();
    const res = await req.get(PAGE);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/dashboard/login');
    expect(retention).not.toHaveBeenCalled();
  });
});
