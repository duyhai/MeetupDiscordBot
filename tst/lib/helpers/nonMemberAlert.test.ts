import { ButtonInteraction } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GqlMeetupClient } from '../../../src/lib/client/meetup/gqlClient.js';
import { logAlert } from '../../../src/lib/helpers/discordLogger.js';
import { selfOnboardUser } from '../../../src/lib/helpers/onboardUser.js';

vi.mock('../../../src/lib/helpers/discordLogger.js', () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
  logAlert: vi.fn().mockResolvedValue(undefined),
}));

const cacheRemove = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../src/util/cache.js', () => ({
  ApplicationCache: vi.fn(async () => ({
    get: vi.fn(),
    remove: cacheRemove,
    set: vi.fn(),
  })),
}));

const MEETUP_ID = '404060606';
const PROFILE_URL = `https://www.meetup.com/members/${MEETUP_ID}/`;

function fakeInteraction() {
  return {
    guild: {},
    client: {},
    user: {
      id: 'discord-9',
      username: 'matcha.milktea123',
      toString: () => '<@discord-9>',
    },
    customId: 'meetupSyncAccount',
    isButton: () => true,
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
  } as unknown as ButtonInteraction;
}

function fakeClient(memberUrl: string) {
  return {
    getUserInfo: vi.fn().mockResolvedValue({
      self: {
        id: MEETUP_ID,
        name: 'Jane D.',
        gender: 'OTHER',
        memberUrl,
      },
    }),
    getUserMembershipInfo: vi.fn().mockResolvedValue({
      groupByUrlname: {
        id: '7595882',
        name: '1.5 Gen Asians',
        isMember: false,
      },
    }),
  } as unknown as GqlMeetupClient;
}

/** The single alert posted during the call. */
function alertPayload() {
  expect(logAlert).toHaveBeenCalledTimes(1);
  const [, entry] = vi.mocked(logAlert).mock.calls[0];
  return entry;
}

describe('non-member verification alert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('posts the Meetup profile so organizers can follow up', async () => {
    await expect(
      selfOnboardUser(fakeClient(PROFILE_URL), fakeInteraction()),
    ).rejects.toThrow(/not a member on Meetup/);

    const entry = alertPayload();
    expect(entry.title).toBe('Non-member tried to verify');
    // The whole point of the change: the organizer can click through to the
    // person's Meetup profile straight from the alert.
    expect(entry.description).toContain(PROFILE_URL);
    expect(entry.description).toContain('Jane D.');
    expect(entry.description).toContain('matcha.milktea123');
    expect(entry.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Meetup ID', value: MEETUP_ID }),
      ]),
    );
  });

  it('falls back to the member id when Meetup returns no profile url', async () => {
    await expect(
      selfOnboardUser(fakeClient(''), fakeInteraction()),
    ).rejects.toThrow(/not a member on Meetup/);

    const entry = alertPayload();
    // An empty memberUrl must not render as a broken masked link...
    expect(entry.description).not.toMatch(/\]\(\s*\)/);
    expect(entry.description).toContain('Jane D.');
    // ...and the member is still identifiable from the id field.
    expect(entry.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Meetup ID', value: MEETUP_ID }),
      ]),
    );
  });

  it('marks the error handled so the wrapper skips its generic alert', async () => {
    const error = await selfOnboardUser(
      fakeClient(PROFILE_URL),
      fakeInteraction(),
    ).catch((e: unknown) => e);

    // Without this marker discordCommandWrapper posts a second, less useful
    // alert for the same event.
    expect((error as { alertHandled?: boolean }).alertHandled).toBe(true);
  });

  it('still clears the cached tokens', async () => {
    await selfOnboardUser(fakeClient(PROFILE_URL), fakeInteraction()).catch(
      () => undefined,
    );

    // Pre-existing behaviour: a non-member must re-authorize next attempt
    // rather than reuse a token for an account that cannot pass the check.
    expect(cacheRemove).toHaveBeenCalledWith('discord-9-meetup-tokens');
  });

  it('posts no alert for an actual group member', async () => {
    const client = fakeClient(PROFILE_URL);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(client.getUserMembershipInfo).mockResolvedValue({
      groupByUrlname: {
        id: '7595882',
        name: '1.5 Gen Asians',
        isMember: true,
      },
    } as never);

    await selfOnboardUser(client, fakeInteraction()).catch(() => undefined);

    expect(logAlert).not.toHaveBeenCalled();
  });
});
