import { describe, expect, it, vi } from 'vitest';

import {
  APPROVE_ID,
  PostTarget,
  DENY_ID,
  decisionLine,
  mirrorDecision,
  postRequest,
  requestButtons,
  requestIdFrom,
  requestPostContent,
} from '../../../src/lib/hosts/requestPost.js';
import { EventRequest } from '../../../src/lib/repositories/postgresEventRequestRepository.js';
import { GUEST_HOST_EVENT_DESCRIPTION } from '../../../src/templates/createEventTemplate.js';
import { eventRequestRow } from '../../web/routes/pageFakes.js';

const ORIGIN = 'https://meetup-discord-bot.herokuapp.com';
const LINKS = { origin: ORIGIN };
const DISCORD = '123456789012345678';
const LEADER = '223456789012345678';

const pending = eventRequestRow({
  id: '17',
  discordUserId: DISCORD,
  description: `💡 Host Tip: Start small 💡\n\n${GUEST_HOST_EVENT_DESCRIPTION}`,
});

describe('requestPostContent', () => {
  it('keeps the request post format, with the defaults and the links', () => {
    const text = requestPostContent(pending, 3, LINKS);
    expect(text).toContain(
      `❗<@${DISCORD}> is requesting the creation of a new Meetup event.❗`,
    );
    expect(text).toContain('**Meetup User ID**: 4242');
    expect(text).toContain('**Number of hosted events**: 3');
    expect(text).toContain('**Event Date**: 2026-11-20');
    expect(text).toContain('**Event Title**: Board game night');
    expect(text).toContain(
      '**Starts**: 7:00 PM for 2 h · standard description and RSVP limits (12, 1 guest)',
    );
    expect(text).toContain(`<${ORIGIN}/host/requests/17>`);
    expect(text).toContain(`<${ORIGIN}/dashboard/hosts/requests>`);
    expect(text).toContain('💡 **Host Tip**: Start small 💡');
    expect(text.endsWith('Organizers, please approve or deny below:')).toBe(
      true,
    );
  });

  it('names a host with no Discord link instead of mentioning', () => {
    const text = requestPostContent(
      eventRequestRow({ discordUserId: null, hostName: '*Hana*' }),
      0,
      LINKS,
    );
    expect(text).not.toContain('<@');
    expect(text).toContain('\\*Hana\\* is requesting');
  });

  it('omits the hosted count line when it is unknown', () => {
    const text = requestPostContent(pending, undefined, LINKS);
    expect(text).not.toContain('Number of hosted events');
  });

  it('says when the description or limits are not the standard ones', () => {
    const text = requestPostContent(
      eventRequestRow({ description: 'My own text', rsvpLimit: 20 }),
      1,
      LINKS,
    );
    expect(text).toContain("host's own description");
    expect(text).toContain('RSVP limits (20, 1 guest)');
    expect(text).not.toContain('Host Tip');
  });

  it('escapes markdown in the title', () => {
    const text = requestPostContent(
      eventRequestRow({ title: '**bold** [x](https://evil)' }),
      1,
      LINKS,
    );
    expect(text).toContain('\\*\\*bold\\*\\*');
    expect(text).toContain('\\[x](https://evil)');
  });
});

describe('requestPostContent with an outcome', () => {
  it('drops the approve-or-deny line when the outcome is attached', () => {
    const text = requestPostContent(pending, 3, LINKS, { decided: true });
    expect(text).not.toContain('Organizers, please approve or deny below:');
    expect(text).toContain('**Event Title**: Board game night');
  });
});

describe('buttons', () => {
  it('names the request in the custom ids and reads it back', () => {
    expect(APPROVE_ID('17')).toBe('request-approve:17');
    expect(DENY_ID('17')).toBe('request-deny:17');
    expect(requestIdFrom('request-approve:17')).toBe('17');
    expect(requestIdFrom('request-deny:17')).toBe('17');
    expect(requestIdFrom('approve')).toBeUndefined();
    expect(requestIdFrom('request-approve:0')).toBeUndefined();
    expect(requestIdFrom('request-approve:17; drop')).toBeUndefined();
  });

  it('can render disabled', () => {
    const row = requestButtons('17', true).toJSON();
    expect(row.components).toHaveLength(2);
    expect(
      row.components.every((c) => (c as { disabled?: boolean }).disabled),
    ).toBe(true);
    expect(
      requestButtons('17', false)
        .toJSON()
        .components.map((c) => (c as { custom_id: string }).custom_id),
    ).toEqual(['request-approve:17', 'request-deny:17']);
  });
});

describe('decisionLine', () => {
  it('is empty while the request is open', () => {
    expect(decisionLine(pending)).toBeUndefined();
    expect(
      decisionLine(eventRequestRow({ status: 'publishing' })),
    ).toBeUndefined();
  });

  it('shows approval with the event link', () => {
    const line = decisionLine(
      eventRequestRow({
        status: 'published',
        decidedBy: LEADER,
        eventUrl: 'https://www.meetup.com/x/events/9/',
      }),
    );
    expect(line).toContain(`✅ Request approved by <@${LEADER}>.`);
    expect(line).toContain(
      'Link to event: <https://www.meetup.com/x/events/9/>',
    );
  });

  it('says a host published their own request', () => {
    const line = decisionLine(
      eventRequestRow({
        status: 'published',
        meetupMemberId: '4242',
        decidedBy: '4242',
        hostName: 'Hana',
        eventUrl: 'https://www.meetup.com/x/events/9/',
      }),
    );
    expect(line).toContain('✅ Published by Hana.');
    expect(line).not.toContain('approved');
    expect(line).not.toContain('<@');
  });

  it('shortens a long deny reason and points at the website', () => {
    const line = decisionLine(
      eventRequestRow({
        status: 'denied',
        decidedBy: LEADER,
        denyReason: 'x'.repeat(500),
      }),
    );
    expect(line?.length ?? 0).toBeLessThan(400);
    expect(line).toContain('… (the full reason is on the website)');
  });

  it('shows a denial with its reason, escaped', () => {
    const line = decisionLine(
      eventRequestRow({
        status: 'denied',
        decidedBy: LEADER,
        denyReason: 'Too soon **please**',
      }),
    );
    expect(line).toContain(`❌ Request denied by <@${LEADER}>.`);
    expect(line).toContain('Reason: Too soon \\*\\*please\\*\\*');
  });

  it('shows a failed publish', () => {
    const line = decisionLine(
      eventRequestRow({ status: 'failed', decidedBy: LEADER, failure: 'x' }),
    );
    expect(line).toContain('⚠️');
    expect(line).toContain('retrying on the website');
  });

  it('tells the two deciders apart: the host themself by name, a leader by Discord mention', () => {
    const base = {
      meetupMemberId: '4242',
      hostName: 'Hana',
      eventUrl: 'https://www.meetup.com/x/events/9/',
    };
    const self = decisionLine(
      eventRequestRow({ ...base, status: 'published', decidedBy: '4242' }),
    );
    const approved = decisionLine(
      eventRequestRow({ ...base, status: 'published', decidedBy: LEADER }),
    );
    const denied = decisionLine(
      eventRequestRow({
        ...base,
        status: 'denied',
        decidedBy: LEADER,
        denyReason: 'Too soon',
      }),
    );
    expect(self).toMatch(/^✅ Published by Hana\./);
    expect(approved).toMatch(
      new RegExp(`^✅ Request approved by <@${LEADER}>\\.`),
    );
    expect(denied).toMatch(new RegExp(`^❌ Request denied by <@${LEADER}>\\.`));
    expect(self).not.toContain('<@');
    expect(approved).not.toContain('Hana');
    expect(denied).not.toContain('Hana');
  });
});

type SendPayload = Parameters<PostTarget['send']>[0];
const SENT = { id: '9'.repeat(18), channelId: '8'.repeat(18) };
const sender = (fn?: () => Promise<typeof SENT>) =>
  vi.fn<(payload: SendPayload) => Promise<typeof SENT>>(
    fn ?? (async () => SENT),
  );
const disabledAll = (payload: SendPayload | undefined) =>
  payload?.components[0]
    .toJSON()
    .components.every((c) => (c as { disabled?: boolean }).disabled);

function postDeps(over: { count?: () => Promise<number> } = {}) {
  const setDiscordPost = vi.fn(async () => eventRequestRow());
  const alert = vi.fn().mockResolvedValue(true);
  return {
    setDiscordPost,
    alert,
    deps: {
      store: async () => ({ setDiscordPost }),
      pastHostedCount: over.count ?? (async () => 3),
      alert,
      origin: ORIGIN,
    },
  };
}

describe('postRequest', () => {
  it('posts without pings and records the message', async () => {
    const { deps, setDiscordPost } = postDeps();
    const send = sender();
    await postRequest(deps, pending, { send });
    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0]?.[0];
    expect(payload?.allowedMentions).toEqual({ parse: [] });
    expect(payload?.content).toContain('**Number of hosted events**: 3');
    expect(payload?.components).toHaveLength(1);
    expect(setDiscordPost).toHaveBeenCalledWith(
      '17',
      '8'.repeat(18),
      '9'.repeat(18),
    );
  });

  it('still posts when the hosted count cannot be read', async () => {
    const { deps } = postDeps({
      count: async () => {
        throw new Error('meetup down');
      },
    });
    const send = sender();
    await postRequest(deps, pending, { send });
    expect(send.mock.calls[0]?.[0].content).not.toContain(
      'Number of hosted events',
    );
  });

  it('a published request posts without live buttons', async () => {
    const { deps } = postDeps();
    const send = sender();
    await postRequest(
      deps,
      eventRequestRow({
        status: 'published',
        decidedBy: '4242',
        eventUrl: 'https://www.meetup.com/x/events/9/',
      }),
      { send },
    );
    const payload = send.mock.calls[0]?.[0];
    expect(payload?.content).toContain('✅ Published by Hana.');
    expect(payload?.content).not.toContain('Organizers, please approve');
    expect(disabledAll(payload)).toBe(true);
  });

  it('mirrors at once when the request was decided before the post was recorded', async () => {
    const { deps, setDiscordPost } = postDeps();
    // The website denied it while the post was being sent: the pointer
    // write returns the row as it is now.
    setDiscordPost.mockResolvedValueOnce(
      eventRequestRow({
        id: '17',
        status: 'denied',
        decidedBy: LEADER,
        denyReason: 'No',
        discordPost: { channelId: '8'.repeat(18), messageId: '9'.repeat(18) },
      }),
    );
    const mirror = vi.fn<(request: EventRequest) => Promise<undefined>>(
      async () => undefined,
    );
    await postRequest({ ...deps, mirror }, pending, { send: sender() });
    expect(mirror).toHaveBeenCalledTimes(1);
    expect(mirror.mock.calls[0]?.[0]).toMatchObject({ status: 'denied' });
  });

  it("does not mirror a promoted host's post that was sent already decided", async () => {
    const { deps, setDiscordPost } = postDeps();
    const published = eventRequestRow({
      id: '17',
      status: 'published',
      meetupMemberId: '4242',
      decidedBy: '4242',
      eventUrl: 'https://www.meetup.com/x/events/9/',
    });
    setDiscordPost.mockResolvedValueOnce({
      ...published,
      discordPost: { channelId: '8'.repeat(18), messageId: '9'.repeat(18) },
    });
    const mirror = vi.fn<(request: EventRequest) => Promise<undefined>>(
      async () => undefined,
    );
    await postRequest({ ...deps, mirror }, published, { send: sender() });
    expect(mirror).not.toHaveBeenCalled();
  });

  it('does not mirror a request that is still open after posting', async () => {
    const { deps } = postDeps();
    const mirror = vi.fn(async () => undefined);
    await postRequest({ ...deps, mirror }, pending, { send: sender() });
    expect(mirror).not.toHaveBeenCalled();
  });

  it('takes a known hosted count instead of reading it again', async () => {
    const count = vi.fn(async () => 99);
    const { deps } = postDeps({ count });
    const send = sender();
    await postRequest(deps, pending, { send }, 3);
    expect(count).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.[0].content).toContain(
      '**Number of hosted events**: 3',
    );
  });

  it('says the post exists but is untracked when only the pointer write fails', async () => {
    const { deps, alert, setDiscordPost } = postDeps();
    setDiscordPost.mockRejectedValueOnce(new Error('db down'));
    await postRequest(deps, pending, { send: sender() });
    const text = JSON.stringify(alert.mock.calls[0][0]);
    expect(text).toContain('posted');
    expect(text).toContain('not recorded');
    expect(text).not.toContain('Could not post');
  });

  it('alerts and does not throw when the post cannot be sent', async () => {
    const { deps, alert, setDiscordPost } = postDeps();
    const send = sender(async () => {
      throw new Error('Missing Access');
    });
    await expect(postRequest(deps, pending, { send })).resolves.toBeUndefined();
    expect(setDiscordPost).not.toHaveBeenCalled();
    expect(JSON.stringify(alert.mock.calls[0][0])).toContain(
      'Could not post request #17',
    );
  });
});

function fakeClient(options: { message?: unknown; fetchError?: Error } = {}) {
  const edit = vi.fn<(payload: unknown) => Promise<undefined>>(
    async () => undefined,
  );
  const message = options.message ?? { content: 'original', edit };
  const messages = {
    fetch: vi.fn(async () => {
      if (options.fetchError) {
        throw options.fetchError;
      }
      return message;
    }),
  };
  const channel = { isTextBased: () => true, messages };
  const channels = { fetch: vi.fn(async () => channel) };
  return { client: { channels } as never, edit, messages, channels };
}

describe('mirrorDecision', () => {
  const decided = eventRequestRow({
    status: 'denied',
    decidedBy: LEADER,
    denyReason: 'No',
    discordPost: { channelId: '8'.repeat(18), messageId: '9'.repeat(18) },
  });

  it('appends the outcome and disables the buttons', async () => {
    const { client, edit, channels, messages } = fakeClient();
    const alert = vi.fn().mockResolvedValue(true);
    await mirrorDecision({ getClient: () => client, alert }, decided);
    expect(channels.fetch).toHaveBeenCalledWith('8'.repeat(18));
    expect(messages.fetch).toHaveBeenCalledWith('9'.repeat(18));
    const payload = edit.mock.calls[0]?.[0] as {
      content: string;
      components: { toJSON: () => { components: { disabled?: boolean }[] } }[];
      allowedMentions: unknown;
    };
    expect(payload.content.startsWith('original\n')).toBe(true);
    expect(payload.content).toContain('❌ Request denied by');
    expect(
      payload.components[0].toJSON().components.every((c) => c.disabled),
    ).toBe(true);
    expect(payload.allowedMentions).toEqual({ parse: [] });
    expect(alert).not.toHaveBeenCalled();
  });

  it('a failed edit alerts and does not throw', async () => {
    const { client } = fakeClient({ fetchError: new Error('Unknown Message') });
    const alert = vi.fn().mockResolvedValue(true);
    await expect(
      mirrorDecision({ getClient: () => client, alert }, decided),
    ).resolves.toBeUndefined();
    expect(JSON.stringify(alert.mock.calls[0][0])).toContain(
      'Could not update the Discord post for request #1',
    );
  });

  it('does nothing for a request with no post, or while the bot is offline', async () => {
    const { client, channels } = fakeClient();
    const alert = vi.fn().mockResolvedValue(true);
    await mirrorDecision(
      { getClient: () => client, alert },
      eventRequestRow({ status: 'denied', discordPost: null }),
    );
    expect(channels.fetch).not.toHaveBeenCalled();
    await mirrorDecision({ getClient: () => undefined, alert }, decided);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it('does not append a second line to a self-published post', async () => {
    const edit = vi.fn();
    const { client } = fakeClient({
      message: {
        content:
          'original\n✅ Published by Hana.\nLink to event: <https://www.meetup.com/x/events/9/>',
        edit,
      },
    });
    await mirrorDecision(
      { getClient: () => client, alert: vi.fn() },
      eventRequestRow({
        status: 'published',
        meetupMemberId: '4242',
        decidedBy: '4242',
        eventUrl: 'https://www.meetup.com/x/events/9/',
        discordPost: { channelId: '8'.repeat(18), messageId: '9'.repeat(18) },
      }),
    );
    expect(edit).not.toHaveBeenCalled();
  });

  it('a failed post gets the final outcome when the request is retried or denied later', async () => {
    const failedPost =
      'original\n⚠️ Approved by <@x>, but publishing failed; leadership is retrying on the website.';
    const published = fakeClient({
      message: { content: failedPost, edit: vi.fn(async () => undefined) },
    });
    await mirrorDecision(
      { getClient: () => published.client, alert: vi.fn() },
      eventRequestRow({
        status: 'published',
        decidedBy: LEADER,
        eventUrl: 'https://www.meetup.com/x/events/9/',
        discordPost: { channelId: '8'.repeat(18), messageId: '9'.repeat(18) },
      }),
    );
    const message = (await published.messages.fetch()) as {
      edit: ReturnType<typeof vi.fn>;
    };
    const payload = message.edit.mock.calls[0]?.[0] as { content: string };
    expect(payload.content).toContain('✅ Request approved by');
    // A second failure does not stack a second warning.
    const again = fakeClient({
      message: { content: failedPost, edit: vi.fn() },
    });
    await mirrorDecision(
      { getClient: () => again.client, alert: vi.fn() },
      eventRequestRow({
        status: 'failed',
        failure: 'x',
        decidedBy: LEADER,
        discordPost: { channelId: '8'.repeat(18), messageId: '9'.repeat(18) },
      }),
    );
    expect(
      ((await again.messages.fetch()) as { edit: ReturnType<typeof vi.fn> })
        .edit,
    ).not.toHaveBeenCalled();
  });

  it('does not edit the post a second time once it carries a decision', async () => {
    const { client, edit } = fakeClient({
      message: {
        content: 'original\n❌ Request denied by <@x>.\nReason: No',
        edit: vi.fn(),
      },
    });
    await mirrorDecision({ getClient: () => client, alert: vi.fn() }, decided);
    expect(edit).not.toHaveBeenCalled();
  });
});
