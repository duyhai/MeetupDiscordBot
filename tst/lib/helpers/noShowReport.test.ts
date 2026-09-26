import { describe, expect, it } from 'vitest';

import {
  classifyNoShowCount,
  recommendedSuspensionDays,
} from '../../../src/lib/helpers/noShowReport.js';

describe('classifyNoShowCount', () => {
  it('warns at exactly one and suspends at two or more', () => {
    expect(classifyNoShowCount(1)).toBe('warning');
    expect(classifyNoShowCount(2)).toBe('suspension');
    expect(classifyNoShowCount(5)).toBe('suspension');
  });
});

describe('recommendedSuspensionDays', () => {
  it('starts at 30 and doubles per prior suspension', () => {
    expect(recommendedSuspensionDays(0)).toBe(30);
    expect(recommendedSuspensionDays(1)).toBe(60);
    expect(recommendedSuspensionDays(3)).toBe(240);
  });
});
