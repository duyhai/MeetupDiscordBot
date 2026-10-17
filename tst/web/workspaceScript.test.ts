import { describe, expect, it, vi } from 'vitest';

import { WORKSPACE_SCRIPT } from '../../src/web/pageKit.js';

/** Lets every pending promise callback run. */
const settle = () =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

type Write = (text: string) => Promise<void>;

/**
 * Runs the real script text against one stubbed button inside one copy
 * box: `thenSubmit` is a Copy warning button (data-then-submit, in a form).
 */
function harness(options: {
  thenSubmit: boolean;
  clipboard?: { writeText: Write } | undefined;
  textarea?: boolean;
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
    form: options.thenSubmit ? { submit } : null,
    closest(selector: string) {
      return selector === '[data-copy-box]' ? box : null;
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
    querySelectorAll(selector: string) {
      return selector === 'button[data-copy-near]' ? [button] : [];
    },
  };
  const navigator = { clipboard: options.clipboard };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the fixed script text, run against stubs
  const run = new Function('document', 'navigator', WORKSPACE_SCRIPT.value) as (
    document: unknown,
    navigator: unknown,
  ) => void;
  run(document, navigator);
  const click = () => {
    const preventDefault = vi.fn();
    onClick?.({ preventDefault });
    return preventDefault;
  };
  return { button, submit, select, click };
}

describe('WORKSPACE_SCRIPT', () => {
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
