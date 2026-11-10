import { describe, expect, it, vi } from 'vitest';

import {
  hostResolveDeps,
  postRequestToChannel,
  productionDecisionDeps,
  recreateCancelEnabled,
  requestsChannelId,
} from '../../../src/web/host/hostServices.js';
import { eventRequestRow } from '../../web/routes/pageFakes.js';

const organizer = vi.hoisted(() => ({
  getGroupEvents: vi.fn(),
}));

// The organizer read: fn runs on a fake client, no token or Redis involved.
vi.mock(
  '../../../src/lib/reports/organizerMeetup.js',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    withOrganizerMeetup: (
      _client: unknown,
      fn: (meetup: typeof organizer) => Promise<unknown>,
    ) => fn(organizer),
  }),
);

describe('hostResolveDeps.pastHostedCount', () => {
  it('lists the member’s PAST events with the organizer credential and counts only what counts', async () => {
    organizer.getGroupEvents.mockResolvedValue({
      groupByUrlname: {
        id: 'g',
        events: {
          pageInfo: { hasNextPage: false, endCursor: null },
          totalCount: 3,
          edges: [
            { node: { id: '1', title: 'Hike', status: 'PAST', dateTime: 'x' } },
            {
              node: {
                id: '2',
                title: '[Open House] Pickleball',
                status: 'PAST',
                dateTime: 'x',
              },
            },
            {
              node: {
                id: '3',
                title: 'Boba',
                status: 'CANCELLED',
                dateTime: 'x',
              },
            },
          ],
        },
      },
    });
    const count = await hostResolveDeps(() => undefined).pastHostedCount(
      '4242',
    );
    expect(count).toBe(1);
    expect(organizer.getGroupEvents).toHaveBeenCalledWith(expect.anything(), {
      status: ['PAST'],
      hostId: '4242',
    });
  });
});

const CHANNEL = '1'.repeat(19);

describe('requestsChannelId', () => {
  it('is unset without the variable, with one warning', () => {
    const warn = vi.fn();
    expect(requestsChannelId({}, warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('EVENT_REQUESTS_CHANNEL_ID');
  });

  it('returns a well-formed id and refuses anything else', () => {
    const warn = vi.fn();
    expect(
      requestsChannelId({ EVENT_REQUESTS_CHANNEL_ID: ` ${CHANNEL} ` }, warn),
    ).toBe(CHANNEL);
    expect(warn).not.toHaveBeenCalled();
    expect(
      requestsChannelId({ EVENT_REQUESTS_CHANNEL_ID: 'general' }, warn),
    ).toBeUndefined();
    expect(warn.mock.calls.at(-1)?.[0]).toContain('not a Discord channel id');
  });
});

describe('postRequestToChannel', () => {
  function fakes() {
    const send = vi.fn(async () => ({
      id: '9'.repeat(18),
      channelId: CHANNEL,
    }));
    const channel = { isTextBased: () => true, isSendable: () => true, send };
    const client = { channels: { fetch: vi.fn(async () => channel) } };
    const setDiscordPost = vi.fn(async () => eventRequestRow());
    const alert = vi.fn().mockResolvedValue(true);
    const post = postRequestToChannel(() => client as never, CHANNEL, {
      store: async () => ({ setDiscordPost }),
      pastHostedCount: async () => 2,
      alert,
      origin: 'https://meetup-discord-bot.herokuapp.com',
    });
    return { post, send, client, setDiscordPost, alert };
  }

  it('posts the request in the configured channel and records it', async () => {
    const { post, send, client, setDiscordPost } = fakes();
    await post(eventRequestRow({ id: '3' }));
    expect(client.channels.fetch).toHaveBeenCalledWith(CHANNEL);
    expect(send).toHaveBeenCalledTimes(1);
    expect(setDiscordPost).toHaveBeenCalledWith('3', CHANNEL, '9'.repeat(18));
  });

  it('alerts instead of throwing while the bot is offline', async () => {
    const { alert } = fakes();
    const post = postRequestToChannel(() => undefined, CHANNEL, {
      store: async () => ({ setDiscordPost: vi.fn() }),
      pastHostedCount: async () => 2,
      alert,
      origin: 'https://meetup-discord-bot.herokuapp.com',
    });
    await expect(post(eventRequestRow())).resolves.toBeUndefined();
    expect(JSON.stringify(alert.mock.calls[0][0])).toContain(
      'Could not post request #1',
    );
  });
});

describe('productionDecisionDeps', () => {
  it('is one instance per process, so the refusal audit is once a minute per actor', () => {
    const first = productionDecisionDeps(() => undefined);
    const second = productionDecisionDeps(() => undefined);
    expect(second).toBe(first);
    expect(first.refusals.take('223456789012345678')).toBe(true);
    expect(first.refusals.take('223456789012345678')).toBe(false);
    expect(first.refusals.take('323456789012345678')).toBe(true);
  });
});

describe('recreateCancelEnabled', () => {
  it('is on only with ANNOUNCE_RECREATE_CANCEL=1', () => {
    expect(recreateCancelEnabled({})).toBe(false);
    expect(recreateCancelEnabled({ ANNOUNCE_RECREATE_CANCEL: '0' })).toBe(
      false,
    );
    expect(recreateCancelEnabled({ ANNOUNCE_RECREATE_CANCEL: 'true' })).toBe(
      false,
    );
    expect(recreateCancelEnabled({ ANNOUNCE_RECREATE_CANCEL: ' 1 ' })).toBe(
      true,
    );
  });
});
