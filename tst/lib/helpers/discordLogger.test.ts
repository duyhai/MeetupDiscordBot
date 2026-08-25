/* eslint-disable
  @typescript-eslint/no-explicit-any,
  @typescript-eslint/no-unsafe-member-access,
  @typescript-eslint/no-unsafe-assignment,
  @typescript-eslint/unbound-method
*/
import { Client, TextChannel } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BOT_ACTIVITY_LOG_CHANNEL_ID } from '../../../src/constants.js';
import {
  logActivity,
  logAlert,
} from '../../../src/lib/helpers/discordLogger.js';

function makeClient(
  sendMock: ReturnType<typeof vi.fn>,
  options?: { fetchFails?: boolean },
) {
  const channel = Object.create(TextChannel.prototype) as TextChannel;
  (channel as any).send = sendMock;
  return {
    channels: {
      fetch: options?.fetchFails
        ? vi.fn().mockRejectedValue(new Error('fetch failed'))
        : vi.fn().mockResolvedValue(channel),
    },
  } as unknown as Client;
}

describe('discordLogger', () => {
  let sendMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendMock = vi.fn().mockResolvedValue(undefined);
  });

  it('logActivity sends one embed to the activity channel with pings disabled', async () => {
    const client = makeClient(sendMock);
    const fetchMock = client.channels.fetch as ReturnType<typeof vi.fn>;
    await logActivity(client, { title: 'User onboarded' });

    expect(fetchMock).toHaveBeenCalledWith(BOT_ACTIVITY_LOG_CHANNEL_ID);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const payload = sendMock.mock.calls[0][0];
    expect(payload.embeds).toHaveLength(1);
    expect(payload.allowedMentions).toEqual({ parse: [] });
  });

  it('logAlert includes fields in the embed', async () => {
    const client = makeClient(sendMock);
    await logAlert(client, {
      title: 'Duplicate blocked',
      fields: [{ name: 'Meetup ID', value: '123' }],
    });

    const embed = sendMock.mock.calls[0][0].embeds[0];
    expect(embed.data.title).toBe('Duplicate blocked');
    expect(embed.data.fields).toEqual([
      { name: 'Meetup ID', value: '123', inline: undefined },
    ]);
  });

  it('never throws when channel fetch fails, and reports the failure', async () => {
    const client = makeClient(sendMock, { fetchFails: true });
    // Swallowing the error protects the caller; returning false lets a caller
    // that consumed a once-a-day claim (the identity digest) know to retry.
    await expect(logActivity(client, { title: 'x' })).resolves.toBe(false);
    await expect(logAlert(client, { title: 'x' })).resolves.toBe(false);
  });

  it('never throws when send fails, and reports the failure', async () => {
    sendMock.mockRejectedValue(new Error('rate limited'));
    const client = makeClient(sendMock);
    await expect(logActivity(client, { title: 'x' })).resolves.toBe(false);
  });

  it('reports success when the post lands', async () => {
    const client = makeClient(sendMock);
    await expect(logAlert(client, { title: 'x' })).resolves.toBe(true);
  });
});
