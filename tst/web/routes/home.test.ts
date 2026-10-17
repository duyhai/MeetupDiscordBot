import { afterEach, describe, expect, it, vi } from 'vitest';

import { DashboardPageDeps } from '../../../src/web/routes/dashboardPages.js';
import {
  HOME_REPORTS_DEADLINE_MS,
  renderHomeReports,
} from '../../../src/web/routes/home.js';
import { closeServers, makeApp, signIn } from '../dashboardHarness.js';
import {
  PAGE_NOW,
  SEPT,
  fakeIdentity,
  fakeLinkProgress,
  fakePageDeps,
  fakeSnapshots,
  hofPayload,
  noShowPayload,
  seedRow,
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

  it('counts identity changes from exactly 7 days ago', async () => {
    const identity = fakeIdentity();
    identity.countChangesSince.mockResolvedValue(4);
    const out = await render({ identity: async () => identity });
    expect(identity.countChangesSince).toHaveBeenCalledWith(
      new Date('2026-09-28T16:15:00Z'),
    );
    expect(out).toContain('4 identity changes in the last 7 days');
    expect(out).toContain('href="/dashboard/identity"');
  });

  it('shows the latest link progress day', async () => {
    const out = await render();
    expect(out).toContain(
      'Linked 200, unlinked 40, Reverify-tagged 5, onboarding 3 on 2026-10-04',
    );
    const empty = await render({
      linkProgress: async () => fakeLinkProgress([]),
    });
    expect(empty).toContain('No link progress recorded yet.');
  });

  it('one failing section does not hide the others', async () => {
    const identity = fakeIdentity();
    identity.countChangesSince.mockRejectedValue(new Error('db down: secret'));
    const out = await render({ identity: async () => identity });
    expect(out).toContain('Unavailable right now.');
    expect(out).not.toContain('secret');
    expect(out).toContain('8 no-show RSVPs');
    expect(out).toContain('Linked 200');

    const out2 = await render({
      snapshots: async () => {
        throw new Error('nope');
      },
    });
    expect(out2).toContain('Unavailable right now.');
    expect(out2).toContain('Linked 200');
    expect(out2).toContain('identity changes in the last 7 days');

    const out3 = await render({
      linkProgress: async () => {
        throw new Error('nope');
      },
    });
    expect(out3).toContain('8 no-show RSVPs');
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
    expect(out).toContain('Linked 200');
  });

  it('renders a month before the group existed as plain text', async () => {
    const out = (
      await renderHomeReports(
        deps({ now: () => new Date('2013-03-10T16:00:00Z') }),
      )
    ).value;
    expect(out).toContain('February 2013');
    expect(out).not.toContain('2013-02');
    expect(out).toContain('href="/dashboard/hall-of-fame/2013-03"');
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
      identity.countChangesSince.mockImplementation(async () => {
        await gate;
        return 1;
      });
      const links = fakeLinkProgress();
      links.listDays.mockImplementation(async () => {
        await gate;
        return [];
      });
      const pending = renderHomeReports(
        deps({
          snapshots: async () => snapshots,
          identity: async () => identity,
          linkProgress: async () => links,
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(snapshots.getCurrentMeta).toHaveBeenCalledTimes(4);
      expect(identity.countChangesSince).toHaveBeenCalledTimes(1);
      expect(links.listDays).toHaveBeenCalledTimes(1);
      release();
      await pending;
    });

    it('answers inside the deadline when one read never settles', async () => {
      vi.useFakeTimers();
      const identity = fakeIdentity();
      identity.countChangesSince.mockReturnValue(new Promise<number>(() => {}));
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
      expect(out).toContain('Linked 200');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('still renders the page with the Organizer login card', async () => {
      const identity = fakeIdentity();
      identity.countChangesSince.mockReturnValue(new Promise<number>(() => {}));
      const { req } = await makeApp({
        now: () => PAGE_NOW.getTime(),
        homeReports: () =>
          renderHomeReports(deps({ identity: async () => identity })),
        homeStatus: async () => ({ stored: true, failingSince: null }) as never,
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
      expect(res.text).toContain('Organizer login');
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
  async function home(homeReports?: () => Promise<never>) {
    const { req } = await makeApp({
      now: () => PAGE_NOW.getTime(),
      homeReports,
      homeStatus: async () => ({ stored: true, failingSince: null }) as never,
    });
    const cookie = await signIn(req);
    return req.get('/dashboard/').set('Cookie', cookie);
  }

  it('shows the cards beside the welcome and organizer cards', async () => {
    const reports = () => renderHomeReports(deps());
    const res = await home(reports as never);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Welcome');
    expect(res.text).toContain('Latest reports:');
    expect(res.text).toContain('8 no-show RSVPs');
    expect(res.text).toContain('Organizer login');
    expect(res.text).toContain('OK (no failure on record)');
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
    expect(res.text).not.toContain('Latest reports:');
  });
});
