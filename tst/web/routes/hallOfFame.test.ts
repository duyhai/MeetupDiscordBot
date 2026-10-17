import { afterEach, describe, expect, it } from 'vitest';

import { formatHostingStatsText } from '../../../src/lib/reports/hallOfFameReport.js';
import { Period } from '../../../src/lib/reports/period.js';
import { COPY_SCRIPT } from '../../../src/web/pageKit.js';
import {
  DashboardPageDeps,
  registerAllProtectedRoutes,
} from '../../../src/web/routes/dashboardPages.js';
import { commandPeriodLabel } from '../../../src/web/routes/hallOfFame.js';
import {
  closeServers,
  makeApp,
  rawRequest,
  signIn,
} from '../dashboardHarness.js';
import {
  PAGE_NOW,
  REAL_EVENT_URL,
  SEPT,
  SeedRow,
  fakeOrganizerDeps,
  fakePageDeps,
  fakeSnapshots,
  hofPayload,
  seedRow,
} from './pageFakes.js';

afterEach(closeServers);

async function setup(
  rows: SeedRow[] = [seedRow('hall_of_fame', SEPT, hofPayload())],
  pages: Partial<DashboardPageDeps> = {},
) {
  const snapshots = fakeSnapshots(rows);
  const { req, server } = await makeApp({
    now: () => PAGE_NOW.getTime(),
    protectedRoutes: (r) =>
      registerAllProtectedRoutes(r, {
        organizer: fakeOrganizerDeps(),
        pages: fakePageDeps({ snapshots: async () => snapshots, ...pages }),
      }),
  });
  const cookie = await signIn(req);
  const get = (path: string) => req.get(path).set('Cookie', cookie);
  return { req, server, cookie, snapshots, get };
}

const MONTH = '/dashboard/hall-of-fame/2026-09';

const unescape = (text: string) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

/** The hosts table body: one <tr> per host row. */
const hostRows = (body: string) => {
  const tbody = /<tbody>([\s\S]*?)<\/tbody>/.exec(body)?.[1] ?? '';
  return tbody.match(/<tr>/g)?.length ?? 0;
};

describe('Hall of Fame month page', () => {
  it('escapes host names and event titles', async () => {
    const { get } = await setup();
    const res = await get(MONTH);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<script>alert');
    expect(res.text).not.toContain('<img src=x');
    expect(res.text).toMatch(/<bdi>&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  it('labels the per-event number RSVPs, never attendance', async () => {
    const { get } = await setup();
    const res = await get(MONTH);
    expect(res.text).toContain('7 RSVPs / 10 spots');
    expect(res.text).not.toMatch(/attend/i);
  });

  it('member links come from digit ids, never memberUrl', async () => {
    const { get } = await setup();
    const res = await get(MONTH);
    expect(res.text).not.toContain('evil.example');
    expect(res.text).toContain('href="https://www.meetup.com/members/1000/"');
  });

  it('event links pass safeHref or render as text', async () => {
    const { get } = await setup();
    const res = await get(MONTH);
    expect(res.text).not.toContain('href="javascript:');
    expect(res.text).not.toContain('javascript:alert');
    expect(res.text).toContain(`href="${REAL_EVENT_URL}"`);
  });

  it('copy text comes from a readonly textarea value', async () => {
    const { get } = await setup();
    const res = await get(MONTH);
    expect(res.text).toContain(
      '<textarea id="hof-post" class="copy" readonly>',
    );
    const scripts = [
      ...res.text.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g),
    ];
    expect(scripts).toHaveLength(1);
    expect(scripts[0][1]).toMatch(/^ nonce="[^"]+"$/);
    expect(scripts[0][2]).toBe(COPY_SCRIPT.value);
  });

  it("copy text matches the command's ready-to-post block", async () => {
    const payload = hofPayload();
    const { get } = await setup([seedRow('hall_of_fame', SEPT, payload)]);
    const res = await get(MONTH);
    const raw =
      /<textarea id="hof-post" class="copy" readonly>([\s\S]*?)<\/textarea>/.exec(
        res.text,
      )?.[1];
    const expected = formatHostingStatsText(payload, {
      periodLabel: '2026 September',
      showDates: false,
      includeLinks: false,
    }).split('----- READY TO POST -----\n\n')[1];
    expect(expected).toContain('Hall of Fame — 2026 September');
    expect(unescape(raw ?? '')).toBe(expected);
  });

  it('commandPeriodLabel is the command label', () => {
    expect(commandPeriodLabel(SEPT)).toBe('2026 September');
    expect(commandPeriodLabel({ year: 2025, month: 1 })).toBe('2025 January');
  });

  it('paginates hosts at 50', async () => {
    const { get } = await setup();
    const first = await get(MONTH);
    expect(hostRows(first.text)).toBe(50);
    expect(first.text).toContain(`href="${MONTH}?page=2"`);
    expect(first.text).toContain('members/1049/');
    expect(first.text).not.toContain('members/1050/');
    const second = await get(`${MONTH}?page=2`);
    expect(hostRows(second.text)).toBe(10);
    expect(second.text).toMatch(/<td>\s*51\s*<\/td>/);
    expect(second.text).toMatch(/<td>\s*60\s*<\/td>/);
    expect(second.text).toContain('members/1050/');
    expect(second.text).not.toContain('members/1049/');
  });

  it('says not built yet with no snapshot, and offers a refresh', async () => {
    const { get } = await setup();
    const res = await get('/dashboard/hall-of-fame/2026-08');
    expect(res.status).toBe(200);
    expect(res.text).toContain('have not been built yet');
    expect(res.text).toContain('action="/dashboard/reports/2026-08/refresh"');
  });

  it("a month before the group's first is not found and offers no refresh", async () => {
    const { get, snapshots } = await setup();
    const before = await get('/dashboard/hall-of-fame/2013-02');
    expect(before.status).toBe(404);
    expect(before.text).not.toContain('/refresh"');
    expect(snapshots.getCurrent).not.toHaveBeenCalled();
    const first = await get('/dashboard/hall-of-fame/2013-03');
    expect(first.status).toBe(200);
    expect(first.text).toContain('action="/dashboard/reports/2013-03/refresh"');
  });

  it('the refresh form carries the CSRF token and its return page', async () => {
    const { get } = await setup();
    const res = await get(MONTH);
    expect(res.text).toContain('action="/dashboard/reports/2026-09/refresh"');
    expect(res.text).toMatch(/name="_csrf" value="[^"]+"/);
    expect(res.text).toContain('name="return" value="hall-of-fame"');
  });

  it('404 for a malformed or future month', async () => {
    const { get, snapshots, server, cookie } = await setup();
    for (const path of ['2026-9', '2026-13', '2026-11', '2026-09x']) {
      // eslint-disable-next-line no-await-in-loop -- one request at a time, so a failure names its path
      const res = await get(`/dashboard/hall-of-fame/${path}`);
      expect(res.status, path).toBe(404);
    }
    // Sent byte for byte: an HTTP client would resolve the dot segment.
    const dots = await rawRequest(
      server,
      'GET',
      '/dashboard/hall-of-fame/%2E%2E',
      {
        Cookie: cookie,
      },
    );
    expect(dots.status).toBe(404);
    expect(snapshots.getCurrent).not.toHaveBeenCalled();
  });

  it('503 without details when the snapshot read fails', async () => {
    const { get } = await setup(undefined, {
      snapshots: () => Promise.reject(new Error('password=hunter2')),
    });
    const res = await get(MONTH);
    expect(res.status).toBe(503);
    expect(res.text).not.toContain('hunter2');
    const list = await get('/dashboard/hall-of-fame');
    expect(list.status).toBe(503);
    expect(list.text).not.toContain('hunter2');
  });

  it('503 when the stored payload is not a Hall of Fame report', async () => {
    const { get } = await setup([
      seedRow('hall_of_fame', SEPT, { junk: true }),
    ]);
    const res = await get(MONTH);
    expect(res.status).toBe(503);
  });

  it('503, not 500, when a stored host entry is malformed', async () => {
    const good = hofPayload().hosts[1];
    const malformed: unknown[][] = [
      [null],
      ['host'],
      [{ events: [] }],
      [{ host: null, events: [] }],
      [{ host: good.host }],
      [{ host: good.host, events: 'x' }],
      [{ host: good.host, events: [null] }],
      [good, { host: good.host, events: {} }],
    ];
    for (const hosts of malformed) {
      // eslint-disable-next-line no-await-in-loop -- one payload at a time, so a failure names it
      const { get } = await setup([
        seedRow('hall_of_fame', SEPT, { ...hofPayload(), hosts }),
      ]);
      // eslint-disable-next-line no-await-in-loop -- one payload at a time, so a failure names it
      const res = await get(MONTH);
      expect(res.status, JSON.stringify(hosts)).toBe(503);
      expect(res.text).toContain('cannot be loaded right now');
    }
  });

  it('never says incomplete', async () => {
    const { get } = await setup();
    for (const path of [
      MONTH,
      '/dashboard/hall-of-fame/2026-08',
      '/dashboard/hall-of-fame',
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one request at a time, so a failure names its path
      const res = await get(path);
      expect(res.text, path).not.toMatch(/incomplete/i);
    }
  });
});

describe('Hall of Fame months list', () => {
  const months = (n: number): SeedRow[] =>
    Array.from({ length: n }, (_, i) => {
      const period: Period = {
        year: 2026 - Math.floor((i + 3) / 12),
        month: 12 - ((i + 3) % 12),
      };
      return seedRow('hall_of_fame', period, null, {
        summary: { events: 4, hosts: 3, newHosts: 1 },
      });
    });

  it('lists months with links and summary numbers', async () => {
    const { get } = await setup([
      seedRow('hall_of_fame', SEPT, null, {
        summary: { events: 12, hosts: 7, newHosts: 2 },
      }),
      seedRow('hall_of_fame', { year: 2026, month: 8 }, null, {
        summary: { events: '<b>', hosts: null, newHosts: 1 },
      }),
    ]);
    const res = await get('/dashboard/hall-of-fame');
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/dashboard/hall-of-fame/2026-09"');
    expect(res.text).toContain('href="/dashboard/hall-of-fame/2026-08"');
    expect(res.text).toMatch(/<td>\s*12\s*<\/td>/);
    expect(res.text).not.toContain('<b>');
    expect(res.text).not.toContain('&lt;b&gt;');
    expect(res.text).not.toMatch(/incomplete/i);
  });

  it('a stored month before the group began is listed unlinked, not a 500', async () => {
    const { get } = await setup([
      seedRow('hall_of_fame', SEPT, null, {
        summary: { events: 12, hosts: 7, newHosts: 2 },
      }),
      seedRow('hall_of_fame', { year: 2013, month: 3 }, null, {
        summary: { events: 1, hosts: 1, newHosts: 1 },
      }),
      seedRow('hall_of_fame', { year: 2013, month: 2 }, null, {
        summary: { events: 1, hosts: 1, newHosts: 1 },
      }),
    ]);
    const res = await get('/dashboard/hall-of-fame');
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/dashboard/hall-of-fame/2026-09"');
    expect(res.text).toContain('href="/dashboard/hall-of-fame/2013-03"');
    expect(res.text).not.toContain('2013-02');
    expect(res.text).toMatch(/<td>\s*February 2013\s*<\/td>/);
    expect(res.text).not.toMatch(/<a[^>]*>\s*February 2013/);
  });

  it('months list pages with before and ignores junk', async () => {
    const { get, snapshots } = await setup();
    await get('/dashboard/hall-of-fame?before=2026-05');
    expect(snapshots.listSummaries).toHaveBeenLastCalledWith('hall_of_fame', {
      before: { year: 2026, month: 5 },
      limit: 50,
    });
    await get('/dashboard/hall-of-fame?before=2026-5');
    expect(snapshots.listSummaries).toHaveBeenLastCalledWith('hall_of_fame', {
      before: undefined,
      limit: 50,
    });
    await get('/dashboard/hall-of-fame?before=2026-05&before=2026-04');
    expect(snapshots.listSummaries).toHaveBeenLastCalledWith('hall_of_fame', {
      before: undefined,
      limit: 50,
    });
  });

  it('links older months only when a full page came back', async () => {
    const rows = months(51);
    const { get } = await setup(rows);
    const res = await get('/dashboard/hall-of-fame');
    const last = rows[49].meta.period;
    const key = `${last.year}-${String(last.month).padStart(2, '0')}`;
    expect(res.text).toContain(`href="/dashboard/hall-of-fame?before=${key}"`);
    const few = await (await setup(months(3))).get('/dashboard/hall-of-fame');
    expect(few.text).not.toContain('?before=');
  });

  it('says so when nothing is stored yet', async () => {
    const { get } = await setup([]);
    const res = await get('/dashboard/hall-of-fame');
    expect(res.status).toBe(200);
    expect(res.text).toContain('No Hall of Fame reports');
  });
});
