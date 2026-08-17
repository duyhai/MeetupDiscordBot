import { describe, expect, it } from 'vitest';

import { buildReportAttachment } from '../../../src/commands/meetup/identityReport.js';
import { IdentityChangeRecord } from '../../../src/lib/repositories/identityTypes.js';

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

describe('buildReportAttachment', () => {
  it('returns html and a dated filename for a normal range', () => {
    const result = buildReportAttachment([change()], 7);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fileName).toMatch(
      /^identity-report-\d{4}-\d{2}-\d{2}\.html$/,
    );
    expect(result.html).toContain('<!doctype html>');
  });

  it('refuses a range too large for Discord to accept', () => {
    const huge = Array.from({ length: 400 }, (_, i) =>
      change({ id: String(i), newThumb: Buffer.alloc(300_000) }),
    );

    const result = buildReportAttachment(huge, 365);

    // Producing a file Discord rejects wastes the whole generation pass and
    // gives the organizer nothing but a confusing upload error.
    expect(result.ok).toBe(false);
    // `=== true` (not truthy `result.ok`): no strictNullChecks in this
    // project, so a plain truthy check doesn't narrow the union down to the
    // `reason` variant reliably — literal equality does.
    if (result.ok === true) return;
    expect(result.reason).toContain('narrower');
  });

  it('still builds a report when there are no changes', () => {
    const result = buildReportAttachment([], 7);

    expect(result.ok).toBe(true);
  });
});
