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
  if (chunk === 'VP8 ') {
    // Key frame (bit 0 of the frame tag clear), then the start code; the
    // top two bits of each size are scaling, not size.
    if (
      b.length < 30 ||
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
    if (b.length < 25 || b[20] !== 0x2f || b[24] >> 5 !== 0) {
      return undefined;
    }
    const width = 1 + (b[21] | ((b[22] & 0x3f) << 8));
    const height = 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10));
    return sized('image/webp', width, height);
  }
  if (chunk === 'VP8X') {
    if (b.length < 30 || (b[20] & 0x02) !== 0) {
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
