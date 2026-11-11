import { describe, expect, it, vi } from 'vitest';

import { MemberRecord } from '../../../src/lib/repositories/types.js';
import { CohortCandidate } from '../../../src/lib/wrapped/cohort.js';
import {
  COHORT_LOOKUP_CAP,
  COMPANION_LOOKUP_CAP,
  NAMED_COHORT,
  NAMED_COMPANIONS,
  nameCohort,
  nameCompanions,
  nameRanked,
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
    sharedEventIds: [`e${index}`],
  }));
}

function cohort(ids: string[]): CohortCandidate[] {
  return ids.map((meetupId, index) => ({
    meetupId,
    earlyCount: ids.length - index,
    sharedCount: 1,
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
  it('names only linked members, in rank order, up to ten', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => String(i + 1));
    const d = deps(ids.filter((id) => id !== '2'));

    const result = await nameCompanions(ranked(ids), d);

    expect(NAMED_COMPANIONS).toBe(10);
    expect(result.named).toHaveLength(10);
    expect(result.named[0]).toEqual({ discordUserId: 'd1', sharedCount: 12 });
    expect(result.named[1]).toEqual({ discordUserId: 'd3', sharedCount: 10 });
    expect(result.otherCount).toBe(2);
  });

  it('attaches the top named companion’s shared events when given the events', async () => {
    const e0 = { id: 'e0', title: 'A', dateTime: 'd', eventUrl: 'u' };
    const e1 = { id: 'e1', title: 'B', dateTime: 'd', eventUrl: 'u' };
    // '1' (unlinked) ranks first with the same count as '2': the events must be '2's.
    const list = ranked(['1', '2', '3']);
    list[1].sharedCount = 3;
    list[1].sharedEventIds = ['e1'];

    const result = await nameCompanions(
      list,
      deps(['2', '3']),
      new Map([
        ['e0', e0],
        ['e1', e1],
      ]),
    );

    expect(result.named[0]).toEqual({
      discordUserId: 'd2',
      sharedCount: 3,
      sharedEvents: [e1],
    });
    expect(result.named[1]).toEqual({ discordUserId: 'd3', sharedCount: 1 });
  });

  it('carries no Meetup id or event ids into the named list', async () => {
    const result = await nameCompanions(ranked(['1']), deps(['1']));

    expect(Object.keys(result.named[0]).sort()).toEqual([
      'discordUserId',
      'sharedCount',
    ]);
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
    const ids = Array.from({ length: 60 }, (_, i) => String(i + 1));
    const d = deps([]);

    const result = await nameCompanions(ranked(ids), d);

    expect(d.findByMeetupId).toHaveBeenCalledTimes(COMPANION_LOOKUP_CAP);
    expect(COMPANION_LOOKUP_CAP).toBe(50);
    expect(result).toEqual({ named: [], otherCount: 60 });
  });

  it('stops looking once ten are named', async () => {
    const ids = Array.from({ length: 15 }, (_, i) => String(i + 1));
    const d = deps(ids);

    const result = await nameCompanions(ranked(ids), d);

    expect(d.findByMeetupId).toHaveBeenCalledTimes(10);
    expect(result.named).toHaveLength(10);
    expect(result.otherCount).toBe(5);
  });

  it('handles nobody', async () => {
    expect(await nameCompanions([], deps([]))).toEqual({
      named: [],
      otherCount: 0,
    });
  });
});

describe('nameCohort', () => {
  it('names at most ten after at most 25 lookups, keeping both counts', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => String(i + 1));
    const d = deps(ids.filter((_, i) => i % 2 === 0));

    const result = await nameCohort(cohort(ids), d);

    expect(NAMED_COHORT).toBe(10);
    expect(COHORT_LOOKUP_CAP).toBe(25);
    expect(result.named).toHaveLength(10);
    expect(result.named[0]).toEqual({
      discordUserId: 'd1',
      earlyCount: 30,
      sharedCount: 1,
    });
    expect(Object.keys(result.named[0]).sort()).toEqual([
      'discordUserId',
      'earlyCount',
      'sharedCount',
    ]);
    expect(result.otherCount).toBe(20);
  });

  it('stops after its own lookup cap', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => String(i + 1));
    const d = deps([]);

    const result = await nameCohort(cohort(ids), d);

    expect(d.findByMeetupId).toHaveBeenCalledTimes(25);
    expect(result).toEqual({ named: [], otherCount: 30 });
  });
});

describe('nameRanked', () => {
  it('keeps the ranked item and adds the Discord id', async () => {
    const result = await nameRanked(
      [{ meetupId: '1', extra: 'x' }],
      deps(['1']),
      5,
      5,
    );

    expect(result).toEqual({
      named: [{ meetupId: '1', extra: 'x', discordUserId: 'd1' }],
      otherCount: 0,
    });
  });
});
