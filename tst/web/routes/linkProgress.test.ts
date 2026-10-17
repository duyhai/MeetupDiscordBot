import { afterEach, describe, expect, it } from 'vitest';

import { LinkProgressDay } from '../../../src/lib/repositories/postgresLinkProgressRepository.js';
import {
  DashboardPageDeps,
  registerAllProtectedRoutes,
} from '../../../src/web/routes/dashboardPages.js';
import { closeServers, makeApp, signIn } from '../dashboardHarness.js';
import {
  PAGE_NOW,
  fakeLinkProgress,
  fakeOrganizerDeps,
  fakePageDeps,
  linkDay,
  linkDays,
} from './pageFakes.js';

afterEach(closeServers);

const PAGE = '/dashboard/link-progress';

async function setup(
  days: LinkProgressDay[] = linkDays(3),
  pages: Partial<DashboardPageDeps> = {},
) {
  const reader = fakeLinkProgress(days);
  const { req } = await makeApp({
    now: () => PAGE_NOW.getTime(),
    protectedRoutes: (r) =>
      registerAllProtectedRoutes(r, {
        organizer: fakeOrganizerDeps(),
        pages: fakePageDeps({ linkProgress: async () => reader, ...pages }),
      }),
  });
  const cookie = await signIn(req);
  const get = (path: string) => req.get(path).set('Cookie', cookie);
  return { reader, get };
}

const words = (body: string) =>
  body
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Rows of the page's own table (the first tbody is the chart's data table). */
const pageTableDays = (body: string) => {
  const table = /<table class="days">([\s\S]*?)<\/table>/.exec(body)?.[1] ?? '';
  return [...table.matchAll(/<td>(\d{4}-\d{2}-\d{2})<\/td>/g)].map((m) => m[1]);
};

describe('link progress page', () => {
  it('reads the chosen number of days', async () => {
    const { reader, get } = await setup();
    expect((await get(`${PAGE}?days=365`)).status).toBe(200);
    expect(reader.listDays).toHaveBeenLastCalledWith(365);
    expect((await get(`${PAGE}?days=30`)).status).toBe(200);
    expect(reader.listDays).toHaveBeenLastCalledWith(30);
    for (const junk of ['1000', '-1', 'all', '90abc', '']) {
      // eslint-disable-next-line no-await-in-loop -- one request at a time
      expect((await get(`${PAGE}?days=${junk}`)).status).toBe(200);
      expect(reader.listDays).toHaveBeenLastCalledWith(90);
    }
    expect((await get(`${PAGE}?days=30&days=365`)).status).toBe(200);
    expect(reader.listDays).toHaveBeenLastCalledWith(90);
    expect((await get(PAGE)).status).toBe(200);
    expect(reader.listDays).toHaveBeenLastCalledWith(90);
  });

  it('draws one line chart, oldest day first, and a table newest first', async () => {
    const { get } = await setup([
      linkDay('2026-10-04', { linked: 120 }),
      linkDay('2026-10-03', { linked: 110 }),
    ]);
    const res = await get(PAGE);
    expect(res.status).toBe(200);
    expect(res.text.match(/<svg\s+class="chart"/g)).toHaveLength(1);
    expect(res.text).toMatch(/<polyline/);
    expect(res.text).not.toMatch(/style\s*=/i);
    const svgText = /<svg[\s\S]*?<\/svg>/.exec(res.text)?.[0] ?? '';
    expect(svgText.indexOf('2026-10-03')).toBeLessThan(
      svgText.indexOf('2026-10-04'),
    );
    expect(pageTableDays(res.text)).toEqual(['2026-10-04', '2026-10-03']);
    const text = words(res.text);
    expect(text).toContain(
      "Recorded once a day since the dashboard's build job started.",
    );
    for (const label of [
      'Linked',
      'Unlinked',
      'Reverify-tagged',
      'Onboarding',
    ]) {
      expect(text).toContain(label);
    }
  });

  it('paginates the table at 50', async () => {
    const { get } = await setup(linkDays(120));
    const first = await get(PAGE);
    expect(pageTableDays(first.text)).toHaveLength(50);
    expect(pageTableDays(first.text)[0]).toBe('2026-10-04');
    expect(first.text).toContain(
      'href="/dashboard/link-progress?days=90&amp;page=2"',
    );
    // 120 stored, 90 read: page 2 holds the last 40 and links no further.
    const second = await get(`${PAGE}?page=2`);
    expect(pageTableDays(second.text)).toHaveLength(40);
    expect(second.text).not.toContain('page=3');
    const third = await get(`${PAGE}?days=365&page=3`);
    expect(pageTableDays(third.text)).toHaveLength(20);
    expect(third.text).not.toContain('page=4');
    const past = await get(`${PAGE}?page=9`);
    expect(past.status).toBe(200);
    expect(pageTableDays(past.text)).toHaveLength(0);
    expect(words(past.text)).toContain('No more days.');
  });

  it('keeps the days choice in the page links', async () => {
    const { get } = await setup(linkDays(60));
    const res = await get(`${PAGE}?days=365`);
    expect(res.text).toContain(
      'href="/dashboard/link-progress?days=365&amp;page=2"',
    );
    expect(res.text).toContain('href="/dashboard/link-progress?days=30"');
  });

  it('says so when nothing is recorded yet', async () => {
    const { get } = await setup([]);
    const res = await get(PAGE);
    expect(res.status).toBe(200);
    expect(words(res.text)).toContain('No link progress recorded yet.');
    expect(res.text).not.toContain('<svg');
  });

  it('503 when the read fails', async () => {
    const { get } = await setup(undefined, {
      linkProgress: () => Promise.reject(new Error('password=hunter2')),
    });
    const res = await get(PAGE);
    expect(res.status).toBe(503);
    expect(res.text).not.toContain('hunter2');
    expect(words(res.text)).toContain('Link progress cannot be loaded');

    const reader = fakeLinkProgress();
    reader.listDays.mockRejectedValue(new Error('connection reset'));
    const second = await setup(undefined, {
      linkProgress: async () => reader,
    });
    expect((await second.get(PAGE)).status).toBe(503);
  });

  it('503, not 500, when a row has the wrong shape', async () => {
    for (const bad of [
      { day: 'yesterday' },
      { linked: '3' as unknown as number },
      { onboarding: Number.NaN },
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one app at a time
      const { get } = await setup([linkDay('2026-10-04', bad)]);
      // eslint-disable-next-line no-await-in-loop -- one request at a time
      expect((await get(PAGE)).status, JSON.stringify(bad)).toBe(503);
    }
  });
});
