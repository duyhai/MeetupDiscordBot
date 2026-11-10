import { describe, expect, it, vi } from 'vitest';

import { MemberRecord } from '../../../src/lib/repositories/types.js';
import {
  COMPANION_LOOKUP_CAP,
  NAMED_COMPANIONS,
  nameCompanions,
} from '../../../src/lib/wrapped/companions.js';
import { Companion } from '../../../src/lib/wrapped/stats.js';

function record(meetupId: string): MemberRecord {
  return {
    discordUserId: `d${meetupId}`,
    meetupId,
    meetupName: `Member ${meetupId}`,
    meetupMemberUrl: null,
    onboardMethod: 'self_onboard',
    onboardedBy: null,
    firstOnboardedAt: new Date(),
    lastSyncedAt: new Date(),
  };
}

function ranked(ids: string[]): Companion[] {
  return ids.map((meetupId, index) => ({
    meetupId,
    sharedCount: ids.length - index,
  }));
}

function deps(linked: string[], absent: string[] = []) {
  const findByMeetupId = vi.fn((meetupId: string) =>
    Promise.resolve(linked.includes(meetupId) ? record(meetupId) : undefined),
  );
  const isPresent = vi.fn((discordUserId: string) =>
    Promise.resolve(!absent.includes(discordUserId)),
  );
  return { findByMeetupId, isPresent };
}

describe('nameCompanions', () => {
  it('names only linked members, in rank order, up to three', async () => {
    const d = deps(['1', '3', '5']);

    const result = await nameCompanions(ranked(['1', '2', '3', '4', '5']), d);

    expect(result).toEqual({
      named: [
        { discordUserId: 'd1', sharedCount: 5 },
        { discordUserId: 'd3', sharedCount: 3 },
        { discordUserId: 'd5', sharedCount: 1 },
      ],
      otherCount: 2,
    });
    expect(NAMED_COMPANIONS).toBe(3);
  });

  it('skips linked members who left the server', async () => {
    const d = deps(['1', '2'], ['d1']);

    const result = await nameCompanions(ranked(['1', '2']), d);

    expect(result).toEqual({
      named: [{ discordUserId: 'd2', sharedCount: 1 }],
      otherCount: 1,
    });
  });

  it('stops after the lookup cap', async () => {
    const ids = Array.from({ length: 40 }, (_, i) => String(i + 1));
    const d = deps([]);

    const result = await nameCompanions(ranked(ids), d);

    expect(d.findByMeetupId).toHaveBeenCalledTimes(COMPANION_LOOKUP_CAP);
    expect(COMPANION_LOOKUP_CAP).toBe(25);
    expect(result).toEqual({ named: [], otherCount: 40 });
  });

  it('stops looking once three are named', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => String(i + 1));
    const d = deps(ids);

    const result = await nameCompanions(ranked(ids), d);

    expect(d.findByMeetupId).toHaveBeenCalledTimes(3);
    expect(result.named).toHaveLength(3);
    expect(result.otherCount).toBe(7);
  });

  it('handles nobody', async () => {
    expect(await nameCompanions([], deps([]))).toEqual({
      named: [],
      otherCount: 0,
    });
  });
});
