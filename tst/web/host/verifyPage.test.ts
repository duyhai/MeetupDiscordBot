import { describe, expect, it } from 'vitest';

import {
  VERIFY_MARK,
  joinFlags,
  joinOf,
} from '../../../src/web/host/verifyPage.js';

const TAG = 'A'.repeat(22);
const ID = '123456789012345678';

describe('VERIFY_MARK', () => {
  it('reads a mark without ".r" (sealed before refreshes were marked) as not a refresh', () => {
    const parsed = VERIFY_MARK.exec(`verify.${TAG}.${ID}.x`);
    expect(parsed?.slice(1)).toEqual([TAG, ID, 'x', undefined]);
  });

  it('reads ".r" as a refresh, after any join flags', () => {
    for (const flags of ['x', 'f', 'jp', 'j-', '-p', '--']) {
      const parsed = VERIFY_MARK.exec(`verify.${TAG}.${ID}.${flags}.r`);
      expect(parsed?.slice(1)).toEqual([TAG, ID, flags, '.r']);
    }
  });

  it('rejects a doubled ".r", a stray suffix, or a missing join flag', () => {
    for (const mark of [
      `verify.${TAG}.${ID}.x.r.r`,
      `verify.${TAG}.${ID}.x.rr`,
      `verify.${TAG}.${ID}.x.q`,
      `verify.${TAG}.${ID}.x.`,
      `verify.${TAG}.${ID}.xr`,
      `verify.${TAG}.${ID}.r`,
      `verify.${TAG}.${ID}`,
    ]) {
      expect(VERIFY_MARK.test(mark), mark).toBe(false);
    }
  });

  it('carries every join result through its flags', () => {
    for (const join of [
      undefined,
      'failed' as const,
      { joined: true, pending: true },
      { joined: true, pending: false },
      { joined: false, pending: false },
    ]) {
      expect(joinOf(joinFlags(join))).toEqual(join);
    }
  });
});
