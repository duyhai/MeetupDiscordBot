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
  SERVER_ROLES,
} from '../../../src/constants.js';
import {
  logActivity,
  logAlert,
  logModeration,
  postRoleNotice,
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

  describe('postRoleNotice', () => {
    const roles = [SERVER_ROLES.moderator, SERVER_ROLES.leadership];
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

    it('postRoleNotice mentions roles in content and allows only those roles', async () => {
      const client = makeClient(sendMock);
      const fetchMock = client.channels.fetch as ReturnType<typeof vi.fn>;
      const content = `<@&${roles[0]}> <@&${roles[1]}> September 2026 is ready`;

      await expect(
        postRoleNotice(client, BOT_ALERTS_CHANNEL_ID, roles, content, {
          title: 'Report ready',
          description: 'September 2026',
        }),
      ).resolves.toBe(true);

      expect(fetchMock).toHaveBeenCalledWith(BOT_ALERTS_CHANNEL_ID);
      expect(sendMock).toHaveBeenCalledTimes(1);
      const payload = sendMock.mock.calls[0][0];
      expect(payload.content).toBe(content);
      expect(payload.embeds).toHaveLength(1);
      expect(payload.embeds[0].data.title).toBe('Report ready');
      expect(payload.allowedMentions).toEqual({
        parse: [],
        roles: ['912474048775221270', '1347289004932075521'],
      });
    });

    it('never lets content ping @everyone, @here, users or unlisted roles', async () => {
      const client = makeClient(sendMock);
      const content =
        '@everyone @here <@123> <@!456> <@&999> ' + `<@&${roles[0]}>`;

      await postRoleNotice(client, BOT_ALERTS_CHANNEL_ID, [roles[0]], content, {
        title: 'Report ready',
      });

      const payload = sendMock.mock.calls[0][0];
      // The content is sent as given; only allowedMentions decides who pings.
      expect(payload.content).toBe(content);
      // Exact shape: no parse entries (so no @everyone/@here, users or roles
      // parsed from content), no users list, and only the one listed role.
      expect(payload.allowedMentions).toStrictEqual({
        parse: [],
        roles: [roles[0]],
      });
      expect(payload.allowedMentions.roles).not.toContain('999');
      expect(payload.allowedMentions).not.toHaveProperty('users');
      expect(payload.allowedMentions).not.toHaveProperty('repliedUser');
    });

    it('copies the role list so a later caller mutation cannot widen the ping', async () => {
      const client = makeClient(sendMock);
      const given = [roles[0]];
      await postRoleNotice(client, BOT_ALERTS_CHANNEL_ID, given, 'x', {
        title: 'Report ready',
      });
      given.push('999');
      expect(sendMock.mock.calls[0][0].allowedMentions.roles).toEqual([
        roles[0],
      ]);
    });

    it('postRoleNotice returns false and swallows a send failure', async () => {
      const failure = Object.assign(
        new Error('Missing Permissions: SECRET-CONTENT-BODY'),
        { name: 'DiscordAPIError', status: 403 },
      );
      sendMock.mockRejectedValue(failure);
      const client = makeClient(sendMock);

      await expect(
        postRoleNotice(
          client,
          BOT_ALERTS_CHANNEL_ID,
          roles,
          'SECRET-CONTENT-BODY',
          { title: 'Report ready', description: 'SECRET-CONTENT-BODY' },
        ),
      ).resolves.toBe(false);

      const logged = warnSpy.mock.calls
        .map((call) => call.map(String).join(' '))
        .join('\n');
      expect(logged).toContain('DiscordAPIError');
      expect(logged).toContain('403');
      expect(logged).not.toContain('SECRET-CONTENT-BODY');
    });

    it('returns false when the channel fetch fails', async () => {
      const client = makeClient(sendMock, { fetchFails: true });
      await expect(
        postRoleNotice(client, BOT_ALERTS_CHANNEL_ID, roles, 'x', {
          title: 'Report ready',
        }),
      ).resolves.toBe(false);
      expect(sendMock).not.toHaveBeenCalled();
    });
  });
});
