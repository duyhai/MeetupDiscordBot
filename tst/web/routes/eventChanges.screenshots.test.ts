import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { registerAllProtectedRoutes } from '../../../src/web/routes/dashboardPages.js';
import { closeServers, makeApp, signIn } from '../dashboardHarness.js';
import {
  PAGE_NOW,
  eventChangeRow,
  eventHistoryFixture,
  fakeEventAudit,
  fakeOrganizerDeps,
  fakePageDeps,
} from './pageFakes.js';

afterEach(closeServers);

/**
 * Not a test of behaviour: with SCREENSHOT_OUT set to a directory it writes
 * the Event changes list and one event's history, rendered through the real
 * router from the fixtures, as HTML files to screenshot. Skipped otherwise.
 */
const OUT = process.env.SCREENSHOT_OUT;

(OUT ? describe : describe.skip)('event changes screenshots', () => {
  it('writes the list and history pages', async () => {
    const hour = 60 * 60 * 1000;
    const at = (h: number) => new Date(PAGE_NOW.getTime() - h * hour);
    const rows = [
      eventChangeRow({
        id: 9,
        detectedAt: at(1),
        title: 'Board game night',
        rsvpYes: 23,
      }),
      eventChangeRow({
        id: 8,
        kind: 'cancelled',
        detectedAt: at(3),
        title: 'Sunset hike at Twin Peaks',
        eventId: '311000002',
        oldValue: { status: 'ACTIVE' },
        newValue: { status: 'CANCELLED' },
        hosts: [{ id: '5151', name: 'Ken' }],
        rsvpYes: 14,
        waitlist: 0,
      }),
      eventChangeRow({
        id: 7,
        kind: 'host_changed',
        detectedAt: at(5),
        title: 'Dim sum brunch',
        eventId: '311000003',
        oldValue: { hosts: [{ id: '4242', name: 'Hana' }] },
        newValue: {
          hosts: [
            { id: '4242', name: 'Hana' },
            { id: '6161', name: 'Mai' },
          ],
        },
        hosts: [
          { id: '4242', name: 'Hana' },
          { id: '6161', name: 'Mai' },
        ],
        rsvpYes: 31,
        waitlist: 6,
      }),
      eventChangeRow({
        id: 6,
        kind: 'rsvp_drop',
        detectedAt: at(8),
        title: 'Karaoke Friday',
        eventId: '311000004',
        oldValue: { rsvpYes: 20, waitlist: 2 },
        newValue: { rsvpYes: 12, waitlist: 0 },
        rsvpYes: 12,
        waitlist: 0,
      }),
      eventChangeRow({
        id: 5,
        kind: 'start_moved',
        detectedAt: at(26),
        title: 'Pickleball open play',
        eventId: '311000005',
        oldValue: { startAt: '2026-12-06T03:00:00.000Z' },
        newValue: { startAt: '2026-12-07T03:00:00.000Z' },
        startAt: new Date('2026-12-07T03:00:00Z'),
      }),
      eventChangeRow({
        id: 4,
        kind: 'created',
        detectedAt: at(30),
        title: 'Thanksgiving potluck',
        eventId: '311000006',
        oldValue: null,
        newValue: {
          title: 'Thanksgiving potluck',
          startAt: '2026-11-27T02:00:00.000Z',
          hosts: [],
        },
        rsvpYes: 0,
        waitlist: 0,
      }),
    ];
    const { req } = await makeApp({
      now: () => PAGE_NOW.getTime(),
      protectedRoutes: (r) =>
        registerAllProtectedRoutes(r, {
          organizer: fakeOrganizerDeps(),
          pages: fakePageDeps({
            eventAudit: async () =>
              fakeEventAudit(rows, { '311000001': eventHistoryFixture() }),
          }),
        }),
    });
    const cookie = await signIn(req);
    mkdirSync(OUT ?? '', { recursive: true });
    for (const [name, url] of [
      ['event-changes', '/dashboard/events'],
      ['event-history', '/dashboard/events/311000001'],
    ]) {
      // eslint-disable-next-line no-await-in-loop -- two pages
      const res = await req.get(url).set('Cookie', cookie);
      expect(res.status).toBe(200);
      writeFileSync(path.join(OUT ?? '', `${name}.html`), res.text);
    }
  });
});
