import fs from 'fs';
import nock from 'nock';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GqlMeetupClient } from '../../../src/lib/client/meetup/gqlClient.js';
import { buildHallOfFameReport } from '../../../src/lib/reports/hallOfFameReport.js';
import { fetchMonthData } from '../../../src/lib/reports/meetupMonth.js';
import { ApplicationCache } from '../../../src/util/cache.js';
import { registerAllProtectedRoutes } from '../../../src/web/routes/dashboardPages.js';
import { installMeetupResponder } from '../../fixtures/meetup/graphqlResponder.js';
import { WORLD_2026 } from '../../fixtures/meetup/world2026.js';
import { closeServers, makeApp, signIn } from '../dashboardHarness.js';
import { FakeCache } from '../fakeCache.js';
import {
  PAGE_NOW,
  SEPT,
  fakeOrganizerDeps,
  fakePageDeps,
  fakeSnapshots,
  seedRow,
} from './pageFakes.js';

// The Meetup client's cache, as in the command goldens: a fresh FakeCache.
vi.mock('../../../src/util/cache.js', () => ({ ApplicationCache: vi.fn() }));

const GOLDEN = new URL(
  '../../commands/meetup/__goldens__/hostStats-2026-09-plain.golden.txt',
  import.meta.url,
);

afterEach(async () => {
  nock.cleanAll();
  vi.useRealTimers();
  await closeServers();
});

/** The September 2026 payload from the same fixture world and clock as the command golden. */
async function fixturePayload() {
  vi.mocked(ApplicationCache).mockResolvedValue(new FakeCache() as never);
  vi.useFakeTimers({
    toFake: ['Date'],
    now: new Date('2026-10-05T17:00:00Z'),
  });
  const responder = installMeetupResponder(WORLD_2026, { maxPageSize: 2 });
  try {
    const client = new GqlMeetupClient('golden-user-token');
    const data = await fetchMonthData(client, SEPT);
    const payload = await buildHallOfFameReport(client, SEPT, data, new Date());
    expect(responder.unhandled()).toEqual([]);
    expect(responder.failures()).toEqual([]);
    return payload;
  } finally {
    nock.cleanAll();
    vi.useRealTimers();
  }
}

const unescape = (text: string) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

describe('Hall of Fame copy text against the command golden', () => {
  it('equals the ready-to-post block of the frozen /meetup_get_host_event_stats output', async () => {
    const golden = fs.readFileSync(GOLDEN, 'utf8');
    const block =
      /----- READY TO POST -----\n\n([\s\S]*?)\n--- end attachment ---/.exec(
        golden,
      )?.[1];
    expect(block).toContain('**Hall of Fame — 2026 September**');

    const payload = await fixturePayload();
    const snapshots = fakeSnapshots([seedRow('hall_of_fame', SEPT, payload)]);
    const { req } = await makeApp({
      now: () => PAGE_NOW.getTime(),
      protectedRoutes: (r) =>
        registerAllProtectedRoutes(r, {
          organizer: fakeOrganizerDeps(),
          pages: fakePageDeps({ snapshots: async () => snapshots }),
        }),
    });
    const cookie = await signIn(req);
    const res = await req
      .get('/dashboard/hall-of-fame/2026-09')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    const text =
      /<textarea id="hof-post" class="copy" readonly>([\s\S]*?)<\/textarea>/.exec(
        res.text,
      )?.[1];
    expect(unescape(text ?? '')).toBe(block);
  });
});
