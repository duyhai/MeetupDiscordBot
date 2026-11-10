import { describe, expect, it, vi } from 'vitest';

import { linkDiscordFromWeb } from '../../../src/lib/hosts/webLink.js';
import {
  MeetupIdConflictError,
  MemberRecord,
} from '../../../src/lib/repositories/types.js';

const DISCORD = '123456789012345678';
const OTHER_DISCORD = '223456789012345678';
const LINK = { meetupId: '4242', meetupName: 'Ann', discordUserId: DISCORD };

const row = (over: Partial<MemberRecord>): MemberRecord => ({
  discordUserId: DISCORD,
  meetupId: '4242',
  meetupName: 'Ann',
  meetupMemberUrl: null,
  onboardMethod: 'self_onboard',
  onboardedBy: null,
  firstOnboardedAt: new Date(0),
  lastSyncedAt: new Date(0),
  ...over,
});

function store(rows: MemberRecord[] = []) {
  return {
    findByMeetupId: vi.fn(async (id: string) =>
      rows.find((r) => r.meetupId === id),
    ),
    findByDiscordId: vi.fn(async (id: string) =>
      rows.find((r) => r.discordUserId === id),
    ),
    upsert: vi.fn(
      async (m: Omit<MemberRecord, 'firstOnboardedAt' | 'lastSyncedAt'>) =>
        row(m),
    ),
  };
}

describe('linkDiscordFromWeb', () => {
  it('links a Meetup account with no link to a Discord account with none', async () => {
    const s = store();
    expect(await linkDiscordFromWeb(s, LINK)).toEqual({ kind: 'linked' });
    expect(s.upsert).toHaveBeenCalledWith({
      discordUserId: DISCORD,
      meetupId: '4242',
      meetupName: 'Ann',
      meetupMemberUrl: 'https://www.meetup.com/members/4242/',
      onboardMethod: 'web_link',
      onboardedBy: null,
    });
  });

  it('a link that is already there is left alone', async () => {
    const s = store([row({})]);
    expect(await linkDiscordFromWeb(s, LINK)).toEqual({ kind: 'already' });
    expect(s.upsert).not.toHaveBeenCalled();
  });

  it('refuses a Meetup account linked to another Discord account', async () => {
    const s = store([row({ discordUserId: OTHER_DISCORD })]);
    expect(await linkDiscordFromWeb(s, LINK)).toEqual({
      kind: 'meetup-taken',
      otherDiscordId: OTHER_DISCORD,
    });
    expect(s.upsert).not.toHaveBeenCalled();
  });

  it('refuses, rather than moves, a Discord account linked to another Meetup account', async () => {
    const s = store([row({ meetupId: '9999' })]);
    expect(await linkDiscordFromWeb(s, LINK)).toEqual({
      kind: 'discord-taken',
      otherMeetupId: '9999',
    });
    expect(s.upsert).not.toHaveBeenCalled();
  });

  it('upgrades a manual-onboard row that has no Meetup id', async () => {
    const s = store([row({ meetupId: null, onboardMethod: 'manual' })]);
    expect(await linkDiscordFromWeb(s, LINK)).toEqual({ kind: 'linked' });
    expect(s.upsert).toHaveBeenCalledOnce();
  });

  it('a concurrent link caught by the unique key counts as taken', async () => {
    const s = store();
    s.upsert.mockRejectedValue(new MeetupIdConflictError('taken'));
    expect(await linkDiscordFromWeb(s, LINK)).toEqual({
      kind: 'meetup-taken',
      otherDiscordId: undefined,
    });
  });

  it('a store failure is thrown, not swallowed', async () => {
    const s = store();
    s.findByMeetupId.mockRejectedValue(new Error('pg down'));
    await expect(linkDiscordFromWeb(s, LINK)).rejects.toThrow('pg down');
  });
});
