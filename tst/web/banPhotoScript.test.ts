import { describe, expect, it, vi } from 'vitest';

import { BAN_PHOTO_SCRIPT } from '../../src/web/pageKit.js';

/** Lets every pending promise callback run. */
const settle = async () => {
  for (let i = 0; i < 20; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- drain the chain one turn at a time
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
};

interface FakeBlob {
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** A blob of `size` bytes (or exactly `bytes`) of the given type. */
function blob(type: string, size: number, bytes?: number[]): FakeBlob {
  const data = Uint8Array.from(bytes ?? Array.from({ length: size }, () => 7));
  return {
    type,
    size: data.length,
    arrayBuffer: async () => data.buffer,
  };
}

const TOO_LARGE = 153_601;

/** Safari's canvas: asked for WebP, it encodes PNG. */
function webpAsPng(type: string): string {
  return type === 'image/webp' ? 'image/png' : type;
}

type Encoder = (type: string, quality: number) => FakeBlob | null;

/**
 * Runs the real script text against one stubbed form[data-ban-photo]:
 * `bitmap` is what createImageBitmap resolves (or an Error it rejects
 * with), `encode` answers each toBlob call.
 */
function harness(
  options: {
    bitmap?: { width: number; height: number } | Error;
    encode?: Encoder;
    noBitmap?: boolean;
    noToBlob?: boolean;
  } = {},
) {
  const el = <T extends object>(extra: T) => ({
    hidden: true,
    textContent: '',
    ...extra,
  });
  const note = el({ hidden: false });
  const label = el({});
  const status = el({});
  const field = { value: '' };
  const button = { disabled: true };
  const drawImage = vi.fn();
  const toBlobCalls: [string, number][] = [];
  const encode: Encoder = options.encode ?? ((type) => blob(type, 40_000));
  const canvas = el({
    width: 0,
    height: 0,
    getContext(kind: string) {
      return kind === '2d' ? { drawImage } : null;
    },
    toBlob(cb: (b: FakeBlob | null) => void, type: string, quality: number) {
      toBlobCalls.push([type, quality]);
      const answer = encode(type, quality);
      setImmediate(() => cb(answer));
    },
  });
  let onChange: (() => void) | undefined;
  const file = { name: 'IMG_0001.HEIC' };
  const input = {
    files: [file] as unknown[],
    addEventListener(type: string, fn: () => void) {
      if (type === 'change') {
        onChange = fn;
      }
    },
  };
  let onSubmit: ((e: { preventDefault(): void }) => void) | undefined;
  const elements: Record<string, unknown> = {
    '[data-ban-photo-nojs]': note,
    label,
    'input[type=file]': input,
    'input[name=photo]': field,
    canvas,
    '[data-ban-photo-status]': status,
    'button[type=submit]': button,
  };
  const form = {
    querySelector: (selector: string) => elements[selector] ?? null,
    addEventListener(type: string, fn: typeof onSubmit) {
      if (type === 'submit') {
        onSubmit = fn;
      }
    },
  };
  const document = {
    querySelectorAll(selector: string) {
      return selector === 'form[data-ban-photo]' ? [form] : [];
    },
  };
  const createImageBitmap = options.noBitmap
    ? undefined
    : vi.fn(async (_file: unknown, _opts: unknown) => {
        const bitmap = options.bitmap ?? { width: 2000, height: 1000 };
        if (bitmap instanceof Error) {
          throw bitmap;
        }
        return { ...bitmap, close: vi.fn() };
      });
  const HTMLCanvasElement = {
    prototype: options.noToBlob ? {} : { toBlob: () => undefined },
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the fixed script text, run against stubs
  const run = new Function(
    'document',
    'createImageBitmap',
    'HTMLCanvasElement',
    'btoa',
    BAN_PHOTO_SCRIPT.value,
  ) as (...args: unknown[]) => void;
  run(document, createImageBitmap, HTMLCanvasElement, btoa);
  const pick = async () => {
    onChange?.();
    await settle();
  };
  const submit = () => {
    const preventDefault = vi.fn();
    onSubmit?.({ preventDefault });
    return preventDefault;
  };
  return {
    note,
    label,
    status,
    field,
    button,
    canvas,
    drawImage,
    toBlobCalls,
    createImageBitmap,
    file,
    pick,
    submit,
  };
}

describe('BAN_PHOTO_SCRIPT', () => {
  it('hides the no-JavaScript note and shows the picker', () => {
    const h = harness();
    expect(h.note.hidden).toBe(true);
    expect(h.label.hidden).toBe(false);
    expect(h.button.disabled).toBe(true);
  });

  it('no createImageBitmap, or no toBlob, shows the fixed browser message', () => {
    for (const options of [{ noBitmap: true }, { noToBlob: true }]) {
      const h = harness(options);
      expect(h.status.textContent).toBe(
        'This browser cannot prepare the photo. Use a current Chrome, Edge, Firefox or Safari.',
      );
      expect(h.label.hidden).toBe(true);
      expect(h.note.hidden).toBe(true);
    }
  });

  it('a 2000x1000 picture is drawn at 512x256 and a 1x1 is never enlarged', async () => {
    const big = harness({ bitmap: { width: 2000, height: 1000 } });
    await big.pick();
    expect(big.createImageBitmap).toHaveBeenCalledWith(big.file, {
      imageOrientation: 'from-image',
    });
    expect([big.canvas.width, big.canvas.height]).toEqual([512, 256]);
    expect(big.drawImage).toHaveBeenCalledWith(
      expect.anything(),
      0,
      0,
      512,
      256,
    );
    expect(big.canvas.hidden).toBe(false);
    const tall = harness({ bitmap: { width: 300, height: 4000 } });
    await tall.pick();
    expect([tall.canvas.width, tall.canvas.height]).toEqual([38, 512]);
    const tiny = harness({ bitmap: { width: 1, height: 1 } });
    await tiny.pick();
    expect([tiny.canvas.width, tiny.canvas.height]).toEqual([1, 1]);
  });

  it('WebP at 0.8 under the cap fills the field with base64url and enables the button', async () => {
    // These bytes give '+', '/' and '=' in standard base64.
    const bytes = [0xfb, 0xff, 0xbf, 0xfe];
    const h = harness({ encode: (type) => blob(type, 0, bytes) });
    await h.pick();
    expect(h.toBlobCalls).toEqual([['image/webp', 0.8]]);
    expect(h.field.value).toBe(Buffer.from(bytes).toString('base64url'));
    expect(h.field.value).toBe('-_-__g');
    expect(h.status.textContent).toBe('Ready: 1 KB');
    expect(h.button.disabled).toBe(false);
    expect(h.submit()).not.toHaveBeenCalled();
  });

  it('a browser that returns PNG for webp falls back to JPEG', async () => {
    const h = harness({
      encode: (type) => blob(webpAsPng(type), 30_000),
    });
    await h.pick();
    expect(h.toBlobCalls).toEqual([
      ['image/webp', 0.8],
      ['image/jpeg', 0.8],
    ]);
    expect(h.field.value).toBe(Buffer.alloc(30_000, 7).toString('base64url'));
    expect(h.status.textContent).toBe('Ready: 30 KB');
    expect(h.button.disabled).toBe(false);
  });

  it('quality steps down until the photo fits', async () => {
    const h = harness({
      encode: (type, quality) =>
        blob(type, quality > 0.65 ? TOO_LARGE : 153_600),
    });
    await h.pick();
    expect(h.toBlobCalls).toEqual([
      ['image/webp', 0.8],
      ['image/webp', 0.7],
      ['image/webp', 0.6],
    ]);
    expect(h.field.value.length).toBe(204_800);
    expect(h.status.textContent).toBe('Ready: 150 KB');
    expect(h.button.disabled).toBe(false);
  });

  it('quality steps down to 0.5 and stops there with the too-large message, button still disabled', async () => {
    const h = harness({ encode: (type) => blob(type, TOO_LARGE) });
    await h.pick();
    expect(h.toBlobCalls).toEqual([
      ['image/webp', 0.8],
      ['image/webp', 0.7],
      ['image/webp', 0.6],
      ['image/webp', 0.5],
    ]);
    expect(h.status.textContent).toBe(
      'That photo is still too large after compressing. Try a smaller picture.',
    );
    expect(h.field.value).toBe('');
    expect(h.button.disabled).toBe(true);
    expect(h.submit()).toHaveBeenCalled();
  });

  it('the JPEG fallback steps down too, and gives up with the same message', async () => {
    const h = harness({
      encode: (type) => blob(webpAsPng(type), TOO_LARGE),
    });
    await h.pick();
    expect(h.toBlobCalls).toEqual([
      ['image/webp', 0.8],
      ['image/jpeg', 0.8],
      ['image/jpeg', 0.7],
      ['image/jpeg', 0.6],
      ['image/jpeg', 0.5],
    ]);
    expect(h.status.textContent).toBe(
      'That photo is still too large after compressing. Try a smaller picture.',
    );
    expect(h.button.disabled).toBe(true);
  });

  it('a decode failure shows the fixed message and fills nothing', async () => {
    const h = harness({ bitmap: new Error('not an image') });
    await h.pick();
    expect(h.status.textContent).toBe(
      'That file could not be read as a picture.',
    );
    expect(h.toBlobCalls).toEqual([]);
    expect(h.field.value).toBe('');
    expect(h.button.disabled).toBe(true);
    expect(h.submit()).toHaveBeenCalled();
  });

  it('a toBlob that gives nothing shows a fixed message and fills nothing', async () => {
    const h = harness({ encode: () => null });
    await h.pick();
    expect(h.status.textContent).toBe(
      'That photo could not be prepared. Try another picture.',
    );
    expect(h.field.value).toBe('');
    expect(h.button.disabled).toBe(true);
  });

  it('a second pick after a good one clears the field until it is ready again, and a failed one leaves nothing to submit', async () => {
    let fail = false;
    const h = harness({
      encode: (type) => blob(type, fail ? TOO_LARGE : 1024),
    });
    await h.pick();
    expect(h.button.disabled).toBe(false);
    expect(h.field.value).not.toBe('');
    fail = true;
    await h.pick();
    expect(h.field.value).toBe('');
    expect(h.button.disabled).toBe(true);
    expect(h.submit()).toHaveBeenCalled();
  });

  it('the script text has no blob:, data:, fetch, XMLHttpRequest, Worker, innerHTML or getAttribute(', () => {
    const text = BAN_PHOTO_SCRIPT.value;
    for (const banned of [
      'blob:',
      'data:',
      'fetch',
      'XMLHttpRequest',
      'Worker',
      'innerHTML',
      'getAttribute(',
      'createObjectURL',
      'eval',
    ]) {
      expect(text).not.toContain(banned);
    }
  });
});
