import { afterEach, describe, expect, it, vi } from 'vitest';

import { EventAuditRequestResult } from '../../../src/lib/eventAudit/job.js';
import { EventChange } from '../../../src/lib/eventAudit/types.js';
import { registerAllProtectedRoutes } from '../../../src/web/routes/dashboardPages.js';
import { SNAPSHOT_MESSAGES } from '../../../src/web/routes/eventChanges.js';
import {
  Client,
  ORIGIN,
  USER,
  closeServers,
  makeApp,
  signIn,
} from '../dashboardHarness.js';
import {
  PAGE_NOW,
  eventChangeRow,
  eventHistoryFixture,
  fakeEventAudit,
  fakeOrganizerDeps,
  fakePageDeps,
} from './pageFakes.js';

afterEach(() => {
  vi.restoreAllMocks();
  return closeServers();
});

const PAGE = '/dashboard/events';
const SNAPSHOT = '/dashboard/events/snapshot';
const HOSTILE = '<script>alert(1)</script>"><img src=x>';

async function tokenOf(req: Client, cookie: string): Promise<string> {
  const home = await req.get('/dashboard').set('Cookie', cookie);
  const match = /name="_csrf" value="([^"]+)"/.exec(home.text);
  if (!match) {
    throw new Error('home page has no CSRF field');
  }
  return match[1];
}

async function setup(
  options: {
    changes?: EventChange[];
    snapshot?: EventAuditRequestResult | { status: 'unavailable' } | Error;
    broken?: boolean;
  } = {},
) {
  const audit = fakeEventAudit(options.changes ?? [eventChangeRow()], {
    '311000001': eventHistoryFixture(),
  });
  const snapshotNow = vi.fn(async () => {
    if (options.snapshot instanceof Error) {
      throw options.snapshot;
    }
    return (
      options.snapshot ?? {
        status: 'started' as const,
        done: Promise.resolve({
          ok: true as const,
          listed: 1,
          confirmed: 0,
          changes: 0,
          deleted: 0,
          durationMs: 1,
        }),
      }
    );
  });
  const { req } = await makeApp({
    now: () => PAGE_NOW.getTime(),
    protectedRoutes: (r) =>
      registerAllProtectedRoutes(r, {
        organizer: fakeOrganizerDeps(),
        pages: fakePageDeps({
          eventAudit: options.broken
            ? () => Promise.reject(new Error('pg down'))
            : async () => audit,
          snapshotNow,
        }),
      }),
  });
  const cookie = await signIn(req);
  const token = await tokenOf(req, cookie);
  const get = (path: string) => req.get(path).set('Cookie', cookie);
  const post = (path = SNAPSHOT) =>
    req
      .post(path)
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: token });
  return { audit, snapshotNow, get, post };
}

const resultOf = (location: string | undefined) =>
  new URL(location ?? '', 'http://x').searchParams.get('result');

describe('Event changes page', () => {
  it('lists changes newest first, escaped, with Meetup, history and host filter links', async () => {
    const { get } = await setup({
      changes: [
        eventChangeRow({
          id: 2,
          title: HOSTILE,
          hosts: [{ id: '4242', name: HOSTILE }],
        }),
        eventChangeRow({
          id: 1,
          kind: 'cancelled',
          eventUrl: null,
          oldValue: { status: 'ACTIVE' },
          newValue: { status: 'CANCELLED' },
        }),
      ],
    });
    const res = await get(PAGE);
    expect(res.status).toBe(200);
    expect(res.text).toContain('aria-current="page">Event changes');
    expect(res.text).not.toContain('<script>alert');
    expect(res.text).not.toContain('<img src=x>');
    expect(res.text).toContain('&lt;script&gt;');
    expect(res.text).toContain(
      'href="https://www.meetup.com/g/events/311000001/"',
    );
    expect(res.text).toContain('href="/dashboard/events/311000001"');
    expect(res.text).toContain('href="/dashboard/events?host=4242"');
    expect(res.text).toContain('Deleted');
    expect(res.text).toContain('Cancelled');
    expect(res.text).toContain('Last snapshot:');
    expect(res.text).toContain('Snapshot now');
    // Newest first (the badges, not the filter's options).
    const deleted = res.text.search(/badge attn"\s*>\s*Deleted/);
    const cancelled = res.text.search(/badge attn"\s*>\s*Cancelled/);
    expect(deleted).toBeGreaterThan(0);
    expect(deleted).toBeLessThan(cancelled);
  });

  it('passes validated filters to the store and ignores anything else', async () => {
    const { get, audit } = await setup();
    await get(
      `${PAGE}?kind=deleted&host=4242&from=2026-10-01&to=2026-10-05&before=12`,
    );
    expect(audit.listChanges).toHaveBeenLastCalledWith(
      {
        kind: 'deleted',
        hostId: '4242',
        from: new Date('2026-10-01T07:00:00.000Z'),
        to: new Date('2026-10-06T07:00:00.000Z'),
        beforeId: 12,
      },
      50,
    );
    await get(`${PAGE}?kind=nope&host=abc&from=2026-02-30&before=x`);
    expect(audit.listChanges).toHaveBeenLastCalledWith({}, 50);
    const res = await get(
      `${PAGE}?kind=nope&host=${encodeURIComponent(HOSTILE)}`,
    );
    expect(res.text).not.toContain('<script>alert');
  });

  it('a full page links to older changes, keeping the filters', async () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      eventChangeRow({ id: 100 - i }),
    );
    const { get } = await setup({ changes: rows });
    const res = await get(`${PAGE}?kind=deleted`);
    expect(res.text).toContain(
      'href="/dashboard/events?kind=deleted&amp;before=51"',
    );
    const short = await (await setup()).get(PAGE);
    expect(short.text).not.toContain('Older changes');
  });

  it('shows the result notice in fixed text only', async () => {
    const { get } = await setup();
    for (const [code, text] of Object.entries(SNAPSHOT_MESSAGES)) {
      // eslint-disable-next-line no-await-in-loop -- one request per code
      const res = await get(`${PAGE}?result=${code}`);
      expect(res.text).toContain(text);
    }
    const other = await get(`${PAGE}?result=${encodeURIComponent(HOSTILE)}`);
    expect(other.text).not.toContain('<script>alert');
  });

  it('a row with no readable hosts and no URL renders plainly, never a link', async () => {
    const { get } = await setup({
      changes: [
        eventChangeRow({ hosts: [], eventUrl: null, title: 'Mystery' }),
      ],
    });
    const res = await get(PAGE);
    expect(res.status).toBe(200);
    expect(res.text).toContain('unknown hosts');
    expect(res.text).toContain('Mystery');
    expect(res.text).not.toContain('href="https://www.meetup.com');
  });

  it('names events whose deletion could not be confirmed for three runs', async () => {
    const history = eventHistoryFixture();
    const audit = fakeEventAudit([eventChangeRow()], {}, undefined, [
      {
        ...history.state,
        unconfirmedRuns: 4,
        latest: { ...history.state.latest, title: HOSTILE },
      },
    ]);
    const { req } = await makeApp({
      now: () => PAGE_NOW.getTime(),
      protectedRoutes: (r) =>
        registerAllProtectedRoutes(r, {
          organizer: fakeOrganizerDeps(),
          pages: fakePageDeps({ eventAudit: async () => audit }),
        }),
    });
    const cookie = await signIn(req);
    const res = await req.get(PAGE).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('One event has');
    expect(res.text).toContain('(4 runs)');
    expect(res.text).not.toContain('<script>alert');
    expect(audit.unconfirmable).toHaveBeenCalledWith(3, PAGE_NOW);
  });

  it('is the 503 page when the store cannot answer', async () => {
    const { get } = await setup({ broken: true });
    const res = await get(PAGE);
    expect(res.status).toBe(503);
  });

  it('the event history page shows the latest snapshot, changes and snapshots; unknown ids are 404', async () => {
    const { get } = await setup();
    const res = await get('/dashboard/events/311000001');
    expect(res.status).toBe(200);
    expect(res.text).toContain('aria-current="page">Event changes');
    expect(res.text).toContain('Board games');
    expect(res.text).toContain('Hana');
    expect(res.text).toContain('Hosts changed');
    expect(res.text).toContain('<h2>Snapshots');
    expect((await get('/dashboard/events/999')).status).toBe(404);
    expect((await get('/dashboard/events/abc')).status).toBe(404);
  });

  it('Snapshot now asks the job as the signed-in member and redirects with the code', async () => {
    const { post, snapshotNow } = await setup();
    const res = await post();
    expect(res.status).toBe(303);
    expect(resultOf(res.headers.location)).toBe('started');
    expect(snapshotNow).toHaveBeenCalledWith(USER.id);
    const busy = await (await setup({ snapshot: { status: 'busy' } })).post();
    expect(resultOf(busy.headers.location)).toBe('busy');
    const down = await (
      await setup({ snapshot: { status: 'unavailable' } })
    ).post();
    expect(resultOf(down.headers.location)).toBe('unavailable');
    const broken = await (await setup({ snapshot: new Error('redis') })).post();
    expect(resultOf(broken.headers.location)).toBe('error');
  });
});
