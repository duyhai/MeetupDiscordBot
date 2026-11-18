/**
 * CALENDAR_VIEW_SCRIPT in jsdom on real host pages: a click on a Layout
 * link stores its view, loading a page never does, and links to the bare
 * calendar (the nav tab, Home's button) carry the stored view, again after
 * a back/forward-cache restore. Storage that throws changes nothing.
 */
import express from 'express';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HostEvent } from '../../../src/lib/hosts/hostEvents.js';
import { createHostRouter } from '../../../src/web/host/hostRouter.js';
import { registerHostPages } from '../../../src/web/host/hostPages.js';
import { CALENDAR_VIEW_SCRIPT } from '../../../src/web/host/hostScripts.js';
import { clientFor, listen } from '../../setup/loopbackServer.js';
import {
  closeServers,
  makeHostDeps,
  signInWithDiscord,
} from './hostHarness.js';

const NOW = new Date('2026-11-03T18:00:00Z');
const KEY = 'host-calendar-view';
const ORIGIN = 'http://localhost';

interface El {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  querySelector(selector: string): El | null;
  querySelectorAll(selector: string): Iterable<El>;
  dispatchEvent(event: object): boolean;
  appendChild(child: El): El;
}
interface Win {
  document: El & { body: El; createElement(tag: string): El };
  eval(code: string): unknown;
  localStorage: {
    getItem(k: string): string | null;
    setItem(k: string, v: string): void;
  };
  MouseEvent: new (type: string, init: object) => object;
  Event: new (type: string) => object;
  dispatchEvent(event: object): boolean;
}

const pages: { home: string; calendar: string } = { home: '', calendar: '' };

beforeAll(async () => {
  const event: HostEvent = {
    id: '1',
    title: 'Board games',
    dateTime: '2026-11-10T19:00:00-08:00',
    eventUrl: 'https://www.meetup.com/g/events/1/',
    type: 'social',
    counted: true,
    hosts: [],
  };
  const { deps } = makeHostDeps({
    pages: (router) =>
      registerHostPages(router, {
        events: { fetchGroupEvents: async () => [event], now: () => NOW },
      }),
  });
  const app = express();
  app.use('/host', createHostRouter(deps));
  const req = clientFor(await listen(app));
  const sid = await signInWithDiscord(req);
  pages.home = (await req.get('/host').set('Cookie', sid)).text;
  pages.calendar = (
    await req.get('/host/calendar?month=2026-11&view=tiles').set('Cookie', sid)
  ).text;
});
afterAll(closeServers);

function load(
  page: string,
  url: string,
  setup: (window: Win) => void = () => undefined,
) {
  // jsdom does not navigate: a followed link is a "not implemented" error.
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(page, {
    runScripts: 'outside-only',
    url,
    virtualConsole,
  });
  const window = dom.window as Win;
  setup(window);
  const doc = window.document;
  const hrefs = (selector: string) =>
    [...doc.querySelectorAll(selector)].map((a) => a.getAttribute('href'));
  return {
    window,
    doc,
    hrefs,
    run: () => window.eval(CALENDAR_VIEW_SCRIPT.value),
    click: (el: El, button = 0) =>
      el.dispatchEvent(
        new window.MouseEvent(button === 0 ? 'click' : 'auxclick', {
          bubbles: true,
          cancelable: true,
          button,
        }),
      ),
  };
}

const navCalendar = 'nav.site a[href^="/host/calendar"]';

describe('CALENDAR_VIEW_SCRIPT', () => {
  it('is on every signed-in host page, once', () => {
    for (const page of [pages.home, pages.calendar]) {
      expect(page.split('window.__hostCalendarView=1').length).toBe(2);
    }
  });

  it('stores the view of a clicked Layout link, any mouse button', () => {
    const t = load(pages.calendar, `${ORIGIN}/host/calendar?view=tiles`);
    t.run();
    expect(t.window.localStorage.getItem(KEY)).toBeNull();
    const list = t.doc.querySelector('[data-cal-views] a');
    expect(list?.getAttribute('href')).toContain('view=list');
    t.click(list);
    expect(t.window.localStorage.getItem(KEY)).toBe('list');
    // A middle click (new tab) counts too.
    const u = load(pages.calendar, `${ORIGIN}/host/calendar?view=tiles`);
    u.run();
    u.click(u.doc.querySelector('[data-cal-views] a'), 1);
    expect(u.window.localStorage.getItem(KEY)).toBe('list');
    // Other links store nothing.
    const v = load(pages.calendar, `${ORIGIN}/host/calendar`);
    v.run();
    v.click(v.doc.querySelector('nav[aria-label="Which days"] a'));
    expect(v.window.localStorage.getItem(KEY)).toBeNull();
  });

  it('a page loaded with ?view=tiles does not overwrite a stored List', () => {
    const t = load(pages.calendar, `${ORIGIN}/host/calendar?view=tiles`, (w) =>
      w.localStorage.setItem(KEY, 'list'),
    );
    t.run();
    expect(t.window.localStorage.getItem(KEY)).toBe('list');
  });

  it('points the nav tab and Home’s button at the stored view, leaving other links alone', () => {
    const t = load(pages.home, `${ORIGIN}/host`, (w) =>
      w.localStorage.setItem(KEY, 'list'),
    );
    // A bare link with a hash, and one with its own query.
    const extra = t.doc.createElement('a');
    extra.setAttribute('href', '/host/calendar#day');
    t.doc.body.appendChild(extra);
    const other = t.doc.createElement('a');
    other.setAttribute('href', '/host/calendar?month=2026-12');
    t.doc.body.appendChild(other);
    expect(t.hrefs(navCalendar)).toEqual(['/host/calendar']);
    expect(t.hrefs('main a[href^="/host/calendar"]')).toEqual([
      '/host/calendar',
    ]);
    t.run();
    expect(t.hrefs(navCalendar)).toEqual(['/host/calendar?view=list']);
    expect(t.hrefs('main a[href^="/host/calendar"]')).toEqual([
      '/host/calendar?view=list',
    ]);
    expect(extra.getAttribute('href')).toBe('/host/calendar?view=list#day');
    expect(other.getAttribute('href')).toBe('/host/calendar?month=2026-12');
    // Other pages' links are untouched.
    expect(t.hrefs('nav.site a[href="/host/history"]')).toEqual([
      '/host/history',
    ]);
  });

  it('leaves in-page links alone on the bare calendar page', () => {
    const t = load(pages.calendar, `${ORIGIN}/host/calendar`, (w) =>
      w.localStorage.setItem(KEY, 'list'),
    );
    const skip = t.doc.querySelector('a.skip');
    expect(skip?.getAttribute('href')).toBe('#main');
    const empty = t.doc.createElement('a');
    empty.setAttribute('href', '');
    t.doc.body.appendChild(empty);
    t.run();
    expect(skip?.getAttribute('href')).toBe('#main');
    expect(empty.getAttribute('href')).toBe('');
    expect(t.hrefs(navCalendar)).toEqual(['/host/calendar?view=list']);
  });

  it('a right click on a Layout link stores nothing', () => {
    const t = load(pages.calendar, `${ORIGIN}/host/calendar?view=tiles`);
    t.run();
    t.click(t.doc.querySelector('[data-cal-views] a'), 2);
    expect(t.window.localStorage.getItem(KEY)).toBeNull();
  });

  it('rewrites again after a back/forward-cache restore, and runs once', () => {
    const t = load(pages.home, `${ORIGIN}/host`, (w) =>
      w.localStorage.setItem(KEY, 'list'),
    );
    t.run();
    t.run();
    expect(t.hrefs(navCalendar)).toEqual(['/host/calendar?view=list']);
    t.window.localStorage.setItem(KEY, 'tiles');
    const restored = new t.window.Event('pageshow');
    Object.defineProperty(restored, 'persisted', { value: true });
    t.window.dispatchEvent(restored);
    expect(t.hrefs(navCalendar)).toEqual(['/host/calendar?view=tiles']);
    // A plain load event (not from the cache) does nothing.
    t.window.localStorage.setItem(KEY, 'list');
    t.window.dispatchEvent(new t.window.Event('pageshow'));
    expect(t.hrefs(navCalendar)).toEqual(['/host/calendar?view=tiles']);
  });

  it('leaves links alone when nothing or something odd is stored', () => {
    for (const stored of [undefined, 'LIST', 'grid']) {
      const t = load(pages.home, `${ORIGIN}/host`, (w) => {
        if (stored !== undefined) {
          w.localStorage.setItem(KEY, stored);
        }
      });
      t.run();
      expect(t.hrefs(navCalendar)).toEqual(['/host/calendar']);
    }
  });

  it('changes nothing, and does not throw, when storage throws', () => {
    const t = load(pages.calendar, `${ORIGIN}/host/calendar`, (w) =>
      Object.defineProperty(w, 'localStorage', {
        get() {
          throw new Error('SecurityError');
        },
      }),
    );
    expect(() => t.window.localStorage).toThrow('SecurityError');
    expect(() => t.run()).not.toThrow();
    expect(t.hrefs(navCalendar)).toEqual(['/host/calendar']);
    expect(() =>
      t.click(t.doc.querySelector('[data-cal-views] a')),
    ).not.toThrow();
  });
});
