import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceStatus } from '../../../src/lib/workspace/types.js';

import { STYLE } from '../../../src/web/pages.js';
import { DashboardPageDeps } from '../../../src/web/routes/dashboardPages.js';
import {
  HOME_REPORTS_DEADLINE_MS,
  renderHomeReports,
} from '../../../src/web/routes/home.js';
import { closeServers, makeApp, signIn } from '../dashboardHarness.js';
import {
  PAGE_NOW,
  SEPT,
  eventRequestRow,
  fakeEventRequests,
  fakeIdentity,
  fakePageDeps,
  fakeSnapshots,
  fakeWorkspace,
  hofPayload,
  identityChange,
  noShowPayload,
  seedRow,
  workspaceRow,
} from './pageFakes.js';

afterEach(closeServers);

const OCT = { year: 2026, month: 10 };

const septRows = () => [
  seedRow(
    'hall_of_fame',
    SEPT,
    hofPayload({
      summary: { events: 4, hosts: 3, newHosts: 1 },
    }),
  ),
  seedRow(
    'no_show',
    SEPT,
    noShowPayload({
      summary: {
        noShows: 8,
        members: 5,
        warnings: 2,
        suspensionCandidates: 3,
        cleared: 0,
        departed: 0,
      },
    }),
  ),
];

function deps(overrides: Partial<DashboardPageDeps> = {}) {
  return fakePageDeps({
    snapshots: async () => fakeSnapshots(septRows()),
    identity: async () => fakeIdentity(),
    ...overrides,
  });
}

/** Markup whitespace collapsed, so assertions read the sentence, not the formatting. */
const render = async (overrides: Partial<DashboardPageDeps> = {}) =>
  (await renderHomeReports(deps(overrides))).value
    .replace(/\s+/g, ' ')
    .replace(/> </g, '><');

describe('Home report cards', () => {
  it('shows latest month counts', async () => {
    const out = await render();
    expect(out).toContain('8 no-show RSVPs');
    expect(out).toContain('2 warnings');
    expect(out).toContain('3 suspension candidates');
    expect(out).toContain('4 events');
    expect(out).toContain('3 hosts (1 new)');
    expect(out).toContain('href="/dashboard/hall-of-fame/2026-09"');
    expect(out).toContain('href="/dashboard/no-show-history/2026-09"');
    expect(out).not.toMatch(/attend|incomplete/i);
  });

  it('says "not built yet" with no snapshot', async () => {
    const out = await render();
    expect(out).toContain('The October 2026 reports have not been built yet.');
    expect(out).toContain('So far this month');
  });

  it('notes a finished month with no no-shows, and never an open one', async () => {
    const zero = { pastEventsWithRsvps: 6, eventsWithNoShow: 0, noShows: 0 };
    const rows = [
      seedRow('hall_of_fame', SEPT, hofPayload()),
      seedRow('no_show', SEPT, noShowPayload(), { attendance: zero }),
      seedRow('hall_of_fame', OCT, hofPayload()),
      seedRow('no_show', OCT, noShowPayload(), { attendance: zero }),
    ];
    const out = await render({ snapshots: async () => fakeSnapshots(rows) });
    expect(out).toContain('No no-shows were recorded for September 2026');
    expect(out).not.toContain('No no-shows were recorded for October 2026');
    expect(out).not.toMatch(/incomplete/i);
  });

  it('lists the latest 10 identity changes inline, with the see-all link', async () => {
    const identity = fakeIdentity(
      Array.from({ length: 12 }, (_, i) =>
        identityChange({ id: String(500 - i), newValue: `Nick ${i}` }),
      ),
    );
    const out = await render({ identity: async () => identity });
    expect(identity.listChangesPage).toHaveBeenCalledTimes(1);
    expect(identity.listChangesPage).toHaveBeenCalledWith({ limit: 10 });
    expect(identity.countChangesSince).not.toHaveBeenCalled();
    const card =
      /<h2>Identity changes<\/h2>[\s\S]*?<\/div>$/.exec(out)?.[0] ?? '';
    expect(card.match(/<tr>/g)).toHaveLength(11); // the head row and 10 changes
    expect(card).toContain('Nick 0');
    expect(card).toContain('Nick 9');
    expect(card).not.toContain('Nick 10');
    expect(card).toContain(
      '<a href="/dashboard/identity">See all identity changes</a>',
    );
  });

  it('with no identity changes yet, says so and keeps the link', async () => {
    const out = await render({ identity: async () => fakeIdentity() });
    expect(out).toContain('No identity changes recorded yet.');
    expect(out).toContain('href="/dashboard/identity"');
  });

  it('has no Link progress card (Hai, 2026-11-16)', async () => {
    const out = await render();
    expect(out).not.toContain('Link progress');
  });

  it('has no Wrapped or organizer login cards: they are on Settings', async () => {
    const out = await render();
    expect(out).not.toContain('Wrapped');
    expect(out).not.toContain('organizer-login');
  });

  it('one failing section does not hide the others', async () => {
    const identity = fakeIdentity();
    identity.listChangesPage.mockRejectedValue(new Error('db down: secret'));
    const out = await render({ identity: async () => identity });
    expect(out).toContain(
      '<h2>Identity changes</h2><p class="muted">Unavailable right now.</p>',
    );
    expect(out).not.toContain('secret');
    expect(out).toContain('8 no-show RSVPs');
    expect(out).toContain('Board game night');

    const out2 = await render({
      snapshots: async () => {
        throw new Error('nope');
      },
    });
    expect(out2).toContain('Unavailable right now.');
    expect(out2).toContain('Board game night');
    expect(out2).toContain('No identity changes recorded yet.');

    const out3 = await render({
      eventRequests: async () => {
        throw new Error('nope');
      },
    });
    expect(out3.match(/Unavailable right now\./g)).toHaveLength(1);
    expect(out3).toContain('8 no-show RSVPs');
    expect(out3).toContain('href="/dashboard/hosts/requests"');
  });

  it('renders summary numbers through Number()', async () => {
    const rows = [
      seedRow('hall_of_fame', SEPT, hofPayload(), {
        summary: { events: '<script>', hosts: 1, newHosts: 0 },
      }),
      seedRow('no_show', SEPT, noShowPayload(), {
        summary: { noShows: '<script>', warnings: 1, suspensionCandidates: 0 },
      }),
    ];
    const out = await render({ snapshots: async () => fakeSnapshots(rows) });
    expect(out).not.toContain('<script>');
    expect(out).toContain('0 no-show RSVPs');
    expect(out).toContain('0 events');
  });

  it('never selects payloads', async () => {
    const snapshots = fakeSnapshots(septRows());
    await render({ snapshots: async () => snapshots });
    expect(snapshots.getCurrent).not.toHaveBeenCalled();
    expect(snapshots.getCurrentMeta).toHaveBeenCalledTimes(4);
  });
});

/** September: 2 new, 1 warning copied, 1 on hold, 3 done (sent, suspended, skipped); October: 1 voided. */
const workspaceRows = () => {
  const statuses: WorkspaceStatus[] = [
    'new',
    'new',
    'warning_copied',
    'on_hold',
    'warning_sent',
    'suspended',
    'skipped',
  ];
  return [
    ...statuses.map((status, i) =>
      workspaceRow({ id: i + 1, memberId: String(1000 + i), status }),
    ),
    // Dropped from the report: never counted.
    workspaceRow({ id: 20, memberId: '2000', inLatestSnapshot: false }),
    workspaceRow({ id: 21, period: OCT, memberId: '3000', status: 'voided' }),
  ];
};

/** A month state: the month has been set up. */
const setUp = (period: typeof SEPT) => ({
  period,
  snapshotId: 1,
  snapshotBuiltAt: new Date('2026-10-01T15:00:00Z'),
  syncedAt: new Date('2026-10-01T16:00:00Z'),
});

const seededWorkspace = () =>
  fakeWorkspace({
    rows: workspaceRows(),
    months: [setUp(SEPT), setUp(OCT)],
    events: [],
  });

const MONTH_KEYS: Record<string, string> = {
  'September 2026': '2026-09',
  'October 2026': '2026-10',
};

/** A month's three workspace tiles, as the collapsed markup reads them. */
const tiles = (month: string, todo: number, hold: number, done: number) =>
  `href="/dashboard/no-shows/${MONTH_KEYS[month]}">No-show workspace</a></h3><dl class="stats">` +
  `<div class="stat todo"><dt>To do</dt><dd>${todo}</dd></div>` +
  `<div class="stat"><dt>On hold</dt><dd>${hold}</dd></div>` +
  `<div class="stat done"><dt>Done</dt><dd>${done}</dd></div></dl>`;

/** One month's collapsible, as collapsed markup. */
const monthSection = (out: string, month: string) =>
  new RegExp(
    `<details class="ui-collapsible"[^>]*><summary><span class="ui-collapsible-title">${month}</span>[\\s\\S]*?</details>`,
  ).exec(out)?.[0] ?? '';

describe('Home: one card, a collapsible per month (Hai, 2026-11-16)', () => {
  it('the open month first and open; the finished month folded', async () => {
    const out = await render({ workspace: async () => seededWorkspace() });
    const card =
      /<div class="card"><h2>This month and last<\/h2>[\s\S]*?<\/details><\/div>/.exec(
        out,
      )?.[0] ?? '';
    expect(card).not.toBe('');
    expect(card.indexOf('October 2026')).toBeLessThan(
      card.indexOf('September 2026'),
    );
    expect(card).toContain(
      '<details class="ui-collapsible" open><summary>' +
        '<span class="ui-collapsible-title">October 2026</span>' +
        '<span class="ui-collapsible-meta">So far this month · 0 to do</span>',
    );
    expect(card).toContain(
      '<details class="ui-collapsible"><summary>' +
        '<span class="ui-collapsible-title">September 2026</span>' +
        '<span class="ui-collapsible-meta">3 to do</span>',
    );
  });

  it('each month holds its workspace counts, its no-show summary and its Hall of Fame summary, with their links', async () => {
    const out = await render({ workspace: async () => seededWorkspace() });
    const sept = monthSection(out, 'September 2026');
    expect(sept).toContain(tiles('September 2026', 3, 1, 3));
    expect(sept).toContain('href="/dashboard/no-shows/2026-09"');
    expect(sept).toContain('8 no-show RSVPs');
    expect(sept).toContain('href="/dashboard/no-show-history/2026-09"');
    expect(sept).toContain(
      '<a href="/dashboard/hall-of-fame/2026-09">Hall of Fame</a>: 4 events',
    );
    // The workspace tiles come before the reports.
    expect(sept.indexOf('<dl class="stats">')).toBeLessThan(
      sept.indexOf('8 no-show RSVPs'),
    );
    // The heading inside does not repeat the month the collapsible names.
    expect(sept).toContain(
      '<h3><a href="/dashboard/no-shows/2026-09">No-show workspace</a></h3>',
    );
    expect(sept).not.toContain('September 2026 no-show workspace');
    const oct = monthSection(out, 'October 2026');
    expect(oct).toContain(tiles('October 2026', 0, 0, 1));
    expect(oct).toContain('The October 2026 reports have not been built yet.');
    expect(oct).not.toContain('8 no-show RSVPs');
  });

  it('host requests sit in the same card: a count, the oldest few, and the queue link', async () => {
    const rows = Array.from({ length: 7 }, (_, i) =>
      eventRequestRow({ id: String(i + 1), title: `Request ${i + 1}` }),
    );
    const store = fakeEventRequests(rows);
    const out = await render({ eventRequests: async () => store });
    expect(store.listByStatus).toHaveBeenCalledWith(['pending'], 50, 'oldest');
    const section = monthSection(out, 'Host requests');
    expect(section).toMatch(/^<details class="ui-collapsible" open>/);
    expect(section).toContain(
      '<span class="ui-collapsible-meta">7 waiting</span>',
    );
    expect(section.match(/<li>/g)).toHaveLength(5);
    expect(section).toContain('Request 1');
    expect(section).toContain('Request 5');
    expect(section).not.toContain('Request 6');
    expect(section).toContain('And 2 more in the queue.');
    expect(section).toContain(
      '<a href="/dashboard/hosts/requests">Open the host requests queue</a>',
    );
    // Inside the grouped card, after the months.
    const card =
      /<h2>This month and last<\/h2>[\s\S]*?<\/details><\/div>/.exec(
        out,
      )?.[0] ?? '';
    expect(card).toContain('Host requests');
    expect(card.indexOf('September 2026')).toBeLessThan(
      card.indexOf('Host requests'),
    );
  });

  it('host requests: none waiting folds the section and says so; names are escaped', async () => {
    const none = await render({
      eventRequests: async () => fakeEventRequests([]),
    });
    const section = monthSection(none, 'Host requests');
    expect(section).toMatch(/^<details class="ui-collapsible">/);
    expect(section).toContain('None waiting');
    expect(section).toContain('No requests are waiting.');

    const hostile = await render({
      eventRequests: async () =>
        fakeEventRequests([
          eventRequestRow({ title: '<img src=x>', hostName: '‮Eve' }),
        ]),
    });
    expect(hostile).not.toContain('<img src=x>');
    expect(hostile).toContain('<bdi>&lt;img src=x&gt;</bdi>');
  });

  it('50 waiting reads as 50+', async () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      eventRequestRow({ id: String(i + 1) }),
    );
    const out = await render({
      eventRequests: async () => fakeEventRequests(rows),
    });
    expect(out).toContain('50+ waiting');
    expect(out).toContain('And more in the queue.');
  });
});

describe('Home open workspace items card', () => {
  it('shows open workspace items for the latest finished and the open month', async () => {
    const out = await render({ workspace: async () => seededWorkspace() });
    expect(out).toContain(tiles('September 2026', 3, 1, 3));
    expect(out).toContain(tiles('October 2026', 0, 0, 1));
    expect(out).not.toMatch(/attend|incomplete|<@/i);
  });

  it('shows each month as three tiles, the to-do number in coral', async () => {
    const out = await render({ workspace: async () => seededWorkspace() });
    // Exactly one to-do tile per month, and it is the first tile.
    expect(out.match(/<div class="stat todo">/g)).toHaveLength(2);
    expect(
      out.match(/<dl class="stats"><div class="stat todo">/g),
    ).toHaveLength(2);
    // The stylesheet colours the to-do tile's number with the coral token.
    const rule = /\.stat\.todo dd\{([^}]*)\}/.exec(STYLE.value)?.[1] ?? '';
    expect(rule).toMatch(/(?:^|;)color:var\(--attn\)(?:;|$)/);
  });

  it('links each workspace month', async () => {
    const out = await render({ workspace: async () => seededWorkspace() });
    expect(out).toContain('href="/dashboard/no-shows/2026-09"');
    expect(out).toContain('href="/dashboard/no-shows/2026-10"');
  });

  it('reads one aggregate for exactly the two months', async () => {
    const ws = seededWorkspace();
    await render({ workspace: async () => ws });
    expect(ws.statusCounts).toHaveBeenCalledTimes(1);
    expect(ws.statusCounts).toHaveBeenCalledWith([SEPT, OCT]);
    expect(ws.listRows).not.toHaveBeenCalled();
    expect(ws.statusesByMember).not.toHaveBeenCalled();
  });

  it('a set-up month with no rows shows zeros', async () => {
    const out = await render({
      workspace: async () =>
        fakeWorkspace({
          rows: [],
          months: [setUp(SEPT), setUp(OCT)],
          events: [],
        }),
    });
    expect(out).toContain(tiles('September 2026', 0, 0, 0));
    expect(out).toContain(tiles('October 2026', 0, 0, 0));
  });

  it('a month with no workspace yet says so, never zeros', async () => {
    const ws = fakeWorkspace({
      rows: workspaceRows(),
      months: [setUp(SEPT)],
      events: [],
    });
    const out = await render({ workspace: async () => ws });
    expect(out).toContain(tiles('September 2026', 3, 1, 3));
    expect(out).toContain(
      'href="/dashboard/no-shows/2026-10">No-show workspace</a></h3><p class="muted">Not set up yet</p>',
    );
    expect(out).not.toContain(
      'href="/dashboard/no-shows/2026-10">No-show workspace</a></h3><dl',
    );
    expect(ws.monthState).toHaveBeenCalledTimes(2);
    expect(ws.listRows).not.toHaveBeenCalled();
  });

  it('the workspace card failure degrades alone', async () => {
    const ws = seededWorkspace();
    ws.statusCounts.mockRejectedValue(new Error('db down: secret'));
    const out = await render({ workspace: async () => ws });
    // One line per month's workspace part; nothing else degrades.
    expect(out.match(/Unavailable right now\./g)).toHaveLength(2);
    expect(out).not.toContain('secret');
    expect(out).toContain('8 no-show RSVPs');
    expect(out).toContain('The October 2026 reports have not been built yet.');
    expect(out).toContain('No identity changes recorded yet.');
    expect(out).toContain('Board game night');

    const lookup = await render({
      workspace: async () => {
        throw new Error('no DATABASE_URL');
      },
    });
    expect(lookup.match(/Unavailable right now\./g)).toHaveLength(2);
    expect(lookup).toContain('8 no-show RSVPs');
    expect(lookup).toContain('Board game night');
  });

  it('a month before the workspace shows no workspace line', async () => {
    const out = (
      await renderHomeReports(
        deps({
          now: () => new Date('2026-09-10T16:00:00Z'),
          workspace: async () => seededWorkspace(),
        }),
      )
    ).value
      .replace(/\s+/g, ' ')
      .replace(/> </g, '><');
    expect(out).toContain(tiles('September 2026', 3, 1, 3));
    expect(out).not.toContain('2026-08">No-show workspace');
    expect(out).not.toContain('/dashboard/no-shows/2026-08');
  });

  it('before the first workspace month there is no workspace card and no read', async () => {
    const ws = seededWorkspace();
    const out = (
      await renderHomeReports(
        deps({
          now: () => new Date('2026-08-10T16:00:00Z'),
          workspace: async () => ws,
        }),
      )
    ).value;
    expect(out).not.toContain('No-show workspace');
    expect(ws.statusCounts).not.toHaveBeenCalled();
  });
});

describe('Home report cards, failure isolation and timing', () => {
  it('degrades only the finished-month card when its meta read fails', async () => {
    const snapshots = fakeSnapshots(septRows());
    snapshots.getCurrentMeta.mockImplementation(async (type, period) => {
      if (period.month === 9) {
        throw new Error('boom');
      }
      return undefined;
    });
    const out = await render({ snapshots: async () => snapshots });
    expect(out.match(/Unavailable right now\./g)).toHaveLength(1);
    expect(out).toContain('The October 2026 reports have not been built yet.');
    expect(out).toContain('Board game night');
  });

  it('renders a month before the group existed as plain text', async () => {
    const out = (
      await renderHomeReports(
        deps({ now: () => new Date('2013-03-10T16:00:00Z') }),
      )
    ).value;
    expect(out).toContain('February 2013');
    expect(out).not.toContain('2013-02');
  });

  describe('with fake timers', () => {
    afterEach(() => vi.useRealTimers());

    it('starts all four reads before any resolves', async () => {
      vi.useFakeTimers();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const snapshots = fakeSnapshots(septRows());
      snapshots.getCurrentMeta.mockImplementation(async () => {
        await gate;
        return undefined;
      });
      const identity = fakeIdentity();
      identity.listChangesPage.mockImplementation(async () => {
        await gate;
        return [];
      });
      const requests = fakeEventRequests();
      requests.listByStatus.mockImplementation(async () => {
        await gate;
        return [];
      });
      const pending = renderHomeReports(
        deps({
          snapshots: async () => snapshots,
          identity: async () => identity,
          eventRequests: async () => requests,
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(snapshots.getCurrentMeta).toHaveBeenCalledTimes(4);
      expect(identity.listChangesPage).toHaveBeenCalledTimes(1);
      expect(requests.listByStatus).toHaveBeenCalledTimes(1);
      release();
      await pending;
    });

    it('cards load in parallel: all five reads start before any resolves', async () => {
      vi.useFakeTimers();
      const started: string[] = [];
      let resolved = false;
      let release: () => void = () => undefined;
      const gate = new Promise<void>((r) => {
        release = r;
      }).then(() => {
        resolved = true;
      });
      const startedBeforeResolve = (name: string) => {
        if (!resolved) {
          started.push(name);
        }
      };
      const snapshots = fakeSnapshots(septRows());
      snapshots.getCurrentMeta.mockImplementation(async (_type, period) => {
        startedBeforeResolve(`meta ${period.month}`);
        await gate;
        return undefined;
      });
      const identity = fakeIdentity();
      identity.listChangesPage.mockImplementation(async () => {
        startedBeforeResolve('identity');
        await gate;
        return [];
      });
      const requests = fakeEventRequests();
      requests.listByStatus.mockImplementation(async () => {
        startedBeforeResolve('requests');
        await gate;
        return [];
      });
      const ws = seededWorkspace();
      ws.statusCounts.mockImplementation(async () => {
        startedBeforeResolve('workspace');
        await gate;
        return new Map();
      });
      const pending = renderHomeReports(
        deps({
          snapshots: async () => snapshots,
          identity: async () => identity,
          eventRequests: async () => requests,
          workspace: async () => ws,
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      release();
      await pending;
      expect([...new Set(started)].sort()).toEqual([
        'identity',
        'meta 10',
        'meta 9',
        'requests',
        'workspace',
      ]);
    });

    it('the workspace card shares the 5 s deadline', async () => {
      vi.useFakeTimers();
      const ws = seededWorkspace();
      ws.statusCounts.mockReturnValue(new Promise(() => {}));
      let out = '';
      const pending = renderHomeReports(
        deps({ workspace: async () => ws }),
      ).then((v) => {
        out = v.value;
      });
      await vi.advanceTimersByTimeAsync(HOME_REPORTS_DEADLINE_MS - 1);
      expect(out).toBe('');
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(out.match(/Unavailable right now\./g)).toHaveLength(2);
      expect(out).toContain('8 no-show RSVPs');
      expect(out).toContain('Board game night');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('the month-state read shares the 5 s deadline', async () => {
      vi.useFakeTimers();
      const ws = seededWorkspace();
      ws.monthState.mockReturnValue(new Promise(() => {}));
      let out = '';
      const pending = renderHomeReports(
        deps({ workspace: async () => ws }),
      ).then((v) => {
        out = v.value;
      });
      await vi.advanceTimersByTimeAsync(HOME_REPORTS_DEADLINE_MS - 1);
      expect(out).toBe('');
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(out.match(/Unavailable right now\./g)).toHaveLength(2);
      expect(out).toContain('8 no-show RSVPs');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('answers inside the deadline when one read never settles', async () => {
      vi.useFakeTimers();
      const identity = fakeIdentity();
      identity.listChangesPage.mockReturnValue(new Promise(() => {}));
      let out = '';
      const pending = renderHomeReports(
        deps({ identity: async () => identity }),
      ).then((v) => {
        out = v.value;
      });
      await vi.advanceTimersByTimeAsync(HOME_REPORTS_DEADLINE_MS - 1);
      expect(out).toBe('');
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(out.match(/Unavailable right now\./g)).toHaveLength(1);
      expect(out).toContain('8 no-show RSVPs');
      expect(out).toContain('Board game night');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('still renders the page with the welcome card', async () => {
      const identity = fakeIdentity();
      identity.listChangesPage.mockReturnValue(new Promise(() => {}));
      const { req } = await makeApp({
        now: () => PAGE_NOW.getTime(),
        homeReports: () =>
          renderHomeReports(deps({ identity: async () => identity })),
      });
      const cookie = await signIn(req);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const settled = Promise.resolve(
        req.get('/dashboard/').set('Cookie', cookie),
      );
      for (let i = 0; i < 20; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- let the socket I/O run between clock steps
        await new Promise<void>((r) => {
          setImmediate(r);
        });
        // eslint-disable-next-line no-await-in-loop -- see above
        await vi.advanceTimersByTimeAsync(HOME_REPORTS_DEADLINE_MS);
      }
      const res = await settled;
      expect(res.status).toBe(200);
      expect(res.text).toContain('Unavailable right now.');
      expect(res.text).toContain('Welcome');
    });
  });

  it('treats negative or non-finite summary numbers as 0', async () => {
    const rows = [
      seedRow('hall_of_fame', SEPT, hofPayload(), {
        summary: { events: -3, hosts: Infinity, newHosts: 1 },
      }),
      seedRow('no_show', SEPT, noShowPayload(), {
        summary: { noShows: -1, warnings: 1, suspensionCandidates: 0 },
      }),
    ];
    const out = await render({ snapshots: async () => fakeSnapshots(rows) });
    expect(out).toContain('0 no-show RSVPs');
    expect(out).toContain('0 events');
    expect(out).toContain('0 hosts');
  });
});

describe('Home page integration', () => {
  it('the workspace card rejecting still renders the whole Home page', async () => {
    const ws = seededWorkspace();
    ws.statusCounts.mockRejectedValue(new Error('down'));
    const res = await home((() =>
      renderHomeReports(deps({ workspace: async () => ws }))) as never);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Unavailable right now.');
    expect(res.text).toContain('8 no-show RSVPs');
  });

  async function home(homeReports?: () => Promise<never>) {
    const { req } = await makeApp({
      now: () => PAGE_NOW.getTime(),
      homeReports,
    });
    const cookie = await signIn(req);
    return req.get('/dashboard/').set('Cookie', cookie);
  }

  it('shows the cards after the welcome card, and no organizer login card', async () => {
    const reports = () => renderHomeReports(deps());
    const res = await home(reports as never);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Welcome');
    expect(res.text).toContain('What needs doing, newest month first.');
    expect(res.text).toContain('8 no-show RSVPs');
    expect(res.text).not.toContain('/dashboard/organizer-login');
    expect(res.text).not.toContain('OK (no failure on record)');
  });

  it('answers 200 with the welcome text when homeReports rejects', async () => {
    const res = await home(vi.fn().mockRejectedValue(new Error('x')));
    expect(res.status).toBe(200);
    expect(res.text).toContain('Reports will appear here');
  });

  it('without homeReports the home page is unchanged', async () => {
    const res = await home(undefined);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Reports will appear here');
    expect(res.text).not.toContain('What needs doing');
  });
});
