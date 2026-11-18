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
  defaultView: Win | null;
  querySelectorAll<T extends El = El>(selector: string): T[];
  getElementById(id: string): El | null;
  addEventListener(type: string, fn: (event: { key?: string }) => void): void;
  dispatchEvent(event: object): boolean;
}
interface Win {
  document: Document;
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
async function monthPage(): Promise<string> {
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
  const res = await req
    .get('/dashboard/no-shows/2026-09')
    .set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.text;
}

/** The page in jsdom (its own scripts never run), with the dialog polyfill and a clipboard. */
function load(page: string) {
  const dom = new JSDOM(page, { runScripts: 'outside-only' });
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
      expect(d.closest('details')).toBeNull();
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
      'No-shows',
      'Hosts & events',
      'Members',
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
