import { describe, expect, it } from 'vitest';

import {
  estimateReportBytes,
  renderIdentityReport,
} from '../../../../src/lib/helpers/identity/report.js';
import { IdentityChangeRecord } from '../../../../src/lib/repositories/identityTypes.js';

const range = {
  from: new Date('2026-08-10T00:00:00Z'),
  to: new Date('2026-08-17T00:00:00Z'),
};

const change = (
  over: Partial<IdentityChangeRecord> = {},
): IdentityChangeRecord => ({
  id: '1',
  platform: 'discord',
  scopeId: 'g1',
  subjectId: 'u1',
  field: 'user_avatar',
  oldValue: 'aaa',
  newValue: 'bbb',
  oldThumb: Buffer.from([1, 2, 3]),
  newThumb: Buffer.from([4, 5, 6]),
  detectedAt: new Date('2026-08-16T14:02:00Z'),
  source: 'sweep',
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
      [change({ subjectId: '<img src=x onerror=alert(1)>' })],
      range,
    );

    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('renders a Meetup row with its platform column and thumbnail', () => {
    const html = renderIdentityReport(
      [
        change({
          platform: 'meetup',
          subjectId: 'm1',
          field: 'photo',
          oldThumb: null,
          newThumb: Buffer.from([7, 8, 9]),
        }),
      ],
      range,
    );

    expect(html).toContain('<th>Platform</th>');
    expect(html).toContain('Meetup');
    expect(html).toContain('Profile photo');
    // The new photo's bytes render as an image; the old one -- unrecoverable
    // for a Meetup photo change -- falls back to the same placeholder as a
    // failed Discord CDN fetch.
    expect(html).toContain('data:image/webp;base64,');
    expect(html).toContain('no image');
  });

  it('labels JPEG thumbnails as JPEG', () => {
    // Meetup serves JPEG, not WebP. The hardcoded image/webp made every
    // Meetup photo change render as a broken image in a document whose whole
    // purpose is showing organizers the before and after.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const html = renderIdentityReport(
      [change({ platform: 'meetup', oldThumb: null, newThumb: jpeg })],
      range,
    );

    expect(html).toContain('data:image/jpeg;base64,');
    expect(html).not.toContain('data:image/webp;base64,/9j');
  });

  it('labels PNG thumbnails as PNG', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const html = renderIdentityReport([change({ newThumb: png })], range);

    expect(html).toContain('data:image/png;base64,');
  });

  it('labels a RIFF/WEBP thumbnail as WebP', () => {
    const webp = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('WEBP', 'ascii'),
      Buffer.from([1, 2, 3]),
    ]);
    const html = renderIdentityReport([change({ newThumb: webp })], range);

    expect(html).toContain('data:image/webp;base64,');
  });

  it('resolves a Meetup id to its linked Discord account', () => {
    const html = renderIdentityReport(
      [change({ platform: 'meetup', subjectId: '404060606', field: 'photo' })],
      range,
      new Map([['404060606', 'discord-1']]),
    );

    // The spec promises this mapping on BOTH surfaces. Only the digest had
    // it; the report showed a bare 9-digit id, which is exactly the
    // "member 404060606 changed their photo" the mapping exists to avoid.
    expect(html).toContain('discord-1');
    // The raw id must survive alongside it -- it is what an organizer needs
    // to search Meetup with, so resolving has to add, not replace.
    expect(html).toContain('404060606');
    // Mention markup is inert in a static HTML file.
    expect(html).not.toContain('<@');
  });

  it('falls back to the raw Meetup id when the member is not linked', () => {
    const html = renderIdentityReport(
      [change({ platform: 'meetup', subjectId: '404060606', field: 'photo' })],
      range,
      new Map(),
    );

    expect(html).toContain('404060606');
    expect(html).not.toContain('undefined');
  });

  it('leaves a Discord row showing its own user id', () => {
    const html = renderIdentityReport(
      [change({ platform: 'discord', subjectId: 'u1' })],
      range,
      new Map([['u1', 'someone-else']]),
    );

    // The map is keyed by MEETUP id. A Discord subject id that happens to
    // collide with one must not be rewritten into another member's name.
    expect(html).toContain('u1');
    expect(html).not.toContain('someone-else');
  });

  it('escapes a hostile linked Discord id', () => {
    const html = renderIdentityReport(
      [change({ platform: 'meetup', subjectId: 'm1', field: 'photo' })],
      range,
      new Map([['m1', '<img src=x onerror=alert(1)>']]),
    );

    // The mapped value comes from the members table, which is populated from
    // user-controlled linking -- it is no more trusted than a nickname.
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('does not throw on an unrecognised field from an older row', () => {
    const html = renderIdentityReport(
      [
        change({
          field: 'legacy_field' as never,
          oldThumb: null,
          newThumb: null,
        }),
      ],
      range,
    );

    // FIELD_LABELS lookup yields undefined, and this project builds without
    // strictNullChecks -- escapeHtml guarding only null would throw on
    // .replace and destroy the entire report.
    expect(html).toContain('<!doctype html>');
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
