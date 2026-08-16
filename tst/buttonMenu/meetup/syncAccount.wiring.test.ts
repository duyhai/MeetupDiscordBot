/* eslint-disable @typescript-eslint/unbound-method */
import { ButtonInteraction, EmbedBuilder } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MeetupSyncAccountCommands } from '../../../src/buttonMenu/meetup/syncAccount.js';

/**
 * Guards the CALL SITE, not the helpers.
 *
 * selfOnboardUser, getUserRoles and getBadges stopped replying for themselves
 * and now return facts for the button to compose. Each is unit-tested in
 * isolation, and buildVerificationSummary is unit-tested in isolation -- but
 * none of that proves the handler threads one into the other. A previous
 * release shipped exactly that shape of bug: a correct, fully unit-tested
 * badge helper that was never wired into its caller, so production quietly
 * kept running the old path (see tst/integration/getBadges.wiring.test.ts).
 *
 * Every field below is given a distinct value, so a swapped or dropped
 * argument changes the rendered embed rather than passing unnoticed.
 */

// vi.mock factories are hoisted above the module body, so the values they
// return have to be hoisted with them.
const { ATTENDED, HOSTED, MEETUP_NAME, MEETUP_URL, ROLES } = vi.hoisted(() => ({
  ATTENDED: 327,
  HOSTED: 133,
  MEETUP_NAME: 'Wired Tester',
  MEETUP_URL: 'https://www.meetup.com/members/424242/',
  ROLES: ['Organizer', 'Guest Host'],
}));

vi.mock('../../../src/lib/helpers/onboardUser.js', () => ({
  selfOnboardUser: vi.fn().mockResolvedValue({
    meetupName: MEETUP_NAME,
    meetupMemberUrl: MEETUP_URL,
  }),
}));
vi.mock('../../../src/lib/helpers/getUserRoles.js', () => ({
  getUserRoles: vi.fn().mockResolvedValue(ROLES),
}));
vi.mock('../../../src/lib/helpers/getBadges.js', () => ({
  getBadges: vi
    .fn()
    .mockResolvedValue({ attendedCount: ATTENDED, hostedCount: HOSTED }),
}));

// Run the callbacks straight through: this test is about what the handler
// composes, not about the wrapper or the Meetup client.
vi.mock('../../../src/util/meetup.js', () => ({
  withMeetupClient: vi.fn(async (_interaction, fn: (c: unknown) => unknown) => {
    await fn({});
  }),
}));
vi.mock('../../../src/util/discord.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/util/discord.js')>();
  return {
    ...actual,
    // linkStr stays real -- the embed's Meetup field is built with it.
    discordCommandWrapper: vi.fn(async (_interaction, fn: () => unknown) => {
      await fn();
    }),
  };
});

function fakeInteraction() {
  return {
    guild: {},
    user: { id: 'discord-1', username: 'tester' },
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
  } as unknown as ButtonInteraction;
}

async function pressButton() {
  const interaction = fakeInteraction();
  await new MeetupSyncAccountCommands().meetupSyncAccountEventHandler(
    interaction,
  );

  const calls = vi.mocked(interaction.followUp).mock.calls;
  const [payload] = calls[calls.length - 1] as [{ embeds: EmbedBuilder[] }];
  return { interaction, embed: payload.embeds[0].toJSON() };
}

describe('sync button verification summary wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('answers with exactly one summary message', async () => {
    const { interaction } = await pressButton();

    expect(vi.mocked(interaction.followUp)).toHaveBeenCalledTimes(1);
  });

  it('threads every helper result into the rendered embed', async () => {
    const { embed } = await pressButton();
    const fields = Object.fromEntries(
      (embed.fields ?? []).map((field) => [field.name, field.value]),
    );

    expect(embed.title).toBe('✅ You are verified');
    // Both halves come from selfOnboardUser; linkStr composes them.
    expect(fields.Meetup).toBe(`[${MEETUP_NAME}](${MEETUP_URL})`);
    expect(fields.Roles).toBe('Organizer, Guest Host');
    // Distinct counts: a swap here would render "133 attended · 327 hosted".
    expect(fields.Activity).toBe(
      `${ATTENDED} attended · ${HOSTED} hosted — badges applied`,
    );
  });

  it('sends the summary ephemerally', async () => {
    const { interaction } = await pressButton();
    const [payload] = vi.mocked(interaction.followUp).mock.calls[0] as [
      { ephemeral: boolean },
    ];

    expect(payload.ephemeral).toBe(true);
  });
});
