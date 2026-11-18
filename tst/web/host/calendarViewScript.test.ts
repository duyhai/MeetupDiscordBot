/**
 * CALENDAR_VIEW_SCRIPT in jsdom on the real calendar page: a page that
 * names its view stores it, one that does not reopens with the stored
 * List, and storage that is missing or throws changes nothing. jsdom does
 * not navigate; location.replace shows up as its "not implemented" error.
 */
import express from 'express';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

import { createHostRouter } from '../../../src/web/host/hostRouter.js';
import { registerHostPages } from '../../../src/web/host/hostPages.js';
import { CALENDAR_VIEW_SCRIPT } from '../../../src/web/host/hostScripts.js';
import { clientFor, listen } from '../../setup/loopbackServer.js';
import {
  closeServers,
  makeHostDeps,
  signInWithDiscord,
} from './hostHarness.js';

afterEach(closeServers);

const NOW = new Date('2026-11-03T18:00:00Z');
const KEY = 'host-calendar-view';

interface Win {
  eval(code: string): unknown;
  localStorage: {
    getItem(k: string): string | null;
    setItem(k: string, v: string): void;
  };
}

async function calendarPage(): Promise<string> {
  const { deps } = makeHostDeps({
    pages: (router) =>
      registerHostPages(router, {
        events: { fetchGroupEvents: async () => [], now: () => NOW },
      }),
  });
  const app = express();
  app.use('/host', createHostRouter(deps));
  const req = clientFor(await listen(app));
  const sid = await signInWithDiscord(req);
  return (await req.get('/host/calendar').set('Cookie', sid)).text;
}

function load(
  page: string,
  url: string,
  setup: (window: Win) => void = () => undefined,
) {
  const navigations: string[] = [];
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole().on('jsdomError', (error) => {
    (/navigation/i.test(error.message) ? navigations : errors).push(
      error.message,
    );
  });
  const dom = new JSDOM(page, {
    runScripts: 'outside-only',
    url,
    virtualConsole,
  });
  const window = dom.window as Win;
  setup(window);
  return {
    window,
    run: () => window.eval(CALENDAR_VIEW_SCRIPT.value),
    navigations,
    errors,
  };
}

const AT = 'http://localhost/host/calendar';

describe('CALENDAR_VIEW_SCRIPT', () => {
  it('stores the view a page names, and does not navigate', async () => {
    const page = await calendarPage();
    for (const view of ['list', 'tiles']) {
      const t = load(page, `${AT}?month=2026-11&view=${view}`);
      t.run();
      expect(t.window.localStorage.getItem(KEY)).toBe(view);
      expect(t.navigations).toHaveLength(0);
    }
  });

  it('reopens a page without ?view= as List when List is stored, once', async () => {
    const page = await calendarPage();
    const t = load(page, `${AT}?month=2026-12`, (w) =>
      w.localStorage.setItem(KEY, 'list'),
    );
    t.run();
    t.run();
    expect(t.navigations).toHaveLength(1);
    expect(t.errors).toEqual([]);
  });

  it('leaves the default alone when Tiles or nothing is stored', async () => {
    const page = await calendarPage();
    for (const stored of ['tiles', undefined, 'bogus']) {
      const t = load(page, AT, (w) => {
        if (stored !== undefined) {
          w.localStorage.setItem(KEY, stored);
        }
      });
      t.run();
      expect(t.navigations).toHaveLength(0);
    }
  });

  it('changes nothing when storage throws', async () => {
    const page = await calendarPage();
    for (const url of [AT, `${AT}?view=list`]) {
      const t = load(page, url, (w) =>
        Object.defineProperty(w, 'localStorage', {
          get() {
            throw new Error('SecurityError');
          },
        }),
      );
      expect(() => t.window.localStorage).toThrow('SecurityError');
      expect(() => t.run()).not.toThrow();
      expect(t.navigations).toHaveLength(0);
    }
  });

  it('does nothing on a page without the layout switch', () => {
    const t = load('<main><p>Not the calendar</p></main>', AT, (w) =>
      w.localStorage.setItem(KEY, 'list'),
    );
    t.run();
    expect(t.navigations).toHaveLength(0);
  });
});
