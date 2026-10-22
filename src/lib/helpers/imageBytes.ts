export type ThumbType = 'image/png' | 'image/jpeg' | 'image/webp';

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/**
 * The served type of a stored thumbnail, from its magic bytes only: PNG,
 * JPEG or WebP. Anything else (GIF, SVG, HTML, PDF, empty) is undefined and
 * is not served. Unlike report.ts's mimeOf, there is no default type.
 */
export function sniffImageType(bytes: Buffer): ThumbType | undefined {
  if (!Buffer.isBuffer(bytes)) {
    return undefined;
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
}

export interface ImageSize {
  type: 'image/webp' | 'image/jpeg' | 'image/png';
  width: number;
  height: number;
}

/**
 * The pixel size from a WebP (VP8, VP8L or a still VP8X), JPEG (SOF) or
 * PNG (IHDR) header, without decoding. Undefined for anything else, or a header that
 * is malformed, truncated, animated or zero-sized. Never throws: every read
 * is length-checked first.
 */
export function readImageSize(bytes: Buffer): ImageSize | undefined {
  if (!Buffer.isBuffer(bytes)) {
    return undefined;
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return jpegSize(bytes);
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return pngSize(bytes);
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return webpSize(bytes);
  }
  return undefined;
}

function sized(
  type: ImageSize['type'],
  width: number,
  height: number,
): ImageSize | undefined {
  return width > 0 && height > 0 ? { type, width, height } : undefined;
}

/**
 * Little-endian offsets: RIFF size at 4 (must cover exactly the rest, so
 * no trailing payload), first chunk FourCC at 12, chunk size at 16, chunk
 * payload from 20.
 */
function webpSize(b: Buffer): ImageSize | undefined {
  if (b.length < 20 || b.readUInt32LE(4) + 8 !== b.length) {
    return undefined;
  }
  const chunk = b.toString('latin1', 12, 16);
  // The first chunk must declare at least the header bytes read below.
  const declared = b.readUInt32LE(16);
  if (chunk === 'VP8 ') {
    // Key frame (bit 0 of the frame tag clear), then the start code; the
    // top two bits of each size are scaling, not size.
    if (
      b.length < 30 ||
      declared < 10 ||
      (b[20] & 0x01) !== 0 ||
      b[23] !== 0x9d ||
      b[24] !== 0x01 ||
      b[25] !== 0x2a
    ) {
      return undefined;
    }
    return sized(
      'image/webp',
      b.readUInt16LE(26) & 0x3fff,
      b.readUInt16LE(28) & 0x3fff,
    );
  }
  if (chunk === 'VP8L') {
    if (b.length < 25 || declared < 5 || b[20] !== 0x2f || b[24] >> 5 !== 0) {
      return undefined;
    }
    const width = 1 + (b[21] | ((b[22] & 0x3f) << 8));
    const height = 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10));
    return sized('image/webp', width, height);
  }
  if (chunk === 'VP8X') {
    if (b.length < 30 || declared < 10 || (b[20] & 0x02) !== 0) {
      return undefined;
    }
    return sized(
      'image/webp',
      1 + b.readUIntLE(24, 3),
      1 + b.readUIntLE(27, 3),
    );
  }
  return undefined;
}

/** SOF markers C0-CF, except DHT (C4), JPG (C8) and DAC (CC). */
const isSof = (marker: number): boolean =>
  marker >= 0xc0 &&
  marker <= 0xcf &&
  marker !== 0xc4 &&
  marker !== 0xc8 &&
  marker !== 0xcc;

/**
 * A bounded marker walk from offset 2. Each step advances at least two
 * bytes; a segment must fit inside the buffer. SOS or EOI before a SOF
 * means no size.
 */
function jpegSize(b: Buffer): ImageSize | undefined {
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) {
      return undefined;
    }
    let q = p + 1;
    while (q < b.length && b[q] === 0xff) {
      q += 1;
    }
    if (q >= b.length) {
      return undefined;
    }
    const marker = b[q];
    p = q + 1;
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      continue;
    }
    if (marker === 0x00 || marker === 0xd9 || marker === 0xda) {
      return undefined;
    }
    if (p + 2 > b.length) {
      return undefined;
    }
    const length = b.readUInt16BE(p);
    if (length < 2 || p + length > b.length) {
      return undefined;
    }
    if (isSof(marker)) {
      // Length, precision, height, width: 7 bytes at least.
      if (length < 7) {
        return undefined;
      }
      return sized('image/jpeg', b.readUInt16BE(p + 5), b.readUInt16BE(p + 3));
    }
    p += length;
  }
  return undefined;
}

/** PNG chunks are at most 2^31-1 bytes (the PNG spec). */
const PNG_MAX_CHUNK = 0x7fffffff;

/** IHDR first, 13 bytes: width at 16, height at 20, big-endian. */
function pngSize(b: Buffer): ImageSize | undefined {
  if (
    b.length < 33 ||
    b.readUInt32BE(8) !== 13 ||
    b.toString('latin1', 12, 16) !== 'IHDR'
  ) {
    return undefined;
  }
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  if (width > PNG_MAX_CHUNK || height > PNG_MAX_CHUNK) {
    return undefined;
  }
  return sized('image/png', width, height);
}

/**
 * The same image without its metadata: container-level byte surgery, no
 * decoding, keeping only allow-listed parts. Undefined for anything that is
 * not a well-formed JPEG, WebP or PNG, or whose size readImageSize cannot
 * read afterwards. Controller ruling 2026-10-22 (D14): the server strips
 * rather than refuses, as Safari's canvas JPEG may carry a minimal EXIF
 * APP1.
 */
export function stripImageMetadata(bytes: Buffer): Buffer | undefined {
  const size = Buffer.isBuffer(bytes) ? readImageSize(bytes) : undefined;
  if (size === undefined) {
    return undefined;
  }
  const stripped =
    size.type === 'image/jpeg'
      ? stripJpeg(bytes)
      : size.type === 'image/png'
        ? stripPng(bytes)
        : stripWebp(bytes);
  return stripped !== undefined && readImageSize(stripped) !== undefined
    ? stripped
    : undefined;
}

/**
 * Before SOS: APP0 (JFIF), APP14 (Adobe colour transform), DQT, DHT, DAC,
 * DRI and the SOF markers. Every other segment is dropped.
 */
const keptBeforeScan = (marker: number): boolean =>
  marker === 0xe0 ||
  marker === 0xee ||
  marker === 0xdb ||
  marker === 0xc4 ||
  marker === 0xcc ||
  marker === 0xdd ||
  marker === 0xda ||
  isSof(marker);

/**
 * An APP0 or APP14 is kept only in the one form a canvas encoder writes:
 * JFIF APP0 of length 16 with a 0x0 thumbnail (Chrome and ImageIO), and
 * Adobe APP14 of length 14. Any other APP0 or APP14 is dropped; decoders
 * need neither. `q` is the marker byte; the payload starts at q + 3.
 */
function appSegmentKept(
  b: Buffer,
  q: number,
  marker: number,
  length: number,
): boolean {
  if (marker === 0xe0) {
    return (
      length === 16 &&
      b.toString('latin1', q + 3, q + 8) === 'JFIF\0' &&
      b[q + 15] === 0 &&
      b[q + 16] === 0
    );
  }
  if (marker === 0xee) {
    return length === 14 && b.toString('latin1', q + 3, q + 8) === 'Adobe';
  }
  return true;
}

/** Between scans: SOS, DHT, DQT, DRI and DNL. */
const keptBetweenScans = (marker: number): boolean =>
  marker === 0xda ||
  marker === 0xc4 ||
  marker === 0xdb ||
  marker === 0xdd ||
  marker === 0xdc;

/** APP0-APP15 and COM: dropped wherever they are. */
const isAppOrComment = (marker: number): boolean =>
  (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;

/**
 * The end of one scan's entropy data, starting at `p`: the offset of the
 * next marker's 0xFF. FF 00 (a stuffed byte), RST0-7 and FF fill bytes stay
 * inside the scan. Undefined when the data runs out first.
 */
function entropyEnd(b: Buffer, p: number): number | undefined {
  let e = p;
  while (e + 1 < b.length) {
    if (b[e] !== 0xff) {
      e += 1;
      continue;
    }
    const next = b[e + 1];
    if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
      e += 2;
    } else if (next === 0xff) {
      e += 1;
    } else {
      return e;
    }
  }
  return undefined;
}

/**
 * Walks the whole file. Before the first SOS, only allow-listed segments
 * are kept; after it, the scans and the tables between them are kept,
 * APPn and COM are dropped, and anything else is malformed. Output ends at
 * EOI, so nothing after it survives; no EOI is malformed.
 */
function stripJpeg(b: Buffer): Buffer | undefined {
  const kept: Buffer[] = [b.subarray(0, 2)];
  let p = 2;
  let afterScan = false;
  for (;;) {
    if (p >= b.length || b[p] !== 0xff) {
      return undefined;
    }
    let q = p + 1;
    while (q < b.length && b[q] === 0xff) {
      q += 1;
    }
    if (q >= b.length) {
      return undefined;
    }
    const marker = b[q];
    if (marker === 0xd9) {
      if (!afterScan) {
        return undefined;
      }
      kept.push(b.subarray(q - 1, q + 1));
      return Buffer.concat(kept);
    }
    if (
      marker === 0x00 ||
      marker === 0x01 ||
      marker === 0xd8 ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      q + 3 > b.length
    ) {
      return undefined;
    }
    const length = b.readUInt16BE(q + 1);
    const end = q + 1 + length;
    if (length < 2 || end > b.length) {
      return undefined;
    }
    if (
      afterScan
        ? keptBetweenScans(marker)
        : keptBeforeScan(marker) && appSegmentKept(b, q, marker, length)
    ) {
      kept.push(b.subarray(q - 1, end));
    } else if (afterScan && !isAppOrComment(marker)) {
      return undefined;
    }
    p = end;
    if (marker === 0xda) {
      afterScan = true;
      const scanEnd = entropyEnd(b, p);
      if (scanEnd === undefined) {
        return undefined;
      }
      kept.push(b.subarray(p, scanEnd));
      p = scanEnd;
    }
  }
}

/** The VP8X chunks kept: the header, alpha and the image itself. */
const WEBP_KEPT_CHUNKS = new Set(['VP8X', 'ALPH', 'VP8 ', 'VP8L']);
/** VP8X flags for chunks never kept: ICC (0x20), EXIF (0x08) and XMP (0x04). */
const VP8X_DROPPED_FLAGS = 0x20 | 0x08 | 0x04;

/**
 * The chunks must tile the RIFF body exactly (each padded to an even
 * length). A simple (VP8 or VP8L) file is that one chunk only, returned
 * unchanged. A VP8X file must hold exactly one VP8 or VP8L chunk; it keeps
 * only WEBP_KEPT_CHUNKS, loses the flags of what was dropped, and gets a
 * new RIFF size.
 */
function stripWebp(b: Buffer): Buffer | undefined {
  const chunks: { fourCC: string; start: number; end: number }[] = [];
  let p = 12;
  while (p < b.length) {
    if (p + 8 > b.length) {
      return undefined;
    }
    const size = b.readUInt32LE(p + 4);
    const end = p + 8 + size + (size % 2);
    if (end > b.length) {
      return undefined;
    }
    chunks.push({ fourCC: b.toString('latin1', p, p + 4), start: p, end });
    p = end;
  }
  const first = chunks[0]?.fourCC;
  if (first !== 'VP8X') {
    return chunks.length === 1 ? b : undefined;
  }
  const kept = chunks
    .filter((c) => WEBP_KEPT_CHUNKS.has(c.fourCC))
    .map((c) => Buffer.from(b.subarray(c.start, c.end)));
  const images = chunks.filter(
    (c) => c.fourCC === 'VP8 ' || c.fourCC === 'VP8L',
  ).length;
  if (images !== 1) {
    return undefined;
  }
  kept[0][8] &= ~VP8X_DROPPED_FLAGS;
  const head = Buffer.from(b.subarray(0, 12));
  const body = Buffer.concat(kept);
  head.writeUInt32LE(4 + body.length, 4);
  return Buffer.concat([head, body]);
}

/**
 * The PNG chunks kept: image data and colour only. Text, EXIF, time, ICC
 * and the APNG chunks (acTL, fcTL, fdAT) go, so an animated PNG becomes its
 * default image.
 */
const PNG_KEPT_CHUNKS = new Set([
  'IHDR',
  'PLTE',
  'tRNS',
  'IDAT',
  'IEND',
  'gAMA',
  'cHRM',
  'sRGB',
  'sBIT',
  'pHYs',
]);

/**
 * Walks every chunk (length, type, data, CRC): IHDR first with length 13
 * and nowhere else, IEND last with nothing after it, at least one IDAT;
 * whole allow-listed chunks are copied.
 */
function stripPng(b: Buffer): Buffer | undefined {
  const kept: Buffer[] = [b.subarray(0, 8)];
  let sawImageData = false;
  let p = 8;
  while (p + 12 <= b.length) {
    const length = b.readUInt32BE(p);
    if (length > PNG_MAX_CHUNK || p + 12 + length > b.length) {
      return undefined;
    }
    const type = b.toString('latin1', p + 4, p + 8);
    const end = p + 12 + length;
    if ((p === 8) !== (type === 'IHDR') || (p === 8 && length !== 13)) {
      return undefined;
    }
    if (type === 'IDAT') {
      sawImageData = true;
    }
    if (PNG_KEPT_CHUNKS.has(type)) {
      kept.push(b.subarray(p, end));
    }
    if (type === 'IEND') {
      return end === b.length && sawImageData ? Buffer.concat(kept) : undefined;
    }
    p = end;
  }
  return undefined;
}
