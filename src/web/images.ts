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
