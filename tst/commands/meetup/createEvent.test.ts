import { ButtonInteraction, CommandInteraction } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SERVER_ROLES } from '../../../src/constants.js';
import { MeetupCreateEventCommands } from '../../../src/commands/meetup/createEvent.js';
import { logAlert } from '../../../src/lib/helpers/discordLogger.js';
import {
  GUEST_HOST_EVENT_DESCRIPTION,
  createEventTemplate,
} from '../../../src/templates/createEventTemplate.js';

const meetup = vi.hoisted(() => ({
  getUserMembershipInfo: vi.fn(),
  getUserInfo: vi.fn(),
  getEvent: vi.fn(),
  createEvent: vi.fn(),
  closeEventRsvps: vi.fn(),
  editEvent: vi.fn(),
}));

const fakeCache = vi.hoisted(() => {
  const data = new Map<string, string>();
  return {
    data,
    exclusive_set: (key: string, value: string) => {
      if (data.has(key)) return Promise.resolve(false);
      data.set(key, value);
      return Promise.resolve(true);
    },
    get: (key: string) => Promise.resolve(data.get(key)),
    remove: (key: string) => {
      data.delete(key);
      return Promise.resolve();
    },
  };
});

vi.mock('../../../src/util/cache.js', () => ({
  ApplicationCache: () => Promise.resolve(fakeCache),
}));
vi.mock('../../../src/util/meetup.js', () => ({
  withMeetupClient: (
    _interaction: unknown,
    fn: (client: typeof meetup) => Promise<void>,
  ) => fn(meetup),
}));
// The real discordCommandWrapper runs, so the tests see the exact reply an
// organizer would get; only its staff-channel logging is stubbed.
vi.mock('../../../src/lib/helpers/discordLogger.js', () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
  logAlert: vi.fn().mockResolvedValue(undefined),
  logModeration: vi.fn().mockResolvedValue(undefined),
}));

const TIP = 'Arrive 10 minutes early to greet people. 💡';

function requestContent({ withTip }: { withTip: boolean }) {
  return [
    `❗<@member-1> is requesting the creation of a new Meetup event.❗`,
    `**Meetup User ID**: 238429835`,
    `**Number of hosted events**: 3`,
    `**Event Date**: 2026-11-14`,
    `**Event Title**: Board Games at the Park`,
    ``,
    ...(withTip ? [`💡 **Host Tip**: ${TIP}`] : []),
    `Please reach out to us if you have any questions while setting up your event.`,
    `Organizers, please approve or deny below:`,
  ].join('\n');
}

function approveInteraction(content: string) {
  const messageEdit = vi
    .fn<(options: { content: string }) => Promise<void>>()
    .mockResolvedValue(undefined);
  const interaction = {
    client: {},
    user: {
      id: 'organizer-1',
      username: 'organizer',
      toString: () => '<@organizer-1>',
    },
    customId: 'approve',
    isButton: () => true,
    isChatInputCommand: () => false,
    reply: vi.fn().mockResolvedValue({ delete: vi.fn() }),
    editReply: vi
      .fn<(options: { content: string }) => Promise<void>>()
      .mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    message: {
      id: 'request-message-1',
      content,
      fetch: vi
        .fn()
        .mockResolvedValue({ id: 'request-message-1', edit: messageEdit }),
    },
  };
  return {
    interaction: interaction as unknown as ButtonInteraction,
    raw: interaction,
    messageEdit,
  };
}

describe('approving a guest-host event request', () => {
  const handler = new MeetupCreateEventCommands();

  beforeEach(() => {
    vi.clearAllMocks();
    fakeCache.data.clear();
    meetup.getUserMembershipInfo.mockResolvedValue({
      groupByUrlname: { membershipMetadata: { status: 'LEADER' } },
    });
    // The deleted template: what production has returned since 2026-10-25.
    meetup.getEvent.mockResolvedValue({ event: null });
    meetup.createEvent.mockResolvedValue({
      createEvent: {
        event: { id: '999', eventUrl: 'https://www.meetup.com/x/events/999/' },
      },
    });
    meetup.closeEventRsvps.mockResolvedValue({});
    meetup.editEvent.mockResolvedValue({});
  });

  it('uses the in-code description when the request has no Host Tip', async () => {
    const { interaction } = approveInteraction(
      requestContent({ withTip: false }),
    );

    await handler.meetupRequestApproveEventHandler(interaction);

    expect(meetup.createEvent).toHaveBeenCalledWith({
      ...createEventTemplate,
      description: GUEST_HOST_EVENT_DESCRIPTION,
      title: '[Guest Host] Board Games at the Park',
      startDateTime: '2026-11-14T19:00',
      eventHosts: [238429835],
    });
  });

  it('puts the Host Tip above the in-code description', async () => {
    const { interaction } = approveInteraction(
      requestContent({ withTip: true }),
    );

    await handler.meetupRequestApproveEventHandler(interaction);

    expect(meetup.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        description: `💡 Host Tip: ${TIP}\n\n${GUEST_HOST_EVENT_DESCRIPTION}`,
      }),
    );
  });

  it('never looks up a Meetup template event', async () => {
    const { interaction } = approveInteraction(
      requestContent({ withTip: true }),
    );

    await handler.meetupRequestApproveEventHandler(interaction);

    expect(meetup.getEvent).not.toHaveBeenCalled();
  });

  it('keeps a real description in the code', () => {
    expect(GUEST_HOST_EVENT_DESCRIPTION.trim().length).toBeGreaterThan(0);
    expect(createEventTemplate.description).toBe(GUEST_HOST_EVENT_DESCRIPTION);
  });

  it('closes RSVPs, reapplies the RSVP settings and links the event', async () => {
    const { interaction, raw, messageEdit } = approveInteraction(
      requestContent({ withTip: false }),
    );

    await handler.meetupRequestApproveEventHandler(interaction);

    expect(meetup.closeEventRsvps).toHaveBeenCalledWith({ eventId: '999' });
    expect(meetup.editEvent).toHaveBeenCalledWith({
      eventId: '999',
      rsvpSettings: createEventTemplate.rsvpSettings,
    });
    expect(messageEdit.mock.calls[0][0].content).toContain(
      'Link to event: <https://www.meetup.com/x/events/999/>',
    );
    expect(raw.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ content: '✅ Event request approved!' }),
    );
  });

  it('tells the organizer plainly when Meetup refuses to create the event', async () => {
    meetup.createEvent.mockRejectedValue(
      new Error('GraphQL Error (Code: 500): {"response":{"errors":[...]}}'),
    );
    const { interaction, raw, messageEdit } = approveInteraction(
      requestContent({ withTip: false }),
    );

    await handler.meetupRequestApproveEventHandler(interaction);

    const reply = raw.editReply.mock.calls.at(-1)?.[0].content;
    expect(reply).toContain('Meetup did not create the event');
    expect(reply).toContain('nothing was created');
    expect(reply).not.toMatch(/TypeError|GraphQL Error|response/);
    expect(messageEdit).not.toHaveBeenCalled();
    expect(meetup.closeEventRsvps).not.toHaveBeenCalled();
    // Staff still get the raw cause in the alert channel.
    expect(vi.mocked(logAlert).mock.calls[0][1].description).toContain(
      'Meetup did not create the event',
    );
    // The lock is released so the request can be approved again.
    expect(fakeCache.data.size).toBe(0);
  });

  it('tells the organizer plainly when Meetup answers without an event', async () => {
    meetup.createEvent.mockResolvedValue({ createEvent: { event: null } });
    const { interaction, raw } = approveInteraction(
      requestContent({ withTip: false }),
    );

    await handler.meetupRequestApproveEventHandler(interaction);

    const reply = raw.editReply.mock.calls.at(-1)?.[0].content;
    expect(reply).toContain('Meetup did not create the event');
    expect(reply).not.toContain('TypeError');
    expect(reply).not.toMatch(/Cannot (read|destructure)/);
  });

  it('says the event exists when only the RSVP follow-up fails', async () => {
    meetup.closeEventRsvps.mockRejectedValue(new Error('boom'));
    const { interaction, raw } = approveInteraction(
      requestContent({ withTip: false }),
    );

    await handler.meetupRequestApproveEventHandler(interaction);

    const reply = raw.editReply.mock.calls.at(-1)?.[0].content;
    expect(reply).toContain('https://www.meetup.com/x/events/999/');
    expect(reply).toContain('RSVP');
  });

  it('refuses a request message it cannot read instead of creating a broken event', async () => {
    const { interaction, raw } = approveInteraction('something else entirely');

    await handler.meetupRequestApproveEventHandler(interaction);

    expect(meetup.createEvent).not.toHaveBeenCalled();
    const reply = raw.editReply.mock.calls.at(-1)?.[0].content;
    expect(reply).toContain("Couldn't read");
  });
});

function templateInteraction(roleIds: string[]) {
  const interaction = {
    client: {},
    commandName: 'meetup_recreate_event_template',
    isChatInputCommand: () => true,
    isButton: () => false,
    user: {
      id: 'leader-1',
      username: 'leader',
      toString: () => '<@leader-1>',
    },
    guild: {
      members: {
        fetch: vi.fn().mockResolvedValue({
          permissions: { has: () => false },
          roles: { cache: { has: (id: string) => roleIds.includes(id) } },
        }),
      },
    },
    reply: vi.fn().mockResolvedValue({ delete: vi.fn() }),
    editReply: vi
      .fn<(options: { content: string }) => Promise<void>>()
      .mockResolvedValue(undefined),
    followUp: vi
      .fn<(options: { content: string }) => Promise<void>>()
      .mockResolvedValue(undefined),
  };
  return {
    interaction: interaction as unknown as CommandInteraction,
    raw: interaction,
  };
}

describe('/meetup_recreate_event_template', () => {
  const handler = new MeetupCreateEventCommands();

  beforeEach(() => {
    vi.clearAllMocks();
    meetup.getUserMembershipInfo.mockResolvedValue({
      groupByUrlname: { membershipMetadata: { status: 'LEADER' } },
    });
    meetup.getUserInfo.mockResolvedValue({ self: { id: '182828976' } });
    meetup.createEvent.mockResolvedValue({
      createEvent: {
        event: { id: '555', eventUrl: 'https://www.meetup.com/x/events/555/' },
      },
    });
  });

  it('creates an unpublished copy of the guest-host template for hosts to copy', async () => {
    vi.useFakeTimers({
      now: new Date('2026-10-26T12:00:00Z'),
      toFake: ['Date'],
    });
    const { interaction, raw } = templateInteraction([SERVER_ROLES.leadership]);

    await handler.meetupRecreateEventTemplateHandler(interaction);
    vi.useRealTimers();

    expect(meetup.createEvent).toHaveBeenCalledWith({
      ...createEventTemplate,
      title: 'Organizer Event Template',
      description: GUEST_HOST_EVENT_DESCRIPTION,
      publishStatus: 'DRAFT',
      startDateTime: '2027-10-26T19:00',
      eventHosts: [182828976],
    });
    expect(meetup.closeEventRsvps).not.toHaveBeenCalled();
    expect(raw.followUp.mock.calls[0][0].content).toContain(
      'https://www.meetup.com/x/events/555/',
    );
  });

  it('lets moderators run it too', async () => {
    const { interaction } = templateInteraction([SERVER_ROLES.moderator]);

    await handler.meetupRecreateEventTemplateHandler(interaction);

    expect(meetup.createEvent).toHaveBeenCalled();
  });

  it('refuses members outside leadership and moderators', async () => {
    const { interaction, raw } = templateInteraction([SERVER_ROLES.organizer]);

    await handler.meetupRecreateEventTemplateHandler(interaction);

    expect(meetup.createEvent).not.toHaveBeenCalled();
    expect(raw.editReply.mock.calls.at(-1)?.[0].content).toContain(
      'Leadership',
    );
  });

  it('refuses when the Meetup account is not an organizer of the group', async () => {
    meetup.getUserMembershipInfo.mockResolvedValue({
      groupByUrlname: { membershipMetadata: { status: 'MEMBER' } },
    });
    const { interaction } = templateInteraction([SERVER_ROLES.leadership]);

    await handler.meetupRecreateEventTemplateHandler(interaction);

    expect(meetup.createEvent).not.toHaveBeenCalled();
  });

  it('tells the leader plainly when Meetup refuses to create it', async () => {
    meetup.createEvent.mockRejectedValue(
      new Error('GraphQL Error (Code: 500)'),
    );
    const { interaction, raw } = templateInteraction([SERVER_ROLES.leadership]);

    await handler.meetupRecreateEventTemplateHandler(interaction);

    const reply = raw.editReply.mock.calls.at(-1)?.[0].content;
    expect(reply).toContain('Meetup did not create the template');
    expect(reply).not.toContain('GraphQL Error');
  });
});
