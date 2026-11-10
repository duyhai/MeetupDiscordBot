import { ButtonInteraction, CommandInteraction } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WrappedCommands,
  currentWrappedYear,
} from '../../../src/commands/meetup/wrapped.js';
import { runShare, runWrapped } from '../../../src/lib/wrapped/handlers.js';

vi.mock('../../../src/util/discord.js', () => ({
  discordCommandWrapper: (_interaction: unknown, fn: () => Promise<void>) =>
    fn(),
}));
vi.mock('../../../src/lib/wrapped/handlers.js', () => ({
  runWrapped: vi.fn(),
  runShare: vi.fn(),
}));

describe('currentWrappedYear', () => {
  it('is the Pacific calendar year', () => {
    // 1 Jan 2027 07:00 UTC is still 31 Dec 2026 in Los Angeles.
    expect(currentWrappedYear(new Date('2027-01-01T07:00:00Z'))).toBe(2026);
    expect(currentWrappedYear(new Date('2027-01-01T09:00:00Z'))).toBe(2027);
  });
});

describe('/wrapped', () => {
  const interaction = {} as CommandInteraction;
  const handler = new WrappedCommands();

  beforeEach(() => {
    vi.mocked(runWrapped).mockClear();
    vi.mocked(runShare).mockClear();
  });

  it('defaults to the current year with refresh off', async () => {
    await handler.wrappedHandler(undefined, undefined, interaction);

    expect(runWrapped).toHaveBeenCalledWith(interaction, {
      year: currentWrappedYear(),
      refresh: false,
    });
  });

  it('passes an explicit year and refresh', async () => {
    await handler.wrappedHandler(2025, true, interaction);

    expect(runWrapped).toHaveBeenCalledWith(interaction, {
      year: 2025,
      refresh: true,
    });
  });

  it('rejects a year before 2015 or after this one', async () => {
    await expect(
      handler.wrappedHandler(2014, undefined, interaction),
    ).rejects.toThrow(/2015/);
    await expect(
      handler.wrappedHandler(currentWrappedYear() + 1, undefined, interaction),
    ).rejects.toThrow(/2015/);
    expect(runWrapped).not.toHaveBeenCalled();
  });

  it('routes the share button to runShare', async () => {
    const button = { customId: 'wrapped_share:2026:1' } as ButtonInteraction;

    await handler.shareHandler(button);

    expect(runShare).toHaveBeenCalledWith(button);
  });
});
