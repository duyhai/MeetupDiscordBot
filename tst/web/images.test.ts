import { describe, expect, it } from 'vitest';

import { sniffImageType } from '../../src/web/images.js';
import { JPEG_BYTES, PNG_1X1, WEBP_BYTES } from './routes/pageFakes.js';

describe('sniffImageType', () => {
  it('recognises PNG, JPEG and WebP', () => {
    expect(sniffImageType(PNG_1X1)).toBe('image/png');
    expect(sniffImageType(JPEG_BYTES)).toBe('image/jpeg');
    expect(sniffImageType(WEBP_BYTES)).toBe('image/webp');
  });

  it('refuses everything else', () => {
    const refused = [
      Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">'),
      Buffer.from('<!doctype html><script>alert(1)</script>'),
      Buffer.from('%PDF-1.7\n'),
      Buffer.concat([
        Buffer.from('RIFF', 'latin1'),
        Buffer.from([0x1a, 0, 0, 0]),
        Buffer.from('AVI LIST', 'latin1'),
      ]),
      // A truncated PNG signature and a truncated WebP header.
      PNG_1X1.subarray(0, 7),
      WEBP_BYTES.subarray(0, 11),
      Buffer.alloc(0),
      Buffer.from([0xff, 0xd8]),
    ];
    for (const bytes of refused) {
      expect(sniffImageType(bytes)).toBeUndefined();
    }
  });

  it('refuses a value that is not a Buffer', () => {
    expect(sniffImageType('\x89PNG\r\n\x1a\n' as unknown as Buffer)).toBe(
      undefined,
    );
    expect(sniffImageType(null as never)).toBeUndefined();
  });
});
