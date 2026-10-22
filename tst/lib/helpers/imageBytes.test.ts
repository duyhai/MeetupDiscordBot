import { describe, expect, it } from 'vitest';

import {
  readImageSize,
  sniffImageType,
} from '../../../src/lib/helpers/imageBytes.js';
import { sniffImageType as reExported } from '../../../src/web/images.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

const VP8L_1X1 = Buffer.from(
  'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==',
  'base64',
);

/** RIFF/WEBP with one chunk: the RIFF size always matches the length. */
function riff(fourCC: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(20);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(12 + payload.length, 4);
  head.write('WEBP', 8, 'latin1');
  head.write(fourCC, 12, 'latin1');
  head.writeUInt32LE(payload.length, 16);
  return Buffer.concat([head, payload]);
}

/** A 30-byte lossy WebP header: key frame tag, start code, 16-bit sizes. */
function vp8(
  width: number,
  height: number,
  options: { frameTag?: number[]; startCode?: number[] } = {},
): Buffer {
  const payload = Buffer.alloc(10);
  Buffer.from(options.frameTag ?? [0x00, 0x00, 0x00]).copy(payload, 0);
  Buffer.from(options.startCode ?? [0x9d, 0x01, 0x2a]).copy(payload, 3);
  payload.writeUInt16LE(width, 6);
  payload.writeUInt16LE(height, 8);
  return riff('VP8 ', payload);
}

/** A 30-byte extended WebP header: flags, then 24-bit width-1 and height-1. */
function vp8x(width: number, height: number, flags = 0x10): Buffer {
  const payload = Buffer.alloc(10);
  payload[0] = flags;
  payload.writeUIntLE(width - 1, 4, 3);
  payload.writeUIntLE(height - 1, 7, 3);
  return riff('VP8X', payload);
}

const bytes = (...values: number[]) => Buffer.from(values);

const APP0 = Buffer.concat([bytes(0xff, 0xe0, 0x00, 0x10), Buffer.alloc(14)]);

/** A baseline (or other) SOF segment: precision 8, height, width, 3 components. */
function sof(marker: number, width: number, height: number): Buffer {
  const segment = Buffer.alloc(19);
  segment[0] = 0xff;
  segment[1] = marker;
  segment.writeUInt16BE(17, 2);
  segment[4] = 8;
  segment.writeUInt16BE(height, 5);
  segment.writeUInt16BE(width, 7);
  segment[9] = 3;
  return segment;
}

const jpeg = (...parts: Buffer[]) =>
  Buffer.concat([bytes(0xff, 0xd8), ...parts]);

describe('readImageSize: WebP', () => {
  it('VP8L 1x1', () => {
    expect(readImageSize(VP8L_1X1)).toEqual({
      type: 'image/webp',
      width: 1,
      height: 1,
    });
  });

  it('VP8 lossy 512x384, also with the scale bits set', () => {
    expect(vp8(512, 384)).toHaveLength(30);
    expect(readImageSize(vp8(512, 384))).toEqual({
      type: 'image/webp',
      width: 512,
      height: 384,
    });
    expect(readImageSize(vp8(0xc200, 384))).toEqual({
      type: 'image/webp',
      width: 512,
      height: 384,
    });
  });

  it('VP8X 640x480 still; animated is refused', () => {
    expect(readImageSize(vp8x(640, 480))).toEqual({
      type: 'image/webp',
      width: 640,
      height: 480,
    });
    expect(readImageSize(vp8x(4000, 4000, 0x10))).toEqual({
      type: 'image/webp',
      width: 4000,
      height: 4000,
    });
    expect(readImageSize(vp8x(640, 480, 0x02))).toBeUndefined();
    expect(readImageSize(vp8x(640, 480, 0x12))).toBeUndefined();
  });

  it('VP8L version bits set, VP8 missing start code, VP8 non-key frame', () => {
    const versioned = Buffer.from(VP8L_1X1);
    versioned[24] |= 0x20;
    expect(readImageSize(versioned)).toBeUndefined();
    const unsigned = Buffer.from(VP8L_1X1);
    unsigned[20] = 0x2e;
    expect(readImageSize(unsigned)).toBeUndefined();
    expect(
      readImageSize(vp8(512, 384, { startCode: [0x9d, 0x01, 0x2b] })),
    ).toBeUndefined();
    expect(
      readImageSize(vp8(512, 384, { frameTag: [0x01, 0x00, 0x00] })),
    ).toBeUndefined();
  });

  it('RIFF size that does not match the length', () => {
    expect(
      readImageSize(Buffer.concat([vp8(512, 384), bytes(0)])),
    ).toBeUndefined();
    expect(
      readImageSize(
        Buffer.concat([vp8(512, 384), Buffer.from('<html><script>x</script>')]),
      ),
    ).toBeUndefined();
    expect(readImageSize(vp8(512, 384).subarray(0, 29))).toBeUndefined();
  });

  it('a RIFF/WEBP header with chunk ALPH first; RIFF AVI', () => {
    expect(readImageSize(riff('ALPH', Buffer.alloc(10)))).toBeUndefined();
    const avi = vp8(512, 384);
    avi.write('AVI ', 8, 'latin1');
    expect(readImageSize(avi)).toBeUndefined();
  });

  it('zero-sized VP8 is refused', () => {
    expect(readImageSize(vp8(0, 384))).toBeUndefined();
    expect(readImageSize(vp8(0xc000, 384))).toBeUndefined();
  });
});

describe('readImageSize: JPEG', () => {
  it('JPEG SOF0 800x600; with fill bytes; SOF2', () => {
    const expected = { type: 'image/jpeg', width: 800, height: 600 };
    expect(readImageSize(jpeg(APP0, sof(0xc0, 800, 600)))).toEqual(expected);
    const filled = sof(0xc0, 800, 600);
    expect(
      readImageSize(jpeg(APP0, Buffer.concat([bytes(0xff, 0xff), filled]))),
    ).toEqual(expected);
    expect(readImageSize(jpeg(APP0, sof(0xc2, 800, 600)))).toEqual(expected);
    expect(
      readImageSize(jpeg(bytes(0xff, 0xd0), APP0, sof(0xc1, 800, 600))),
    ).toEqual(expected);
  });

  it('JPEG that hits SOS (or EOI) before a SOF', () => {
    const sos = Buffer.concat([bytes(0xff, 0xda, 0x00, 0x08), Buffer.alloc(6)]);
    expect(readImageSize(jpeg(APP0, sos, sof(0xc0, 800, 600)))).toBeUndefined();
    expect(
      readImageSize(jpeg(APP0, bytes(0xff, 0xd9), sof(0xc0, 800, 600))),
    ).toBeUndefined();
  });

  it('JPEG segment length running past the end, and length 0 or 1', () => {
    expect(
      readImageSize(jpeg(bytes(0xff, 0xe0, 0x00, 0x40), Buffer.alloc(10))),
    ).toBeUndefined();
    expect(readImageSize(jpeg(sof(0xc0, 800, 600).subarray(0, 18)))).toBe(
      undefined,
    );
    for (const length of [0, 1]) {
      expect(
        readImageSize(
          jpeg(bytes(0xff, 0xe0, 0x00, length), sof(0xc0, 800, 600)),
        ),
      ).toBeUndefined();
    }
  });

  it('DHT C4 is not a SOF; neither are C8 and CC', () => {
    for (const marker of [0xc4, 0xc8, 0xcc]) {
      expect(readImageSize(jpeg(sof(marker, 800, 600)))).toBeUndefined();
    }
  });

  it('zero width or height', () => {
    expect(readImageSize(jpeg(APP0, sof(0xc0, 0, 600)))).toBeUndefined();
    expect(readImageSize(jpeg(APP0, sof(0xc0, 800, 0)))).toBeUndefined();
  });

  it('a byte that is not a marker where one should be', () => {
    expect(
      readImageSize(jpeg(bytes(0x00, 0xff), APP0, sof(0xc0, 800, 600))),
    ).toBeUndefined();
  });
});

describe('readImageSize: everything else', () => {
  it('PNG, empty, 11 bytes of RIFF, 5 MB of 0xFF after FF D8, a non-Buffer', () => {
    expect(readImageSize(PNG_1X1)).toBeUndefined();
    expect(readImageSize(Buffer.alloc(0))).toBeUndefined();
    expect(readImageSize(VP8L_1X1.subarray(0, 11))).toBeUndefined();
    const started = Date.now();
    expect(
      readImageSize(
        Buffer.concat([bytes(0xff, 0xd8), Buffer.alloc(5 * 1024 * 1024, 0xff)]),
      ),
    ).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(readImageSize('RIFF' as unknown as Buffer)).toBeUndefined();
    expect(readImageSize(null)).toBeUndefined();
  });
});

describe('sniffImageType', () => {
  it('behaves as before, and src/web/images re-exports the same function', () => {
    expect(reExported).toBe(sniffImageType);
    expect(sniffImageType(PNG_1X1)).toBe('image/png');
    expect(sniffImageType(VP8L_1X1)).toBe('image/webp');
    expect(sniffImageType(jpeg(APP0))).toBe('image/jpeg');
    expect(sniffImageType(Buffer.from('<html>'))).toBeUndefined();
  });
});
