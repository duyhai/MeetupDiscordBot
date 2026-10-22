import { describe, expect, it } from 'vitest';

import {
  readImageSize,
  sniffImageType,
  stripImageMetadata,
} from '../../../src/lib/helpers/imageBytes.js';
import { sniffImageType as reExported } from '../../../src/web/images.js';
import {
  CHROME_JPEG,
  CHROME_WEBP_ALPHA,
  CHROME_WEBP_OPAQUE,
} from './chromeCanvasImages.js';

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

/** JFIF APP0 as Chrome and ImageIO write it: length 16, no thumbnail. */
const APP0 = Buffer.concat([
  bytes(0xff, 0xe0, 0x00, 0x10),
  Buffer.from('JFIF\0', 'latin1'),
  bytes(0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00),
]);

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

  it('FF 00 outside entropy data', () => {
    expect(
      readImageSize(jpeg(bytes(0xff, 0x00), APP0, sof(0xc0, 800, 600))),
    ).toBeUndefined();
  });
});

describe('readImageSize: first chunk size', () => {
  /** `image` with the first chunk's declared size (offset 16) replaced. */
  const declared = (image: Buffer, size: number) => {
    const copy = Buffer.from(image);
    copy.writeUInt32LE(size, 16);
    return copy;
  };

  it('VP8 and VP8X need a declared chunk size of at least 10', () => {
    expect(readImageSize(declared(vp8(512, 384), 9))).toBeUndefined();
    expect(readImageSize(declared(vp8(512, 384), 0))).toBeUndefined();
    expect(readImageSize(declared(vp8x(640, 480), 9))).toBeUndefined();
    expect(readImageSize(declared(vp8(512, 384), 10))).toEqual({
      type: 'image/webp',
      width: 512,
      height: 384,
    });
  });

  it('VP8L needs a declared chunk size of at least 5', () => {
    expect(readImageSize(declared(VP8L_1X1, 4))).toBeUndefined();
    expect(readImageSize(declared(VP8L_1X1, 5))).toEqual({
      type: 'image/webp',
      width: 1,
      height: 1,
    });
  });
});

/** RIFF/WEBP from several chunks, each padded to an even length. */
function riffChunks(chunks: [string, Buffer][]): Buffer {
  const parts = chunks.map(([fourCC, payload]) => {
    const head = Buffer.alloc(8);
    head.write(fourCC, 0, 'latin1');
    head.writeUInt32LE(payload.length, 4);
    return Buffer.concat([
      head,
      payload,
      payload.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0),
    ]);
  });
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + body.length, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

const vp8xPayload = (width: number, height: number, flags: number) =>
  vp8x(width, height, flags).subarray(20);
const vp8Payload = vp8(640, 480).subarray(20);

const segment = (marker: number, payload: Buffer) => {
  const head = bytes(0xff, marker, 0, 0);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
};
const APP1_GPS = segment(0xe1, Buffer.from('Exif\0\0GPS-LAT-51.5-LON-0.12'));
const APP2_ICC = segment(0xe2, Buffer.from('ICC_PROFILE-SECRET'));
const COM = segment(0xfe, Buffer.from('COMMENT-HOME-ADDRESS'));
/** Adobe APP14: 'Adobe', version, flags0, flags1, transform; length 14. */
const APP14 = segment(
  0xee,
  Buffer.concat([
    Buffer.from('Adobe', 'latin1'),
    bytes(0x00, 0x64, 0x00, 0x00, 0x00, 0x00, 0x01),
  ]),
);
const APP15 = segment(0xef, Buffer.from('APP15-NOTE'));
const SOS_TO_END = Buffer.concat([
  bytes(0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00),
  Buffer.from('entropy-data-kept'),
  bytes(0xff, 0x00, 0x12, 0xff, 0xd9),
]);

describe('stripImageMetadata: JPEG', () => {
  const marked = jpeg(
    APP0,
    APP1_GPS,
    APP2_ICC,
    COM,
    APP14,
    APP15,
    sof(0xc0, 800, 600),
    SOS_TO_END,
  );

  it('drops APP1-APP13, APP15 and COM; keeps APP0, APP14, SOF and everything from SOS', () => {
    const stripped = stripImageMetadata(marked);
    expect(stripped).toBeDefined();
    const text = stripped.toString('latin1');
    for (const gone of ['GPS-LAT', 'Exif', 'ICC_PROFILE', 'COMMENT', 'APP15']) {
      expect(text).not.toContain(gone);
    }
    expect(stripped).toEqual(
      jpeg(APP0, APP14, sof(0xc0, 800, 600), SOS_TO_END),
    );
    expect(readImageSize(stripped)).toEqual(readImageSize(marked));
    expect(readImageSize(stripped)).toEqual({
      type: 'image/jpeg',
      width: 800,
      height: 600,
    });
  });

  it('a clean JPEG comes back byte for byte', () => {
    const clean = jpeg(APP0, sof(0xc0, 800, 600), SOS_TO_END);
    expect(stripImageMetadata(clean)).toEqual(clean);
  });

  it('malformed JPEG is undefined: no SOS, EOI first, a segment past the end, FF 00 before SOS', () => {
    expect(stripImageMetadata(jpeg(APP0, sof(0xc0, 800, 600)))).toBeUndefined();
    expect(
      stripImageMetadata(
        jpeg(APP0, bytes(0xff, 0xd9), sof(0xc0, 800, 600), SOS_TO_END),
      ),
    ).toBeUndefined();
    expect(
      stripImageMetadata(jpeg(bytes(0xff, 0xe1, 0x00, 0x40), Buffer.alloc(4))),
    ).toBeUndefined();
    expect(
      stripImageMetadata(
        jpeg(bytes(0xff, 0x00), APP0, sof(0xc0, 800, 600), SOS_TO_END),
      ),
    ).toBeUndefined();
  });
});

describe('stripImageMetadata: APP0 and APP14 by content', () => {
  const tail = () => Buffer.concat([sof(0xc0, 800, 600), SOS_TO_END]);
  const clean = () => jpeg(tail());

  it('keeps JFIF APP0 of length 16 with a 0x0 thumbnail and Adobe APP14 of length 14', () => {
    const kept = jpeg(APP0, APP14, tail());
    expect(stripImageMetadata(kept)).toEqual(kept);
  });

  it('drops an APP0 that is not JFIF, or is JFIF with a thumbnail or another length', () => {
    const notJfif = segment(
      0xe0,
      Buffer.concat([Buffer.from('JFXX\0', 'latin1'), Buffer.alloc(9)]),
    );
    const secret = segment(0xe0, Buffer.from('APP0-SECRET-HOME'));
    const thumbnail = Buffer.from(APP0);
    thumbnail[16] = 0x01;
    thumbnail[17] = 0x01;
    const withThumb = segment(
      0xe0,
      Buffer.concat([thumbnail.subarray(4), Buffer.from('RGB')]),
    );
    const longer = segment(
      0xe0,
      Buffer.concat([APP0.subarray(4), Buffer.from('APP0-EXTRA')]),
    );
    for (const app0 of [notJfif, secret, thumbnail, withThumb, longer]) {
      expect(stripImageMetadata(jpeg(app0, tail()))).toEqual(clean());
    }
  });

  it('drops an APP14 that is not Adobe, or is Adobe of another length', () => {
    const notAdobe = segment(0xee, Buffer.from('Abode-SECRET'));
    const longer = segment(0xee, Buffer.from('Adobe-colour-SECRET'));
    for (const app14 of [notAdobe, longer]) {
      expect(stripImageMetadata(jpeg(APP0, app14, tail()))).toEqual(
        jpeg(APP0, tail()),
      );
    }
  });
});

describe('stripImageMetadata: JPEG after SOS', () => {
  const SOS = bytes(0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00);
  const scan = (label: string) =>
    Buffer.concat([
      Buffer.from(label),
      bytes(0xff, 0x00, 0x7f, 0xff, 0xd3, 0x01),
    ]);
  const EOI = bytes(0xff, 0xd9);
  /** A well-formed DHT (ten codes of length 2) whose values hold FF D9. */
  const DHT_WITH_EOI = segment(
    0xc4,
    Buffer.concat([
      bytes(0x00),
      bytes(0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
      Buffer.alloc(4, 1),
      bytes(0xff, 0xd9),
      Buffer.alloc(4, 2),
    ]),
  );
  const head = () => jpeg(APP0, sof(0xc2, 800, 600));

  it('APP1 and COM between two scans are dropped; DHT, DQT and DRI between scans are kept', () => {
    const DQT = segment(0xdb, Buffer.alloc(65, 3));
    const DRI = segment(0xdd, bytes(0x00, 0x10));
    const marked = Buffer.concat([
      head(),
      SOS,
      scan('scan-one'),
      APP1_GPS,
      COM,
      DHT_WITH_EOI,
      DQT,
      DRI,
      SOS,
      scan('scan-two'),
      EOI,
    ]);
    const stripped = stripImageMetadata(marked);
    expect(stripped).toEqual(
      Buffer.concat([
        head(),
        SOS,
        scan('scan-one'),
        DHT_WITH_EOI,
        DQT,
        DRI,
        SOS,
        scan('scan-two'),
        EOI,
      ]),
    );
    const text = stripped?.toString('latin1') ?? '';
    expect(text).not.toContain('GPS-LAT');
    expect(text).not.toContain('COMMENT');
  });

  it('junk after EOI is dropped', () => {
    const clean = Buffer.concat([head(), SOS, scan('s'), EOI]);
    expect(
      stripImageMetadata(
        Buffer.concat([clean, Buffer.from('TRAILING-SECRET'), APP1_GPS]),
      ),
    ).toEqual(clean);
  });

  it('FF D9 inside a DHT payload does not truncate, before or after SOS', () => {
    const marked = Buffer.concat([
      jpeg(APP0, DHT_WITH_EOI, sof(0xc0, 800, 600)),
      SOS,
      scan('s'),
      EOI,
    ]);
    expect(stripImageMetadata(marked)).toEqual(marked);
  });

  it('no EOI, or a marker that has no place after SOS, is undefined', () => {
    expect(
      stripImageMetadata(Buffer.concat([head(), SOS, scan('s')])),
    ).toBeUndefined();
    expect(
      stripImageMetadata(
        Buffer.concat([head(), SOS, scan('s'), sof(0xc0, 800, 600), EOI]),
      ),
    ).toBeUndefined();
    expect(
      stripImageMetadata(
        Buffer.concat([head(), SOS, scan('s'), bytes(0xff, 0x01), EOI]),
      ),
    ).toBeUndefined();
  });

  it('before SOS, a marker off the allow-list is dropped', () => {
    const extension = segment(0xf0, Buffer.from('EXTENSION-SECRET'));
    const clean = Buffer.concat([head(), SOS, scan('s'), EOI]);
    const marked = Buffer.concat([
      jpeg(APP0, extension, sof(0xc2, 800, 600)),
      SOS,
      scan('s'),
      EOI,
    ]);
    expect(stripImageMetadata(marked)).toEqual(clean);
  });
});

/** A PNG chunk: big-endian length, type, data, and a CRC (not checked). */
function pngChunk(type: string, data: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, data, Buffer.alloc(4, 0xcc)]);
}
const PNG_SIG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
function ihdr(width: number, height: number): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;
  data[9] = 6;
  return pngChunk('IHDR', data);
}
const png = (...chunks: Buffer[]) => Buffer.concat([PNG_SIG, ...chunks]);
const IDAT = pngChunk('IDAT', Buffer.from('image-data'));
const IEND = pngChunk('IEND');

describe('PNG: size and strip', () => {
  it('readImageSize reads IHDR; a zero side or a first chunk other than IHDR is undefined', () => {
    expect(readImageSize(png(ihdr(300, 200), IDAT, IEND))).toEqual({
      type: 'image/png',
      width: 300,
      height: 200,
    });
    expect(readImageSize(png(ihdr(0, 200), IDAT, IEND))).toBeUndefined();
    expect(readImageSize(png(ihdr(300, 0), IDAT, IEND))).toBeUndefined();
    expect(readImageSize(png(IDAT, ihdr(300, 200), IEND))).toBeUndefined();
    expect(readImageSize(png(ihdr(300, 200)).subarray(0, 30))).toBeUndefined();
  });

  it('drops tEXt, zTXt, iTXt, eXIf and tIME; keeps the allow-listed chunks', () => {
    const keep = [
      pngChunk('gAMA', Buffer.alloc(4, 1)),
      pngChunk('cHRM', Buffer.alloc(32, 2)),
      pngChunk('sRGB', bytes(0)),
      pngChunk('sBIT', Buffer.alloc(4, 8)),
      pngChunk('pHYs', Buffer.alloc(9, 3)),
      pngChunk('PLTE', Buffer.alloc(6, 4)),
      pngChunk('tRNS', Buffer.alloc(2, 5)),
    ];
    const marked = png(
      ihdr(300, 200),
      pngChunk('tEXt', Buffer.from('Author\0TEXT-SECRET')),
      ...keep,
      pngChunk('zTXt', Buffer.from('Z-SECRET')),
      pngChunk('iTXt', Buffer.from('I-SECRET')),
      pngChunk('eXIf', Buffer.from('GPS-SECRET')),
      pngChunk('tIME', Buffer.alloc(7, 9)),
      pngChunk('iCCP', Buffer.from('ICC-SECRET')),
      IDAT,
      IEND,
    );
    const stripped = stripImageMetadata(marked);
    expect(stripped).toEqual(png(ihdr(300, 200), ...keep, IDAT, IEND));
    expect(stripped?.toString('latin1') ?? '').not.toContain('SECRET');
    expect(readImageSize(stripped)).toEqual(readImageSize(marked));
    expect(stripImageMetadata(PNG_1X1)).toEqual(PNG_1X1);
  });

  it('an animated PNG flattens to its first frame', () => {
    const frame = (n: number) => Buffer.alloc(26, n);
    const animated = png(
      ihdr(300, 200),
      pngChunk('acTL', Buffer.alloc(8, 1)),
      pngChunk('fcTL', frame(0)),
      IDAT,
      pngChunk('fcTL', frame(1)),
      pngChunk('fdAT', Buffer.from('second-frame')),
      IEND,
    );
    expect(stripImageMetadata(animated)).toEqual(
      png(ihdr(300, 200), IDAT, IEND),
    );
  });

  it('malformed PNG is undefined: no IEND, data after IEND, IHDR of the wrong length, a chunk past the end, a length over 2^31-1', () => {
    expect(stripImageMetadata(png(ihdr(300, 200), IDAT))).toBeUndefined();
    expect(
      stripImageMetadata(
        Buffer.concat([
          png(ihdr(300, 200), IDAT, IEND),
          Buffer.from('TRAILER'),
        ]),
      ),
    ).toBeUndefined();
    expect(
      stripImageMetadata(
        png(pngChunk('IHDR', Buffer.alloc(14, 1)), IDAT, IEND),
      ),
    ).toBeUndefined();
    const past = png(ihdr(300, 200), IDAT, IEND);
    past.writeUInt32BE(9999, 33);
    expect(stripImageMetadata(past)).toBeUndefined();
    const huge = png(ihdr(300, 200), IDAT, IEND);
    huge.writeUInt32BE(0x80000000, 33);
    expect(stripImageMetadata(huge)).toBeUndefined();
  });
});

describe('PNG: image data and IHDR position', () => {
  it('a PNG with no IDAT left is undefined', () => {
    expect(stripImageMetadata(png(ihdr(300, 200), IEND))).toBeUndefined();
    expect(
      stripImageMetadata(
        png(
          ihdr(300, 200),
          pngChunk('acTL', Buffer.alloc(8, 1)),
          pngChunk('fdAT', Buffer.from('only-frame')),
          IEND,
        ),
      ),
    ).toBeUndefined();
  });

  it('an IHDR anywhere but first is undefined', () => {
    expect(
      stripImageMetadata(png(ihdr(300, 200), IDAT, ihdr(1, 1), IEND)),
    ).toBeUndefined();
    expect(
      stripImageMetadata(png(ihdr(300, 200), ihdr(4000, 4000), IDAT, IEND)),
    ).toBeUndefined();
  });
});

describe('stripImageMetadata: WebP image chunks', () => {
  const header = ['VP8X', vp8xPayload(640, 480, 0x10)] as [string, Buffer];
  // The frame must be the canvas size (PR review M2), so not VP8L_1X1.
  const vp8lPayload = vp8lPayloadOf(640, 480);

  it('VP8X with exactly one VP8 or VP8L is kept', () => {
    for (const image of [
      ['VP8 ', vp8Payload],
      ['VP8L', vp8lPayload],
    ] as [string, Buffer][]) {
      const file = riffChunks([header, image]);
      expect(stripImageMetadata(file)).toEqual(file);
    }
  });

  it('VP8X with no image chunk, two of them, or one of each is undefined', () => {
    for (const chunks of [
      [header, ['ALPH', Buffer.from('ALPHA')]],
      [header, ['EXIF', Buffer.from('GPS-LAT')]],
      [header, ['VP8 ', vp8Payload], ['VP8 ', vp8Payload]],
      [header, ['VP8 ', vp8Payload], ['VP8L', vp8lPayload]],
    ] as [string, Buffer][][]) {
      expect(stripImageMetadata(riffChunks(chunks))).toBeUndefined();
    }
  });
});

describe('stripImageMetadata: WebP', () => {
  it('VP8X: drops EXIF and XMP chunks, clears their flags, rewrites the RIFF size', () => {
    const alph = Buffer.from('ALPHA-ODD'); // odd: padded
    const marked = riffChunks([
      ['VP8X', vp8xPayload(640, 480, 0x10 | 0x08 | 0x04)],
      ['ALPH', alph],
      ['VP8 ', vp8Payload],
      ['EXIF', Buffer.from('GPS-LAT-51.5-ODD')],
      ['XMP ', Buffer.from('<x:xmpmeta>HOME</x:xmpmeta>')],
    ]);
    const stripped = stripImageMetadata(marked);
    expect(stripped).toBeDefined();
    const text = stripped.toString('latin1');
    for (const gone of ['EXIF', 'GPS-LAT', 'XMP ', 'xmpmeta']) {
      expect(text).not.toContain(gone);
    }
    expect(stripped).toEqual(
      riffChunks([
        ['VP8X', vp8xPayload(640, 480, 0x10)],
        ['ALPH', alph],
        ['VP8 ', vp8Payload],
      ]),
    );
    expect(stripped.readUInt32LE(4) + 8).toBe(stripped.length);
    expect(readImageSize(stripped)).toEqual({
      type: 'image/webp',
      width: 640,
      height: 480,
    });
  });

  it('plain VP8 and VP8L come back unchanged', () => {
    expect(stripImageMetadata(vp8(512, 384))).toEqual(vp8(512, 384));
    expect(stripImageMetadata(VP8L_1X1)).toEqual(VP8L_1X1);
  });

  it('malformed WebP is undefined: a chunk past the end, a simple file with a second chunk', () => {
    const truncated = riffChunks([
      ['VP8X', vp8xPayload(640, 480, 0x10)],
      ['VP8 ', vp8Payload],
    ]);
    truncated.writeUInt32LE(9999, 30 + 4);
    expect(stripImageMetadata(truncated)).toBeUndefined();
    const smuggled = riffChunks([
      ['VP8 ', vp8Payload],
      ['EXIF', Buffer.from('GPS-LAT')],
    ]);
    expect(stripImageMetadata(smuggled)).toBeUndefined();
  });

  it('VP8X keeps only VP8X, ALPH, VP8 and VP8L: ICCP and unknown chunks go, and the ICC flag is cleared', () => {
    const marked = riffChunks([
      ['VP8X', vp8xPayload(640, 480, 0x20 | 0x10)],
      ['ICCP', Buffer.from('ICC-PROFILE-SECRET')],
      ['ALPH', Buffer.from('ALPHA')],
      ['VP8 ', vp8Payload],
      ['ZZZZ', Buffer.from('UNKNOWN-CHUNK-SECRET')],
    ]);
    const stripped = stripImageMetadata(marked);
    expect(stripped).toEqual(
      riffChunks([
        ['VP8X', vp8xPayload(640, 480, 0x10)],
        ['ALPH', Buffer.from('ALPHA')],
        ['VP8 ', vp8Payload],
      ]),
    );
    const text = stripped?.toString('latin1') ?? '';
    expect(text).not.toContain('SECRET');
  });

  it('junk and non-Buffers are undefined', () => {
    expect(stripImageMetadata(Buffer.from('<html>'))).toBeUndefined();
    expect(stripImageMetadata(null)).toBeUndefined();
  });
});

describe('readImageSize: everything else', () => {
  it('PNG, empty, 11 bytes of RIFF, 5 MB of 0xFF after FF D8, a non-Buffer', () => {
    expect(readImageSize(PNG_1X1)).toEqual({
      type: 'image/png',
      width: 1,
      height: 1,
    });
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

/** A VP8L payload: signature, 14-bit width-1 and height-1, no alpha, version 0. */
function vp8lPayloadOf(width: number, height: number): Buffer {
  const payload = Buffer.alloc(8);
  payload[0] = 0x2f;
  payload.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 1);
  return payload;
}
const vp8PayloadOf = (width: number, height: number) =>
  vp8(width, height).subarray(20);

describe('stripImageMetadata: VP8X structure (PR review M2)', () => {
  const header = (flags = 0x10): [string, Buffer] => [
    'VP8X',
    vp8xPayload(640, 480, flags),
  ];
  const image: [string, Buffer] = ['VP8 ', vp8PayloadOf(640, 480)];
  const alph: [string, Buffer] = ['ALPH', Buffer.from('ALPHA')];

  it('the well-formed controls are kept: VP8X + ALPH + VP8, VP8X + VP8L of the canvas size', () => {
    expect(stripImageMetadata(riffChunks([header(), alph, image]))).toEqual(
      riffChunks([header(), alph, image]),
    );
    const lossless = riffChunks([header(0), ['VP8L', vp8lPayloadOf(640, 480)]]);
    expect(stripImageMetadata(lossless)).toEqual(lossless);
  });

  it('a second VP8X chunk is undefined, wherever it is', () => {
    for (const chunks of [
      [header(), header(), image],
      [header(), image, header()],
      [header(), ['VP8X', vp8xPayload(320, 240, 0x10)], alph, image],
    ] as [string, Buffer][][]) {
      expect(stripImageMetadata(riffChunks(chunks))).toBeUndefined();
    }
  });

  it('more than one ALPH chunk is undefined', () => {
    expect(
      stripImageMetadata(riffChunks([header(), alph, alph, image])),
    ).toBeUndefined();
    expect(
      stripImageMetadata(riffChunks([header(), alph, image, alph])),
    ).toBeUndefined();
  });

  it('an ALPH chunk without the VP8X alpha flag (0x10) is undefined', () => {
    expect(
      stripImageMetadata(riffChunks([header(0x00), alph, image])),
    ).toBeUndefined();
    expect(
      stripImageMetadata(riffChunks([header(0x20), alph, image])),
    ).toBeUndefined();
  });

  it('a VP8 or VP8L frame whose size is not the VP8X canvas is undefined', () => {
    for (const frame of [
      ['VP8 ', vp8PayloadOf(512, 384)],
      ['VP8 ', vp8PayloadOf(640, 479)],
      ['VP8 ', vp8PayloadOf(641, 480)],
      ['VP8L', vp8lPayloadOf(1, 1)],
      ['VP8L', vp8lPayloadOf(640, 481)],
    ] as [string, Buffer][]) {
      expect(stripImageMetadata(riffChunks([header(), frame]))).toBeUndefined();
    }
  });

  it('an inner frame header that does not parse is undefined', () => {
    const noStartCode = Buffer.from(vp8PayloadOf(640, 480));
    noStartCode[3] = 0x00;
    const interFrame = Buffer.from(vp8PayloadOf(640, 480));
    interFrame[0] |= 0x01;
    const shortVp8 = vp8PayloadOf(640, 480).subarray(0, 9);
    const badSignature = Buffer.from(vp8lPayloadOf(640, 480));
    badSignature[0] = 0x2e;
    const shortVp8l = vp8lPayloadOf(640, 480).subarray(0, 4);
    for (const frame of [
      ['VP8 ', noStartCode],
      ['VP8 ', interFrame],
      ['VP8 ', shortVp8],
      ['VP8L', badSignature],
      ['VP8L', shortVp8l],
    ] as [string, Buffer][]) {
      expect(stripImageMetadata(riffChunks([header(), frame]))).toBeUndefined();
    }
  });
});

describe('stripImageMetadata: JPEG frames and tables (PR review M3)', () => {
  /** DQT: one 8-bit table (Pq 0) is 65 bytes, one 16-bit table (Pq 1) is 129. */
  const dqt8 = (id: number) => Buffer.concat([bytes(id), Buffer.alloc(64, 1)]);
  const dqt16 = (id: number) =>
    Buffer.concat([bytes(0x10 | id), Buffer.alloc(128, 1)]);
  /** DHT: class/id, 16 counts, then as many values as the counts add up to. */
  const dht = (classId: number, counts: number[]) => {
    const sixteen = Buffer.alloc(16);
    counts.forEach((count, i) => {
      sixteen[i] = count;
    });
    const total = counts.reduce((a, b) => a + b, 0);
    return Buffer.concat([bytes(classId), sixteen, Buffer.alloc(total, 5)]);
  };
  const file = (...tables: Buffer[]) =>
    jpeg(APP0, ...tables, sof(0xc0, 800, 600), SOS_TO_END);

  it('a JPEG with two SOF segments is undefined', () => {
    expect(
      stripImageMetadata(
        jpeg(APP0, sof(0xc0, 800, 600), sof(0xc0, 800, 600), SOS_TO_END),
      ),
    ).toBeUndefined();
    expect(
      stripImageMetadata(
        jpeg(APP0, sof(0xc0, 800, 600), sof(0xc2, 16, 16), SOS_TO_END),
      ),
    ).toBeUndefined();
    // The single-SOF control.
    expect(
      stripImageMetadata(jpeg(APP0, sof(0xc0, 800, 600), SOS_TO_END)),
    ).toBeDefined();
  });

  it('well-formed DQT and DHT segments are kept, one or several tables each', () => {
    const tables = [
      segment(0xdb, dqt8(0)),
      segment(0xdb, Buffer.concat([dqt8(1), dqt16(2)])),
      segment(0xc4, dht(0x00, [0, 1, 5, 1, 1, 1, 1, 1, 1])),
      segment(0xc4, Buffer.concat([dht(0x10, [0, 2, 1]), dht(0x01, [1])])),
    ];
    const ok = file(...tables);
    expect(stripImageMetadata(ok)).toEqual(ok);
  });

  it('a DQT whose length does not match its tables is undefined', () => {
    for (const payload of [
      Buffer.alloc(64, 1), // one short
      Buffer.concat([dqt8(0), bytes(0)]), // a stray byte
      Buffer.concat([bytes(0x10), Buffer.alloc(64, 1)]), // Pq 1 needs 128
      Buffer.concat([bytes(0x20), Buffer.alloc(64, 1)]), // Pq 2 does not exist
      Buffer.alloc(0),
    ]) {
      expect(stripImageMetadata(file(segment(0xdb, payload)))).toBeUndefined();
    }
  });

  it('a DHT whose length does not match its counts is undefined', () => {
    for (const payload of [
      dht(0x00, [0, 1, 5]).subarray(0, 20), // values cut short
      Buffer.concat([dht(0x00, [1]), bytes(9)]), // a stray byte
      Buffer.alloc(16), // no room for 16 counts
      dht(0x00, [255, 255]), // more than 256 codes
      Buffer.alloc(0),
    ]) {
      expect(stripImageMetadata(file(segment(0xc4, payload)))).toBeUndefined();
    }
  });

  it('a malformed table between scans is undefined too', () => {
    const SOS = bytes(
      0xff,
      0xda,
      0x00,
      0x08,
      0x01,
      0x01,
      0x00,
      0x00,
      0x3f,
      0x00,
    );
    const twoScans = (table: Buffer) =>
      jpeg(
        APP0,
        sof(0xc2, 800, 600),
        SOS,
        Buffer.from('scan-one'),
        table,
        SOS,
        Buffer.from('scan-two'),
        bytes(0xff, 0xd9),
      );
    expect(stripImageMetadata(twoScans(segment(0xdb, dqt8(0))))).toBeDefined();
    expect(
      stripImageMetadata(twoScans(segment(0xdb, Buffer.alloc(10, 1)))),
    ).toBeUndefined();
    expect(
      stripImageMetadata(twoScans(segment(0xc4, Buffer.alloc(10, 1)))),
    ).toBeUndefined();
  });
});

describe('stripImageMetadata: real Chrome canvas output still passes', () => {
  it('opaque WebP (VP8X + ICCP + VP8) loses ICCP and its flag, keeps 24x16', () => {
    const stripped = stripImageMetadata(CHROME_WEBP_OPAQUE);
    expect(stripped).toBeDefined();
    expect(stripped?.toString('latin1')).not.toContain('ICCP');
    expect(stripped?.[20]).toBe(0x00);
    expect(readImageSize(stripped)).toEqual({
      type: 'image/webp',
      width: 24,
      height: 16,
    });
  });

  it('WebP with transparency (VP8X + ICCP + ALPH + VP8) keeps ALPH and the alpha flag', () => {
    const stripped = stripImageMetadata(CHROME_WEBP_ALPHA);
    expect(stripped).toBeDefined();
    const text = stripped?.toString('latin1') ?? '';
    expect(text).toContain('ALPH');
    expect(text).not.toContain('ICCP');
    expect(stripped?.[20]).toBe(0x10);
    expect(readImageSize(stripped)).toEqual({
      type: 'image/webp',
      width: 24,
      height: 16,
    });
  });

  it('JPEG (APP0, ICC APP2, DQT, SOF0, DHT) loses the ICC segment, keeps 24x16', () => {
    const stripped = stripImageMetadata(CHROME_JPEG);
    expect(stripped).toBeDefined();
    expect(stripped?.toString('latin1')).not.toContain('ICC_PROFILE');
    expect(readImageSize(stripped)).toEqual({
      type: 'image/jpeg',
      width: 24,
      height: 16,
    });
  });
});
