import { describe, expect, it } from 'vitest';

import {
  collectUnlinkedMemberIds,
  formatUnlinkedDigest,
  shouldRunDigestNow,
} from '../../../src/lib/helpers/unlinkedDigest.js';
import { MemberRecord } from '../../../src/lib/repositories/types.js';

const linkedRow = (discordUserId: string): MemberRecord => ({
  discordUserId,
  meetupId: `meetup-${discordUserId}`,
  meetupName: 'x',
  meetupMemberUrl: 'x',
  onboardMethod: 'self_onboard',
  onboardedBy: null,
  firstOnboardedAt: new Date(),
  lastSyncedAt: new Date(),
});

const manualRow = (discordUserId: string): MemberRecord => ({
  ...linkedRow(discordUserId),
  meetupId: null,
  onboardMethod: 'manual',
});

describe('shouldRunDigestNow', () => {
  it('fires only during the 17:00 UTC hour', () => {
    expect(shouldRunDigestNow(new Date('2026-08-14T17:30:00Z'))).toBe(true);
    expect(shouldRunDigestNow(new Date('2026-08-14T16:59:00Z'))).toBe(false);
    expect(shouldRunDigestNow(new Date('2026-08-14T18:00:00Z'))).toBe(false);
  });
});

describe('collectUnlinkedMemberIds', () => {
  it('flags verified humans with no row or a null-meetup row', () => {
    const members = [
      { id: 'linked', isBot: false, hasOnboardingRole: false },
      { id: 'norow', isBot: false, hasOnboardingRole: false },
      { id: 'manual', isBot: false, hasOnboardingRole: false },
      { id: 'bot', isBot: true, hasOnboardingRole: false },
      { id: 'newbie', isBot: false, hasOnboardingRole: true },
    ];
    const rows = [linkedRow('linked'), manualRow('manual')];

    expect(collectUnlinkedMemberIds(members, rows)).toEqual([
      'norow',
      'manual',
    ]);
  });
});

describe('formatUnlinkedDigest', () => {
  it('returns undefined when everyone is linked', () => {
    expect(formatUnlinkedDigest([])).toBeUndefined();
  });

  it('lists members and caps at 50 with an overflow note', () => {
    const few = formatUnlinkedDigest(['a', 'b']);
    expect(few?.title).toContain('2');
    expect(few?.description).toContain('<@a>');
    expect(few?.description).toContain('<@b>');

    const ids = Array.from({ length: 120 }, (_, i) => `user-${i}`);
    const many = formatUnlinkedDigest(ids);
    expect(many?.title).toContain('120');
    expect(many?.description).toContain('<@user-49>');
    expect(many?.description).not.toContain('<@user-50>');
    expect(many?.description).toContain('…and 70 more');
  });
});
