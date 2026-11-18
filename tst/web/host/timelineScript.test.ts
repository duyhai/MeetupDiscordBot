/**
 * TIMELINE_SCRIPT in jsdom on the real history page: the Older link loads
 * the next chunk in place, the year rail loads up to its year and jumps,
 * and a failed load puts the link back. jsdom has no IntersectionObserver
 * (the script then waits for a click) and no layout (scrollIntoView is a
 * stub here).
 */
import express from 'express';
import { JSDOM } from 'jsdom';
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
  textContent: string | null;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  querySelector(selector: string): El | null;
  querySelectorAll(selector: string): Iterable<El>;
  dispatchEvent(event: object): boolean;
}
interface Win {
  document: El;
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

function load(page: string, fetchImpl: (url: string) => Promise<unknown>) {
  const dom = new JSDOM(page, { runScripts: 'outside-only' });
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
  };
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
