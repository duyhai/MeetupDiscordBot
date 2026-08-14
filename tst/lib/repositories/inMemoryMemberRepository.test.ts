import { describe, expect, it } from 'vitest';

import { InMemoryMemberRepository } from '../../../src/lib/repositories/inMemoryMemberRepository.js';
import { MeetupIdConflictError } from '../../../src/lib/repositories/types.js';

const linkedMember = {
  discordUserId: 'discord-1',
  meetupId: 'meetup-1',
  meetupName: 'Test User',
  meetupMemberUrl: 'https://www.meetup.com/members/1/',
  onboardMethod: 'self_onboard' as const,
  onboardedBy: null,
};

describe('InMemoryMemberRepository', () => {
  it('returns undefined for unknown lookups', async () => {
    const repo = new InMemoryMemberRepository();
    expect(await repo.findByDiscordId('nope')).toBeUndefined();
    expect(await repo.findByMeetupId('nope')).toBeUndefined();
  });

  it('round-trips a member through upsert/find', async () => {
    const repo = new InMemoryMemberRepository();
    const stored = await repo.upsert(linkedMember);

    expect(stored.meetupId).toBe('meetup-1');
    expect(stored.firstOnboardedAt).toBeInstanceOf(Date);
    expect(await repo.findByDiscordId('discord-1')).toMatchObject(linkedMember);
    expect(await repo.findByMeetupId('meetup-1')).toMatchObject(linkedMember);
  });

  it('upsert updates in place and preserves firstOnboardedAt', async () => {
    const repo = new InMemoryMemberRepository();
    const first = await repo.upsert(linkedMember);
    const updated = await repo.upsert({
      ...linkedMember,
      meetupName: 'Renamed User',
    });

    expect(updated.meetupName).toBe('Renamed User');
    expect(updated.firstOnboardedAt).toEqual(first.firstOnboardedAt);
    expect(await repo.listAll()).toHaveLength(1);
  });

  it('supports null meetupId rows (manual onboards)', async () => {
    const repo = new InMemoryMemberRepository();
    await repo.upsert({
      discordUserId: 'discord-2',
      meetupId: null,
      meetupName: null,
      meetupMemberUrl: null,
      onboardMethod: 'manual',
      onboardedBy: 'mod-1',
    });

    const row = await repo.findByDiscordId('discord-2');
    expect(row?.meetupId).toBeNull();
    expect(row?.onboardedBy).toBe('mod-1');
  });

  it('rejects claiming a meetup id held by another user, matching Postgres', async () => {
    const repo = new InMemoryMemberRepository();
    await repo.upsert(linkedMember);

    await expect(
      repo.upsert({ ...linkedMember, discordUserId: 'discord-2' }),
    ).rejects.toThrow(MeetupIdConflictError);
    expect(await repo.findByDiscordId('discord-2')).toBeUndefined();
  });

  it('allows multiple null meetupId rows to coexist', async () => {
    const repo = new InMemoryMemberRepository();
    const nullRow = { ...linkedMember, meetupId: null };
    await repo.upsert({ ...nullRow, discordUserId: 'discord-2' });
    await repo.upsert({ ...nullRow, discordUserId: 'discord-3' });

    expect(await repo.listAll()).toHaveLength(2);
  });

  it('remove deletes the row', async () => {
    const repo = new InMemoryMemberRepository();
    await repo.upsert(linkedMember);
    await repo.remove('discord-1');

    expect(await repo.findByDiscordId('discord-1')).toBeUndefined();
    expect(await repo.listAll()).toHaveLength(0);
  });
});
