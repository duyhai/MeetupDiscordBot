/**
 * KIT_SCRIPT in a real DOM (jsdom) on the real month page markup: the
 * stubs in kitScript.test.ts check each branch; this checks they add up.
 * jsdom has no top layer, so a small showModal/close polyfill stands in,
 * and Esc is the browser's own cancel (the polyfill closes on it, as a
 * browser does); what the kit does on close is the kit's.
 */
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { html, localUrl } from '../../../src/web/html.js';
import { copyButton, copyText } from '../../../src/web/ui/copy.js';
import { modal } from '../../../src/web/ui/modal.js';
import { KIT_SCRIPT } from '../../../src/web/ui/script.js';
import { registerAllProtectedRoutes } from '../../../src/web/routes/dashboardPages.js';
import { closeServers, makeApp, signIn } from '../dashboardHarness.js';
import {
  SEPT,
  fakeBans,
  fakeOrganizerDeps,
  fakePageDeps,
  fakeSnapshots,
  fakeSuspensions,
  fakeWorkspace,
  fakeWorkspaceActions,
  noShowPayload,
  seedRow,
  suspensionRecord,
  workspaceRow,
} from '../routes/pageFakes.js';

/*
 * The DOM as this test uses it: structural types, since the project has no
 * DOM lib (see tst/types/jsdom.d.ts).
 */
interface El {
  tagName: string;
  textContent: string | null;
  className: string;
  type: string;
  method: string;
  disabled: boolean;
  value: string;
  required: boolean;
  maxLength: number;
  ownerDocument: Document;
  previousElementSibling: El | null;
  nextElementSibling: El | null;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  querySelector<T extends El = El>(selector: string): T | null;
  querySelectorAll<T extends El = El>(selector: string): T[];
  closest(selector: string): El | null;
  click(): void;
  focus(): void;
  dispatchEvent(event: object): boolean;
}
type HTMLElement = El;
type HTMLButtonElement = El;
interface HTMLDialogElement extends El {
  showModal(): void;
  close(): void;
}
interface Document {
  activeElement: El | null;
  readyState: string;
  defaultView: Win | null;
  querySelectorAll<T extends El = El>(selector: string): T[];
  getElementById(id: string): El | null;
  addEventListener(type: string, fn: (event: { key?: string }) => void): void;
  dispatchEvent(event: object): boolean;
}
interface Win {
  document: Document;
  addEventListener(type: string, fn: (value?: unknown) => void): void;
  navigator: object;
  eval(code: string): unknown;
  Event: new (type: string) => object;
  KeyboardEvent: new (
    type: string,
    init: { key: string; bubbles?: boolean },
  ) => object;
  MouseEvent: new (type: string, init: { bubbles: boolean }) => object;
  setTimeout(fn: (value?: unknown) => void, ms: number): number;
  HTMLDialogElement: { prototype: object };
  FormData: new (form: El) => {
    get(name: string): unknown;
    has(name: string): boolean;
  };
  dispatchEvent(event: object): boolean;
}

afterEach(() => {
  vi.restoreAllMocks();
  return closeServers();
});

const OCT_17 = new Date('2026-10-17T16:00:00Z');

/** The September month page with one suspended card, as a Leadership member sees it. */
async function monthPage(
  path = '/dashboard/no-shows/2026-09',
): Promise<string> {
  const ws = fakeWorkspace({
    rows: [
      workspaceRow({
        id: 2,
        memberId: '2001',
        memberName: 'Member 1',
        classification: 'suspension',
        status: 'suspended',
        suspensionRecordId: 31,
        version: 7,
      }),
    ],
    months: [
      {
        period: SEPT,
        snapshotId: 41,
        snapshotBuiltAt: new Date('2026-10-01T15:00:00Z'),
        syncedAt: new Date('2026-10-01T16:00:00Z'),
      },
    ],
    events: [],
  });
  const snaps = fakeSnapshots([
    seedRow('no_show', SEPT, noShowPayload(), {
      id: 41,
      builtAt: new Date('2026-10-01T15:00:00Z'),
    }),
  ]);
  const susp = fakeSuspensions(
    {},
    [],
    [
      suspensionRecord({
        id: 31,
        memberId: '2001',
        suspendedAt: new Date('2026-09-20T00:00:00Z'),
        durationDays: 30,
      }),
    ],
  );
  const { req } = await makeApp({
    now: () => OCT_17.getTime(),
    protectedRoutes: (r) =>
      registerAllProtectedRoutes(r, {
        organizer: fakeOrganizerDeps(),
        pages: fakePageDeps({
          now: () => OCT_17,
          workspace: async () => ws,
          snapshots: async () => snaps,
          suspensions: async () => susp,
          upcoming: async () => new Map(),
          isLeadership: vi.fn(async () => true),
          workspaceActions: fakeWorkspaceActions(),
          bans: async () => fakeBans({ active: [] }),
        }),
      }),
  });
  const cookie = await signIn(req);
  const res = await req.get(path).set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.text;
}

/** The page in jsdom (its own scripts never run), with the dialog polyfill and a clipboard. */
function load(page: string, url?: string) {
  const dom = new JSDOM(page, {
    runScripts: 'outside-only',
    ...(url === undefined ? {} : { url }),
  });
  const window = dom.window as Win;
  const proto = window.HTMLDialogElement.prototype as unknown as {
    showModal: () => void;
    close: () => void;
  };
  proto.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
    const first = this.querySelector<HTMLElement>(
      'textarea, button, input:not([type=hidden])',
    );
    first?.focus();
  };
  proto.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute('open')) {
      return;
    }
    this.removeAttribute('open');
    this.dispatchEvent(new window.Event('close'));
  };
  window.document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      window.document
        .querySelectorAll('dialog[open]')
        .forEach((d) => (d as HTMLDialogElement).close());
    }
  });
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
  const run = () => window.eval(KIT_SCRIPT.value);
  return { window, document: window.document, run, writeText };
}

const trigger = (document: Document, label: string) => {
  const found = [...document.querySelectorAll('button')].filter(
    (b) => b.textContent?.trim() === label && b.hasAttribute('aria-haspopup'),
  );
  expect(found).toHaveLength(1);
  return found[0];
};

const settle = () =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

describe('KIT_SCRIPT in a real DOM', () => {
  it('moves each dialog out of its details, labelled by its title', async () => {
    const { document, run } = load(await monthPage());
    expect(document.querySelectorAll('details[data-modal]').length).toBe(3);
    run();
    expect(document.querySelectorAll('details[data-modal]').length).toBe(0);
    const dialogs = [...document.querySelectorAll('dialog')];
    expect(dialogs).toHaveLength(3);
    for (const d of dialogs) {
      expect(d.closest('details[data-modal]')).toBeNull();
      const title = document.getElementById(
        d.getAttribute('aria-labelledby') ?? '',
      );
      expect(title?.closest('dialog')).toBe(d);
      expect(title?.hasAttribute('data-modal-title')).toBe(true);
      // The trigger button sits right before its dialog.
      const b = d.previousElementSibling;
      expect(b.tagName).toBe('BUTTON');
      expect(b.type).toBe('button');
      expect(b.getAttribute('aria-haspopup')).toBe('dialog');
    }
  });

  it('the trigger button keeps the summary’s hover hint, and gets none without one', () => {
    const page = `<!doctype html><body><main>${
      modal({
        trigger: { label: 'Hinted', hint: 'Why "this" & that' },
        title: 'A',
        body: html`<p>a</p>`,
      }).value
    }${
      modal({ trigger: { label: 'Plain' }, title: 'B', body: html`<p>b</p>` })
        .value
    }</main></body>`;
    const { document, run } = load(page);
    run();
    expect(trigger(document, 'Hinted').getAttribute('title')).toBe(
      'Why "this" & that',
    );
    expect(trigger(document, 'Plain').hasAttribute('title')).toBe(false);
  });

  it('Void suspension: the moved form carries _csrf, version, action and note', async () => {
    const { document, run } = load(await monthPage());
    run();
    const b = trigger(document, 'Void suspension');
    expect(b.className).toBe('button danger');
    const d = b.nextElementSibling as HTMLDialogElement;
    expect(d.tagName).toBe('DIALOG');
    const form = d.querySelector('form');
    expect(form?.method).toBe('post');
    expect(form?.getAttribute('action')).toBe(
      '/dashboard/no-shows/2026-09/rows/2',
    );
    const data = new form.ownerDocument.defaultView.FormData(form);
    expect(data.get('_csrf')).toMatch(/.+/);
    expect(data.get('version')).toBe('7');
    expect(data.get('action')).toBe('void');
    expect(data.has('note')).toBe(true);
    const note = form.querySelector('textarea[name=note]');
    expect(note.required).toBe(true);
    expect(note.maxLength).toBe(500);
    expect(form.querySelector('button[type=submit]')?.textContent?.trim()).toBe(
      'Void this suspension',
    );
  });

  it('Esc and Cancel close it, and focus returns to the trigger', async () => {
    const { window, document, run } = load(await monthPage());
    run();
    const b = trigger(document, 'Void suspension');
    const d = b.nextElementSibling as HTMLDialogElement;
    b.focus();
    b.click();
    expect(d.hasAttribute('open')).toBe(true);
    expect(document.activeElement?.tagName).toBe('TEXTAREA');
    document.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Escape' }),
    );
    expect(d.hasAttribute('open')).toBe(false);
    expect(document.activeElement).toBe(b);

    b.click();
    expect(d.hasAttribute('open')).toBe(true);
    const cancel = d.querySelector<HTMLButtonElement>('[data-modal-close]');
    expect(cancel?.textContent?.trim()).toBe('Cancel');
    cancel.click();
    expect(d.hasAttribute('open')).toBe(false);
    expect(document.activeElement).toBe(b);
  });

  it('a dialog with a textarea ignores backdrop clicks; typed text stays', async () => {
    const { window, document, run } = load(await monthPage());
    run();
    const b = trigger(document, 'Void suspension');
    const d = b.nextElementSibling as HTMLDialogElement;
    b.click();
    const note = d.querySelector('textarea');
    note.value = 'recorded twice';
    d.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }));
    d.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(d.hasAttribute('open')).toBe(true);
    expect(note.value).toBe('recorded twice');
  });

  it('closing the message dialog puts the copy label back', async () => {
    const { document, run, writeText } = load(await monthPage());
    run();
    const b = trigger(document, 'Suspension message');
    const d = b.nextElementSibling as HTMLDialogElement;
    b.click();
    const copy = d.querySelector<HTMLButtonElement>('button[data-copy]');
    expect(copy.textContent).toBe('Copy message');
    copy.click();
    await settle();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(copy.textContent).toBe('Copied');
    d.querySelector<HTMLButtonElement>('[data-modal-close]').click();
    expect(copy.textContent).toBe('Copy message');
  });

  it('a back/forward cache restore closes dialogs and re-enables copy buttons', async () => {
    const { window, document, run } = load(await monthPage());
    run();
    const b = trigger(document, 'Suspension message');
    const d = b.nextElementSibling as HTMLDialogElement;
    b.click();
    const copy = d.querySelector<HTMLButtonElement>('button[data-copy]');
    // As after copy-then-submit: disabled while the page navigated away.
    copy.disabled = true;
    copy.textContent = 'Copied';
    const notRestored = new window.Event('pageshow');
    window.dispatchEvent(notRestored);
    expect(d.hasAttribute('open')).toBe(true);
    const restored = new window.Event('pageshow');
    Object.defineProperty(restored, 'persisted', { value: true });
    window.dispatchEvent(restored);
    expect(d.hasAttribute('open')).toBe(false);
    expect(copy.disabled).toBe(false);
    expect(copy.textContent).toBe('Copy message');
  });

  it('running twice wires nothing twice', async () => {
    const { document, run, writeText } = load(await monthPage());
    run();
    run();
    const b = trigger(document, 'Suspension message');
    b.click();
    const copy = (
      b.nextElementSibling as HTMLDialogElement
    ).querySelector<HTMLButtonElement>('button[data-copy]');
    copy.click();
    await settle();
    expect(writeText).toHaveBeenCalledTimes(1);
  });
});

/** A bare page holding `body`, loaded like `load` (dialog polyfill, Esc, clipboard). */
function bare(body: string) {
  return load(`<!doctype html><html><body><main>${body}</main></body></html>`);
}

describe('KIT_SCRIPT in a real DOM: #159 review hardening', () => {
  it('Esc while the clipboard write is pending: the copy-then-submit form is never sent', async () => {
    const markup = modal({
      trigger: { label: 'Send warning', tone: 'primary' },
      title: 'Warning',
      body: html`<form
        method="post"
        action="${localUrl('/dashboard/x')}"
        data-copy-box
      >
        ${copyText('Hello')}${copyButton({ label: 'Copy warning', target: 'near', thenSubmit: true })}
      </form>`,
    }).value;
    const { window, document, run, writeText } = bare(markup);
    let resolveWrite: () => void = () => undefined;
    writeText.mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          resolveWrite = () => resolve(undefined);
        }),
    );
    const submit = vi.fn();
    (
      window as unknown as {
        HTMLFormElement: { prototype: { submit: () => void } };
      }
    ).HTMLFormElement.prototype.submit = submit;
    run();
    const b = trigger(document, 'Send warning');
    const d = b.nextElementSibling as HTMLDialogElement;
    b.click();
    const copy = d.querySelector<HTMLButtonElement>('button[data-copy]');
    copy.click();
    expect(writeText).toHaveBeenCalledTimes(1);
    document.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Escape' }),
    );
    expect(d.hasAttribute('open')).toBe(false);
    resolveWrite();
    await settle();
    expect(submit).not.toHaveBeenCalled();
    expect(copy.disabled).toBe(false);
    expect(copy.textContent).toBe('Copy warning');
  });

  it('no textarea: a press on the backdrop released inside the box keeps it open; one released on the backdrop closes it', () => {
    const markup = modal({
      trigger: { label: 'Details' },
      title: 'Details',
      body: html`<p>Read only.</p>`,
    }).value;
    const { window, document, run } = bare(markup);
    run();
    const b = trigger(document, 'Details');
    const d = b.nextElementSibling as HTMLDialogElement;
    const box = d.querySelector('.ui-dialog-box');
    const fire = (target: El, type: string) =>
      target.dispatchEvent(new window.MouseEvent(type, { bubbles: true }));
    b.click();
    // Pressed on the backdrop, let go on the box: the click's target is the
    // dialog (their common ancestor), as in a browser.
    fire(d, 'pointerdown');
    fire(box, 'pointerup');
    fire(d, 'click');
    expect(d.hasAttribute('open')).toBe(true);
    fire(d, 'pointerdown');
    fire(d, 'pointerup');
    fire(d, 'click');
    expect(d.hasAttribute('open')).toBe(false);
    expect(document.activeElement).toBe(b);
  });
});

describe('KIT_SCRIPT in a real DOM: the nav accordion', () => {
  const groups = (document: Document) =>
    document.querySelectorAll<El & { open: boolean }>(
      'nav.site details[data-nav-group]',
    );

  it('the page renders the current page’s group open; opening another closes it', async () => {
    const { window, document, run } = load(await monthPage());
    run();
    const all = [...groups(document)];
    expect(all.map((g) => g.querySelector('summary')?.textContent)).toEqual([
      'Member moderation',
      'Hosts & events',
      'Analytics',
      'Settings',
    ]);
    expect(all.map((g) => g.open)).toEqual([true, false, false, false]);
    expect(all[0].querySelector('[aria-current="page"]')?.textContent).toBe(
      'Workspace',
    );
    // The parse-time toggle of the open group (browsers fire one too) runs
    // first, and changes nothing: no other group is open.
    await new Promise((r) => {
      window.setTimeout(r, 0);
    });
    expect(all.map((g) => g.open)).toEqual([true, false, false, false]);
    // As a summary press does: the browser sets open, and its toggle event
    // follows asynchronously (jsdom fires it too, but has no summary
    // activation behaviour).
    all[2].open = true;
    await new Promise((r) => {
      window.setTimeout(r, 0);
    });
    expect(all.map((g) => g.open)).toEqual([false, false, true, false]);
  });

  it('keyboard: Esc in an open group closes it and puts focus on its summary', async () => {
    const { window, document, run } = load(await monthPage());
    run();
    const [noShows] = [...groups(document)];
    const link = noShows.querySelector('a');
    link.focus();
    link.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(noShows.open).toBe(false);
    expect(document.activeElement).toBe(noShows.querySelector('summary'));
  });
});

describe('KIT_SCRIPT in a real DOM: back on the acted card, where it was', () => {
  const PATH = '/dashboard/no-shows/2026-09';
  const MONTH = `http://localhost${PATH}`;
  const LANDING = `${MONTH}?result=done&row=2#acted`;
  const KEY = 'ui-keep-place';
  interface Storage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
  }
  type Landing = Win & {
    sessionStorage: Storage;
    scrollBy: (x: number, y: number) => void;
  };
  const submitEvent = (window: Win) =>
    new (
      window as unknown as { Event: new (t: string, i: object) => object }
    ).Event('submit', { bubbles: true, cancelable: true });
  /** A place saved for row 2 on the September page, 300px down, two seconds ago. */
  const place = (extra: object = {}) => ({
    p: PATH,
    r: '2',
    t: 300,
    at: Date.now() - 2_000,
    ...extra,
  });
  /**
   * jsdom has no layout: the card's top is a number that scrollBy moves,
   * as a browser's would. It starts at 16, where the browser's fragment
   * scroll put the acted heading.
   */
  function layout(window: Win, card: El | null) {
    expect(card).not.toBeNull();
    const view = { top: 16 };
    (
      card as unknown as { getBoundingClientRect: () => object }
    ).getBoundingClientRect = () => ({ top: view.top });
    const scrollBy = vi.fn((_x: number, y: number) => {
      view.top -= y;
    });
    (window as Landing).scrollBy = scrollBy;
    return { view, scrollBy };
  }
  /** jsdom runs the kit at readyState interactive; load follows. */
  async function loaded(window: Win, document: Document) {
    if (document.readyState !== 'complete') {
      await new Promise((r) => {
        window.addEventListener('load', r);
      });
    }
  }

  async function landed(saved: object | undefined, url = LANDING) {
    const page = load(
      await monthPage('/dashboard/no-shows/2026-09?result=done&row=2'),
      url,
    );
    const w = page.window as Landing;
    if (saved !== undefined) {
      w.sessionStorage.setItem(KEY, JSON.stringify(saved));
    }
    const acted = page.document.getElementById('acted');
    const { view, scrollBy } = layout(
      page.window,
      acted?.closest('[data-keep-place]') ?? null,
    );
    return { ...page, w, acted, view, scrollBy };
  }

  it('puts the card back at the height it was when the action was sent, and focuses its heading', async () => {
    const { window, document, run, w, acted, view, scrollBy } =
      await landed(place());
    expect(document.readyState).not.toBe('complete');
    run();
    // From 16px down the viewport back to 300px: scroll up by 284.
    expect(scrollBy).toHaveBeenCalledExactlyOnceWith(0, -284);
    expect(view.top).toBe(300);
    expect(document.activeElement).toBe(acted);
    expect(acted?.getAttribute('tabindex')).toBe('-1');
    // Used once: a reload or Back to the same URL is a plain landing.
    expect(w.sessionStorage.getItem(KEY)).toBeNull();
    // Load: the card has not moved since, so nothing scrolls again.
    await loaded(window, document);
    expect(scrollBy).toHaveBeenCalledTimes(1);
  });

  it('run after load (readyState complete): placed and focused at once, nothing waits for a load that has passed', async () => {
    const { window, document, run, acted, view, scrollBy } =
      await landed(place());
    await loaded(window, document);
    expect(document.readyState).toBe('complete');
    run();
    expect(scrollBy).toHaveBeenCalledExactlyOnceWith(0, -284);
    expect(view.top).toBe(300);
    expect(document.activeElement).toBe(acted);
  });

  it('the browser’s fragment scroll after the first placement is undone once at load', async () => {
    const { window, document, run, view, scrollBy } = await landed(place());
    run();
    view.top = 16; // the browser scrolled to #acted after the kit ran
    await loaded(window, document);
    expect(scrollBy).toHaveBeenCalledTimes(2);
    expect(view.top).toBe(300);
  });

  it.each(['wheel', 'touchstart', 'keydown', 'pointerdown'])(
    'a %s by the reader before load: the page is left where the reader put it',
    async (type) => {
      const { window, document, run, view, scrollBy } = await landed(place());
      run();
      view.top = 16;
      window.dispatchEvent(new window.Event(type));
      await loaded(window, document);
      expect(scrollBy).toHaveBeenCalledTimes(1);
      expect(view.top).toBe(16);
    },
  );

  it('focus already somewhere else (the reader clicked into the page) is not taken', async () => {
    const { document, run, acted } = await landed(place());
    const [link] = document.querySelectorAll('main a');
    expect(link).toBeDefined();
    link.focus();
    run();
    expect(document.activeElement).toBe(link);
    expect(document.activeElement).not.toBe(acted);
  });

  it.each<[string, object | undefined]>([
    ['nothing saved (no JavaScript before, or a link)', undefined],
    [
      'another row’s place (Skip on one card, then a landing for another)',
      place({ r: '3' }),
    ],
    ['another page’s place', place({ p: '/dashboard/no-shows/2026-10' })],
    [
      'a place saved over ten minutes ago',
      place({ at: Date.now() - 11 * 60_000 }),
    ],
    [
      'a place saved in the future (clock change)',
      place({ at: Date.now() + 60_000 }),
    ],
    ['junk', { p: PATH, r: '2', t: '300', at: 'x' }],
    ['a row that is not digits', place({ r: '2"],a[x="' })],
  ])(
    '%s: the browser’s own landing stands, the heading still takes focus, and the entry is dropped',
    async (_why, saved) => {
      const { window, document, run, w, acted, scrollBy } = await landed(saved);
      run();
      await loaded(window, document);
      expect(scrollBy).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(acted);
      expect(w.sessionStorage.getItem(KEY)).toBeNull();
    },
  );

  it('storage that throws on read and remove (private mode): no scroll, heading focused, no error', async () => {
    const { window, document, run, acted, scrollBy } = await landed(undefined);
    const boom = () => {
      throw new Error('SecurityError');
    };
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      value: { getItem: boom, setItem: boom, removeItem: boom },
    });
    expect(run).not.toThrow();
    await loaded(window, document);
    expect(scrollBy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(acted);
  });

  it('a page without #acted drops a saved place and scrolls nothing', async () => {
    const { window, document, run, w, scrollBy } = await landed(place(), MONTH);
    run();
    await loaded(window, document);
    expect(scrollBy).not.toHaveBeenCalled();
    expect(w.sessionStorage.getItem(KEY)).toBeNull();
  });

  it('the Record suspension page keeps its row’s place and restarts its ten minutes; another row’s is dropped', async () => {
    const confirm = await monthPage(
      '/dashboard/no-shows/2026-09/rows/2/suspend',
    );
    const url = 'http://localhost/dashboard/no-shows/2026-09/rows/2/suspend';
    const mine = load(confirm, url);
    const saved = place({ at: Date.now() - 9 * 60_000 });
    (mine.window as Landing).sessionStorage.setItem(KEY, JSON.stringify(saved));
    mine.run();
    const kept = JSON.parse(
      (mine.window as Landing).sessionStorage.getItem(KEY) ?? 'null',
    ) as { at: number };
    expect(kept).toMatchObject({ p: PATH, r: '2', t: 300 });
    expect(Math.abs(kept.at - Date.now())).toBeLessThan(5_000);

    const other = load(confirm, url);
    (other.window as Landing).sessionStorage.setItem(
      KEY,
      JSON.stringify(place({ r: '3' })),
    );
    other.run();
    expect((other.window as Landing).sessionStorage.getItem(KEY)).toBeNull();
  });

  it('a form sent from inside a card saves that card’s row and place; one outside a card saves nothing', async () => {
    const { window, document, run } = load(await monthPage(), MONTH);
    const w = window as Landing;
    run();
    const card = document.querySelectorAll('[data-keep-place]')[0];
    expect(card.getAttribute('data-keep-place')).toBe('2');
    layout(window, card).view.top = 412;
    const inCard = card.querySelector('form');
    expect(inCard).not.toBeNull();
    inCard?.dispatchEvent(submitEvent(window));
    const saved = JSON.parse(w.sessionStorage.getItem(KEY) ?? 'null') as {
      p: string;
      r: string;
      t: number;
      at: number;
    };
    expect(saved).toMatchObject({ p: PATH, r: '2', t: 412 });
    expect(Math.abs(saved.at - Date.now())).toBeLessThan(5_000);

    w.sessionStorage.setItem(KEY, 'untouched');
    const outside = [...document.querySelectorAll('form')].find(
      (f) => f.closest('[data-keep-place]') === null,
    );
    expect(outside).toBeDefined();
    outside?.dispatchEvent(submitEvent(window));
    expect(w.sessionStorage.getItem(KEY)).toBe('untouched');
  });

  it('the result notice is the acted heading’s description, for screen readers', async () => {
    const { document } = await landed(undefined);
    const acted = document.getElementById('acted');
    expect(acted?.getAttribute('aria-describedby')).toBe('acted-result');
    expect(document.getElementById('acted-result')?.textContent?.trim()).toBe(
      'Saved.',
    );
  });
});
