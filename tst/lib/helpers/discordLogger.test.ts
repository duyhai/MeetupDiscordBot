/* eslint-disable
  @typescript-eslint/no-explicit-any,
  @typescript-eslint/no-unsafe-member-access,
  @typescript-eslint/no-unsafe-assignment,
  @typescript-eslint/unbound-method
*/
import { Client, TextChannel } from 'discord.js';
import { Logger } from 'tslog';
import {
  MockInstance,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  BOT_ACTIVITY_LOG_CHANNEL_ID,
  BOT_ALERTS_CHANNEL_ID,
  MODERATION_LOG_CHANNEL_ID,
} from '../../../src/constants.js';
import {
  logActivity,
  logAlert,
  logModeration,
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
    expect(payload).not.toHaveProperty('content');
  });

  it('logModeration sends to the staff moderation channel, not the activity log', async () => {
    const client = makeClient(sendMock);
    const fetchMock = client.channels.fetch as ReturnType<typeof vi.fn>;
    await logModeration(client, { title: 'Suspension record voided' });

    expect(fetchMock).toHaveBeenCalledWith(MODERATION_LOG_CHANNEL_ID);
    expect(fetchMock).not.toHaveBeenCalledWith(BOT_ACTIVITY_LOG_CHANNEL_ID);
    expect(sendMock.mock.calls[0][0].allowedMentions).toEqual({ parse: [] });
  });

  it('logAlert sends to the alerts channel with pings disabled', async () => {
    const client = makeClient(sendMock);
    const fetchMock = client.channels.fetch as ReturnType<typeof vi.fn>;
    await logAlert(client, { title: 'Build failed' });

    expect(fetchMock).toHaveBeenCalledWith(BOT_ALERTS_CHANNEL_ID);
    const payload = sendMock.mock.calls[0][0];
    expect(payload.allowedMentions).toEqual({ parse: [] });
    expect(payload).not.toHaveProperty('content');
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
  it.each([
    ['logActivity', logActivity],
    ['logModeration', logModeration],
    ['logAlert', logAlert],
  ])(
    'every log function sends no content and allows no mentions (%s)',
    async (_name, log) => {
      const client = makeClient(sendMock);
      await log(client, { title: 'x', description: '<@123> @everyone' });
      const payload = sendMock.mock.calls[0][0];
      expect(payload).not.toHaveProperty('content');
      expect(payload.allowedMentions).toEqual({ parse: [] });
    },
  );

  it('exports no role-notice helper', async () => {
    const exported = Object.keys(
      await import('../../../src/lib/helpers/discordLogger.js'),
    );
    expect(exported).not.toContain('postRoleNotice');
  });

  describe('send failures', () => {
    let warnSpy: MockInstance<(...args: unknown[]) => unknown>;

    beforeEach(() => {
      // Spy on the process log to prove what a failed send records.
      const proto = Logger.prototype as unknown as {
        warn: (...args: unknown[]) => unknown;
      };
      warnSpy = vi.spyOn(proto, 'warn').mockReturnValue(undefined);
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('logs the Discord error code and the channel id, never the message', async () => {
      const failure = Object.assign(
        new Error('Missing Access: SECRET-CONTENT-BODY'),
        { name: 'DiscordAPIError', status: 403, code: 50001 },
      );
      sendMock.mockRejectedValue(failure);
      const client = makeClient(sendMock);

      await logAlert(client, { title: 'Report ready' });

      const logged = warnSpy.mock.calls
        .map((call) => call.map(String).join(' '))
        .join('\n');
      expect(logged).toContain('DiscordAPIError[50001] (HTTP 403)');
      expect(logged).toContain(`to ${BOT_ALERTS_CHANNEL_ID}`);
      expect(logged).not.toContain('SECRET-CONTENT-BODY');
    });

    it('logs a short string code but drops a code that could carry text', async () => {
      const client = makeClient(sendMock);
      sendMock.mockRejectedValueOnce(
        Object.assign(new Error('boom SECRET'), { code: 'ECONNRESET' }),
      );
      await logAlert(client, { title: 'Report ready' });
      sendMock.mockRejectedValueOnce(
        Object.assign(new Error('boom'), {
          code: 'SECRET-CONTENT-BODY with spaces and a long tail of text',
        }),
      );
      await logAlert(client, { title: 'Report ready' });

      const lines = warnSpy.mock.calls.map((call) =>
        call.map(String).join(' '),
      );
      expect(lines[0]).toContain('Error[ECONNRESET]');
      expect(lines[1]).toMatch(/: Error$/);
      expect(lines.join('\n')).not.toContain('SECRET');
    });
  });
});
