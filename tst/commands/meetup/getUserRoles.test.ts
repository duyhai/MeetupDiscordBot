/* eslint-disable
  @typescript-eslint/no-explicit-any,
  @typescript-eslint/no-unsafe-return,
  @typescript-eslint/no-unsafe-call,
  @typescript-eslint/unbound-method
*/
import { CommandInteraction, Guild } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GqlMeetupClient } from '../../../src/lib/client/meetup/gqlClient.js';
import * as paginationHelper from '../../../src/lib/client/meetup/paginationHelper.js';
import { GetGroupEventsResponse } from '../../../src/lib/client/meetup/types.js';
import { getUserRoles } from '../../../src/lib/helpers/getUserRoles.js';
import * as onboardUser from '../../../src/lib/helpers/onboardUser.js';

// Mocking the external dependencies.
// Real ESM module namespaces are frozen, so mutating
// `(module as any).fn = mock` after an auto-mock (the previous approach here)
// doesn't work under real ESM. Instead each mocked module's factory provides
// the mock functions directly, and tests reach them via `vi.mocked(...)`.
vi.mock('../../../src/lib/client/meetup/gqlClient.js', () => ({
  GqlMeetupClient: vi.fn().mockImplementation(function GqlMeetupClientMock() {
    return {
      getUserMembershipInfo: vi.fn(),
      getUserInfo: vi.fn(),
      getGroupEvents: vi.fn(),
    };
  }),
}));
vi.mock('../../../src/lib/client/meetup/paginationHelper.js', () => ({
  getPaginatedData: vi.fn(),
}));
vi.mock('../../../src/lib/helpers/onboardUser.js', () => ({
  addServerRole: vi.fn(),
}));

describe('getUserRoles', () => {
  let interaction: CommandInteraction;
  let meetupClient: GqlMeetupClient;

  beforeEach(() => {
    vi.clearAllMocks();
    interaction = {
      user: {
        username: 'testUser',
        id: '123456789012345678', // Replace with a valid user ID
      },
      guild: {
        roles: {
          cache: new Map<string, unknown>(), // Replace with roles if needed
        },
      } as Guild,
      editReply: vi.fn(),
      followUp: vi.fn(),
    } as unknown as CommandInteraction;

    meetupClient = new GqlMeetupClient('1234');
  });

  it('should add roles for organizer', async () => {
    // Set up mock data for organizer
    vi.mocked(meetupClient.getUserMembershipInfo).mockResolvedValue({
      groupByUrlname: {
        id: '1',
        isMember: true,
        membershipMetadata: {
          status: 'LEADER',
          joinTime: '2018-07-01T12:00:00-04:00',
          rsvpStats: {
            noShowCount: 0,
          },
        },
        name: 'test',
      },
    });

    const addServerRoleMock = vi.mocked(onboardUser.addServerRole);
    await getUserRoles(meetupClient, interaction);

    expect(addServerRoleMock).toHaveBeenCalledWith(
      interaction.guild,
      interaction.user.id,
      'organizer',
    );
    expect(addServerRoleMock).toHaveBeenCalledWith(
      interaction.guild,
      interaction.user.id,
      'guest_host',
    );
    expect(interaction.followUp).toHaveBeenCalledWith({
      content: `Your Meetup roles are all set up based on your Meetup status!`,
      ephemeral: true,
    });
  });

  it('should handle non-member user', async () => {
    // Set up mock data for non-member user
    vi.mocked(meetupClient.getUserMembershipInfo).mockResolvedValue({
      groupByUrlname: {
        id: '1',
        isMember: false,
        membershipMetadata: {
          status: 'ACTIVE',
          joinTime: '2018-07-01T12:00:00-04:00',
          rsvpStats: {
            noShowCount: 0,
          },
        },
        name: 'test',
      },
    });

    await expect(getUserRoles(meetupClient, interaction)).rejects.toThrow(
      `You're not a member on Meetup. Please join the group and try onboarding again`,
    );
  });

  it('should handle non-organizer user with hosted events', async () => {
    // Set up mock data for non-organizer user with hosted events
    vi.mocked(meetupClient.getUserMembershipInfo).mockResolvedValue({
      groupByUrlname: {
        id: '1',
        isMember: true,
        membershipMetadata: {
          status: 'ACTIVE',
          joinTime: '2018-07-01T12:00:00-04:00',
          rsvpStats: {
            noShowCount: 0,
          },
        },
        name: 'test',
      },
    });
    vi.mocked(meetupClient.getUserInfo).mockResolvedValue({
      self: {
        id: 'testUserId',
        gender: 'MALE',
        name: 'Test',
        memberUrl: '',
      },
    });

    const addServerRoleMock = vi.mocked(onboardUser.addServerRole);

    const getPaginatedDataMock = vi.mocked(paginationHelper.getPaginatedData);
    getPaginatedDataMock.mockImplementation((fun: any) => fun());

    vi.mocked(meetupClient.getGroupEvents).mockResolvedValue({
      groupByUrlname: {
        events: [
          {
            eventHosts: [{ member: { id: 'testUserId' } }],
          },
        ],
      },
    } as unknown as GetGroupEventsResponse);

    await getUserRoles(meetupClient, interaction);

    expect(addServerRoleMock).toHaveBeenCalledWith(
      interaction.guild,
      interaction.user.id,
      'guest_host',
    );
  });

  it('should handle non-organizer user without hosted events', async () => {
    // Set up mock data for non-organizer user without hosted events
    vi.mocked(meetupClient.getUserMembershipInfo).mockResolvedValue({
      groupByUrlname: {
        id: '1',
        isMember: true,
        membershipMetadata: {
          status: 'ACTIVE',
          joinTime: '2018-07-01T12:00:00-04:00',
          rsvpStats: {
            noShowCount: 0,
          },
        },
        name: 'test',
      },
    });

    vi.mocked(meetupClient.getUserInfo).mockResolvedValue({
      self: {
        id: 'testUserId',
        gender: 'MALE',
        name: 'Test',
        memberUrl: '',
      },
    });

    const addServerRoleMock = vi.mocked(onboardUser.addServerRole);

    const getPaginatedDataMock = vi.mocked(paginationHelper.getPaginatedData);
    getPaginatedDataMock.mockImplementation((fun: any) => fun());

    vi.mocked(meetupClient.getGroupEvents).mockResolvedValueOnce({
      groupByUrlname: {
        events: [], // No hosted events
      },
    } as unknown as GetGroupEventsResponse);

    await getUserRoles(meetupClient, interaction);

    // Expectations for not meeting the criteria for guest_host role
    expect(addServerRoleMock).not.toHaveBeenCalledWith(
      interaction.guild,
      interaction.user.id,
      'guest_host',
    );

    vi.mocked(meetupClient.getGroupEvents).mockResolvedValueOnce({
      groupByUrlname: {
        events: [],
      },
    } as unknown as GetGroupEventsResponse);

    await getUserRoles(meetupClient, interaction);

    // Expectations for not meeting the criteria for guest_host role
    expect(addServerRoleMock).not.toHaveBeenCalledWith(
      interaction.guild,
      interaction.user.id,
      'guest_host',
    );
  });
});
