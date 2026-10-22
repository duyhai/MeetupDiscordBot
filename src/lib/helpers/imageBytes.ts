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
  type: 'image/webp' | 'image/jpeg';
  width: number;
  height: number;
}

/**
 * The pixel size from a WebP (VP8, VP8L or a still VP8X) or JPEG (SOF)
 * header, without decoding. Undefined for anything else, or a header that
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

/**
 * The same image without its metadata: container-level byte surgery, no
 * decoding. Undefined for anything that is not a well-formed JPEG or WebP
 * (PNG included), or whose size readImageSize cannot read afterwards.
 * Controller ruling 2026-10-22: the server strips rather than refuses, as
 * Safari's canvas JPEG may carry a minimal EXIF APP1.
 */
export function stripImageMetadata(bytes: Buffer): Buffer | undefined {
  if (!Buffer.isBuffer(bytes) || readImageSize(bytes) === undefined) {
    return undefined;
  }
  const stripped = bytes[0] === 0xff ? stripJpeg(bytes) : stripWebp(bytes);
  return stripped !== undefined && readImageSize(stripped) !== undefined
    ? stripped
    : undefined;
}

/**
 * APP1-APP13 and APP15 (EXIF, XMP, ICC, IPTC, ...) and COM are metadata.
 * APP0 (JFIF) and APP14 (Adobe: colour transform) are kept.
 */
const isJpegMetadata = (marker: number): boolean =>
  (marker >= 0xe1 && marker <= 0xed) || marker === 0xef || marker === 0xfe;

/**
 * Walks the segments before SOS, dropping metadata ones; everything from
 * SOS to the end is copied unchanged. Fill bytes before a marker are
 * dropped. Standalone markers before SOS (other than RST) are malformed.
 */
function stripJpeg(b: Buffer): Buffer | undefined {
  const kept: Buffer[] = [b.subarray(0, 2)];
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
    if (marker === 0xda) {
      kept.push(b.subarray(q - 1));
      return Buffer.concat(kept);
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      kept.push(b.subarray(q - 1, q + 1));
      p = q + 1;
      continue;
    }
    if (
      marker === 0x00 ||
      marker === 0x01 ||
      marker === 0xd8 ||
      marker === 0xd9
    ) {
      return undefined;
    }
    if (q + 3 > b.length) {
      return undefined;
    }
    const length = b.readUInt16BE(q + 1);
    const end = q + 1 + length;
    if (length < 2 || end > b.length) {
      return undefined;
    }
    if (!isJpegMetadata(marker)) {
      kept.push(b.subarray(q - 1, end));
    }
    p = end;
  }
  return undefined;
}

const WEBP_METADATA_CHUNKS = new Set(['EXIF', 'XMP ']);
/** VP8X flags: EXIF (0x08) and XMP (0x04) present. */
const VP8X_METADATA_FLAGS = 0x08 | 0x04;

/**
 * The chunks must tile the RIFF body exactly (each padded to an even
 * length). A simple (VP8 or VP8L) file is that one chunk only, returned
 * unchanged. A VP8X file loses its EXIF and XMP chunks and their flags,
 * and gets a new RIFF size.
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
    .filter((c) => !WEBP_METADATA_CHUNKS.has(c.fourCC))
    .map((c) => Buffer.from(b.subarray(c.start, c.end)));
  kept[0][8] &= ~VP8X_METADATA_FLAGS;
  const head = Buffer.from(b.subarray(0, 12));
  const body = Buffer.concat(kept);
  head.writeUInt32LE(4 + body.length, 4);
  return Buffer.concat([head, body]);
}
