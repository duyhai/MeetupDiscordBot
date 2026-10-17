import { afterEach, describe, expect, it, vi } from 'vitest';

import { Period } from '../../../src/lib/reports/period.js';
import { NoShowPayload } from '../../../src/lib/reports/types.js';
import { SuspensionRecordState } from '../../../src/lib/repositories/postgresSuspensionRepository.js';
import {
  recordedSuspensionMessage,
  suspensionMessage,
  warningMessage,
} from '../../../src/lib/workspace/templates.js';
import {
  WorkspaceEvent,
  WorkspaceRow,
} from '../../../src/lib/workspace/types.js';
import { UpcomingEntry } from '../../../src/lib/workspace/upcoming.js';
import { escapeHtml } from '../../../src/web/html.js';
import { WORKSPACE_SCRIPT } from '../../../src/web/pageKit.js';
import {
  DashboardPageDeps,
  registerAllProtectedRoutes,
} from '../../../src/web/routes/dashboardPages.js';
import {
  LEADERSHIP_DISPLAY_CACHE_MAX,
  LEADERSHIP_DISPLAY_CACHE_MS,
  LeadershipDisplayCache,
} from '../../../src/web/routes/workspace.js';
import { WORKSPACE_RESULT_MESSAGES } from '../../../src/web/routes/workspaceActions.js';
import { closeServers, makeApp, signIn } from '../dashboardHarness.js';
import {
  PAGE_NOW,
  SEPT,
  SeedRow,
  WorkspaceSeed,
  fakeOrganizerDeps,
  fakePageDeps,
  fakeSnapshots,
  fakeSuspensions,
  fakeWorkspace,
  fakeWorkspaceActions,
  noShowPayload,
  seedRow,
  suspensionRecord,
  workspaceRow,
} from './pageFakes.js';

afterEach(() => {
  vi.restoreAllMocks();
  return closeServers();
});

const OCT: Period = { year: 2026, month: 10 };
const LIST = '/dashboard/no-shows';
const MONTH = '/dashboard/no-shows/2026-09';
const CONFIRM = '/dashboard/no-shows/2026-09/rows/2/suspend';
const SNAPSHOT_ID = 41;
const BUILT_AT = new Date('2026-10-01T15:00:00Z');

const HOSTILE_NOTE = '</textarea><script>alert(1)</script>';
const RTL = 'Mallory‮evil';

/** The September report: case 0 (member 2000) a warning, case 1 (member 2001) a suspension candidate. */
const payload = (overrides: Partial<NoShowPayload> = {}) =>
  noShowPayload(overrides);

const warningRow = (overrides: Partial<WorkspaceRow> = {}) =>
  workspaceRow({
    id: 1,
    memberId: '2000',
    memberName: '<script>alert(1)</script>‮',
    classification: 'warning',
    ...overrides,
  });

const suspensionCardRow = (overrides: Partial<WorkspaceRow> = {}) =>
  workspaceRow({
    id: 2,
    memberId: '2001',
    memberName: 'Member 1',
    classification: 'suspension',
    ...overrides,
  });

const seed = (
  rows: WorkspaceRow[] = [warningRow(), suspensionCardRow()],
  overrides: Partial<WorkspaceSeed> = {},
): WorkspaceSeed => ({
  rows,
  months: [
    {
      period: SEPT,
      snapshotId: SNAPSHOT_ID,
      snapshotBuiltAt: BUILT_AT,
      syncedAt: new Date('2026-10-01T16:00:00Z'),
    },
  ],
  events: [],
  ...overrides,
});

const snapshotRows = (p: unknown = payload()): SeedRow[] => [
  seedRow('no_show', SEPT, p, { id: SNAPSHOT_ID, builtAt: BUILT_AT }),
];

interface Options {
  seed?: WorkspaceSeed;
  snapshots?: SeedRow[];
  records?: SuspensionRecordState[];
  upcoming?: (ids: string[]) => Promise<Map<string, UpcomingEntry>>;
  leader?: boolean | Error;
  pages?: Partial<DashboardPageDeps>;
  /** The clock at sign-in (PAGE_NOW unless set). */
  start?: Date;
}

async function setup(options: Options = {}) {
  const ws = fakeWorkspace(options.seed ?? seed());
  const snaps = fakeSnapshots(options.snapshots ?? snapshotRows());
  const susp = fakeSuspensions({}, [], options.records ?? []);
  const upcoming = vi.fn(options.upcoming ?? (async () => new Map()));
  const actions = fakeWorkspaceActions();
  const isLeadership = vi.fn(async (_userId: string) => {
    if (options.leader instanceof Error) {
      throw options.leader;
    }
    return options.leader ?? false;
  });
  let clock = (options.start ?? PAGE_NOW).getTime();
  const { req } = await makeApp({
    now: () => clock,
    protectedRoutes: (r) =>
      registerAllProtectedRoutes(r, {
        organizer: fakeOrganizerDeps(),
        pages: fakePageDeps({
          now: () => new Date(clock),
          workspace: async () => ws,
          snapshots: async () => snaps,
          suspensions: async () => susp,
          upcoming,
          isLeadership,
          workspaceActions: actions,
          ...options.pages,
        }),
      }),
  });
  const cookie = await signIn(req);
  /** `text` is flattened (see flat); `raw` is the body as sent. */
  const get = async (path: string) => {
    const res = await req.get(path).set('Cookie', cookie);
    return { status: res.status, text: flat(res.text), raw: res.text };
  };
  const advance = (ms: number) => {
    clock += ms;
  };
  return { get, ws, snaps, susp, upcoming, actions, isLeadership, advance };
}

/**
 * Whitespace collapsed, and dropped next to < and >: markup checks then do
 * not depend on how Prettier wrapped a template. Copy text is read from the
 * raw body.
 */
const flat = (body: string) =>
  body.replace(/\s+/g, ' ').replace(/ ?([<>]) ?/g, '$1');

/** The session's CSRF token, from the sign-out form in the page header. */
const csrfOf = (body: string) =>
  /action="\/dashboard\/logout"><input type="hidden" name="_csrf" value="([^"]+)"/.exec(
    body,
  )?.[1] ?? 'missing';

/** The sync form's markup. */
const syncFormOf = (body: string) =>
  /<form method="post" action="\/dashboard\/no-shows\/2026-09\/sync">[\s\S]*?<\/form>/.exec(
    body,
  )?.[0] ?? '';

const unescape = (text: string) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

/** Each member card's markup, in page order. */
const cards = (body: string) =>
  body
    .split('<div class="card ws-card">')
    .slice(1)
    .map((card) => card.split(/<nav class="pager">|<script/)[0]);

/** The text of every copy box's textarea, in page order. */
const copyTexts = (body: string) =>
  [
    ...body.matchAll(
      /<textarea class="copy" readonly[^>]*>([\s\S]*?)<\/textarea>/g,
    ),
  ].map((m) => unescape(m[1]));

/** Page text with tags dropped and whitespace collapsed, for sentence checks. */
const words = (body: string) =>
  body
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The page without its copy boxes (the member message templates are fixed text from Task 4). */
const withoutCopyBoxes = (body: string) =>
  body.replace(/<textarea class="copy"[\s\S]*?<\/textarea>/g, '');

describe('GET /dashboard/no-shows/:period (month cards)', () => {
  it('month page lists one card per row with classification and status', async () => {
    const { get } = await setup({
      seed: seed([
        warningRow(),
        suspensionCardRow({ status: 'on_hold', notes: 'waiting' }),
      ]),
    });
    const res = await get(MONTH);
    expect(res.status).toBe(200);
    expect(res.text).toContain('No-show workspace — September 2026');
    const [warning, suspension] = cards(res.text);
    expect(cards(res.text)).toHaveLength(2);
    expect(warning).toContain('Warning');
    expect(warning).toContain('New');
    expect(suspension).toContain('Suspension candidate');
    expect(suspension).toContain('On hold');
  });

  it('notes are escaped in the card and history', async () => {
    const event: WorkspaceEvent = {
      id: '1',
      rowId: 1,
      actor: '123456789012345678',
      action: 'hold',
      oldStatus: 'new',
      newStatus: 'on_hold',
      note: HOSTILE_NOTE,
      suspensionRecordId: null,
      createdAt: new Date('2026-10-02T17:00:00Z'),
    };
    const { get } = await setup({
      seed: seed([warningRow({ notes: HOSTILE_NOTE, status: 'on_hold' })], {
        events: [event],
      }),
    });
    const res = await get(MONTH);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<script>alert(1)</script>');
    expect(res.text).not.toContain('</textarea><script>');
    const escaped = '&lt;/textarea&gt;&lt;script&gt;alert(1)&lt;/script&gt;';
    // In the notes textarea, and in the history (inside <bdi>).
    expect(res.text).toContain(
      `<textarea name="note" rows="3" maxlength="2000">${escaped}</textarea>`,
    );
    expect(res.text).toContain(`<bdi>${escaped}</bdi>`);
    expect(res.text).toContain('<details><summary>History</summary>');
  });

  it('member names and event titles are escaped and isolated', async () => {
    const { get } = await setup({
      seed: seed([warningRow({ memberName: RTL })]),
    });
    const res = await get(MONTH);
    expect(res.status).toBe(200);
    expect(res.text).toContain(`<bdi>${RTL}</bdi>`);
    // Case 0's hostile event title from the report.
    expect(res.text).toContain(
      '<bdi>&quot;&gt;&lt;img src=x onerror=alert(1)&gt;</bdi>',
    );
    expect(res.text).not.toContain('<img');
    expect(res.text).not.toContain('javascript:');
  });

  it('Open on Meetup only for digit ids', async () => {
    const { get } = await setup({
      seed: seed([warningRow({ memberId: '12a' }), suspensionCardRow()]),
    });
    const res = await get(MONTH);
    expect(res.status).toBe(200);
    const [bad, good] = cards(res.text);
    expect(bad).not.toContain('Open on Meetup');
    expect(bad).not.toContain('meetup.com/members/12a');
    expect(good).toContain(
      '<a href="https://www.meetup.com/members/2001/" rel="noopener noreferrer" target="_blank">Open on Meetup</a>',
    );
  });

  it('copy reads the readonly textarea', async () => {
    const { get } = await setup();
    const res = await get(MONTH);
    expect(res.status).toBe(200);
    const boxes = res.text.match(/data-copy-box>/g) ?? [];
    expect(boxes).toHaveLength(2);
    for (const card of cards(res.text)) {
      expect(card).toMatch(
        /data-copy-box>[\s\S]*?<textarea class="copy" readonly[^>]*>[\s\S]*?<\/textarea>[\s\S]*?data-copy-near/,
      );
    }
    const scripts = [
      ...res.text.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g),
    ];
    expect(scripts).toHaveLength(1);
    expect(scripts[0][1]).toBe(WORKSPACE_SCRIPT.value);
    expect(res.raw.match(/<script/g)).toHaveLength(1);
    // No message text in any attribute or script.
    expect(res.text).not.toMatch(/data-text=/);
    expect(scripts[0][1]).not.toContain('Hello');
  });

  it('warning text in the copy box is the template for that member', async () => {
    const { get } = await setup();
    const res = await get(MONTH);
    const [warning, suspension] = copyTexts(res.raw);
    const cases = payload().cases;
    expect(warning).toBe(
      warningMessage({
        memberName: '<script>alert(1)</script>‮',
        event: cases[0].counted[0],
        priorSuspensions: 0,
        hostWaiver: false,
      }),
    );
    expect(suspension).toBe(
      suspensionMessage({
        memberName: 'Member 1',
        counted: cases[1].counted,
        priorSuspensions: 0,
        hostWaiver: true,
        suspendedOn: '2026-10-05',
      }),
    );
  });

  it('the live prior count sets the message and the next length', async () => {
    const { get } = await setup({
      records: [
        suspensionRecord({
          memberId: '2001',
          suspendedAt: new Date('2026-03-02T00:00:00Z'),
        }),
      ],
    });
    const res = await get(MONTH);
    const suspension = cards(res.text)[1];
    expect(words(suspension)).toContain('Earlier suspensions: 1');
    expect(words(suspension)).toContain('Next suspension: 60 days');
    expect(copyTexts(res.raw)[1]).toBe(
      suspensionMessage({
        memberName: 'Member 1',
        counted: payload().cases[1].counted,
        priorSuspensions: 1,
        hostWaiver: true,
        suspendedOn: '2026-10-05',
      }),
    );
  });

  describe("a suspended card's message is built from its linked record", () => {
    /** 2026-10-17, 09:00 Pacific: four weeks after the backdated record. */
    const OCT_17 = new Date('2026-10-17T16:00:00Z');
    const linkedRecord = (overrides: Partial<SuspensionRecordState> = {}) =>
      suspensionRecord({
        id: 31,
        memberId: '2001',
        suspendedAt: new Date('2026-09-20T00:00:00Z'),
        durationDays: 30,
        ...overrides,
      });
    const suspendedCard = (overrides: Partial<WorkspaceRow> = {}) =>
      seed([
        suspensionCardRow({
          status: 'suspended',
          suspensionRecordId: 31,
          ...overrides,
        }),
      ]);
    /** The September report with case 1 not a host. */
    const noWaiver = () => {
      const p = payload();
      p.cases[1] = { ...p.cases[1], hostedPastEvent: false };
      return snapshotRows(p);
    };
    const expected = (prior: number, hostWaiver: boolean) =>
      recordedSuspensionMessage({
        memberName: 'Member 1',
        priorSuspensions: prior,
        hostWaiver,
        suspendedOn: '2026-09-20',
        durationDays: 30,
      });
    async function view(options: Options) {
      const page = await setup({ ...options, start: OCT_17 });
      const res = await page.get(MONTH);
      expect(res.status).toBe(200);
      return {
        card: words(cards(res.text)[0]),
        raw: cards(res.text)[0],
        texts: copyTexts(res.raw),
      };
    }

    it('a record backdated to Sep 20 for 30 days, no earlier ones', async () => {
      const { card, raw, texts } = await view({
        seed: suspendedCard(),
        snapshots: noWaiver(),
        records: [linkedRecord()],
      });
      expect(texts).toEqual([expected(0, false)]);
      expect(texts[0]).toContain('suspended from the group for 30 days.');
      expect(texts[0]).toContain('After October 19, 2026, you can reapply');
      expect(texts[0]).toContain('$10 admin fee');
      // The record, not the report's counted no-shows.
      expect(texts[0]).not.toContain('our records show');
      expect(raw).toContain('Copy suspension message');
      expect(raw).not.toContain('value="copy_warning"');
      expect(card).toContain(
        'Earlier suspensions: 0 · This suspension: 30 days (plus a $10 admin fee to rejoin)',
      );
      expect(card).not.toContain('Next suspension');
    });

    it('one earlier record sets the fee, the record keeps its own length', async () => {
      const { card, texts } = await view({
        seed: suspendedCard(),
        snapshots: noWaiver(),
        records: [
          suspensionRecord({
            id: 30,
            memberId: '2001',
            suspendedAt: new Date('2026-03-02T00:00:00Z'),
          }),
          linkedRecord(),
        ],
      });
      expect(texts).toEqual([expected(1, false)]);
      expect(texts[0]).toContain('$20 admin fee');
      expect(card).toContain(
        'Earlier suspensions: 1 · This suspension: 30 days (plus a $20 admin fee to rejoin)',
      );
    });

    it('a host gets no fee', async () => {
      const { card, texts } = await view({
        seed: suspendedCard(),
        records: [linkedRecord()],
      });
      expect(texts).toEqual([expected(0, true)]);
      expect(card).toContain(
        'Earlier suspensions: 0 · This suspension: 30 days (has hosted, so no admin fee)',
      );
    });

    it('a rebuild that reclassified it as a warning still shows the suspension message, never a warning box', async () => {
      // Recording the suspension on the open month: the next build counts
      // only no-shows after it, and the member comes back as a warning.
      const { card, raw, texts } = await view({
        seed: suspendedCard({ classification: 'warning' }),
        snapshots: noWaiver(),
        records: [linkedRecord()],
        leader: true,
      });
      expect(texts).toEqual([expected(0, false)]);
      expect(raw).not.toContain('value="copy_warning"');
      expect(card).not.toContain('Copy warning');
      expect(card).toContain('Copy suspension message');
    });

    it('a row a rebuild dropped still shows the message, with a note that hosting was not checked', async () => {
      const { card, texts } = await view({
        seed: suspendedCard({ inLatestSnapshot: false }),
        snapshots: noWaiver(),
        records: [linkedRecord()],
      });
      expect(texts).toEqual([expected(0, false)]);
      expect(card).toContain(
        'not in the latest report, so hosting could not be checked',
      );
    });

    it('a voided linked record on a still-suspended card shows the fixed line, no box', async () => {
      const { card, texts } = await view({
        seed: suspendedCard(),
        records: [
          linkedRecord({
            voidedAt: new Date('2026-09-21T00:00:00Z'),
            voidedBy: '123456789012345678',
            voidReason: 'mistake',
          }),
        ],
      });
      expect(texts).toEqual([]);
      expect(card).toContain('Suspended — see the record above.');
      expect(card).toContain(
        'Earlier suspensions: 0 · Next suspension: 30 days',
      );
    });

    it.each(['warning', 'suspension'] as const)(
      'a voided %s card shows no message at all',
      async (classification) => {
        const { card, raw, texts } = await view({
          seed: suspendedCard({ status: 'voided', classification }),
          snapshots: noWaiver(),
          records: [
            linkedRecord({
              voidedAt: new Date('2026-09-21T00:00:00Z'),
              voidedBy: '123456789012345678',
              voidReason: 'mistake',
            }),
          ],
        });
        expect(texts).toEqual([]);
        expect(raw).not.toContain('data-copy-box');
        expect(card).toContain('Voided — no message to send.');
        expect(card).not.toContain('Copy warning');
        expect(card).not.toContain('Copy suspension message');
      },
    );
  });

  it('Copy warning submits copy_warning only after copying', async () => {
    const { get } = await setup();
    const res = await get(MONTH);
    const [warning, suspension] = cards(res.text);
    const copyForm = new RegExp(
      [
        '<form method="post" action="/dashboard/no-shows/2026-09/rows/1" data-copy-box>',
        '[\\s\\S]*?name="action" value="copy_warning"[\\s\\S]*?',
        '<button type="submit" data-copy-near data-then-submit>Copy warning</button></form>',
      ].join(''),
    );
    expect(warning).toMatch(copyForm);
    expect(suspension).toMatch(
      /<div data-copy-box>[\s\S]*?<button type="button" data-copy-near>Copy suspension message<\/button><\/div>/,
    );
    expect(suspension).not.toContain('data-then-submit');
  });

  it('a warning whose copy_warning is no longer allowed copies without submitting', async () => {
    const { get } = await setup({
      seed: seed([warningRow({ status: 'warning_sent' })]),
    });
    const res = await get(MONTH);
    const [warning] = cards(res.text);
    expect(warning).toContain(
      '<button type="button" data-copy-near>Copy warning</button>',
    );
    expect(warning).not.toContain('value="copy_warning"');
  });

  it('suspension card shows live upcoming RSVPs with payment marks and act-by', async () => {
    const { get } = await setup({
      upcoming: async () =>
        new Map<string, UpcomingEntry>([
          [
            '2001',
            {
              state: 'ok',
              fetchedAt: PAGE_NOW.toISOString(),
              events: [
                {
                  id: '77',
                  title: 'Karaoke <night>',
                  eventUrl: 'https://www.meetup.com/1-5genasians/events/77/',
                  dateTime: '2026-10-07T02:00:00.000Z',
                  payment: '$15 event fee',
                },
                {
                  id: '78',
                  title: 'Hike',
                  eventUrl: 'javascript:alert(1)',
                  dateTime: '2026-10-20T16:00:00.000Z',
                  payment: null,
                },
              ],
            },
          ],
        ]),
    });
    const res = await get(MONTH);
    const suspension = cards(res.text)[1];
    expect(suspension).toContain(
      '<a href="https://www.meetup.com/1-5genasians/events/77/" rel="noopener noreferrer" target="_blank"><bdi>Karaoke &lt;night&gt;</bdi></a>',
    );
    expect(words(suspension)).toContain('💵 $15 event fee');
    expect(suspension).not.toContain('javascript:');
    // Oct 6 7 PM Pacific: act by Oct 3, already passed on Oct 5.
    expect(words(suspension)).toContain('Act by 2026-10-03 — act now');
  });

  it('a suspension card with no upcoming RSVPs and one that left say so', async () => {
    const { get } = await setup({
      seed: seed([
        suspensionCardRow(),
        suspensionCardRow({ id: 3, memberId: '2002' }),
      ]),
      upcoming: async () =>
        new Map<string, UpcomingEntry>([
          ['2001', { state: 'ok', events: [], fetchedAt: 'x' }],
          ['2002', { state: 'left', fetchedAt: 'x' }],
        ]),
    });
    const res = await get(MONTH);
    const [none, left] = cards(res.text);
    expect(words(none)).toContain('No upcoming RSVPs.');
    expect(words(left)).toContain('Left the group.');
  });

  it('Meetup down shows "Meetup unavailable, try again later"', async () => {
    const { get } = await setup({
      upcoming: async () =>
        new Map<string, UpcomingEntry>([['2001', { state: 'unavailable' }]]),
    });
    const res = await get(MONTH);
    expect(words(cards(res.text)[1])).toContain(
      'Meetup unavailable, try again later.',
    );
  });

  it('a loader that rejects still renders the page, with Meetup unavailable', async () => {
    const { get } = await setup({
      upcoming: async () => {
        throw new Error('boom');
      },
    });
    const res = await get(MONTH);
    expect(res.status).toBe(200);
    expect(words(cards(res.text)[1])).toContain(
      'Meetup unavailable, try again later.',
    );
  });

  it('upcoming RSVPs still loading say so', async () => {
    const { get } = await setup({
      upcoming: async () =>
        new Map<string, UpcomingEntry>([['2001', { state: 'pending' }]]),
    });
    const res = await get(MONTH);
    expect(words(cards(res.text)[1])).toContain(
      'Still loading upcoming RSVPs from Meetup — reload in a minute.',
    );
  });

  it('only suspension rows still in the report ask Meetup', async () => {
    const { get, upcoming } = await setup({
      seed: seed([
        warningRow(),
        suspensionCardRow(),
        suspensionCardRow({ id: 3, memberId: '2003', inLatestSnapshot: false }),
        suspensionCardRow({ id: 4, memberId: '2004', status: 'suspended' }),
        suspensionCardRow({ id: 5, memberId: '2005', status: 'skipped' }),
      ]),
    });
    await get(MONTH);
    expect(upcoming).toHaveBeenCalledTimes(1);
    expect(upcoming.mock.calls[0][0]).toEqual(['2001']);
  });

  it('a suspension recorded outside the workspace is shown with a link button for Leadership', async () => {
    const outside = suspensionRecord({
      id: 9,
      memberId: '2001',
      suspendedAt: new Date('2026-09-20T00:00:00Z'),
    });
    const { get } = await setup({ records: [outside], leader: true });
    const res = await get(MONTH);
    const suspension = cards(res.text)[1];
    expect(words(suspension)).toContain(
      'Suspended outside the workspace on Sep 20, 2026 (#9)',
    );
    expect(suspension).toContain(
      '<input type="hidden" name="action" value="link_suspension" />',
    );
    expect(suspension).toContain(
      '<input type="hidden" name="recordId" value="9" />',
    );
  });

  it("only records dated from the card's month through the next are shown or offered for linking", async () => {
    const at = (id: number, iso: string) =>
      suspensionRecord({
        id,
        memberId: '2001',
        suspendedAt: new Date(`${iso}T00:00:00Z`),
      });
    const { get, ws } = await setup({
      records: [
        at(6, '2026-08-31'),
        at(7, '2026-09-01'),
        at(8, '2026-10-31'),
        at(9, '2026-11-01'),
      ],
      leader: true,
    });
    const res = await get(MONTH);
    const card = cards(res.text)[1];
    // The first day of the month is in (the page's lower bound is >=).
    expect(words(card)).toContain(
      'Suspended outside the workspace on Sep 1, 2026 (#7)',
    );
    expect(card).toContain('<input type="hidden" name="recordId" value="7" />');
    // A September case suspended in October with the slash command.
    expect(words(card)).toContain(
      'Suspended outside the workspace on Oct 31, 2026 (#8)',
    );
    expect(card).toContain('<input type="hidden" name="recordId" value="8" />');
    for (const id of ['6', '9']) {
      expect(card).not.toContain(`(#${id})`);
      expect(card).not.toContain(`name="recordId" value="${id}"`);
    }
    // Only the records in the window are asked about.
    expect(ws.linkedRecordIds).toHaveBeenCalledWith([7, 8]);
  });

  it('a November record never reaches the September card, linked elsewhere or not', async () => {
    const { get, ws } = await setup({
      records: [
        suspensionRecord({
          id: 9,
          memberId: '2001',
          suspendedAt: new Date('2026-11-02T00:00:00Z'),
        }),
      ],
      leader: true,
    });
    const res = await get(MONTH);
    const card = cards(res.text)[1];
    expect(words(card)).not.toContain('Suspended outside the workspace');
    expect(words(card)).not.toContain("Recorded on another month's card");
    expect(card).not.toContain('value="link_suspension"');
    expect(ws.linkedRecordIds).not.toHaveBeenCalled();
  });

  it('a suspension voided outside the workspace shows live', async () => {
    const linked = suspensionRecord({
      id: 12,
      memberId: '2001',
      suspendedAt: new Date('2026-10-01T00:00:00Z'),
      durationDays: 60,
      voidedAt: new Date('2026-10-03T18:00:00Z'),
      voidedBy: '123456789012345678',
      voidReason: '<b>wrong person</b>',
    });
    const { get } = await setup({
      seed: seed([
        suspensionCardRow({ status: 'suspended', suspensionRecordId: 12 }),
      ]),
      records: [linked],
    });
    const res = await get(MONTH);
    const [card] = cards(res.text);
    expect(words(card)).toContain(
      'Suspension #12, 60 days from Oct 1, 2026 through Nov 29, 2026',
    );
    expect(words(card)).toContain('Voided Oct 3, 2026 11:00 AM by');
    expect(card).toContain(
      '<a href="https://discord.com/users/123456789012345678" rel="noopener noreferrer" target="_blank">staff member</a>',
    );
    expect(card).toContain('<bdi>&lt;b&gt;wrong person&lt;/b&gt;</bdi>');
  });

  it('forms carry the row version and the CSRF token', async () => {
    const { get } = await setup({
      seed: seed([warningRow({ version: 7 })]),
    });
    const res = await get(MONTH);
    const token = /name="_csrf" value="([^"]+)"/.exec(res.text)?.[1];
    expect(token).toBeTruthy();
    const [card] = cards(res.text);
    const forms = card.match(/<form method="post"[\s\S]*?<\/form>/g) ?? [];
    expect(forms.length).toBeGreaterThan(2);
    for (const form of forms) {
      expect(form).toContain(
        `<input type="hidden" name="_csrf" value="${token}" />`,
      );
      expect(form).toContain(
        '<input type="hidden" name="version" value="7" />',
      );
    }
  });

  it('only allowed actions get a button', async () => {
    const { get } = await setup({
      seed: seed([warningRow({ status: 'warning_sent' })]),
      leader: true,
    });
    const res = await get(MONTH);
    const [card] = cards(res.text);
    expect(card).toContain('value="hold"');
    expect(card).toContain('value="skip"');
    expect(card).toContain('value="edit_notes"');
    expect(card).not.toContain('value="mark_sent"');
    expect(card).not.toContain('value="reopen"');
    expect(card).not.toContain('value="void"');
    expect(card).not.toContain('Record suspension');
  });

  it('Leadership sees record and void; a suspended card offers void', async () => {
    const { get } = await setup({
      seed: seed([
        suspensionCardRow(),
        suspensionCardRow({
          id: 3,
          memberId: '2003',
          status: 'suspended',
          suspensionRecordId: 5,
        }),
      ]),
      leader: true,
    });
    const res = await get(MONTH);
    const [open, suspended] = cards(res.text);
    expect(open).toContain(
      '<a class="button" href="/dashboard/no-shows/2026-09/rows/2/suspend">Record suspension…</a>',
    );
    expect(suspended).toContain('value="void"');
    expect(suspended).toContain('maxlength="500"');
  });

  it('a Moderator never sees record, link or void controls', async () => {
    const outside = suspensionRecord({
      id: 9,
      memberId: '2001',
      suspendedAt: new Date('2026-09-20T00:00:00Z'),
    });
    const { get, isLeadership } = await setup({
      seed: seed([
        suspensionCardRow(),
        suspensionCardRow({
          id: 3,
          memberId: '2003',
          status: 'suspended',
          suspensionRecordId: 5,
        }),
      ]),
      records: [outside],
      leader: false,
    });
    const res = await get(MONTH);
    expect(res.status).toBe(200);
    expect(isLeadership).toHaveBeenCalled();
    expect(res.text).not.toContain('Record suspension');
    expect(res.text).not.toContain('/suspend"');
    expect(res.text).not.toContain('value="void"');
    expect(res.text).not.toContain('value="link_suspension"');
    expect(res.text).not.toContain('name="recordId"');
    // Everything else stays.
    expect(res.text).toContain('value="hold"');
    expect(words(res.text)).toContain(
      'Suspended outside the workspace on Sep 20, 2026 (#9)',
    );
  });

  it('Discord unreachable hides the Leadership controls and says why', async () => {
    const { get } = await setup({ leader: new Error('discord down') });
    const res = await get(MONTH);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('Record suspension');
    expect(words(res.text)).toContain(
      'Discord could not be reached to check your role',
    );
  });

  it("a record linked to another month's card is not offered for linking", async () => {
    // Dated in September but on October's card (linked before the month
    // window, or recorded there by hand).
    const elsewhere = suspensionRecord({
      id: 9,
      memberId: '2001',
      suspendedAt: new Date('2026-09-25T00:00:00Z'),
    });
    const { get, ws } = await setup({
      seed: seed([
        suspensionCardRow(),
        workspaceRow({
          id: 20,
          period: OCT,
          memberId: '2001',
          status: 'suspended',
          suspensionRecordId: 9,
        }),
      ]),
      records: [elsewhere],
      leader: true,
    });
    const res = await get(MONTH);
    const [card] = cards(res.text);
    expect(words(card)).not.toContain('Suspended outside the workspace');
    expect(card).not.toContain('value="link_suspension"');
    expect(card).not.toContain('name="recordId"');
    expect(words(card)).toContain("Recorded on another month's card (#9)");
    expect(ws.linkedRecordIds).toHaveBeenCalledWith([9]);
  });

  it('a workspace link read failure → 503 page', async () => {
    const ws = fakeWorkspace(seed());
    ws.linkedRecordIds.mockRejectedValue(new Error('db down'));
    const { get } = await setup({
      records: [
        suspensionRecord({
          id: 9,
          memberId: '2001',
          suspendedAt: new Date('2026-09-20T00:00:00Z'),
        }),
      ],
      pages: { workspace: async () => ws },
    });
    expect((await get(MONTH)).status).toBe(503);
  });

  it('notes that begin with a newline round-trip through the notes textarea', async () => {
    const { get } = await setup({
      seed: seed([warningRow({ notes: '\nfirst line blank' })]),
    });
    const res = await get(MONTH);
    expect(res.status).toBe(200);
    // The parser drops one newline right after <textarea>: the template's own.
    expect(res.raw).toContain(
      '<textarea name="note" rows="3" maxlength="2000">\n\nfirst line blank</textarea>',
    );
  });

  it('a second month-page load within 60 s reuses the Leadership answer', async () => {
    const { get, isLeadership, advance } = await setup({ leader: true });
    await get(MONTH);
    await get(MONTH);
    expect(isLeadership).toHaveBeenCalledTimes(1);
    advance(LEADERSHIP_DISPLAY_CACHE_MS);
    const later = await get(MONTH);
    expect(isLeadership).toHaveBeenCalledTimes(2);
    expect(later.text).toContain('Record suspension');
  });

  it('an unreachable Leadership check is not cached', async () => {
    const { get, isLeadership } = await setup({
      leader: new Error('discord down'),
    });
    await get(MONTH);
    await get(MONTH);
    expect(isLeadership).toHaveBeenCalledTimes(2);
  });

  it('a month before 2026-09 → 404, a future month → 404, a junk period → 404', async () => {
    const { get, ws } = await setup();
    for (const path of [
      '/dashboard/no-shows/2026-08',
      '/dashboard/no-shows/2026-11',
      '/dashboard/no-shows/junk',
      '/dashboard/no-shows/2026-9',
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one request at a time
      const res = await get(path);
      expect(res.status, path).toBe(404);
    }
    expect(ws.listRows).not.toHaveBeenCalled();
  });

  it('the open month has a workspace page', async () => {
    const { get } = await setup();
    const res = await get('/dashboard/no-shows/2026-10');
    expect(res.status).toBe(200);
    expect(res.text).toContain(
      "This month's workspace has not been set up yet",
    );
  });

  it('pages cards at 50', async () => {
    const rows = Array.from({ length: 55 }, (_, i) =>
      warningRow({
        id: i + 1,
        memberId: String(9000 + i),
        memberName: `M${i}`,
      }),
    );
    const { get, ws } = await setup({ seed: seed(rows) });
    const first = await get(MONTH);
    expect(cards(first.text)).toHaveLength(50);
    expect(first.text).toContain('href="/dashboard/no-shows/2026-09?page=2"');
    expect(ws.listRows).toHaveBeenCalledWith(SEPT, { offset: 0, limit: 50 });
    const second = await get(`${MONTH}?page=2`);
    expect(cards(second.text)).toHaveLength(5);
    expect(second.text).not.toContain('page=3');
    expect(ws.listRows).toHaveBeenLastCalledWith(SEPT, {
      offset: 50,
      limit: 50,
    });
  });

  it('a workspace read failure → 503 page', async () => {
    const { get } = await setup({
      pages: {
        workspace: async () => {
          throw new Error('db down');
        },
      },
    });
    const res = await get(MONTH);
    expect(res.status).toBe(503);
    expect(res.text).toContain('cannot be loaded right now');
  });

  it('a suspension read failure → 503 page', async () => {
    const susp = fakeSuspensions();
    susp.listByMemberIds.mockRejectedValue(new Error('db down'));
    const { get } = await setup({ pages: { suspensions: async () => susp } });
    const res = await get(MONTH);
    expect(res.status).toBe(503);
  });

  it('a month not set up yet says so and offers set-up', async () => {
    const { get } = await setup({ seed: seed([], { months: [] }) });
    const res = await get(MONTH);
    expect(res.status).toBe(200);
    expect(words(res.text)).toContain(
      "This month's workspace has not been set up yet",
    );
    expect(res.text).toMatch(
      /<form method="post" action="\/dashboard\/no-shows\/2026-09\/sync">[\s\S]*?Set up from the stored report<\/button>/,
    );
    expect(syncFormOf(res.text)).toContain(
      `<input type="hidden" name="_csrf" value="${csrfOf(res.text)}" />`,
    );
  });

  it('a behind workspace offers an update', async () => {
    const { get } = await setup({
      snapshots: [
        seedRow('no_show', SEPT, payload(), {
          id: SNAPSHOT_ID + 1,
          builtAt: new Date('2026-10-04T15:00:00Z'),
        }),
      ],
    });
    const res = await get(MONTH);
    expect(words(res.text)).toContain('A newer report');
    expect(res.text).toMatch(
      /action="\/dashboard\/no-shows\/2026-09\/sync">[\s\S]*?Update from the stored report<\/button>/,
    );
    expect(syncFormOf(res.text)).toContain(
      `<input type="hidden" name="_csrf" value="${csrfOf(res.text)}" />`,
    );
  });

  it('an up-to-date workspace offers no update, and shows when it was built', async () => {
    const { get } = await setup();
    const res = await get(MONTH);
    expect(res.text).not.toContain('Update from the stored report');
    expect(words(res.text)).toContain(
      'Report built Oct 1, 2026 8:00 AM by the daily job; workspace updated Oct 1, 2026 9:00 AM',
    );
    expect(res.text).toContain('name="return" value="workspace"');
  });

  it('a malformed stored report still renders the cards, without copy boxes', async () => {
    const { get } = await setup({
      snapshots: snapshotRows({ reportType: 'no_show', cases: 'nope' }),
    });
    const res = await get(MONTH);
    expect(res.status).toBe(200);
    expect(cards(res.text)).toHaveLength(2);
    expect(res.text).not.toContain('data-copy-box>');
  });

  it('the month picker links every workspace month, the current one unlinked', async () => {
    const { get } = await setup();
    const res = await get(MONTH);
    expect(res.text).toContain(
      '<a href="/dashboard/no-shows/2026-10">October 2026</a>',
    );
    expect(res.text).not.toContain(
      '<a href="/dashboard/no-shows/2026-09">September 2026</a>',
    );
  });

  it('the page never says attendance or incomplete outside the message templates', async () => {
    const { get } = await setup({ leader: true });
    const res = await get(MONTH);
    const text = withoutCopyBoxes(res.text).toLowerCase();
    expect(text).not.toContain('attendance');
    expect(text).not.toContain('incomplete');
  });
});

describe('GET /dashboard/no-shows (months list)', () => {
  it('list page shows every workspace month with to-do counts', async () => {
    const rows = [
      warningRow(),
      warningRow({ id: 3, memberId: '3', status: 'warning_copied' }),
      warningRow({ id: 4, memberId: '4', status: 'on_hold' }),
      warningRow({ id: 5, memberId: '5', status: 'warning_sent' }),
      suspensionCardRow({ status: 'suspended' }),
      workspaceRow({ id: 6, period: OCT, memberId: '6' }),
    ];
    const { get } = await setup({ seed: seed(rows) });
    const res = await get(LIST);
    expect(res.status).toBe(200);
    const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(res.text)?.[1] ?? '';
    const trs = body.split('<tr>').slice(1).map(words);
    expect(trs).toEqual([
      'October 2026 1 0 0 Not set up yet',
      'September 2026 2 1 2 Updated Oct 1, 2026 9:00 AM',
    ]);
    expect(res.text).toContain('<a href="/dashboard/no-shows/2026-09">');
  });

  it('a read failure → 503 page', async () => {
    const { get } = await setup({
      pages: {
        workspace: async () => {
          throw new Error('db down');
        },
      },
    });
    const res = await get(LIST);
    expect(res.status).toBe(503);
  });

  it('the nav links the workspace', async () => {
    const { get } = await setup();
    const res = await get('/dashboard/hall-of-fame');
    expect(res.text).toContain(
      '<a href="/dashboard/no-shows">No-show workspace</a>',
    );
  });
});

describe('GET /dashboard/no-shows/:period/rows/:rowId/suspend (confirm)', () => {
  const prior = () =>
    suspensionRecord({
      memberId: '2001',
      suspendedAt: new Date('2026-03-02T00:00:00Z'),
    });

  it('confirm page shows the computed length and a date limited to the month start and today', async () => {
    const { get } = await setup({
      seed: seed([warningRow(), suspensionCardRow({ notes: RTL, version: 4 })]),
      records: [prior()],
      leader: true,
    });
    const res = await get(CONFIRM);
    expect(res.status).toBe(200);
    expect(words(res.text)).toContain(
      'Dated today that is 60 days (1 earlier suspension)',
    );
    expect(words(res.text)).toContain('$20 admin fee to rejoin');
    expect(res.text).toContain(
      '<input type="date" name="date" value="2026-10-05" min="2026-09-01" ' +
        'max="2026-10-05" required />',
    );
    const confirmForm = new RegExp(
      [
        '<form method="post" action="/dashboard/no-shows/2026-09/rows/2">',
        'name="_csrf"',
        'name="version" value="4"',
        'name="action" value="record_suspension"',
        'name="confirm" value="yes"',
        '<input type="hidden" name="date" value="2026-10-05" />',
      ].join('[\\s\\S]*'),
    );
    expect(res.text).toMatch(confirmForm);
    expect(res.text).toContain(`<bdi>${RTL}</bdi>`);
    expect(res.text).toContain('Member 1');
    expect(res.text).toContain('href="/dashboard/no-shows/2026-09">Cancel</a>');
  });

  describe('a chosen date', () => {
    /** Earlier records: March, and a 7-day one from Sep 3 (through Sep 9) in the month. */
    const twoRecords = () => [
      prior(),
      suspensionRecord({
        id: 50,
        memberId: '2001',
        suspendedAt: new Date('2026-09-03T00:00:00Z'),
        durationDays: 7,
      }),
    ];
    const recordForm = (body: string) =>
      /<form method="post" action="\/dashboard\/no-shows\/2026-09\/rows\/2">[\s\S]*?<\/form>/.exec(
        body,
      )?.[0] ?? '';
    const dateForm = (body: string) =>
      /<form method="get"[\s\S]*?<\/form>/.exec(body)?.[0] ?? '';

    it('today counts both earlier records', async () => {
      const { get } = await setup({ records: twoRecords(), leader: true });
      const res = await get(CONFIRM);
      expect(words(res.text)).toContain(
        'Dated today that is 120 days (2 earlier suspensions)',
      );
      expect(words(res.text)).toContain('$40 admin fee to rejoin');
    });

    it('a chosen date after the latest record ends counts both, and the min is the day after it', async () => {
      const { get } = await setup({ records: twoRecords(), leader: true });
      const res = await get(`${CONFIRM}?date=2026-09-15`);
      expect(res.status).toBe(200);
      expect(words(res.text)).toContain(
        'Dated the chosen day that is 120 days (2 earlier suspensions)',
      );
      expect(words(res.text)).not.toContain('Dated today');
      // The date the length was worked out for is the one recorded.
      expect(recordForm(res.text)).toContain(
        '<input type="hidden" name="date" value="2026-09-15" />',
      );
      expect(dateForm(res.text)).toContain(
        '<input type="date" name="date" value="2026-09-15" min="2026-09-10" ' +
          'max="2026-10-05" required />',
      );
      expect(words(unescape(res.raw))).toContain(
        'This member has a suspension on file through Sep 9, 2026. ' +
          "A new one can't overlap it or be dated before it, so the earliest date is Sep 10, 2026.",
      );
    });

    it.each([
      ["the latest record's own day", '2026-09-03'],
      ['its last day', '2026-09-09'],
      ['between the 1st and the min', '2026-09-01'],
    ])(
      'a date before the min (%s) falls back to today',
      async (_what, date) => {
        const { get } = await setup({ records: twoRecords(), leader: true });
        const res = await get(`${CONFIRM}?date=${date}`);
        expect(words(res.text)).toContain('Dated today that is 120 days');
        expect(recordForm(res.text)).toContain(
          '<input type="hidden" name="date" value="2026-10-05" />',
        );
      },
    );

    it('the min itself is taken', async () => {
      const { get } = await setup({ records: twoRecords(), leader: true });
      const res = await get(`${CONFIRM}?date=2026-09-10`);
      expect(recordForm(res.text)).toContain(
        '<input type="hidden" name="date" value="2026-09-10" />',
      );
    });

    it('the date form is a GET back to this page, carrying only the date', async () => {
      const { get } = await setup({ leader: true });
      const res = await get(CONFIRM);
      const form = dateForm(res.text);
      expect(form).toContain(
        '<form method="get" action="/dashboard/no-shows/2026-09/rows/2/suspend">',
      );
      expect(form).not.toContain('_csrf');
      expect(form).not.toContain('name="action"');
      expect(form.match(/name="/g)).toHaveLength(1);
      // The record form has no date input of its own to drift from the length shown.
      expect(recordForm(res.text)).not.toContain('type="date"');
    });

    it.each([
      ['before the month', '2026-08-31'],
      ['after today', '2026-10-06'],
      ['not a calendar day', '2026-09-31'],
      ['not a date', '<script>alert(1)</script>'],
      ['loose', '2026-9-15'],
      ['with a time', '2026-09-15T00:00:00Z'],
      ['an attribute break', '2026-09-15" autofocus onfocus="alert(1)'],
    ])('a date %s falls back to today, never echoed', async (_what, date) => {
      const { get } = await setup({ records: twoRecords(), leader: true });
      const res = await get(`${CONFIRM}?date=${encodeURIComponent(date)}`);
      expect(res.status).toBe(200);
      expect(words(res.text)).toContain(
        'Dated today that is 120 days (2 earlier suspensions)',
      );
      expect(recordForm(res.text)).toContain(
        '<input type="hidden" name="date" value="2026-10-05" />',
      );
      expect(res.raw).not.toContain(date);
      expect(res.raw).not.toContain(escapeHtml(date));
    });

    it('a repeated date falls back to today', async () => {
      const { get } = await setup({ records: twoRecords(), leader: true });
      const res = await get(`${CONFIRM}?date=2026-09-15&date=2026-09-16`);
      expect(words(res.text)).toContain('Dated today that is 120 days');
      expect(res.raw).not.toContain('2026-09-15');
      expect(res.raw).not.toContain('2026-09-16');
    });

    it("today's date given explicitly reads as today", async () => {
      const { get } = await setup({ records: twoRecords(), leader: true });
      const res = await get(`${CONFIRM}?date=2026-10-05`);
      expect(words(res.text)).toContain('Dated today that is 120 days');
    });
  });

  describe("the member's live records set the earliest date", () => {
    const record = (iso: string, durationDays = 30, voided = false) =>
      suspensionRecord({
        memberId: '2001',
        suspendedAt: new Date(`${iso}T00:00:00Z`),
        durationDays,
        ...(voided && {
          voidedAt: new Date('2026-10-01T00:00:00Z'),
          voidedBy: '1',
          voidReason: 'x',
        }),
      });

    it('records that ended before the 1st leave the min at the 1st, with no line about them', async () => {
      const { get } = await setup({ records: [prior()], leader: true });
      const res = await get(CONFIRM);
      expect(res.text).toContain('min="2026-09-01"');
      expect(words(unescape(res.raw))).not.toContain('on file through');
    });

    it('a voided record does not move the min', async () => {
      const { get } = await setup({
        records: [record('2026-09-20', 30, true)],
        leader: true,
      });
      const res = await get(CONFIRM);
      expect(res.text).toContain('min="2026-09-01"');
    });

    it('the latest last day wins, even from an earlier-dated record', async () => {
      const { get } = await setup({
        records: [record('2026-09-02', 20), record('2026-09-05', 7)],
        leader: true,
      });
      // Sep 2 for 20 days runs through Sep 21; Sep 5 for 7 through Sep 11.
      const res = await get(CONFIRM);
      expect(res.text).toContain('min="2026-09-22"');
    });

    it('a min of today still shows the form, dated today', async () => {
      // Sep 5 for 30 days runs through Oct 4.
      const { get } = await setup({
        records: [record('2026-09-05')],
        leader: true,
      });
      const res = await get(CONFIRM);
      expect(res.text).toContain(
        '<input type="date" name="date" value="2026-10-05" min="2026-10-05" ' +
          'max="2026-10-05" required />',
      );
    });

    it('a min after today shows a fixed line and no form', async () => {
      // Sep 6 for 30 days runs through Oct 5, today.
      const { get } = await setup({
        records: [record('2026-09-06')],
        leader: true,
      });
      const res = await get(`${CONFIRM}?date=2026-09-15`);
      expect(res.status).toBe(200);
      expect(words(unescape(res.raw))).toContain(
        'This member has a suspension on file through Oct 5, 2026. ' +
          "A new one can't overlap it or be dated before it, so it can't be recorded from here right now.",
      );
      expect(res.text).not.toContain('type="date"');
      expect(res.text).not.toContain('name="action"');
      expect(res.text).not.toContain(
        'method="post" action="/dashboard/no-shows/2026-09/rows/2"',
      );
      expect(res.text).toContain(
        'href="/dashboard/no-shows/2026-09">Back to the workspace</a>',
      );
    });

    it('?result=out-of-order names the latest record by its stored date', async () => {
      const { get } = await setup({
        records: [prior(), record('2026-09-03', 7)],
        leader: true,
      });
      const res = await get(`${CONFIRM}?result=out-of-order`);
      expect(words(unescape(res.raw))).toContain(
        "This member already has a suspension dated Sep 3, 2026. A new one can't be dated before it. Nothing was recorded.",
      );
      expect(res.text).toContain('min="2026-09-10"');
    });

    it('?result=out-of-order with no live record left shows the fixed message', async () => {
      const { get } = await setup({ records: [], leader: true });
      const res = await get(`${CONFIRM}?result=out-of-order`);
      expect(words(unescape(res.raw))).toContain(
        WORKSPACE_RESULT_MESSAGES['out-of-order'],
      );
    });

    it('other result codes are not shown on the confirm page', async () => {
      const { get } = await setup({ leader: true });
      const res = await get(`${CONFIRM}?result=done`);
      expect(words(unescape(res.raw))).not.toContain(
        WORKSPACE_RESULT_MESSAGES.done,
      );
    });
  });

  it('the confirm page always asks Discord live, even after a month-page load', async () => {
    const { get, isLeadership } = await setup({ leader: true });
    await get(MONTH);
    expect(isLeadership).toHaveBeenCalledTimes(1);
    expect((await get(CONFIRM)).status).toBe(200);
    expect((await get(CONFIRM)).status).toBe(200);
    expect(isLeadership).toHaveBeenCalledTimes(3);
  });

  it('a Moderator never sees the confirm form', async () => {
    const { get, ws } = await setup({ leader: false });
    const res = await get(CONFIRM);
    expect(res.status).toBe(403);
    expect(words(res.text)).toContain(
      'Only the 1.5 Leadership Team can record suspensions',
    );
    expect(res.text).not.toContain('name="action"');
    expect(res.text).not.toContain('type="date"');
    expect(ws.getRow).not.toHaveBeenCalled();
  });

  it('Discord unreachable refuses the confirm page', async () => {
    const { get } = await setup({ leader: new Error('discord down') });
    const res = await get(CONFIRM);
    expect(res.status).toBe(503);
    expect(res.text).not.toContain('type="date"');
    expect(words(res.text)).toContain(
      'Discord could not be reached to check your role',
    );
  });

  it('confirm page for a warning row says it cannot be suspended', async () => {
    const { get } = await setup({ leader: true });
    const res = await get('/dashboard/no-shows/2026-09/rows/1/suspend');
    expect(res.status).toBe(200);
    expect(words(res.text)).toContain(
      'This card cannot be suspended from here (New)',
    );
    expect(res.text).not.toContain('type="date"');
  });

  it('confirm page 404s for an unknown row or a junk row id', async () => {
    const { get } = await setup({ leader: true });
    for (const path of [
      '/dashboard/no-shows/2026-09/rows/99/suspend',
      '/dashboard/no-shows/2026-09/rows/0/suspend',
      '/dashboard/no-shows/2026-09/rows/01/suspend',
      '/dashboard/no-shows/2026-09/rows/abc/suspend',
      '/dashboard/no-shows/2026-08/rows/2/suspend',
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one request at a time
      const res = await get(path);
      expect(res.status, path).toBe(404);
    }
  });

  it('a read failure → 503 page', async () => {
    const { get } = await setup({
      leader: true,
      pages: {
        workspace: async () => {
          throw new Error('db down');
        },
      },
    });
    const res = await get(CONFIRM);
    expect(res.status).toBe(503);
  });
});

describe('workspace GETs', () => {
  it('GET handlers write nothing', async () => {
    const { get, actions, susp } = await setup({ leader: true });
    for (const path of [LIST, MONTH, CONFIRM]) {
      // eslint-disable-next-line no-await-in-loop -- one request at a time
      const res = await get(path);
      expect(res.status, path).toBe(200);
    }
    expect(actions.perform).not.toHaveBeenCalled();
    expect(actions.sync).not.toHaveBeenCalled();
    expect(actions.moderationLog).not.toHaveBeenCalled();
    // The suspension reader has reads only; nothing else was touched.
    expect(Object.keys(susp).sort()).toEqual([
      'countByMonth',
      'countByState',
      'listByIds',
      'listByMemberIds',
      'listPage',
    ]);
  });

  it('the result and refresh codes in the query are never echoed', async () => {
    const { get } = await setup();
    const evil = await get(
      `${MONTH}?result=%3Cb%3Epwned-result%3C%2Fb%3E&refresh=pwned-refresh`,
    );
    expect(evil.status).toBe(200);
    expect(evil.raw).not.toContain('pwned-result');
    expect(evil.raw).not.toContain('pwned-refresh');
    const suffixed = await get(`${MONTH}?result=done%20pwned-suffix`);
    expect(suffixed.raw).not.toContain('pwned-suffix');
    expect(suffixed.raw).not.toContain(WORKSPACE_RESULT_MESSAGES.done);
    const known = await get(`${MONTH}?result=done&refresh=started`);
    expect(known.text).toContain(
      `<p class="note">${WORKSPACE_RESULT_MESSAGES.done}</p>`,
    );
    expect(known.text).toContain('Refreshing from Meetup.');
    const leader = await get(`${MONTH}?result=not-leadership`);
    expect(leader.text).toContain('Only the 1.5 Leadership Team can record');
  });
});

describe('LeadershipDisplayCache', () => {
  const at = (ms: number) => () => ms;

  it('keeps leader and not-leader for 60 s, never unreachable', async () => {
    let now = 0;
    const cache = new LeadershipDisplayCache(() => now);
    const ask = vi.fn(
      async (): Promise<'leader' | 'not-leader' | 'unreachable'> => 'leader',
    );
    expect(await cache.get('u', ask)).toBe('leader');
    expect(await cache.get('u', ask)).toBe('leader');
    expect(ask).toHaveBeenCalledTimes(1);
    now = LEADERSHIP_DISPLAY_CACHE_MS - 1;
    await cache.get('u', ask);
    expect(ask).toHaveBeenCalledTimes(1);
    now = LEADERSHIP_DISPLAY_CACHE_MS;
    await cache.get('u', ask);
    expect(ask).toHaveBeenCalledTimes(2);
    const down = vi.fn(
      async (): Promise<'leader' | 'not-leader' | 'unreachable'> =>
        'unreachable',
    );
    expect(await cache.get('v', down)).toBe('unreachable');
    expect(await cache.get('v', down)).toBe('unreachable');
    expect(down).toHaveBeenCalledTimes(2);
  });

  it('holds at most 200 users, evicting the oldest', async () => {
    const cache = new LeadershipDisplayCache(at(0));
    const ask = vi.fn(
      async (): Promise<'leader' | 'not-leader' | 'unreachable'> =>
        'not-leader',
    );
    for (let i = 0; i <= LEADERSHIP_DISPLAY_CACHE_MAX; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- one user at a time
      await cache.get(`u${i}`, ask);
    }
    expect(LEADERSHIP_DISPLAY_CACHE_MAX).toBe(200);
    expect(cache.size).toBe(200);
    ask.mockClear();
    await cache.get('u200', ask);
    await cache.get('u1', ask);
    expect(ask).not.toHaveBeenCalled();
    await cache.get('u0', ask);
    expect(ask).toHaveBeenCalledTimes(1);
  });
});
