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
  pages?: Partial<DashboardPageDeps>;
}

async function setup({
  rows = SEEDED,
  byMonth = [{ month: '2026-09', count: 3 }],
  pages = {},
}: Setup = {}) {
  const snapshots = fakeSnapshots(rows);
  // Trends never read payloads or single months.
  snapshots.getCurrent.mockRejectedValue(new Error('getCurrent read'));
  snapshots.getCurrentMeta.mockRejectedValue(new Error('getCurrentMeta read'));
  snapshots.listSummaries.mockRejectedValue(new Error('listSummaries read'));
  snapshots.listMemberNoShowMonths.mockRejectedValue(new Error('member read'));
  const suspensions = fakeSuspensions({}, byMonth);
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
