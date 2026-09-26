import { describe, expect, it } from 'vitest';

import { parseAndDedupeMemberIds } from '../../../src/commands/meetup/recordSuspension.js';

describe('parseAndDedupeMemberIds', () => {
  it('splits, trims, and returns numeric IDs unchanged', () => {
    const { memberIds, dedupedCount } =
      parseAndDedupeMemberIds(' 123 , 456,789 ');
    expect(memberIds).toEqual(['123', '456', '789']);
    expect(dedupedCount).toBe(0);
  });

  it('dedupes, keeping the first occurrence', () => {
    const { memberIds, dedupedCount } = parseAndDedupeMemberIds('123,456,123');
    expect(memberIds).toEqual(['123', '456']);
    expect(dedupedCount).toBe(1);
  });

  it('rejects a token that is not purely numeric, naming it', () => {
    // "123 456" with no comma between them must not silently become one
    // bogus ID -- it should fail loudly instead.
    expect(() => parseAndDedupeMemberIds('123 456')).toThrow(/123 456/);
  });

  it('rejects a non-numeric token such as a pasted name', () => {
    expect(() => parseAndDedupeMemberIds('123,alice')).toThrow(/alice/);
  });

  it('rejects an empty list', () => {
    expect(() => parseAndDedupeMemberIds(' , , ')).toThrow(/no member IDs/i);
  });
});
