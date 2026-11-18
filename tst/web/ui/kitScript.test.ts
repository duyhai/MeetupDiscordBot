import { describe, expect, it, vi } from 'vitest';

import fs from 'fs';

import { isSafeHtml } from '../../../src/web/html.js';
import { KIT_SCRIPT } from '../../../src/web/ui/script.js';

/** Lets every pending promise callback run. */
const settle = () =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

type Write = (text: string) => Promise<void>;

/** Runs the real script text against stubs (kitDom.test.ts runs it in jsdom). */
function runKit(
  document: unknown,
  navigator: unknown = {},
  window: unknown = { addEventListener: () => undefined },
) {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the fixed script text, run against stubs
  const run = new Function(
    'document',
    'navigator',
    'window',
    KIT_SCRIPT.value,
  ) as (document: unknown, navigator: unknown, window: unknown) => void;
  run(document, navigator, window);
}

/**
 * One stubbed copy button. `thenSubmit` is a Copy warning button
 * (data-then-submit, in a form). `byId` copies the textarea of that id
 * (data-copy="hof-post"); otherwise the one in its [data-copy-box].
 */
function harness(options: {
  thenSubmit: boolean;
  clipboard?: { writeText: Write } | undefined;
  textarea?: boolean;
  byId?: string;
  /** The workspace card the form sits in ([data-keep-place]), and the window it is in. */
  card?: { getBoundingClientRect(): { top: number } };
  window?: unknown;
}) {
  const submit = vi.fn();
  const select = vi.fn();
  const textarea = { value: 'Hello there', select };
  const box = {
    querySelector(selector: string) {
      return selector === 'textarea' && options.textarea !== false
        ? textarea
        : null;
    },
  };
  let onClick: ((event: { preventDefault(): void }) => void) | undefined;
  const button = {
    textContent: options.thenSubmit
      ? 'Copy warning'
      : 'Copy suspension message',
    disabled: false,
    form: options.thenSubmit
      ? {
          submit,
          closest(selector: string) {
            return selector === '[data-keep-place]'
              ? (options.card ?? null)
              : null;
          },
        }
      : null,
    closest(selector: string) {
      return selector === '[data-copy-box]' && !options.byId ? box : null;
    },
    getAttribute(name: string) {
      return name === 'data-copy' ? (options.byId ?? '') : null;
    },
    hasAttribute(name: string) {
      return name === 'data-then-submit' && options.thenSubmit;
    },
    addEventListener(type: string, fn: typeof onClick) {
      if (type === 'click') {
        onClick = fn;
      }
    },
  };
  const document = {
    addEventListener: () => undefined,
    querySelectorAll(selector: string) {
      return selector === 'button[data-copy]' ? [button] : [];
    },
    getElementById(id: string) {
      return options.byId === id && options.textarea !== false
        ? textarea
        : null;
    },
  };
  runKit(document, { clipboard: options.clipboard }, options.window);
  const click = () => {
    const preventDefault = vi.fn();
    onClick?.({ preventDefault });
    return preventDefault;
  };
  return { button, submit, select, click };
}

describe('KIT_SCRIPT: copy', () => {
  it('Copy warning submits exactly once, after the clipboard write resolved', async () => {
    let resolveWrite: () => void = () => undefined;
    const writeText = vi.fn<Write>(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    const h = harness({ thenSubmit: true, clipboard: { writeText } });
    const preventDefault = h.click();
    expect(preventDefault).toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith('Hello there');
    await settle();
    expect(h.submit).not.toHaveBeenCalled();
    resolveWrite();
    await settle();
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.button.disabled).toBe(true);
  });

  it('Copy warning keeps its card’s place before it submits (the landing puts the card back there)', async () => {
    const order: string[] = [];
    const setItem = vi.fn((key: string, value: string) => {
      order.push(`save ${key} ${value}`);
    });
    const writeText = vi.fn<Write>(async () => undefined);
    const h = harness({
      thenSubmit: true,
      clipboard: { writeText },
      card: { getBoundingClientRect: () => ({ top: 412.4 }) },
      window: {
        addEventListener: () => undefined,
        location: { pathname: '/dashboard/no-shows/2026-09', hash: '' },
        sessionStorage: { setItem },
      },
    });
    h.submit.mockImplementation(() => order.push('submit'));
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    h.click();
    await settle();
    expect(order).toEqual([
      'save ui-keep-place {"p":"/dashboard/no-shows/2026-09","t":412,"at":1000}',
      'submit',
    ]);
  });

  it('a storage that throws (private mode) still submits', async () => {
    const writeText = vi.fn<Write>(async () => undefined);
    const h = harness({
      thenSubmit: true,
      clipboard: { writeText },
      card: { getBoundingClientRect: () => ({ top: 10 }) },
      window: {
        addEventListener: () => undefined,
        location: { pathname: '/dashboard/no-shows/2026-09', hash: '' },
        sessionStorage: {
          setItem: () => {
            throw new Error('SecurityError');
          },
        },
      },
    });
    h.click();
    await settle();
    expect(h.submit).toHaveBeenCalledTimes(1);
  });

  it('does not submit when the clipboard write is rejected', async () => {
    const writeText = vi.fn<Write>(async () => {
      throw new Error('denied');
    });
    const h = harness({ thenSubmit: true, clipboard: { writeText } });
    expect(h.click()).toHaveBeenCalled();
    await settle();
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.button.textContent).toBe('Select the text and copy it');
  });

  it('does not submit when there is no clipboard', async () => {
    const h = harness({ thenSubmit: true, clipboard: undefined });
    expect(h.click()).toHaveBeenCalled();
    await settle();
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.select).toHaveBeenCalled();
    expect(h.button.textContent).toBe('Select the text and copy it');
  });

  it('does not submit natively when its box has no textarea', async () => {
    const writeText = vi.fn<Write>(async () => undefined);
    const h = harness({
      thenSubmit: true,
      clipboard: { writeText },
      textarea: false,
    });
    expect(h.click()).toHaveBeenCalled();
    await settle();
    expect(writeText).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('a double click while the write is pending sends once', async () => {
    let resolveWrite: () => void = () => undefined;
    const writeText = vi.fn<Write>(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    const h = harness({ thenSubmit: true, clipboard: { writeText } });
    h.click();
    expect(h.click()).toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledTimes(1);
    resolveWrite();
    await settle();
    h.click();
    await settle();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(h.submit).toHaveBeenCalledTimes(1);
  });

  it('a dialog closed while the write is pending never submits afterwards (#159 review)', async () => {
    let resolveWrite: () => void = () => undefined;
    const writeText = vi.fn<Write>(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    const h = harness({ thenSubmit: true, clipboard: { writeText } });
    h.click();
    expect(writeText).toHaveBeenCalledTimes(1);
    // Esc: the dialog's close handler resets the button (bumps its token).
    (h.button as unknown as { _kitReset: () => void })._kitReset();
    resolveWrite();
    await settle();
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.button.disabled).toBe(false);
    expect(h.button.textContent).toBe('Copy warning');
    // A fresh press after reopening copies and submits as usual.
    h.click();
    expect(writeText).toHaveBeenCalledTimes(2);
    resolveWrite();
    await settle();
    expect(h.submit).toHaveBeenCalledTimes(1);
  });

  it('a refused write after the dialog closed leaves the label alone', async () => {
    let rejectWrite: () => void = () => undefined;
    const writeText = vi.fn<Write>(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectWrite = () => reject(new Error('denied'));
        }),
    );
    const h = harness({ thenSubmit: true, clipboard: { writeText } });
    h.click();
    (h.button as unknown as { _kitReset: () => void })._kitReset();
    rejectWrite();
    await settle();
    expect(h.button.textContent).toBe('Copy warning');
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('a copy-only button never submits, and can copy again', async () => {
    const writeText = vi.fn<Write>(async () => undefined);
    const h = harness({ thenSubmit: false, clipboard: { writeText } });
    h.click();
    await settle();
    expect(h.button.textContent).toBe('Copied');
    h.click();
    await settle();
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(h.submit).not.toHaveBeenCalled();
  });
});

describe('KIT_SCRIPT: copy by id (the Hall of Fame posts)', () => {
  it('copies the textarea of its data-copy id, never a box', async () => {
    const writeText = vi.fn<Write>(async () => undefined);
    const h = harness({
      thenSubmit: false,
      clipboard: { writeText },
      byId: 'hof-post',
    });
    h.click();
    await settle();
    expect(writeText).toHaveBeenCalledWith('Hello there');
    expect(h.button.textContent).toBe('Copied');
  });

  it('a missing id copies nothing', async () => {
    const writeText = vi.fn<Write>(async () => undefined);
    const h = harness({
      thenSubmit: false,
      clipboard: { writeText },
      byId: 'hof-post',
      textarea: false,
    });
    h.click();
    await settle();
    expect(writeText).not.toHaveBeenCalled();
  });
});

type Listener = (event: { target?: unknown }) => void;

/** A stub element that records listeners and attributes. */
function element(extra: Record<string, unknown> = {}) {
  const listeners = new Map<string, Listener[]>();
  const attributes = new Map<string, string>();
  return {
    listeners,
    attributes,
    addEventListener(type: string, fn: Listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    fire(type: string, event: { target?: unknown } = {}) {
      (listeners.get(type) ?? []).forEach((fn) => fn(event));
    },
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
    ...extra,
  };
}

/** One details[data-modal] with its summary, dialog, title and close button. */
function modalHarness(
  options: { showModal?: boolean; textarea?: boolean } = {},
) {
  const title = { id: '' };
  const close = element();
  const dialog = element({
    open: false,
    querySelector: (selector: string) => {
      if (selector === 'textarea') {
        return options.textarea ? {} : null;
      }
      return selector === '[data-modal-title]' ? title : null;
    },
    querySelectorAll: (selector: string) => {
      return selector === '[data-modal-close]' ? [close] : [];
    },
  }) as ReturnType<typeof element> & {
    open: boolean;
    showModal?: () => void;
    close: () => void;
  };
  if (options.showModal !== false) {
    dialog.showModal = vi.fn(() => {
      dialog.open = true;
    });
  }
  dialog.close = vi.fn(() => {
    dialog.open = false;
    dialog.fire('close');
  });
  const summary = {
    className: 'button danger',
    textContent: '\n  Void suspension\n',
  };
  const children: unknown[] = [];
  const parent = {
    children,
    insertBefore: vi.fn((node: unknown) => {
      children.push(node);
    }),
    removeChild: vi.fn(),
  };
  const details = {
    parentNode: parent,
    querySelector: (selector: string) => {
      if (selector === 'summary') {
        return summary;
      }
      return selector === 'dialog' ? dialog : null;
    },
  };
  const created: ReturnType<typeof element>[] = [];
  const document = {
    addEventListener: () => undefined,
    querySelectorAll: (selector: string) => {
      return selector === 'details[data-modal]' ? [details] : [];
    },
    createElement: (tag: string) => {
      const b = element({
        tag,
        type: '',
        className: '',
        textContent: '',
        focus: vi.fn(),
      });
      created.push(b);
      return b;
    },
  };
  runKit(document);
  return { dialog, close, title, parent, details, created };
}

describe('KIT_SCRIPT: modal', () => {
  it('replaces the summary with a real button beside the dialog, labelled by a numbered id', () => {
    const h = modalHarness();
    expect(h.created).toHaveLength(1);
    const button = h.created[0] as unknown as Record<string, unknown> &
      ReturnType<typeof element>;
    expect(button.tag).toBe('button');
    expect(button.type).toBe('button');
    expect(button.className).toBe('button danger');
    expect(button.textContent).toBe('Void suspension');
    expect(button.attributes.get('aria-haspopup')).toBe('dialog');
    expect(h.parent.children).toEqual([button, h.dialog]);
    expect(h.parent.removeChild).toHaveBeenCalledWith(h.details);
    expect(h.title.id).toBe('ui-modal-1-title');
    expect(h.dialog.attributes.get('aria-labelledby')).toBe('ui-modal-1-title');
  });

  it('the button opens it modally; close returns focus to the button', () => {
    const h = modalHarness();
    const button = h.created[0] as unknown as ReturnType<typeof element> & {
      focus: () => void;
    };
    button.fire('click');
    expect(h.dialog.showModal).toHaveBeenCalledTimes(1);
    expect(h.dialog.open).toBe(true);
    // A second click while open does not call showModal again.
    button.fire('click');
    expect(h.dialog.showModal).toHaveBeenCalledTimes(1);
    h.close.fire('click');
    expect(h.dialog.open).toBe(false);
    expect(button.focus).toHaveBeenCalledTimes(1);
  });

  it('a press and release on the backdrop (the dialog itself) closes it; one inside does not', () => {
    const h = modalHarness();
    h.created[0].fire('click');
    const inside = {};
    h.dialog.fire('pointerdown', { target: inside });
    h.dialog.fire('pointerup', { target: inside });
    h.dialog.fire('click', { target: inside });
    expect(h.dialog.open).toBe(true);
    h.dialog.fire('pointerdown', { target: h.dialog });
    h.dialog.fire('pointerup', { target: h.dialog });
    h.dialog.fire('click', { target: h.dialog });
    expect(h.dialog.open).toBe(false);
  });

  it('a press on the backdrop released inside the box does not close it (#159 review)', () => {
    const h = modalHarness();
    h.created[0].fire('click');
    // The click lands on the dialog (the nearest common ancestor), but the
    // release was inside the box.
    h.dialog.fire('pointerdown', { target: h.dialog });
    h.dialog.fire('pointerup', { target: {} });
    h.dialog.fire('click', { target: h.dialog });
    expect(h.dialog.open).toBe(true);
  });

  it('a click with no pointer events first (a synthetic click) does not close it', () => {
    const h = modalHarness();
    h.created[0].fire('click');
    h.dialog.fire('click', { target: h.dialog });
    expect(h.dialog.open).toBe(true);
  });

  it('a drag that starts inside and ends on the backdrop does not close it', () => {
    const h = modalHarness();
    h.created[0].fire('click');
    // Selecting text in a field and letting go outside the box: the click
    // lands on the dialog element itself.
    h.dialog.fire('pointerdown', { target: {} });
    h.dialog.fire('pointerup', { target: h.dialog });
    h.dialog.fire('click', { target: h.dialog });
    expect(h.dialog.open).toBe(true);
  });

  it('a dialog with a textarea never closes from the backdrop', () => {
    const h = modalHarness({ textarea: true });
    h.created[0].fire('click');
    h.dialog.fire('pointerdown', { target: h.dialog });
    h.dialog.fire('pointerup', { target: h.dialog });
    h.dialog.fire('click', { target: h.dialog });
    expect(h.dialog.open).toBe(true);
    h.close.fire('click');
    expect(h.dialog.open).toBe(false);
  });

  it('without <dialog> support the details stays as it is', () => {
    const h = modalHarness({ showModal: false });
    expect(h.created).toHaveLength(0);
    expect(h.parent.insertBefore).not.toHaveBeenCalled();
    expect(h.parent.removeChild).not.toHaveBeenCalled();
  });
});

/** One nav [data-accordion] with three details[data-nav-group]. */
function accordionHarness(openIndex?: number) {
  const groups = [0, 1, 2].map((i) => {
    const summary = { focus: vi.fn() };
    const g = element({
      open: i === openIndex,
      querySelector: (selector: string) => {
        return selector === 'summary' ? summary : null;
      },
    }) as ReturnType<typeof element> & { open: boolean };
    return { g, summary };
  });
  const nav = {
    querySelectorAll: (selector: string) => {
      return selector === 'details[data-nav-group]'
        ? groups.map((x) => x.g)
        : [];
    },
  };
  const document = {
    addEventListener: () => undefined,
    querySelectorAll: (selector: string) => {
      return selector === '[data-accordion]' ? [nav] : [];
    },
  };
  runKit(document);
  /** As the browser does: set open, then fire toggle. */
  const toggle = (i: number, open: boolean) => {
    groups[i].g.open = open;
    groups[i].g.fire('toggle');
  };
  return { groups, toggle };
}

describe('KIT_SCRIPT: nav accordion', () => {
  it('opening one group closes the others', () => {
    const h = accordionHarness(0);
    h.toggle(2, true);
    expect(h.groups.map((x) => x.g.open)).toEqual([false, false, true]);
    h.toggle(1, true);
    expect(h.groups.map((x) => x.g.open)).toEqual([false, true, false]);
  });

  it('closing a group opens nothing else', () => {
    const h = accordionHarness(1);
    h.toggle(1, false);
    expect(h.groups.map((x) => x.g.open)).toEqual([false, false, false]);
  });

  it('Esc inside an open group closes it and focuses its summary; other keys do nothing', () => {
    const h = accordionHarness(1);
    const g = h.groups[1];
    g.g.fire('keydown', { key: 'Enter' } as never);
    expect(g.g.open).toBe(true);
    g.g.fire('keydown', { key: 'Escape' } as never);
    expect(g.g.open).toBe(false);
    expect(g.summary.focus).toHaveBeenCalledTimes(1);
    // Esc on a closed group: nothing.
    g.g.fire('keydown', { key: 'Escape' } as never);
    expect(g.summary.focus).toHaveBeenCalledTimes(1);
  });
});

describe('KIT_SCRIPT text', () => {
  it('is one staticRaw literal with no interpolation', () => {
    const source = fs.readFileSync(
      new URL('../../../src/web/ui/script.ts', import.meta.url),
      'utf8',
    );
    const start = source.indexOf('export const KIT_SCRIPT');
    expect(start).toBeGreaterThan(-1);
    const definition = source.slice(start).trim();
    expect(definition).not.toContain('${');
    expect(definition).toMatch(/^export const KIT_SCRIPT = staticRaw`[^`]*`;$/);
    expect(isSafeHtml(KIT_SCRIPT)).toBe(true);
  });

  it('finds box textareas by position and falls back when the clipboard is missing', () => {
    expect(KIT_SCRIPT.value).toContain("closest('[data-copy-box]')");
    expect(KIT_SCRIPT.value).toContain(
      "if(!navigator.clipboard){b.textContent='Select the text and copy it';return;}",
    );
  });
});
