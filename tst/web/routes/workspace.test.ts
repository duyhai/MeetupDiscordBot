import { afterEach, describe, expect, it, vi } from 'vitest';

import { Period } from '../../../src/lib/reports/period.js';
import { NoShowPayload } from '../../../src/lib/reports/types.js';
import { SuspensionRecordState } from '../../../src/lib/repositories/postgresSuspensionRepository.js';
import {
  suspensionMessage,
  warningMessage,
} from '../../../src/lib/workspace/templates.js';
import {
  WorkspaceEvent,
  WorkspaceRow,
} from '../../../src/lib/workspace/types.js';
import { UpcomingEntry } from '../../../src/lib/workspace/upcoming.js';
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
  let clock = PAGE_NOW.getTime();
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
    const elsewhere = suspensionRecord({
      id: 9,
      memberId: '2001',
      suspendedAt: new Date('2026-10-02T00:00:00Z'),
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
    expect(words(res.text)).toContain('60 days (1 earlier suspension)');
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
      ].join('[\\s\\S]*'),
    );
    expect(res.text).toMatch(confirmForm);
    expect(res.text).toContain(`<bdi>${RTL}</bdi>`);
    expect(res.text).toContain('Member 1');
    expect(res.text).toContain('href="/dashboard/no-shows/2026-09">Cancel</a>');
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
