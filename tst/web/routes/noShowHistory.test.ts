import { afterEach, describe, expect, it } from 'vitest';

import { WorkspaceStatus } from '../../../src/lib/workspace/types.js';

import { Period } from '../../../src/lib/reports/period.js';
import { NoShowPayload } from '../../../src/lib/reports/types.js';
import { MemberNoShowMonth } from '../../../src/lib/repositories/postgresReportSnapshotRepository.js';
import {
  DashboardPageDeps,
  registerAllProtectedRoutes,
} from '../../../src/web/routes/dashboardPages.js';
import {
  closeServers,
  makeApp,
  rawRequest,
  signIn,
} from '../dashboardHarness.js';
import {
  PAGE_NOW,
  SEPT,
  SeedRow,
  fakeOrganizerDeps,
  fakePageDeps,
  fakeSnapshots,
  fakeWorkspace,
  fakeWorkspaceActions,
  noShowCase,
  noShowPayload,
  seedRow,
  workspaceRow,
} from './pageFakes.js';

afterEach(closeServers);

const OCT: Period = { year: 2026, month: 10 };
const MONTH = '/dashboard/no-show-history/2026-09';
const LIST = '/dashboard/no-show-history';
const MEMBER = '/dashboard/no-show-history/members/123456';

async function setup(
  rows: SeedRow[] = [seedRow('no_show', SEPT, noShowPayload())],
  memberMonths: MemberNoShowMonth[] = [],
  pages: Partial<DashboardPageDeps> = {},
) {
  const snapshots = fakeSnapshots(rows, memberMonths);
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

/** Page text with tags dropped and whitespace collapsed, for sentence checks. */
const words = (body: string) =>
  body
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The first table body (the cases table on a month page): one <tr> per row. */
const firstTableRows = (body: string) => {
  const tbody = /<tbody>([\s\S]*?)<\/tbody>/.exec(body)?.[1] ?? '';
  return tbody.match(/<tr>/g)?.length ?? 0;
};

const manyCases = (n: number): NoShowPayload =>
  noShowPayload({
    cases: Array.from({ length: n }, (_, i) => noShowCase(i)),
  });

const zeroEvidence = {
  pastEventsWithRsvps: 6,
  eventsWithNoShow: 0,
  noShows: 0,
};

const memberMonth = (
  period: Period,
  overrides: Partial<MemberNoShowMonth> = {},
): MemberNoShowMonth => ({
  period,
  builtAt: new Date('2026-10-01T15:00:00Z'),
  asOf: '2026-10-01T07:00:00.000Z',
  noShowCase: null,
  cleared: false,
  departed: false,
  ...overrides,
});

describe('no-show history month page', () => {
  it('shows cases, cleared and departed members', async () => {
    const { get } = await setup();
    const res = await get(MONTH);
    expect(res.status).toBe(200);
    const text = words(res.text);
    expect(text).toContain('No-show history — September 2026');
    expect(text).toContain('Warning');
    expect(text).toContain('Suspension candidate');
    expect(text).toContain('Counted since 2025-10-01 (12 months)');
    expect(text).toContain('Counted since 2026-03-02 (last suspension)');
    expect(text).toContain('60 days');
    expect(text).toContain('Has hosted');
    expect(text).toContain('Cleared One');
    expect(text).toContain('suspended 2026-08-01');
    expect(text).not.toContain('last suspended');
    expect(text).toContain(
      "No action needed — this month's no-shows no longer count",
    );
    expect(text).toContain('Gone One');
    expect(res.text).toContain(
      'href="/dashboard/no-show-history/members/2001"',
    );
    expect(res.text).toContain(
      'href="https://www.meetup.com/1-5genasians/events/599/"',
    );
  });

  it('shows asOf', async () => {
    const { get } = await setup();
    const res = await get(MONTH);
    expect(words(res.text)).toContain(
      'Counts no-shows up to Oct 1, 2026 12:00 AM Pacific',
    );
  });

  it('escapes member names and event titles', async () => {
    const { get } = await setup();
    const res = await get(MONTH);
    expect(res.text).not.toContain('<script>alert');
    expect(res.text).not.toContain('<img src=x');
    expect(res.text).toMatch(/<bdi>&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    expect(res.text).not.toContain('evil.example');
    expect(res.text).not.toContain('javascript:');
    expect(res.text).toContain('href="https://www.meetup.com/members/2000/"');
  });

  it('history link only for digit ids', async () => {
    const { get } = await setup([
      seedRow(
        'no_show',
        SEPT,
        noShowPayload({
          cases: [
            noShowCase(0, {
              member: { id: 'x1', name: 'Odd', memberUrl: '' },
            }),
          ],
        }),
      ),
    ]);
    const res = await get(MONTH);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Odd');
    // The cases table only: cleared and departed members have digit ids.
    const cases = /<tbody>([\s\S]*?)<\/tbody>/.exec(res.text)?.[1] ?? '';
    expect(cases).toContain('Odd');
    expect(cases).not.toContain('/no-show-history/members/');
    expect(res.text).toContain('/no-show-history/members/4000"');
  });

  it('paginates at 50', async () => {
    const rows = [seedRow('no_show', SEPT, manyCases(120))];
    const { get } = await setup(rows);
    const first = await get(MONTH);
    expect(firstTableRows(first.text)).toBe(50);
    expect(first.text).toContain(`href="${MONTH}?page=2"`);
    const third = await get(`${MONTH}?page=3`);
    expect(firstTableRows(third.text)).toBe(20);
    expect(third.text).toContain('members/2119/');
    expect(third.text).not.toContain('members/2099/');
    expect(third.text).not.toContain(`href="${MONTH}?page=4"`);
    expect(third.text).toContain(`href="${MONTH}?page=2"`);
  });

  it('orders cases like the command: warnings first, then suspension candidates, before paging', async () => {
    // 60 cases alternating suspension (even i) and warning (odd i).
    const cases = Array.from({ length: 60 }, (_, i) =>
      noShowCase(i, { classification: i % 2 === 0 ? 'suspension' : 'warning' }),
    );
    const { get } = await setup([
      seedRow('no_show', SEPT, noShowPayload({ cases })),
    ]);
    const ids = (body: string) => {
      const tbody = /<tbody>([\s\S]*?)<\/tbody>/.exec(body)?.[1] ?? '';
      return [...tbody.matchAll(/no-show-history\/members\/(\d+)"/g)].map(
        (m) => Number(m[1]) - 2000,
      );
    };
    const warnings = cases.map((_, i) => i).filter((i) => i % 2 === 1);
    const suspensions = cases.map((_, i) => i).filter((i) => i % 2 === 0);
    const expected = [...warnings, ...suspensions];
    const first = await get(MONTH);
    expect(ids(first.text)).toEqual(expected.slice(0, 50));
    const second = await get(`${MONTH}?page=2`);
    expect(ids(second.text)).toEqual(expected.slice(50));
  });

  it("cleared members without a suspension day say the command's fallback", async () => {
    const payload = noShowPayload({
      cleared: [
        { member: { id: '6001', name: 'Aged Out', memberUrl: '' } },
        {
          member: { id: '6002', name: 'Was Suspended', memberUrl: '' },
          lastSuspendedDay: '2026-08-01',
        },
      ],
    });
    const { get } = await setup([seedRow('no_show', SEPT, payload)]);
    const text = words((await get(MONTH)).text);
    expect(text).toMatch(/Aged Out History older than 12 months/);
    expect(text).toMatch(/Was Suspended History suspended 2026-08-01/);
  });

  it('caps cleared and departed lists at 50 with a remainder count', async () => {
    const people = (base: number) =>
      Array.from({ length: 53 }, (_, i) => ({
        id: String(base + i),
        name: `P${base + i}`,
        memberUrl: '',
      }));
    const payload = noShowPayload({
      cleared: people(6000).map((member) => ({ member })),
      departed: people(7000),
    });
    const { get } = await setup([seedRow('no_show', SEPT, payload)]);
    const res = await get(MONTH);
    const text = words(res.text);
    expect(text).toContain('P6049');
    expect(text).not.toContain('P6050');
    expect(text).toContain('P7049');
    expect(text).not.toContain('P7050');
    expect(text.match(/and 3 more/g)).toHaveLength(2);
  });

  it('notes a finished month with no no-shows, never an open one', async () => {
    const zero = (period: Period) =>
      seedRow(
        'no_show',
        period,
        noShowPayload({ attendance: zeroEvidence, cases: [] }),
        { attendance: zeroEvidence },
      );
    const { get } = await setup([zero(SEPT), zero(OCT)]);
    const sept = await get(MONTH);
    expect(words(sept.text)).toContain(
      'No no-shows were recorded for September 2026 across 6 past events with RSVPs',
    );
    const oct = await get('/dashboard/no-show-history/2026-10');
    expect(oct.status).toBe(200);
    expect(oct.text).not.toContain('No no-shows were recorded');
    const list = await get(LIST);
    expect(list.text.match(/No no-shows recorded/g)).toHaveLength(1);
    const septRow =
      /<tr>(?:(?!<\/tr>)[\s\S])*2026-09(?:(?!<\/tr>)[\s\S])*<\/tr>/.exec(
        list.text,
      )?.[0];
    expect(septRow).toContain('No no-shows recorded');
  });

  it('says not built yet with no snapshot, and offers a refresh back here', async () => {
    const { get } = await setup();
    const res = await get('/dashboard/no-show-history/2026-08');
    expect(res.status).toBe(200);
    expect(res.text).toContain('have not been built yet');
    expect(res.text).toContain('action="/dashboard/reports/2026-08/refresh"');
    expect(res.text).toContain('name="return" value="no-show-history"');
  });

  it('the refresh form carries the CSRF token and returns to this page', async () => {
    const { get } = await setup();
    const res = await get(`${MONTH}?refresh=started`);
    expect(res.text).toContain('action="/dashboard/reports/2026-09/refresh"');
    expect(res.text).toMatch(/name="_csrf" value="[^"]+"/);
    expect(res.text).toContain('name="return" value="no-show-history"');
    expect(res.text).toContain('Refreshing from Meetup');
  });

  it('404 for a malformed, early or future month', async () => {
    const { get, snapshots, server, cookie } = await setup();
    for (const path of [
      '2026-9',
      '2026-13',
      '2026-11',
      '2026-09x',
      '2013-02',
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one request at a time, so a failure names its path
      const res = await get(`/dashboard/no-show-history/${path}`);
      expect(res.status, path).toBe(404);
    }
    const dots = await rawRequest(
      server,
      'GET',
      '/dashboard/no-show-history/%2E%2E',
      { Cookie: cookie },
    );
    expect(dots.status).toBe(404);
    expect(snapshots.getCurrent).not.toHaveBeenCalled();
  });

  it('503 when the read fails, without details', async () => {
    const { get } = await setup(undefined, [], {
      snapshots: () => Promise.reject(new Error('password=hunter2')),
    });
    for (const path of [MONTH, LIST, MEMBER]) {
      // eslint-disable-next-line no-await-in-loop -- one request at a time, so a failure names its path
      const res = await get(path);
      expect(res.status, path).toBe(503);
      expect(res.text, path).not.toContain('hunter2');
    }
  });

  it('503, not 500, when the stored payload is malformed', async () => {
    const good = noShowPayload();
    const malformed: unknown[] = [
      null,
      { junk: true },
      { ...good, reportType: 'hall_of_fame' },
      { ...good, cases: 'x' },
      { ...good, cases: [null] },
      { ...good, cases: [{ ...good.cases[0], member: null }] },
      { ...good, cases: [{ ...good.cases[0], counted: 'x' }] },
      { ...good, cases: [{ ...good.cases[0], counted: [null] }] },
      { ...good, cases: [{ ...good.cases[0], since: null }] },
      { ...good, cleared: [{ member: null }] },
      { ...good, cleared: {} },
      { ...good, departed: [null] },
      { ...good, departed: 'x' },
      { ...good, asOf: undefined },
      { ...good, asOf: 42 },
      { ...good, asOf: null },
      {
        ...good,
        cases: [
          {
            ...good.cases[0],
            counted: [{ ...good.cases[0].counted[0], dateTime: 42 }],
          },
        ],
      },
      {
        ...good,
        cases: [
          {
            ...good.cases[0],
            counted: [{ ...good.cases[0].counted[0], dateTime: undefined }],
          },
        ],
      },
      {
        ...good,
        cases: [
          { ...good.cases[0], since: { day: '2026-01-01', reason: 'bogus' } },
        ],
      },
      {
        ...good,
        cases: [
          { ...good.cases[0], since: { day: 42, reason: 'twelve-months' } },
        ],
      },
    ];
    for (const payload of malformed) {
      // eslint-disable-next-line no-await-in-loop -- one payload at a time, so a failure names it
      const { get } = await setup([seedRow('no_show', SEPT, payload)]);
      // eslint-disable-next-line no-await-in-loop -- one payload at a time, so a failure names it
      const res = await get(MONTH);
      expect(res.status, JSON.stringify(payload)).toBe(503);
      expect(res.text).toContain('cannot be loaded right now');
    }
  });

  it('never says incomplete', async () => {
    const { get } = await setup([
      seedRow('no_show', SEPT, noShowPayload(), {
        attendance: noShowPayload().attendance,
      }),
    ]);
    for (const path of [
      MONTH,
      '/dashboard/no-show-history/2026-08',
      LIST,
      MEMBER,
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one request at a time, so a failure names its path
      const res = await get(path);
      expect(res.text, path).not.toMatch(/incomplete/i);
    }
  });
});

describe('no-show history months list', () => {
  it('lists months with links and summary numbers', async () => {
    const { get } = await setup([
      seedRow('no_show', SEPT, null, {
        summary: {
          noShows: 9,
          members: 7,
          warnings: 5,
          suspensionCandidates: 2,
          cleared: 1,
          departed: 3,
        },
      }),
      seedRow('no_show', { year: 2026, month: 8 }, null, {
        summary: { noShows: '<b>', members: null },
      }),
    ]);
    const res = await get(LIST);
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/dashboard/no-show-history/2026-09"');
    expect(res.text).toContain('href="/dashboard/no-show-history/2026-08"');
    expect(res.text).toMatch(/<td>\s*9\s*<\/td>/);
    expect(res.text).not.toContain('<b>');
    expect(res.text).not.toContain('&lt;b&gt;');
    expect(res.text).not.toContain('No no-shows recorded');
  });

  it('a stored month before the group began is listed unlinked, not a 500', async () => {
    const { get } = await setup([
      seedRow('no_show', SEPT, null, { summary: { noShows: 9 } }),
      seedRow('no_show', { year: 2013, month: 3 }, null, {
        summary: { noShows: 1 },
      }),
      seedRow('no_show', { year: 2013, month: 2 }, null, {
        summary: { noShows: 1 },
      }),
    ]);
    const res = await get(LIST);
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/dashboard/no-show-history/2026-09"');
    expect(res.text).toContain('href="/dashboard/no-show-history/2013-03"');
    expect(res.text).not.toContain('2013-02');
    expect(res.text).toMatch(/<td>\s*February 2013\s*<\/td>/);
    expect(res.text).not.toMatch(/<a[^>]*>\s*February 2013/);
  });

  it('pages with before and links older months only after a full page', async () => {
    const rows = Array.from({ length: 51 }, (_, i) =>
      seedRow(
        'no_show',
        { year: 2026 - Math.floor((i + 3) / 12), month: 12 - ((i + 3) % 12) },
        null,
      ),
    );
    const { get, snapshots } = await setup(rows);
    const res = await get(LIST);
    const last = rows[49].meta.period;
    const key = `${last.year}-${String(last.month).padStart(2, '0')}`;
    expect(res.text).toContain(`href="${LIST}?before=${key}"`);
    await get(`${LIST}?before=2026-05`);
    expect(snapshots.listSummaries).toHaveBeenLastCalledWith('no_show', {
      before: { year: 2026, month: 5 },
      limit: 50,
    });
    await get(`${LIST}?before=junk`);
    expect(snapshots.listSummaries).toHaveBeenLastCalledWith('no_show', {
      before: undefined,
      limit: 50,
    });
    const few = await (await setup()).get(LIST);
    expect(few.text).not.toContain('?before=');
  });

  it('says so when nothing is stored yet', async () => {
    const { get } = await setup([]);
    const res = await get(LIST);
    expect(res.status).toBe(200);
    expect(res.text).toContain('No no-show reports');
  });
});

describe('no-show history member page', () => {
  it('per-member view lists every month the member appears in', async () => {
    const { get, snapshots } = await setup(undefined, [
      memberMonth(SEPT, {
        noShowCase: noShowCase(0, {
          member: { id: '123456', name: 'Pat <i>', memberUrl: '' },
        }),
      }),
      memberMonth({ year: 2026, month: 7 }, { cleared: true }),
    ]);
    const res = await get(MEMBER);
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/dashboard/no-show-history/2026-09"');
    expect(res.text).toContain('href="/dashboard/no-show-history/2026-07"');
    const text = words(res.text);
    expect(text).toContain('Warning');
    expect(text).toContain('No action needed — no-shows no longer count');
    expect(text).toContain('As of Oct 1, 2026 12:00 AM');
    expect(res.text).toContain('<bdi>Pat &lt;i&gt;</bdi>');
    expect(res.text).toContain('href="https://www.meetup.com/members/123456/"');
    expect(snapshots.listMemberNoShowMonths).toHaveBeenCalledWith('123456', {
      offset: 0,
      limit: 50,
    });
  });

  it('a stored month before the group began is listed unlinked, not a 500', async () => {
    const { get } = await setup(undefined, [
      memberMonth(SEPT, { cleared: true }),
      memberMonth({ year: 2013, month: 3 }, { cleared: true }),
      memberMonth({ year: 2013, month: 2 }, { cleared: true }),
    ]);
    const res = await get(MEMBER);
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/dashboard/no-show-history/2026-09"');
    expect(res.text).toContain('href="/dashboard/no-show-history/2013-03"');
    expect(res.text).not.toContain('2013-02');
    expect(res.text).toMatch(/<td>\s*February 2013\s*<\/td>/);
    expect(res.text).not.toMatch(/<a[^>]*>\s*February 2013/);
  });

  it('names the member by id when no case carries a name, and says when nothing mentions them', async () => {
    const { get } = await setup(undefined, [
      memberMonth(SEPT, { departed: true }),
    ]);
    const res = await get(MEMBER);
    expect(words(res.text)).toContain('Member 123456');
    expect(words(res.text)).toContain('Left the group');
    const empty = await (await setup()).get(MEMBER);
    expect(empty.status).toBe(200);
    expect(words(empty.text)).toContain(
      'No stored no-show report mentions this member.',
    );
  });

  it('past the last page shows the pager and "No more months.", not "never mentioned"', async () => {
    const { get } = await setup();
    const res = await get(`${MEMBER}?page=3`);
    expect(res.status).toBe(200);
    const text = words(res.text);
    expect(text).toContain('No more months.');
    expect(text).not.toContain(
      'No stored no-show report mentions this member.',
    );
    expect(res.text).toContain(`href="${MEMBER}?page=2"`);
    expect(res.text).not.toContain(`href="${MEMBER}?page=4"`);
  });

  it('member id must be digits', async () => {
    const { get, snapshots } = await setup();
    for (const path of ['12a', '1234567890123456789012', '%31%20OR%201']) {
      // eslint-disable-next-line no-await-in-loop -- one request at a time, so a failure names its path
      const res = await get(`/dashboard/no-show-history/members/${path}`);
      expect(res.status, path).toBe(404);
    }
    expect(snapshots.listMemberNoShowMonths).not.toHaveBeenCalled();
  });

  it('paginates at 50', async () => {
    const full = Array.from({ length: 50 }, (_, i) =>
      memberMonth({ year: 2022 + Math.floor(i / 12), month: (i % 12) + 1 }),
    );
    const { get, snapshots } = await setup(undefined, full);
    const res = await get(`${MEMBER}?page=3`);
    expect(snapshots.listMemberNoShowMonths).toHaveBeenLastCalledWith(
      '123456',
      { offset: 100, limit: 50 },
    );
    expect(res.text).toContain(`href="${MEMBER}?page=4"`);
    expect(res.text).toContain(`href="${MEMBER}?page=2"`);
    const short = await (await setup(undefined, full.slice(0, 3))).get(MEMBER);
    expect(short.text).not.toContain('?page=2');
  });
});

const AUG: Period = { year: 2026, month: 8 };
const JULY: Period = { year: 2026, month: 7 };

/** A workspace over the given (period, member id, status) rows. */
const workspaceOf = (rows: [Period, string, string][]) =>
  fakeWorkspace({
    rows: rows.map(([period, memberId, status], i) =>
      workspaceRow({
        id: i + 1,
        period,
        memberId,
        status: status as WorkspaceStatus,
      }),
    ),
    months: [],
    events: [],
  });

/** The cases table's rows (the first tbody), each as its own markup. */
const caseRows = (body: string) =>
  (/<tbody>([\s\S]*?)<\/tbody>/.exec(body)?.[1] ?? '').split('<tr>').slice(1);

describe('no-show history month page: workspace outcomes', () => {
  it('shows workspace outcome per member', async () => {
    const ws = workspaceOf([
      [SEPT, '2000', 'warning_sent'],
      [SEPT, '2001', 'suspended'],
    ]);
    const actions = fakeWorkspaceActions();
    const { get } = await setup(undefined, [], {
      workspace: async () => ws,
      workspaceActions: actions,
    });
    const res = await get(MONTH);
    expect(res.status).toBe(200);
    expect(res.text).toContain('<th>Outcome</th>');
    const [hostile, second] = caseRows(res.text);
    expect(hostile).toContain('members/2000/');
    expect(words(hostile)).toContain('Warning sent');
    expect(hostile).toContain('href="/dashboard/no-shows/2026-09"');
    expect(second).toContain('members/2001/');
    expect(words(second)).toContain('Suspended');
    // Only this page's members, and reads only.
    expect(ws.statusesByMember).toHaveBeenCalledWith(SEPT, ['2000', '2001']);
    expect(actions.perform).not.toHaveBeenCalled();
    expect(actions.sync).not.toHaveBeenCalled();
    expect(res.text).not.toMatch(/attendance|incomplete/i);
  });

  it('a case with no workspace row, or an unknown stored status, shows no status text', async () => {
    const ws = workspaceOf([[SEPT, '2001', '<script>x</script>']]);
    const { get } = await setup(undefined, [], { workspace: async () => ws });
    const res = await get(MONTH);
    const [hostile, second] = caseRows(res.text);
    expect(words(hostile)).toMatch(/—$/);
    expect(hostile).not.toContain('/dashboard/no-shows/');
    expect(words(second)).toContain('Unknown');
    expect(res.text).not.toContain('<script>x');
  });

  it('reads outcomes for the shown page only', async () => {
    const ws = workspaceOf([]);
    const { get } = await setup(
      [seedRow('no_show', SEPT, manyCases(120))],
      [],
      { workspace: async () => ws },
    );
    await get(`${MONTH}?page=3`);
    const ids = ws.statusesByMember.mock.calls[0][1];
    expect(ids).toHaveLength(20);
    expect(ids).toContain('2119');
  });

  it('months without a workspace show no outcome column', async () => {
    // A stray August row must still never be shown.
    const ws = workspaceOf([[AUG, '2000', 'suspended']]);
    const { get } = await setup(
      [seedRow('no_show', AUG, noShowPayload({ period: '2026-08' }))],
      [],
      { workspace: async () => ws },
    );
    const res = await get('/dashboard/no-show-history/2026-08');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('Outcome');
    expect(words(res.text)).not.toContain('Suspended');
    expect(res.text).not.toContain('/dashboard/no-shows/');
    expect(ws.statusesByMember).not.toHaveBeenCalled();
  });

  it('outcome read failure still renders the page', async () => {
    const ws = workspaceOf([[SEPT, '2000', 'warning_sent']]);
    ws.statusesByMember.mockRejectedValue(new Error('db down: secret'));
    const { get } = await setup(undefined, [], { workspace: async () => ws });
    const res = await get(MONTH);
    expect(res.status).toBe(200);
    expect(res.text).toContain('<th>Outcome (unavailable)</th>');
    expect(res.text).not.toContain('secret');
    expect(words(res.text)).not.toContain('Warning sent');
    for (const row of caseRows(res.text)) {
      expect(words(row)).toMatch(/—$/);
    }
    // The rest of the page is there.
    expect(words(res.text)).toContain('Cleared One');

    const lookup = await setup(undefined, [], {
      workspace: async () => {
        throw new Error('no DATABASE_URL');
      },
    });
    const res2 = await lookup.get(MONTH);
    expect(res2.status).toBe(200);
    expect(res2.text).toContain('<th>Outcome (unavailable)</th>');
  });
});

describe('no-show history member page: workspace outcomes', () => {
  const months = () => [
    memberMonth(OCT),
    memberMonth(SEPT, { noShowCase: noShowCase(0) }),
    memberMonth(JULY, { cleared: true }),
  ];
  /** The member table's row for one month. */
  const rowFor = (body: string, key: string) =>
    caseRows(body).find((r) => r.includes(`no-show-history/${key}"`)) ?? '';

  it('member page shows the outcome per month', async () => {
    // July is before the workspace: a stray row there is never shown.
    const ws = workspaceOf([
      [SEPT, '123456', 'on_hold'],
      [JULY, '123456', 'suspended'],
    ]);
    const { get } = await setup(undefined, months(), {
      workspace: async () => ws,
    });
    const res = await get(MEMBER);
    expect(res.status).toBe(200);
    expect(res.text).toContain('<th>Outcome</th>');
    const sept = rowFor(res.text, '2026-09');
    expect(words(sept)).toContain('On hold');
    expect(sept).toContain('href="/dashboard/no-shows/2026-09"');
    expect(words(rowFor(res.text, '2026-10'))).toMatch(/—$/);
    const july = rowFor(res.text, '2026-07');
    expect(july).not.toBe('');
    expect(words(july)).not.toContain('Suspended');
    expect(july).not.toContain('/dashboard/no-shows/');
    expect(ws.statusesForMember).toHaveBeenCalledWith('123456');
    expect(res.text).not.toMatch(/attendance|incomplete/i);
  });

  it('outcome read failure still renders the member page', async () => {
    const ws = workspaceOf([[SEPT, '123456', 'on_hold']]);
    ws.statusesForMember.mockRejectedValue(new Error('down'));
    const { get } = await setup(undefined, months(), {
      workspace: async () => ws,
    });
    const res = await get(MEMBER);
    expect(res.status).toBe(200);
    expect(res.text).toContain('<th>Outcome (unavailable)</th>');
    expect(words(res.text)).not.toContain('On hold');
    expect(words(rowFor(res.text, '2026-09'))).toContain('Warning');
  });
});
