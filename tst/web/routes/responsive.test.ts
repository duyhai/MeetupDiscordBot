import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DASHBOARD_BASE } from '../../../src/lib/reports/dashboardPaths.js';
import {
  createDashboardRouter,
  protectedRouteList,
} from '../../../src/web/dashboardRouter.js';
import { STYLE } from '../../../src/web/pages.js';
import { registerAllProtectedRoutes } from '../../../src/web/routes/dashboardPages.js';
import { clientFor } from '../../setup/loopbackServer.js';
import { closeServers, listen, makeDeps, signIn } from '../dashboardHarness.js';
import {
  PAGE_NOW,
  SEPT,
  fakeIdentity,
  fakeOrganizerDeps,
  fakePageDeps,
  fakeSnapshots,
  fakeWorkspace,
  hofPayload,
  identityChange,
  noShowCase,
  noShowPayload,
  seedRow,
  workspaceRow,
} from './pageFakes.js';

afterEach(closeServers);

/** Case 0 of noShowPayload: member 2000, with a workspace card, so the outcome columns render. */
const CASE_MEMBER = '2000';

/**
 * The production router, signed in as a 1.5 Leadership Team member, with
 * fixtures that fill every table: both report types, a member history, an
 * image change, and a workspace card for a member in the report.
 */
function buildRouter(opts: { outcomesFail?: boolean } = {}) {
  const { deps } = makeDeps({ now: () => PAGE_NOW.getTime() });
  const rows = [
    seedRow('hall_of_fame', SEPT, hofPayload()),
    seedRow('no_show', SEPT, noShowPayload()),
  ];
  const memberMonths = [
    {
      period: SEPT,
      builtAt: new Date('2026-10-01T15:00:00Z'),
      asOf: '2026-10-01T07:00:00.000Z',
      noShowCase: noShowCase(0),
      cleared: false,
      departed: false,
    },
    // Before the workspace: an empty outcome cell, still labelled.
    {
      period: { year: 2026, month: 8 },
      builtAt: new Date('2026-09-01T15:00:00Z'),
      asOf: '2026-09-01T07:00:00.000Z',
      noShowCase: noShowCase(0),
      cleared: false,
      departed: false,
    },
  ];
  const workspace = fakeWorkspace({
    rows: [
      workspaceRow(),
      workspaceRow({ id: 2, memberId: CASE_MEMBER }),
      workspaceRow({
        id: 3,
        memberId: '3001',
        classification: 'warning',
        status: 'warning_copied',
      }),
      workspaceRow({ id: 4, memberId: '3002', status: 'on_hold' }),
    ],
    months: [
      {
        period: SEPT,
        snapshotId: 1,
        snapshotBuiltAt: new Date('2026-10-01T15:00:00Z'),
        syncedAt: new Date('2026-10-01T16:00:00Z'),
      },
    ],
    events: [],
  });
  if (opts.outcomesFail) {
    // The outcome column's "(unavailable)" state.
    workspace.statusesForMember.mockRejectedValue(new Error('db down'));
    workspace.statusesByMember.mockRejectedValue(new Error('db down'));
  }
  return createDashboardRouter({
    ...deps,
    protectedRoutes: (r) =>
      registerAllProtectedRoutes(r, {
        organizer: fakeOrganizerDeps(),
        pages: fakePageDeps({
          isLeadership: vi.fn().mockResolvedValue(true),
          snapshots: async () => fakeSnapshots(rows, memberMonths),
          identity: async () =>
            fakeIdentity([
              identityChange({ id: '1' }),
              identityChange({
                id: '2',
                field: 'user_avatar',
                hasOldThumb: true,
                hasNewThumb: true,
              }),
            ]),
          workspace: async () => workspace,
        }),
      }),
  });
}

async function setup(opts: { outcomesFail?: boolean } = {}) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(DASHBOARD_BASE, buildRouter(opts));
  const req = clientFor(await listen(app));
  const cookie = await signIn(req);
  const get = async (path: string) => req.get(path).set('Cookie', cookie);
  return { get };
}

/** Markup whitespace collapsed and trimmed at tags, so the checks read elements, not formatting. */
const collapse = (body: string) =>
  body.replace(/\s+/g, ' ').replace(/> /g, '>').replace(/ </g, '<');

const textOf = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Every page with a data table, each with the fixtures above. */
const TABLE_PAGES = [
  '/dashboard/no-shows',
  '/dashboard/hall-of-fame',
  '/dashboard/hall-of-fame/2026-09',
  '/dashboard/no-show-history',
  '/dashboard/no-show-history/2026-09',
  `/dashboard/no-show-history/members/${CASE_MEMBER}`,
  '/dashboard/suspensions',
  '/dashboard/suspensions?state=past',
  '/dashboard/suspensions?state=voided',
  '/dashboard/identity',
  '/dashboard/link-progress',
  '/dashboard/trends',
];

const SAMPLE_PARAMS: Record<string, string> = {
  period: '2026-09',
  memberId: CASE_MEMBER,
  id: '1',
  side: 'old',
  rowId: '1',
};

/** Every signed-in GET page the router lists. */
const PAGE_PATHS = protectedRouteList(buildRouter())
  .filter((r) => r.method === 'get')
  .map((r) =>
    `${DASHBOARD_BASE}${r.path.replace(
      /:([A-Za-z]+)/g,
      (_m, name: string) => SAMPLE_PARAMS[name] ?? '',
    )}`.replace(/\/$/, ''),
  );

/** A table: its opening tag's attributes, its markup, and whether it sits in a .table-scroll box. */
function tables(body: string) {
  const text = collapse(body);
  return [...text.matchAll(/<table([^>]*)>([\s\S]*?)<\/table>/g)].map((m) => ({
    attrs: m[1],
    markup: m[2],
    scroll: text.slice(0, m.index).endsWith('<div class="table-scroll">'),
  }));
}

/** A stacked table's problems: a cell without its column's label. */
function labelProblems(markup: string): string[] {
  const head = /<thead>([\s\S]*?)<\/thead>/.exec(markup)?.[1] ?? '';
  const columns = [...head.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) =>
    textOf(m[1]),
  );
  const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(markup)?.[1] ?? '';
  const problems: string[] = [];
  [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].forEach((row, r) => {
    const labels = [...row[1].matchAll(/<td([^>]*)>/g)].map(
      (td) => /(?:^| )data-label="([^"]+)"/.exec(td[1])?.[1],
    );
    if (labels.length !== columns.length) {
      problems.push(
        `row ${r}: ${labels.length} cells, ${columns.length} columns`,
      );
    }
    labels.forEach((label, c) => {
      // A column whose header names its own state ("Outcome (unavailable)")
      // is labelled by the column name.
      if (label === undefined || !columns[c]?.startsWith(label)) {
        problems.push(`row ${r} cell ${c}: label ${label} for ${columns[c]}`);
      }
    });
  });
  return problems;
}

describe('tables on narrow screens', () => {
  it.each(TABLE_PAGES)('%s renders at least one table', async (path) => {
    const { get } = await setup();
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(tables(res.text).length).toBeGreaterThan(0);
  });

  it.each([...new Set([...TABLE_PAGES, ...PAGE_PATHS])])(
    '%s: every table stacks with a label on each cell, or scrolls in its own box',
    async (path) => {
      const { get } = await setup();
      const res = await get(path);
      if (!String(res.headers['content-type']).startsWith('text/html')) {
        return;
      }
      for (const t of tables(res.text)) {
        if (t.scroll) {
          expect(t.attrs).not.toContain('stack');
          continue;
        }
        expect(t.attrs).toBe(' class="stack"');
        expect(t.markup).toMatch(/<td/);
        expect(labelProblems(t.markup)).toEqual([]);
      }
    },
  );

  it.each([
    ['/dashboard/link-progress', 2],
    ['/dashboard/trends', 5],
  ])('%s keeps its wide data tables in scroll boxes', async (path, count) => {
    const { get } = await setup();
    const scrolling = tables((await get(path)).text).filter((t) => t.scroll);
    expect(scrolling).toHaveLength(count);
  });

  it.each([
    [`/dashboard/no-show-history/members/${CASE_MEMBER}`, 2],
    ['/dashboard/no-show-history/2026-09', 2],
  ])(
    '%s labels the outcome cells when the outcomes are unavailable',
    async (path, rows) => {
      const { get } = await setup({ outcomesFail: true });
      const [t] = tables((await get(path)).text);
      expect(t.markup).toContain('<th>Outcome (unavailable)</th>');
      expect(t.markup.match(/<td data-label="Outcome">/g)).toHaveLength(rows);
      expect(labelProblems(t.markup)).toEqual([]);
    },
  );

  it('a member history month before the workspace has a labelled, empty outcome cell', async () => {
    const { get } = await setup();
    const [t] = tables(
      (await get(`/dashboard/no-show-history/members/${CASE_MEMBER}`)).text,
    );
    expect(t.markup).toContain('<th>Outcome</th>');
    expect(t.markup).toContain('<td data-label="Outcome"></td>');
  });

  it('stacked cells stay in normal flow, so the spaces between inline children survive', () => {
    // display:table (or table-cell) on the cell makes Blink drop the
    // whitespace between its inline children: "Member 1History".
    const rules = [
      ...STYLE.value.matchAll(/([^{}]*table\.stack td[^{}]*)\{([^}]*)\}/g),
    ];
    expect(rules.length).toBeGreaterThan(0);
    for (const [, selector, body] of rules) {
      expect(body, selector).not.toMatch(/display:table/);
    }
    // The cell is a block formatting context; the label floats in its
    // left padding, so a two-line label grows the cell instead of
    // overlapping the next one.
    expect(STYLE.value).toMatch(/table\.stack td\{[^}]*display:flow-root/);
    expect(STYLE.value).toMatch(/table\.stack td::before\{[^}]*float:left/);
  });

  it('the Hall of Fame rank folds into the host cell on phones', async () => {
    const { get } = await setup();
    const text = collapse((await get('/dashboard/hall-of-fame/2026-09')).text);
    expect(text).toContain('<td class="rank" data-label="#">1</td>');
    expect(text).toMatch(
      /<td data-label="Host"><span class="rank-inline">1\.<\/span>/,
    );
    const narrow =
      /@media \(max-width:639\.98px\)\{([\s\S]*?)\}\}/.exec(STYLE.value)?.[1] ??
      '';
    expect(narrow).toMatch(/table\.stack td\.rank\{display:none\}/);
    expect(narrow).toMatch(/\.rank-inline\{display:inline\}/);
    expect(STYLE.value).toMatch(/(?:^|\})\s*\.rank-inline\{display:none\}/);
  });

  it('the stylesheet stacks .stack tables below 640px and labels each cell', () => {
    const css = STYLE.value;
    const narrow = /@media \(max-width:639\.98px\)\{([\s\S]*?)\}\}/.exec(css);
    expect(narrow?.[1]).toMatch(/table\.stack thead\{[^}]*position:absolute/);
    expect(narrow?.[1]).toMatch(
      /table\.stack td::before\{[^}]*content:attr\(data-label\)/,
    );
    expect(narrow?.[1]).toMatch(/table\.stack tr\{[^}]*display:block/);
    expect(css).toMatch(/\.table-scroll\{[^}]*overflow-x:auto/);
  });

  it('the label check catches a missing or wrong label', () => {
    const table = (cells: string) =>
      `<thead><tr><th>Month</th><th>Events</th></tr></thead><tbody><tr>${cells}</tr></tbody>`;
    expect(
      labelProblems(
        table('<td data-label="Month">a</td><td data-label="Events">1</td>'),
      ),
    ).toEqual([]);
    expect(
      labelProblems(table('<td data-label="Month">a</td><td>1</td>')),
    ).not.toEqual([]);
    expect(
      labelProblems(
        table('<td data-label="Month">a</td><td data-label="Hosts">1</td>'),
      ),
    ).not.toEqual([]);
  });
});

describe('button variants', () => {
  it('sessions: both sign-out-everywhere buttons are destructive', async () => {
    const { get } = await setup();
    const text = collapse((await get('/dashboard/sessions')).text);
    expect(text).toContain(
      '<button type="submit" class="danger">Sign me out everywhere</button>',
    );
    expect(text).toContain(
      '<button type="submit" class="danger">Sign them out everywhere</button>',
    );
  });

  it('workspace card: primary for the main action, ghost for the rest, danger for void', async () => {
    const { get } = await setup();
    const text = collapse((await get('/dashboard/no-shows/2026-09')).text);
    expect(text).toContain('<button type="submit">Mark as sent</button>');
    expect(text).toContain(
      '<button type="submit" class="ghost">Put on hold</button>',
    );
    expect(text).toContain('<button type="submit" class="ghost">Skip</button>');
    expect(text).toContain(
      '<button type="submit" class="ghost">Reopen</button>',
    );
    expect(text).toContain(
      '<button type="submit" class="ghost">Save notes</button>',
    );
    expect(text).toContain(
      '<button type="submit" class="ghost">Refresh from Meetup</button>',
    );
    // The copy buttons are the card's main action.
    expect(text).toMatch(/<button type="button" data-copy-near>Copy /);
  });

  it('a suspended card voids with the destructive button', async () => {
    const app = express();
    app.set('trust proxy', 1);
    const { deps } = makeDeps({ now: () => PAGE_NOW.getTime() });
    app.use(
      DASHBOARD_BASE,
      createDashboardRouter({
        ...deps,
        protectedRoutes: (r) =>
          registerAllProtectedRoutes(r, {
            organizer: fakeOrganizerDeps(),
            pages: fakePageDeps({
              isLeadership: vi.fn().mockResolvedValue(true),
              workspace: async () =>
                fakeWorkspace({
                  rows: [
                    workspaceRow({
                      status: 'suspended',
                      suspensionRecordId: 1,
                    }),
                  ],
                  months: [
                    {
                      period: SEPT,
                      snapshotId: 1,
                      snapshotBuiltAt: new Date('2026-10-01T15:00:00Z'),
                      syncedAt: new Date('2026-10-01T16:00:00Z'),
                    },
                  ],
                  events: [],
                }),
            }),
          }),
      }),
    );
    const req = clientFor(await listen(app));
    const cookie = await signIn(req);
    const text = collapse(
      (await req.get('/dashboard/no-shows/2026-09').set('Cookie', cookie)).text,
    );
    expect(text).toContain(
      '<button type="submit" class="danger">Void suspension</button>',
    );
  });

  it('the confirm page: the length check is secondary, recording is primary', async () => {
    const { get } = await setup();
    const text = collapse(
      (await get('/dashboard/no-shows/2026-09/rows/1/suspend')).text,
    );
    expect(text).toContain(
      '<button type="submit" class="ghost">Show the length for this date</button>',
    );
    expect(text).toContain('<button type="submit">Record suspension</button>');
  });

  it('Hall of Fame copy buttons are primary', async () => {
    const { get } = await setup();
    const text = collapse((await get('/dashboard/hall-of-fame/2026-09')).text);
    expect(text).toContain(
      '<button type="button" data-copy="hof-post">Copy</button>',
    );
    expect(text).toContain(
      '<button type="submit" class="ghost">Refresh from Meetup</button>',
    );
  });
});

describe('per-page polish', () => {
  it('the Hall of Fame "New host" badge is the green one', async () => {
    const { get } = await setup();
    const text = collapse((await get('/dashboard/hall-of-fame/2026-09')).text);
    expect(text).toContain('<span class="badge ok">New host</span>');
    expect(text).not.toContain('<span class="badge">');
  });

  it.each([
    '/dashboard/trends',
    '/dashboard/link-progress',
    '/dashboard/suspensions',
    '/dashboard/no-shows/2026-09',
  ])('%s: range choices are a segmented control', async (path) => {
    const { get } = await setup();
    expect(collapse((await get(path)).text)).toMatch(
      /<nav class="pager choices" aria-label="[^"]+">/,
    );
    expect(STYLE.value).toMatch(
      /nav\.pager\.choices strong\{[^}]*background:var\(--accent-soft\)/,
    );
  });

  it('paging keeps the plain pager', async () => {
    const { get } = await setup();
    const text = collapse((await get('/dashboard/link-progress')).text);
    expect(text).toContain('<nav class="pager"><span>Page 1</span></nav>');
  });

  it('the identity filters use the form layout', () => {
    expect(STYLE.value).toMatch(/form\.filters\{[^}]*display:flex/);
    expect(STYLE.value).toMatch(
      /form\.filters label\{[^}]*flex-direction:column/,
    );
  });

  it('identity photos scale inside their cell', async () => {
    const { get } = await setup();
    const text = collapse((await get('/dashboard/identity')).text);
    expect(text).toMatch(
      /<img class="thumb" src="\/dashboard\/identity\/changes\/2\/thumb\/old"/,
    );
    expect(STYLE.value).toMatch(/img\.thumb\{[^}]*max-width:100%/);
  });

  it('member text wraps anywhere, so a long name or note never widens the page', () => {
    // A note on the confirm page sits in a <p>, outside any table cell or
    // heading: without this, an unbroken name scrolls the page sideways.
    expect(STYLE.value).toMatch(
      /(?:^|\})[^{}]*\bbdi\b[^{}]*\{[^}]*overflow-wrap:anywhere/,
    );
  });

  it('pager and choice links are 44px targets', () => {
    expect(STYLE.value).toMatch(
      /nav\.pager a,nav\.pager strong,nav\.pager span\{[^}]*min-height:var\(--tap\)/,
    );
    expect(STYLE.value).toMatch(/--tap:44px/);
  });
});
