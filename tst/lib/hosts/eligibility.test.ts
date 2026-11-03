import { describe, expect, it, vi } from 'vitest';

import { GUEST_HOST_BLACKLIST } from '../../../src/constants.js';
import {
  HostResolveDeps,
  resolveHost,
} from '../../../src/lib/hosts/eligibility.js';

const DISCORD = '123456789012345678';
const MEETUP = '4242';

function deps(over: Partial<HostResolveDeps> = {}): HostResolveDeps {
  return {
    discordIdForMeetup: vi.fn().mockResolvedValue(undefined),
    meetupIdForDiscord: vi.fn().mockResolvedValue(MEETUP),
    hasGuestHostRole: vi.fn().mockResolvedValue(false),
    pastHostedCount: vi.fn().mockResolvedValue(0),
    isPromoted: vi.fn().mockResolvedValue(false),
    ...over,
  };
}

describe('resolveHost', () => {
  it('discord path, linked, Guest Host role: a regular host, count not read', async () => {
    const d = deps({ hasGuestHostRole: vi.fn().mockResolvedValue(true) });
    await expect(resolveHost(d, { discordUserId: DISCORD })).resolves.toEqual({
      kind: 'host',
      meetupMemberId: MEETUP,
      discordUserId: DISCORD,
      tier: 'regular',
    });
    expect(d.pastHostedCount).not.toHaveBeenCalled();
  });

  it('discord path, linked, no role but past events: a host', async () => {
    const d = deps({ pastHostedCount: vi.fn().mockResolvedValue(2) });
    await expect(
      resolveHost(d, { discordUserId: DISCORD }),
    ).resolves.toMatchObject({ kind: 'host', hostedCount: 2 });
  });

  it('meetup path, unlinked, 3 past events: a regular host with no Discord id', async () => {
    const d = deps({ pastHostedCount: vi.fn().mockResolvedValue(3) });
    const result = await resolveHost(d, { meetupMemberId: MEETUP });
    expect(result).toEqual({
      kind: 'host',
      meetupMemberId: MEETUP,
      tier: 'regular',
      hostedCount: 3,
    });
    expect(d.hasGuestHostRole).not.toHaveBeenCalled();
  });

  it('meetup path, linked: the Guest Host role counts too', async () => {
    const d = deps({
      discordIdForMeetup: vi.fn().mockResolvedValue(DISCORD),
      hasGuestHostRole: vi.fn().mockResolvedValue(true),
    });
    await expect(
      resolveHost(d, { meetupMemberId: MEETUP }),
    ).resolves.toMatchObject({ kind: 'host', discordUserId: DISCORD });
  });

  it('meetup path, linked Discord id blacklisted: refused before any Meetup read', async () => {
    const d = deps({
      discordIdForMeetup: vi.fn().mockResolvedValue(GUEST_HOST_BLACKLIST[0]),
      pastHostedCount: vi.fn().mockResolvedValue(9),
    });
    await expect(resolveHost(d, { meetupMemberId: MEETUP })).resolves.toEqual({
      kind: 'refused',
      reason: 'blacklisted',
    });
    expect(d.pastHostedCount).not.toHaveBeenCalled();
    expect(d.hasGuestHostRole).not.toHaveBeenCalled();
  });

  it('discord path, blacklisted Discord id: refused', async () => {
    const d = deps({ hasGuestHostRole: vi.fn().mockResolvedValue(true) });
    await expect(
      resolveHost(d, { discordUserId: GUEST_HOST_BLACKLIST[1] }),
    ).resolves.toEqual({ kind: 'refused', reason: 'blacklisted' });
  });

  it('a blacklisted Meetup id is refused on both paths', async () => {
    const constants = await import('../../../src/constants.js');
    constants.GUEST_HOST_MEETUP_BLACKLIST.push(MEETUP);
    try {
      const d = deps({ pastHostedCount: vi.fn().mockResolvedValue(5) });
      await expect(
        resolveHost(d, { meetupMemberId: MEETUP }),
      ).resolves.toMatchObject({ reason: 'blacklisted' });
      await expect(
        resolveHost(d, { discordUserId: DISCORD }),
      ).resolves.toMatchObject({ reason: 'blacklisted' });
    } finally {
      constants.GUEST_HOST_MEETUP_BLACKLIST.pop();
    }
  });

  it('no role and no past events: not a host', async () => {
    await expect(
      resolveHost(deps(), { discordUserId: DISCORD }),
    ).resolves.toEqual({ kind: 'refused', reason: 'not-a-host' });
  });

  it('discord path with no linked Meetup account: not linked', async () => {
    const d = deps({
      meetupIdForDiscord: vi.fn().mockResolvedValue(undefined),
    });
    await expect(resolveHost(d, { discordUserId: DISCORD })).resolves.toEqual({
      kind: 'refused',
      reason: 'not-linked',
    });
    expect(d.hasGuestHostRole).not.toHaveBeenCalled();
  });

  it('a promoted row makes the tier promoted', async () => {
    const d = deps({
      pastHostedCount: vi.fn().mockResolvedValue(25),
      isPromoted: vi.fn().mockResolvedValue(true),
    });
    await expect(
      resolveHost(d, { meetupMemberId: MEETUP }),
    ).resolves.toMatchObject({ kind: 'host', tier: 'promoted' });
  });

  it('a promoted row alone does not make a host: promoted is a tier of hosts', async () => {
    const d = deps({ isPromoted: vi.fn().mockResolvedValue(true) });
    await expect(resolveHost(d, { meetupMemberId: MEETUP })).resolves.toEqual({
      kind: 'refused',
      reason: 'not-a-host',
    });
  });

  it('a lookup that throws propagates', async () => {
    const d = deps({
      pastHostedCount: vi.fn().mockRejectedValue(new Error('meetup down')),
    });
    await expect(resolveHost(d, { meetupMemberId: MEETUP })).rejects.toThrow(
      'meetup down',
    );
  });
});
