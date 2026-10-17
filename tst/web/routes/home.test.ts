import { afterEach, describe, expect, it, vi } from 'vitest';

import { DashboardPageDeps } from '../../../src/web/routes/dashboardPages.js';
import { renderHomeReports } from '../../../src/web/routes/home.js';
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
    const rows = [
      ...septRows(),
      seedRow('hall_of_fame', OCT, hofPayload()),
      seedRow(
        'no_show',
        OCT,
        noShowPayload({
          attendance: {
            pastEventsWithRsvps: 6,
            eventsWithNoShow: 0,
            noShows: 0,
          },
        }),
        {
          attendance: {
            pastEventsWithRsvps: 6,
            eventsWithNoShow: 0,
            noShows: 0,
          },
        },
      ),
    ];
    rows[1] = seedRow('no_show', SEPT, noShowPayload(), {
      attendance: { pastEventsWithRsvps: 6, eventsWithNoShow: 0, noShows: 0 },
    });
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
