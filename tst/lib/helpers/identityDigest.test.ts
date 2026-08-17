import { describe, expect, it } from 'vitest';

import {
  annotateReverts,
  formatIdentityDigest,
} from '../../../src/lib/helpers/identityDigest.js';
import { IdentityChangeRecord } from '../../../src/lib/repositories/identityTypes.js';

const at = (iso: string) => new Date(iso);

const change = (
  over: Partial<IdentityChangeRecord> = {},
): IdentityChangeRecord => ({
  id: '1',
  discordUserId: 'u1',
  field: 'user_avatar',
  oldValue: 'aaa',
  newValue: 'bbb',
  oldThumb: null,
  newThumb: null,
  detectedAt: at('2026-08-16T14:02:00Z'),
  source: 'event',
  ...over,
});

const stats = { changeCount: 1204, totalBytes: 64_000_000 };

describe('annotateReverts', () => {
  it('marks a change that was undone later the same day', () => {
    const out = annotateReverts([
      change({ id: '1', oldValue: 'aaa', newValue: 'bbb' }),
      change({
        id: '2',
        oldValue: 'bbb',
        newValue: 'aaa',
        detectedAt: at('2026-08-16T18:31:00Z'),
      }),
    ]);

    // A change reverted hours later is far more suspicious than one that
    // stuck, and a daily snapshot diff would miss the pair entirely.
    expect(out[0].revertedAt).toEqual(at('2026-08-16T18:31:00Z'));
  });

  it('leaves a change that stuck unannotated', () => {
    const out = annotateReverts([change()]);

    expect(out[0].revertedAt).toBeUndefined();
  });

  it('annotates only the original, not the change that reverted it', () => {
    const out = annotateReverts([
      change({ id: '1', oldValue: 'aaa', newValue: 'bbb' }),
      change({
        id: '2',
        oldValue: 'bbb',
        newValue: 'aaa',
        detectedAt: at('2026-08-16T18:31:00Z'),
      }),
    ]);

    // Direction matters: without the ordering check the later change matches
    // the earlier one and reports a revert timestamp that precedes it.
    expect(out[0].revertedAt).toEqual(at('2026-08-16T18:31:00Z'));
    expect(out[1].revertedAt).toBeUndefined();
  });

  it("does not treat another member's change as a revert", () => {
    const out = annotateReverts([
      change({ id: '1', discordUserId: 'u1' }),
      change({
        id: '2',
        discordUserId: 'u2',
        oldValue: 'bbb',
        newValue: 'aaa',
        detectedAt: at('2026-08-16T18:31:00Z'),
      }),
    ]);

    expect(out[0].revertedAt).toBeUndefined();
  });
});

describe('formatIdentityDigest', () => {
  it('returns undefined when there were no changes', () => {
    // A silent day must post nothing rather than an empty embed.
    expect(formatIdentityDigest([], stats)).toBeUndefined();
  });

  it('lists each change and reports storage', () => {
    const entry = formatIdentityDigest([change()], stats);

    expect(entry?.title).toContain('1');
    expect(entry?.description).toContain('<@u1>');
    expect(entry?.description).toContain('user avatar');
    expect(entry?.description).toContain('1,204 changes on record');
  });

  it('notes the revert inline', () => {
    const entry = formatIdentityDigest(
      annotateReverts([
        change({ id: '1' }),
        change({
          id: '2',
          oldValue: 'bbb',
          newValue: 'aaa',
          detectedAt: at('2026-08-16T18:31:00Z'),
        }),
      ]),
      stats,
    );

    expect(entry?.description).toContain('reverted');
  });

  it('truncates a flood rather than exceeding the embed limit', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      change({ id: String(i), discordUserId: `u${i}` }),
    );

    const entry = formatIdentityDigest(many, stats);

    // Discord rejects descriptions over 4096 characters outright, which would
    // turn a busy day into no digest at all.
    expect((entry?.description ?? '').length).toBeLessThanOrEqual(4096);
    expect(entry?.description).toContain('more');
  });
});
