import { CommandInteraction } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MeetupGetEventStatsCommands } from '../../../src/commands/meetup/getEventStats.js';
import * as discordUtil from '../../../src/util/discord.js';
import * as meetupUtil from '../../../src/util/meetup.js';

// The wrapper runs straight through, so a refusal surfaces as a rejection
// here; in production the wrapper turns it into the standard error reply.
vi.mock('../../../src/util/discord.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/util/discord.js')>();
  return {
    ...actual,
    discordCommandWrapper: vi.fn(async (_interaction, fn: () => unknown) => {
      await fn();
    }),
    requireModOrOrganizer: vi.fn(),
    logModerationAction: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock('../../../src/util/meetup.js', () => ({
  withMeetupClient: vi.fn().mockResolvedValue(undefined),
}));

describe('/meetup_get_host_event_stats access', () => {
  const interaction = {} as CommandInteraction;
  const run = () =>
    new MeetupGetEventStatsCommands().meetupGetHostEventStatsHandler(
      2026,
      9,
      true,
      true,
      interaction,
    );

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses a member who is not a moderator or organizer before reading Meetup or logging', async () => {
    vi.mocked(discordUtil.requireModOrOrganizer).mockRejectedValue(
      new Error('refused'),
    );

    await expect(run()).rejects.toThrow('refused');

    expect(discordUtil.requireModOrOrganizer).toHaveBeenCalledWith(
      interaction,
      'Only moderators and organizers can view hosting stats.',
    );
    expect(meetupUtil.withMeetupClient).not.toHaveBeenCalled();
    expect(discordUtil.logModerationAction).not.toHaveBeenCalled();
  });

  it('lets a moderator or organizer through to the Meetup lookup', async () => {
    vi.mocked(discordUtil.requireModOrOrganizer).mockResolvedValue(undefined);

    await run();

    expect(meetupUtil.withMeetupClient).toHaveBeenCalledOnce();
  });
});
