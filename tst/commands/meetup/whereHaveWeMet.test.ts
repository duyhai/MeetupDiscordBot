import { CommandInteraction, GuildMember } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WhereHaveWeMetCommands } from '../../../src/commands/meetup/whereHaveWeMet.js';
import { replyWhereHaveWeMet } from '../../../src/lib/helpers/whereHaveWeMet.js';

vi.mock('../../../src/util/discord.js', () => ({
  discordCommandWrapper: (_interaction: unknown, fn: () => Promise<void>) =>
    fn(),
}));
vi.mock('../../../src/lib/helpers/whereHaveWeMet.js', async (original) => ({
  ...(await original<
    typeof import('../../../src/lib/helpers/whereHaveWeMet.js')
  >()),
  replyWhereHaveWeMet: vi.fn(),
}));

describe('/where_have_we_met', () => {
  const interaction = {} as CommandInteraction;
  const handler = new WhereHaveWeMetCommands();

  beforeEach(() => {
    vi.mocked(replyWhereHaveWeMet).mockClear();
  });

  it('names a server member by their display name', async () => {
    // discordx passes a GuildMember for someone on the server, and a
    // GuildMember has no globalName or username of its own.
    const member = { id: 'd2', displayName: 'Jane' } as GuildMember;

    await handler.whereHaveWeMetHandler(member, undefined, interaction);

    expect(replyWhereHaveWeMet).toHaveBeenCalledWith(
      interaction,
      { discordUserId: 'd2' },
      'Jane',
    );
  });

  it('accepts a profile link copied from the group’s member list', async () => {
    await handler.whereHaveWeMetHandler(
      undefined,
      'https://www.meetup.com/1-5genasians/members/238429835/',
      interaction,
    );

    expect(replyWhereHaveWeMet).toHaveBeenCalledWith(
      interaction,
      { meetupId: '238429835' },
      'them',
    );
  });
});
