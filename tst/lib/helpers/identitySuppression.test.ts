import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearIdentityWriteSuppression,
  isIdentityWriteSuppressed,
  releaseIdentityWriteSuppression,
  suppressIdentityWrites,
} from '../../../src/lib/helpers/identitySuppression.js';

describe('identity write suppression', () => {
  beforeEach(() => {
    clearIdentityWriteSuppression();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('reports an unknown member as not suppressed', () => {
    expect(isIdentityWriteSuppressed('u1')).toBe(false);
  });

  it('suppresses a member the bot is writing', () => {
    suppressIdentityWrites('u1');

    expect(isIdentityWriteSuppressed('u1')).toBe(true);
  });

  it('suppresses only the named member', () => {
    suppressIdentityWrites('u1');

    // A global flag would blind the digest to every other member's changes
    // for the duration of one onboarding.
    expect(isIdentityWriteSuppressed('u2')).toBe(false);
  });

  it('keeps suppressing briefly after release, for the in-flight event', () => {
    suppressIdentityWrites('u1');
    releaseIdentityWriteSuppression('u1');

    // The gateway event the bot's own write triggered can arrive after the
    // REST call returns; clearing instantly would reopen the exact race this
    // exists to close.
    vi.advanceTimersByTime(1_000);
    expect(isIdentityWriteSuppressed('u1')).toBe(true);
  });

  it('stops suppressing a few seconds after release', () => {
    suppressIdentityWrites('u1');
    releaseIdentityWriteSuppression('u1');

    vi.advanceTimersByTime(6_000);
    expect(isIdentityWriteSuppressed('u1')).toBe(false);
  });

  it('expires on its own if onboarding never releases', () => {
    suppressIdentityWrites('u1');

    // Onboarding can throw between the write and the release. A permanently
    // suppressed member would never appear in the digest again.
    vi.advanceTimersByTime(31_000);
    expect(isIdentityWriteSuppressed('u1')).toBe(false);
  });

  it('release never extends an entry past its hard expiry', () => {
    suppressIdentityWrites('u1');
    vi.advanceTimersByTime(29_000);
    releaseIdentityWriteSuppression('u1');

    // Release shortens; it must not push the deadline out to now + 5s.
    vi.advanceTimersByTime(1_500);
    expect(isIdentityWriteSuppressed('u1')).toBe(false);
  });

  it('releasing a member that was never suppressed is a no-op', () => {
    releaseIdentityWriteSuppression('u1');

    expect(isIdentityWriteSuppressed('u1')).toBe(false);
  });
});
