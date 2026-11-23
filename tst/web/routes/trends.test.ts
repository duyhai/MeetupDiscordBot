import { afterEach, describe, expect, it } from 'vitest';

import { Period } from '../../../src/lib/reports/period.js';
import {
  DashboardPageDeps,
  registerAllProtectedRoutes,
} from '../../../src/web/routes/dashboardPages.js';
import { closeServers, makeApp, signIn } from '../dashboardHarness.js';
import {
  PAGE_NOW,
  SEPT,
  SeedRow,
  fakeOrganizerDeps,
  fakePageDeps,
  fakeSnapshots,
  fakeSuspensions,
  seedRow,
} from './pageFakes.js';

afterEach(closeServers);

const PAGE = '/dashboard/trends';
const AUG: Period = { year: 2026, month: 8 };

const noShowRow = (period: Period, summary: unknown) =>
  seedRow('no_show', period, { summary });
const hofRow = (period: Period, summary: unknown) =>
  seedRow('hall_of_fame', period, { summary });

const SEEDED: SeedRow[] = [
  noShowRow(SEPT, {
    noShows: 7,
    members: 5,
    warnings: 4,
    suspensionCandidates: 2,
    cleared: 0,
    departed: 0,
  }),
  hofRow(SEPT, { events: 61, hosts: 60, newHosts: 9 }),
];

interface Setup {
  rows?: SeedRow[];
  byMonth?: { month: string; count: number }[];
  /** Live records with a placeholder date (countUndated). */
  undated?: unknown;
  pages?: Partial<DashboardPageDeps>;
}

async function setup({
  rows = SEEDED,
  byMonth = [{ month: '2026-09', count: 3 }],
  undated = 0,
  pages = {},
}: Setup = {}) {
  const snapshots = fakeSnapshots(rows);
  // Trends never read payloads or single months.
  snapshots.getCurrent.mockRejectedValue(new Error('getCurrent read'));
  snapshots.getCurrentMeta.mockRejectedValue(new Error('getCurrentMeta read'));
  snapshots.listSummaries.mockRejectedValue(new Error('listSummaries read'));
  snapshots.listMemberNoShowMonths.mockRejectedValue(new Error('member read'));
  const suspensions = fakeSuspensions({}, byMonth, [], [], undated as number);
  const { req } = await makeApp({
    now: () => PAGE_NOW.getTime(),
    protectedRoutes: (r) =>
      registerAllProtectedRoutes(r, {
        organizer: fakeOrganizerDeps(),
        pages: fakePageDeps({
          snapshots: async () => snapshots,
          suspensions: async () => suspensions,
          ...pages,
        }),
      }),
  });
  const cookie = await signIn(req);
  const get = (path: string) => req.get(path).set('Cookie', cookie);
  return { snapshots, suspensions, get };
}

const words = (body: string) =>
  body
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Each chart's data table, by the chart's aria-label: rows of cell text. */
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

const rowFor = (body: string, title: string, month: string) =>
  dataTable(body, title).find((r) => r[0] === month);

describe('trends page', () => {
  it('reads summaries only', async () => {
    const { snapshots, get } = await setup();
    const res = await get(PAGE);
    expect(res.status).toBe(200);
    expect(snapshots.listSummarySeries).toHaveBeenCalledWith('hall_of_fame', {
      months: 24,
    });
    expect(snapshots.listSummarySeries).toHaveBeenCalledWith('no_show', {
      months: 24,
    });
    expect(snapshots.listSummarySeries).toHaveBeenCalledTimes(2);
    expect(snapshots.getCurrent).not.toHaveBeenCalled();
    expect(snapshots.getCurrentMeta).not.toHaveBeenCalled();
    expect(snapshots.listSummaries).not.toHaveBeenCalled();
    expect(res.text.match(/<svg\s+class="chart"/g)).toHaveLength(4);
    expect(res.text).not.toMatch(/style\s*=/i);
  });

  it('defaults to 24 continuous months ending with the current Pacific month', async () => {
    const { suspensions, get } = await setup();
    const res = await get(PAGE);
    const months = dataTable(res.text, 'No-shows per month').map((r) => r[0]);
    expect(months).toHaveLength(24);
    expect(months[0]).toBe('2024-11');
    expect(months[23]).toBe('2026-10');
    // UTC midnight of the first category's first day, like suspended_at.
    expect(suspensions.countByMonth).toHaveBeenCalledWith(
      new Date('2024-11-01T00:00:00Z'),
    );
  });

  it('accepts only the fixed month ranges', async () => {
    const { snapshots, get } = await setup();
    expect((await get(`${PAGE}?months=12`)).status).toBe(200);
    expect(snapshots.listSummarySeries).toHaveBeenLastCalledWith('no_show', {
      months: 12,
    });
    expect((await get(`${PAGE}?months=60`)).status).toBe(200);
    expect(snapshots.listSummarySeries).toHaveBeenLastCalledWith('no_show', {
      months: 60,
    });
    for (const junk of ['240', '6', '1e3', 'ALL', '24x']) {
      // eslint-disable-next-line no-await-in-loop -- one request at a time
      expect((await get(`${PAGE}?months=${junk}`)).status).toBe(200);
      expect(snapshots.listSummarySeries).toHaveBeenLastCalledWith('no_show', {
        months: 24,
      });
    }
    expect((await get(`${PAGE}?months=12&months=60`)).status).toBe(200);
    expect(snapshots.listSummarySeries).toHaveBeenLastCalledWith('no_show', {
      months: 24,
    });
  });

  it('months=all asks for 240', async () => {
    const { snapshots, get } = await setup({
      rows: [...SEEDED, hofRow({ year: 2019, month: 6 }, { events: 2 })],
    });
    const res = await get(`${PAGE}?months=all`);
    expect(res.status).toBe(200);
    expect(snapshots.listSummarySeries).toHaveBeenCalledWith('hall_of_fame', {
      months: 240,
    });
    expect(snapshots.listSummarySeries).toHaveBeenCalledWith('no_show', {
      months: 240,
    });
    // From the earliest stored month in either series to now.
    const months = dataTable(res.text, 'Events and distinct hosts per month');
    expect(months[0]).toEqual(['2019-06', '2', '0']);
    expect(months.at(-1)?.[0]).toBe('2026-10');
    expect(months).toHaveLength(7 * 12 + 5);
  });

  it('months=all with nothing stored shows the last 24 months', async () => {
    const { get } = await setup({ rows: [] });
    const res = await get(`${PAGE}?months=all`);
    const months = dataTable(res.text, 'No-shows per month').map((r) => r[0]);
    expect(months).toHaveLength(24);
    expect(months[0]).toBe('2024-11');
  });

  it('fills missing months with zero', async () => {
    const { get } = await setup();
    const res = await get(PAGE);
    expect(rowFor(res.text, 'No-shows per month', '2026-09')).toEqual([
      '2026-09',
      '7',
      '4',
      '2',
    ]);
    expect(rowFor(res.text, 'No-shows per month', periodLabel(AUG))).toEqual([
      '2026-08',
      '0',
      '0',
      '0',
    ]);
    expect(
      rowFor(res.text, 'Suspensions recorded per month', '2026-09'),
    ).toEqual(['2026-09', '3']);
    expect(
      rowFor(res.text, 'Suspensions recorded per month', '2026-08'),
    ).toEqual(['2026-08', '0']);
    expect(
      rowFor(res.text, 'Events and distinct hosts per month', '2026-09'),
    ).toEqual(['2026-09', '61', '60']);
    expect(rowFor(res.text, 'New hosts per month', '2026-09')).toEqual([
      '2026-09',
      '9',
    ]);
    expect(rowFor(res.text, 'New hosts per month', '2026-08')).toEqual([
      '2026-08',
      '0',
    ]);
  });

  it('reads junk summary fields as zero', async () => {
    const { get } = await setup({
      rows: [
        noShowRow(SEPT, {
          noShows: 'many',
          warnings: null,
          suspensionCandidates: -1,
        }),
        hofRow(AUG, null),
      ],
    });
    const res = await get(PAGE);
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/NaN|Infinity/);
    expect(rowFor(res.text, 'No-shows per month', '2026-09')).toEqual([
      '2026-09',
      '0',
      '0',
      '0',
    ]);
  });

  describe('titles and notes (Stacey, 2026-11-23)', () => {
    const TITLES = [
      'No-shows per month',
      'Suspensions recorded per month',
      'Events and distinct hosts per month',
      'New hosts per month',
    ];
    /** Each chart's <section>, in page order. */
    const sections = (body: string) =>
      [...body.matchAll(/<section>([\s\S]*?)<\/section>/g)].map((m) => m[1]);

    it("shows each chart's title as a real heading above it, and the chart keeps its name", async () => {
      const { get } = await setup();
      const res = await get(PAGE);
      const parts = sections(res.text);
      expect(parts).toHaveLength(4);
      parts.forEach((part, i) => {
        const heading = /<h2([^>]*)>([^<]*)<\/h2>/.exec(part);
        expect(heading?.[2].trim(), TITLES[i]).toBe(TITLES[i]);
        expect(part.indexOf('<h2')).toBeLessThan(part.indexOf('<svg'));
        // In the heading list: not hidden from assistive tech.
        expect(heading?.[1]).not.toMatch(/hidden/);
        expect(part).toContain(`aria-label="${TITLES[i]}"`);
        expect(part.match(/<h2/g)).toHaveLength(1);
      });
      // One h1, and no heading level skipped.
      expect(res.text.match(/<h1/g)).toHaveLength(1);
      expect(res.text).not.toMatch(/<h[3-6]/);
    });

    it("says what the first chart's three series are, in two sentences: due, not sent", async () => {
      const { get } = await setup();
      const [first] = sections((await get(PAGE)).text).map(words);
      expect(first).toContain(
        'No-shows: no-shows marked at that month’s events. ' +
          'Warnings and Suspension candidates: members who no-showed that month and are due a warning ' +
          '(one no-show in the last 12 months) or a suspension (two or more), ' +
          'counting only no-shows since their last suspension.',
      );
      expect(first).not.toMatch(/sent/i);
    });

    it('says how a month can have more hosts than events, under the third chart only', async () => {
      const { get } = await setup();
      const parts = sections((await get(PAGE)).text).map(words);
      const line =
        'A month can have more hosts than events when events are co-hosted.';
      expect(parts.map((p) => p.includes(line))).toEqual([
        false,
        false,
        true,
        false,
      ]);
    });

    it('says how many suspensions with no recorded date the second chart leaves out', async () => {
      const { suspensions, get } = await setup({
        undated: 68,
        byMonth: [{ month: '2026-09', count: 4 }],
      });
      const res = await get(PAGE);
      expect(suspensions.countUndated).toHaveBeenCalledTimes(1);
      const parts = sections(res.text).map(words);
      const line = '68 older suspensions with no recorded date are not shown.';
      expect(parts.map((p) => p.includes(line))).toEqual([
        false,
        true,
        false,
        false,
      ]);
      // The chart holds what countByMonth answered, nothing added back.
      expect(
        rowFor(res.text, 'Suspensions recorded per month', '2026-09'),
      ).toEqual(['2026-09', '4']);
    });

    it('one is singular; none, or a junk count, says nothing', async () => {
      const one = await setup({ undated: 1 });
      expect(words((await one.get(PAGE)).text)).toContain(
        '1 older suspension with no recorded date is not shown.',
      );
      for (const undated of [0, -3, 'x', null, Number.NaN]) {
        // eslint-disable-next-line no-await-in-loop -- one app at a time
        const { get } = await setup({ undated });
        // eslint-disable-next-line no-await-in-loop
        const res = await get(PAGE);
        expect(res.status, String(undated)).toBe(200);
        expect(words(res.text), String(undated)).not.toContain(
          'no recorded date',
        );
      }
    });

    it('the range picker keeps the notes and the count', async () => {
      const { get } = await setup({ undated: 68 });
      for (const months of ['12', '60', 'all']) {
        // eslint-disable-next-line no-await-in-loop
        const text = words((await get(`${PAGE}?months=${months}`)).text);
        expect(text, months).toContain(
          '68 older suspensions with no recorded date are not shown.',
        );
        expect(text, months).toContain(
          'counting only no-shows since their last suspension.',
        );
      }
    });
  });

  it('has no link progress chart (Hai, 2026-11-18)', async () => {
    const { get } = await setup();
    const res = await get(PAGE);
    expect(res.text).not.toMatch(/link progress/i);
    expect(res.text).not.toMatch(/Linked/);
  });

  it('labels no Hall of Fame number as attendance', async () => {
    const { get } = await setup();
    const res = await get(PAGE);
    expect(res.text).not.toMatch(/attend/i);
    expect(res.text).not.toMatch(/incomplete/i);
    expect(res.text).not.toMatch(/RSVP/);
  });

  it('503 when the read fails', async () => {
    const { get } = await setup({
      pages: { snapshots: () => Promise.reject(new Error('password=hunter2')) },
    });
    const res = await get(PAGE);
    expect(res.status).toBe(503);
    expect(res.text).not.toContain('hunter2');
    expect(words(res.text)).toContain('Trends cannot be loaded');

    const suspensions = fakeSuspensions();
    suspensions.countByMonth.mockRejectedValue(new Error('connection reset'));
    const second = await setup({
      pages: { suspensions: async () => suspensions },
    });
    expect((await second.get(PAGE)).status).toBe(503);
  });
});

function periodLabel(p: Period): string {
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}
