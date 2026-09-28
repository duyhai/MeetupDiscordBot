import { describe, expect, it } from 'vitest';

import {
  estimateReportBytes,
  renderIdentityReport,
} from '../../../src/lib/helpers/identityReport.js';
import { IdentityChangeRecord } from '../../../src/lib/repositories/identityTypes.js';

const range = {
  from: new Date('2026-08-10T00:00:00Z'),
  to: new Date('2026-08-17T00:00:00Z'),
};

const change = (
  over: Partial<IdentityChangeRecord> = {},
): IdentityChangeRecord => ({
  id: '1',
  discordUserId: 'u1',
  field: 'user_avatar',
  oldValue: 'aaa',
  newValue: 'bbb',
  oldThumb: Buffer.from([1, 2, 3]),
  newThumb: Buffer.from([4, 5, 6]),
  detectedAt: new Date('2026-08-16T14:02:00Z'),
  source: 'event',
  ...over,
});

describe('renderIdentityReport', () => {
  it('embeds thumbnails as data uris', () => {
    const html = renderIdentityReport([change()], range);

    // The whole point of storing bytes: the file must render in a year,
    // with no dependency on Discord's CDN, which purges old avatars.
    expect(html).toContain('data:image/webp;base64,AQID');
    expect(html).not.toContain('cdn.discordapp.com');
  });

  it('escapes html in names so a crafted nickname cannot inject markup', () => {
    const html = renderIdentityReport(
      [
        change({
          field: 'nickname',
          oldValue: '<script>alert(1)</script>',
          newValue: 'x',
          oldThumb: null,
          newThumb: null,
        }),
      ],
      range,
    );

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders a placeholder when a thumbnail is missing', () => {
    const html = renderIdentityReport(
      [change({ oldThumb: null, newThumb: null })],
      range,
    );

    // Best-effort thumbs mean nulls are normal; the row must still render.
    expect(html).toContain('no image');
  });

  it('is a complete standalone document', () => {
    const html = renderIdentityReport([change()], range);

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('</html>');
    // No external stylesheet or script may be referenced.
    expect(html).not.toMatch(/<link[^>]+href="http/);
    expect(html).not.toMatch(/<script[^>]+src=/);
  });

  it('reports an empty range without crashing', () => {
    const html = renderIdentityReport([], range);

    expect(html).toContain('No identity changes');
  });

  it('escapes html in the source field', () => {
    const html = renderIdentityReport(
      [change({ source: '<b>event</b>' as IdentityChangeRecord['source'] })],
      range,
    );

    expect(html).not.toContain('<b>event</b>');
    expect(html).toContain('&lt;b&gt;event&lt;/b&gt;');
  });

  it('escapes html in the discord user id shown in the member column', () => {
    const html = renderIdentityReport(
      [change({ discordUserId: '<img src=x onerror=alert(1)>' })],
      range,
    );

    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('estimateReportBytes', () => {
  it('grows with thumbnail size', () => {
    const small = estimateReportBytes([change()]);
    const big = estimateReportBytes([
      change({ newThumb: Buffer.alloc(100_000) }),
    ]);

    // Used to refuse ranges Discord would reject at upload time.
    expect(big).toBeGreaterThan(small);
  });
});
