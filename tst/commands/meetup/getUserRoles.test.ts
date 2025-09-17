/* eslint-disable 
  @typescript-eslint/no-unsafe-member-access,
  @typescript-eslint/no-explicit-any,
  @typescript-eslint/no-unsafe-return,
  @typescript-eslint/no-unsafe-call,
  @typescript-eslint/unbound-method 
*/
import { CommandInteraction, Guild } from 'discord.js';
import { GqlMeetupClient } from '../../../src/lib/client/meetup/gqlClient';
import * as paginationHelper from '../../../src/lib/client/meetup/paginationHelper';
import { GetPastGroupEventsResponse } from '../../../src/lib/client/meetup/types';
import { getUserRoles } from '../../../src/lib/helpers/getUserRoles';
import * as onboardUser from '../../../src/lib/helpers/onboardUser';

// Mocking the external dependencies
jest.mock('../../../src/lib/client/meetup/gqlClient');
jest.mock('../../../src/lib/client/meetup/paginationHelper');
jest.mock('../../../src/lib/helpers/onboardUser');

describe('getUserRoles', () => {
  let interaction: CommandInteraction;
  let meetupClient: GqlMeetupClient;

  beforeEach(() => {
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
      editReply: jest.fn(),
      followUp: jest.fn(),
    } as unknown as CommandInteraction;

    meetupClient = new GqlMeetupClient('1234');
  });

  it('should add roles for organizer', async () => {
    // Set up mock data for organizer
    jest.spyOn(meetupClient, 'getUserMembershipInfo').mockResolvedValue({
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

    const addServerRoleMock = jest.fn();
    (onboardUser as any).addServerRole = addServerRoleMock;
    await getUserRoles(meetupClient, interaction);

    expect(addServerRoleMock).toHaveBeenCalledWith(
      interaction.guild,
      interaction.user.id,
      'organizer'
    );
    expect(addServerRoleMock).toHaveBeenCalledWith(
      interaction.guild,
      interaction.user.id,
      'guest_host'
    );
    expect(interaction.followUp).toHaveBeenCalledWith({
      content: `Your Meetup roles are all set up based on your Meetup status!`,
      ephemeral: true,
    });
  });

  it('should handle non-member user', async () => {
    // Set up mock data for non-member user
    jest.spyOn(meetupClient, 'getUserMembershipInfo').mockResolvedValue({
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
      `You're not a member on Meetup. Please join the group and try onboarding again`
    );
  });

  it('should handle non-organizer user with hosted events', async () => {
    // Set up mock data for non-organizer user with hosted events
    jest.spyOn(meetupClient, 'getUserMembershipInfo').mockResolvedValue({
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
    jest.spyOn(meetupClient, 'getUserInfo').mockResolvedValue({
      self: {
        id: 'testUserId',
        gender: 'MALE',
        name: 'Test',
      },
    });

    const addServerRoleMock = jest.fn();
    (onboardUser as any).addServerRole = addServerRoleMock;

    const getPaginatedDataMock = (fun) => fun();
    (paginationHelper as any).getPaginatedData = getPaginatedDataMock;

    jest.spyOn(meetupClient, 'getPastGroupEvents').mockResolvedValue({
      groupByUrlname: {
        pastEvents: [
          {
            eventHosts: [{ member: { id: 'testUserId' } }],
          },
        ],
      },
    } as unknown as GetPastGroupEventsResponse);

    await getUserRoles(meetupClient, interaction);

    expect(addServerRoleMock).toHaveBeenCalledWith(
      interaction.guild,
      interaction.user.id,
      'guest_host'
    );
  });

  it('should handle non-organizer user without hosted events', async () => {
    // Set up mock data for non-organizer user without hosted events
    jest.spyOn(meetupClient, 'getUserMembershipInfo').mockResolvedValue({
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

    jest.spyOn(meetupClient, 'getUserInfo').mockResolvedValue({
      self: {
        id: 'testUserId',
        gender: 'MALE',
        name: 'Test',
      },
    });

    const addServerRoleMock = jest.fn();
    (onboardUser as any).addServerRole = addServerRoleMock;

    const getPaginatedDataMock = (fun) => fun();
    (paginationHelper as any).getPaginatedData = getPaginatedDataMock;

    jest.spyOn(meetupClient, 'getPastGroupEvents').mockResolvedValueOnce({
      groupByUrlname: {
        pastEvents: [], // No hosted events
      },
    } as unknown as GetPastGroupEventsResponse);

    await getUserRoles(meetupClient, interaction);

    // Expectations for not meeting the criteria for guest_host role
    expect(addServerRoleMock).not.toHaveBeenCalledWith(
      interaction.guild,
      interaction.user.id,
      'guest_host'
    );

    jest.spyOn(meetupClient, 'getPastGroupEvents').mockResolvedValueOnce({
      groupByUrlname: {
        pastEvents: [
          {
            eventHosts: [{ member: { id: 'testUserId2' } }],
          },
        ],
      },
    } as unknown as GetPastGroupEventsResponse);

    await getUserRoles(meetupClient, interaction);

    // Expectations for not meeting the criteria for guest_host role
    expect(addServerRoleMock).not.toHaveBeenCalledWith(
      interaction.guild,
      interaction.user.id,
      'guest_host'
    );
  });
});
