/**
 * TIMELINE_SCRIPT in jsdom on the real history page: the Older link loads
 * the next chunk in place, the year rail loads up to its year and jumps,
 * and a failed load puts the link back. jsdom has no IntersectionObserver
 * (the script then waits for a click) and no layout (scrollIntoView is a
 * stub here).
 */
import express from 'express';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HostEvent } from '../../../src/lib/hosts/hostEvents.js';
import { createHostRouter } from '../../../src/web/host/hostRouter.js';
import { registerHostPages } from '../../../src/web/host/hostPages.js';
import { TIMELINE_SCRIPT } from '../../../src/web/host/hostScripts.js';
import { clientFor, listen } from '../../setup/loopbackServer.js';
import {
  closeServers,
  makeHostDeps,
  signInWithDiscord,
} from './hostHarness.js';

afterEach(closeServers);

const NOW = new Date('2026-11-03T18:00:00Z');

interface El {
  tagName: string;
  textContent: string | null;
  focus(): void;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  querySelector(selector: string): El | null;
  querySelectorAll(selector: string): Iterable<El>;
  dispatchEvent(event: object): boolean;
}
interface Win {
  document: El & { activeElement: El | null };
  location: { search: string; href: string };
  Event: new (type: string) => object;
  eval(code: string): unknown;
  MouseEvent: new (type: string, init: object) => object;
  Element: { prototype: { scrollIntoView?: (opts?: object) => void } };
  fetch?: unknown;
}

/** n events in each year, spread over its months, newest first. */
function years(counts: Record<number, number>): HostEvent[] {
  return Object.entries(counts)
    .flatMap(([y, n]) =>
      Array.from({ length: n }, (_, i) => ({
        id: `${y}${i}`,
        title: `E${y}-${i}`,
        dateTime: `${y}-${String(12 - (i % 12)).padStart(2, '0')}-0${1 + Math.floor(i / 12)}T19:00:00-07:00`,
        eventUrl: `https://www.meetup.com/g/events/${y}${i}/`,
        type: 'social' as const,
        counted: true,
        hosts: [],
      })),
    )
    .sort((a, b) => b.dateTime.localeCompare(a.dateTime));
}

async function pages(): Promise<{ first: string; older: string }> {
  const events = years({ 2026: 12, 2025: 24, 2024: 5, 2023: 5 });
  const { deps } = makeHostDeps({
    pages: (router) =>
      registerHostPages(router, {
        events: { fetchGroupEvents: async () => events, now: () => NOW },
      }),
  });
  const app = express();
  app.use('/host', createHostRouter(deps));
  const req = clientFor(await listen(app));
  const sid = await signInWithDiscord(req);
  const first = (await req.get('/host/history').set('Cookie', sid)).text;
  const older = (
    await req.get('/host/history?year=2026&before=2025').set('Cookie', sid)
  ).text;
  return { first, older };
}

const HISTORY_URL = 'http://localhost/host/history';

function load(page: string, fetchImpl: (url: string) => Promise<unknown>) {
  // jsdom does not navigate; a navigation shows up as its "not implemented" error.
  const navigations: string[] = [];
  const virtualConsole = new VirtualConsole().on('jsdomError', (error) => {
    if (/navigation/i.test(error.message)) {
      navigations.push(error.message);
    }
  });
  const dom = new JSDOM(page, {
    runScripts: 'outside-only',
    url: HISTORY_URL,
    virtualConsole,
  });
  const window = dom.window as Win;
  const scrolled: string[] = [];
  window.Element.prototype.scrollIntoView = function scroll(this: El) {
    scrolled.push(this.getAttribute('data-year') ?? '');
  };
  const fetch = vi.fn(fetchImpl);
  window.fetch = fetch;
  const run = () => window.eval(TIMELINE_SCRIPT.value);
  const click = (el: El) =>
    el.dispatchEvent(
      new window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
      }),
    );
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return {
    window,
    document: window.document,
    run,
    click,
    settle,
    fetch,
    scrolled,
    navigations,
  };
}

/** A fetch answer the test releases when it wants. */
function deferred() {
  let release: (value: unknown) => void = () => undefined;
  const promise = new Promise((r) => {
    release = r;
  });
  return { promise, release };
}

const loadedYears = (document: El) =>
  [...document.querySelectorAll('section.tl-year')].map((s) =>
    s.getAttribute('data-year'),
  );

describe('TIMELINE_SCRIPT', () => {
  it('Older loads the next chunk in place and turns its rail links in-page', async () => {
    const { first, older } = await pages();
    const t = load(first, async () => ({ ok: true, text: async () => older }));
    t.run();
    t.run(); // the re-entry guard: one set of handlers
    expect(loadedYears(t.document)).toEqual(['2026', '2025']);
    const link = t.document.querySelector('[data-timeline-more] a');
    t.click(link);
    expect(link.textContent).toBe('Loading older events');
    await t.settle();
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(String(t.fetch.mock.calls[0][0])).toContain(
      '/host/history?year=2026&before=2025',
    );
    expect(loadedYears(t.document)).toEqual(['2026', '2025', '2024', '2023']);
    expect(t.document.querySelector('[data-timeline-more]')).toBeNull();
    // The older page's Newer link is not brought along.
    expect(t.document.querySelector('.timeline .tl-newer')).toBeNull();
    expect(
      t.document.querySelector('a[data-year="2023"]').getAttribute('href'),
    ).toBe('#y2023');
    expect(t.document.querySelector('[data-timeline-status]').textContent).toBe(
      'Loaded 2024, 2023.',
    );
    // jsdom has no layout, so every section reads as scrolled past: the
    // last one is current, and the address reopens the list there.
    expect(
      t.document
        .querySelector('a[data-year="2023"]')
        .getAttribute('aria-current'),
    ).toBe('location');
    expect(t.window.location.search).toBe('?before=2024');
  });

  it('a sign-in page (expired session) or a page without the timeline is followed natively', async () => {
    const { first } = await pages();
    for (const answer of [
      {
        ok: true,
        url: 'http://localhost/host/login',
        text: async () => '<p>Sign in</p>',
      },
      { ok: true, url: HISTORY_URL, text: async () => '<p>Something else</p>' },
    ]) {
      const t = load(first, async () => answer);
      t.run();
      t.click(t.document.querySelector('[data-timeline-more] a'));
      // eslint-disable-next-line no-await-in-loop -- one page at a time
      await t.settle();
      expect(t.navigations).toHaveLength(1);
      expect(
        t.document.querySelector('[data-timeline-status]').textContent,
      ).toBe('');
      expect(loadedYears(t.document)).toEqual(['2026', '2025']);
    }
  });

  it('one load at a time: clicks while it runs share the one fetch', async () => {
    const { first, older } = await pages();
    const gate = deferred();
    const t = load(first, () => gate.promise);
    t.run();
    const link = t.document.querySelector('[data-timeline-more] a');
    t.click(link);
    t.click(link);
    t.click(link);
    expect(t.fetch).toHaveBeenCalledTimes(1);
    gate.release({ ok: true, text: async () => older });
    await t.settle();
    expect(loadedYears(t.document)).toEqual(['2026', '2025', '2024', '2023']);
    expect(t.fetch).toHaveBeenCalledTimes(1);
  });

  it('a rail click while a load runs waits for it, then jumps', async () => {
    const { first, older } = await pages();
    const gate = deferred();
    const t = load(first, () => gate.promise);
    t.run();
    t.click(t.document.querySelector('[data-timeline-more] a'));
    t.click(t.document.querySelector('a[data-year="2023"]'));
    expect(t.scrolled).toEqual([]);
    gate.release({ ok: true, text: async () => older });
    await t.settle();
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(t.scrolled).toEqual(['2023']);
    expect(t.navigations).toHaveLength(0);
  });

  it('focus on the Older link moves to the first loaded year', async () => {
    const { first, older } = await pages();
    const t = load(first, async () => ({ ok: true, text: async () => older }));
    t.run();
    const link = t.document.querySelector('[data-timeline-more] a');
    link.focus();
    t.click(link);
    await t.settle();
    const focused = t.document.activeElement;
    expect(focused?.tagName).toBe('H3');
    expect(focused?.textContent).toBe('2024');
    expect(focused?.getAttribute('tabindex')).toBe('-1');
  });

  it('a page restored mid-load (back/forward cache) puts the link back', async () => {
    const { first, older } = await pages();
    const gate = deferred();
    let calls = 0;
    const t = load(first, () => {
      calls += 1;
      return calls === 1
        ? gate.promise
        : Promise.resolve({ ok: true, text: async () => older });
    });
    t.run();
    const link = t.document.querySelector('[data-timeline-more] a');
    const label = link.textContent;
    t.click(link);
    const shown = new t.window.Event('pageshow');
    Object.defineProperty(shown, 'persisted', { value: true });
    (t.window as unknown as El).dispatchEvent(shown);
    expect(link.textContent).toBe(label);
    expect(link.hasAttribute('aria-disabled')).toBe(false);
    // The stale answer is dropped; a new click loads afresh.
    gate.release({ ok: true, text: async () => older });
    await t.settle();
    expect(loadedYears(t.document)).toEqual(['2026', '2025']);
    t.click(link);
    await t.settle();
    expect(t.fetch).toHaveBeenCalledTimes(2);
    expect(loadedYears(t.document)).toEqual(['2026', '2025', '2024', '2023']);
  });

  it('a rail year not loaded yet loads up to it, then jumps there', async () => {
    const { first, older } = await pages();
    const t = load(first, async () => ({ ok: true, text: async () => older }));
    t.run();
    t.click(t.document.querySelector('a[data-year="2023"]'));
    await t.settle();
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(t.scrolled).toEqual(['2023']);
    // A loaded year jumps without a fetch.
    t.click(t.document.querySelector('a[data-year="2025"]'));
    expect(t.scrolled).toEqual(['2023', '2025']);
    expect(t.fetch).toHaveBeenCalledTimes(1);
  });

  it('a failed load puts the link back and says so', async () => {
    const { first } = await pages();
    const t = load(first, async () => ({ ok: false, text: async () => '' }));
    t.run();
    const link = t.document.querySelector('[data-timeline-more] a');
    const label = link.textContent;
    t.click(link);
    await t.settle();
    expect(link.textContent).toBe(label);
    expect(link.hasAttribute('aria-disabled')).toBe(false);
    expect(loadedYears(t.document)).toEqual(['2026', '2025']);
    expect(
      t.document.querySelector('[data-timeline-status]').textContent,
    ).toContain('could not be loaded');
  });
});
