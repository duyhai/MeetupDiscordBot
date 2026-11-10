import {
  ButtonInteraction,
  CommandInteraction,
  ModalSubmitInteraction,
} from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import { HostResolution } from '../../../src/lib/hosts/eligibility.js';
import { MAX_PENDING } from '../../../src/lib/hosts/eventRequest.js';
import {
  DiscordRequestDeps,
  UNLINKED_NUDGE,
  handleApprovePress,
  handleDenySubmit,
  handleRequestCommand,
  showDenyModal,
} from '../../../src/lib/hosts/discordRequests.js';
import { PublishOutcome } from '../../../src/lib/hosts/publishRequest.js';
import { DecisionOutcome } from '../../../src/lib/hosts/requestDecision.js';
import {
  EventRequest,
  NewEventRequest,
} from '../../../src/lib/repositories/postgresEventRequestRepository.js';
import { GUEST_HOST_EVENT_DESCRIPTION } from '../../../src/templates/createEventTemplate.js';
import { eventRequestRow } from '../../web/routes/pageFakes.js';

// Tuesday 2026-11-03, 10:00 Pacific.
const NOW = new Date('2026-11-03T18:00:00Z');
const DISCORD = '123456789012345678';
const LEADER = '223456789012345678';
const MEETUP = '4242';
const INTERACTION = '987654321098765432';
const ORIGIN = 'https://meetup-discord-bot.herokuapp.com';
const SENT = { id: '9'.repeat(18), channelId: '8'.repeat(18) };

const HOST: HostResolution = {
  kind: 'host',
  meetupMemberId: MEETUP,
  discordUserId: DISCORD,
  tier: 'regular',
  hostedCount: 3,
};

function memoryStore(seed: EventRequest[] = []) {
  const rows = [...seed];
  return {
    rows,
    create: vi.fn(
      async (input: NewEventRequest, options?: { maxPending?: number }) => {
        await Promise.resolve();
        if (
          options?.maxPending !== undefined &&
          rows.filter(
            (r) =>
              r.meetupMemberId === input.meetupMemberId &&
              r.status === 'pending',
          ).length >= options.maxPending
        ) {
          return 'full' as const;
        }
        if (
          rows.some(
            (r) =>
              r.meetupMemberId === input.meetupMemberId &&
              r.submitToken === input.submitToken,
          )
        ) {
          return undefined;
        }
        const row: EventRequest = {
          ...input,
          id: String(rows.length + 1),
          source: input.source ?? 'web',
          discordPost: null,
          status: 'pending',
          denyReason: null,
          failure: null,
          decidedBy: null,
          decidedAt: null,
          meetupEventId: null,
          eventUrl: null,
          version: 1,
          createdAt: NOW,
          updatedAt: NOW,
        };
        rows.push(row);
        return row;
      },
    ),
    findBySubmitToken: vi.fn(async (member: string, token: string) => {
      await Promise.resolve();
      return rows.find(
        (r) => r.meetupMemberId === member && r.submitToken === token,
      );
    }),
    countPending: vi.fn(async (member: string) => {
      await Promise.resolve();
      return rows.filter(
        (r) => r.meetupMemberId === member && r.status === 'pending',
      ).length;
    }),
    get: vi.fn(async (id: string) => {
      await Promise.resolve();
      return rows.find((r) => r.id === id);
    }),
    setDiscordPost: vi.fn(async (id: string, c: string, m: string) => {
      await Promise.resolve();
      const row = rows.find((r) => r.id === id);
      if (row) {
        row.discordPost = { channelId: c, messageId: m };
      }
      return row;
    }),
  };
}

function setup(
  options: {
    meetupId?: string | undefined;
    resolution?: HostResolution;
    rows?: EventRequest[];
    decide?: (calls: number) => DecisionOutcome;
  } = {},
) {
  const store = memoryStore(options.rows);
  let decisions = 0;
  const decide = vi.fn(async (): Promise<DecisionOutcome> => {
    decisions += 1;
    return (
      options.decide?.(decisions) ?? {
        code: 'published',
        request: eventRequestRow({ status: 'published' }),
      }
    );
  });
  const alert = vi.fn().mockResolvedValue(true);
  const mirror = vi.fn(async (_request: EventRequest) => undefined);
  const publish = vi.fn(async (id: string): Promise<PublishOutcome> => ({
    code: 'published',
    request: {
      ...(store.rows.find((r) => r.id === id) ?? eventRequestRow()),
      status: 'published',
      decidedBy: MEETUP,
      eventUrl: 'https://www.meetup.com/x/events/9/',
    },
  }));
  const deps: DiscordRequestDeps = {
    now: () => NOW,
    meetupIdForDiscord: vi.fn(async () => {
      await Promise.resolve();
      return 'meetupId' in options ? options.meetupId : MEETUP;
    }),
    resolve: vi.fn(async () => options.resolution ?? HOST),
    store: async () => store,
    pastHostedCount: async () => 3,
    publish,
    decide,
    tip: () => 'Start small',
    alert,
    origin: ORIGIN,
    mirror,
  };
  return { deps, store, decide, alert, publish, mirror };
}

type Payload = Record<string, unknown>;
const mockFn = <R>(value: R) =>
  vi.fn<(payload: Payload) => Promise<R>>(async () => value);

function commandInteraction() {
  const followUp = mockFn(SENT);
  const editReply = mockFn(undefined);
  const raw = {
    id: INTERACTION,
    user: { id: DISCORD, username: 'dee', toString: () => `<@${DISCORD}>` },
    followUp,
    editReply,
    client: {},
  };
  return {
    interaction: raw as unknown as CommandInteraction,
    followUp,
    editReply,
  };
}

const GOOD = { year: 2026, month: 11, day: 20, title: 'Board game night' };

describe('/meetup_request_event → the shared request row', () => {
  it('creates the row with the website defaults, tagged as a Discord request', async () => {
    const { deps, store } = setup();
    const { interaction, followUp } = commandInteraction();
    await handleRequestCommand(deps, interaction, GOOD);
    const row = store.rows[0];
    expect(row).toMatchObject({
      meetupMemberId: MEETUP,
      discordUserId: DISCORD,
      hostName: 'dee',
      tier: 'regular',
      kind: 'fresh',
      source: 'discord',
      submitToken: INTERACTION,
      title: 'Board game night',
      startLocal: '2026-11-20T19:00',
      duration: 'PT2H',
      rsvpLimit: 12,
      guestLimit: 1,
    });
    expect(row.description.startsWith('💡 Host Tip: Start small 💡\n\n')).toBe(
      true,
    );
    expect(row.description.endsWith(GUEST_HOST_EVENT_DESCRIPTION)).toBe(true);
    // The public post, in this channel, with the request's buttons.
    const payload = followUp.mock.calls[0]?.[0] as unknown as {
      content: string;
      components: { toJSON: () => { components: { custom_id: string }[] } }[];
      allowedMentions: unknown;
    };
    expect(payload.content).toContain('**Event Title**: Board game night');
    expect(payload.content).toContain(`<${ORIGIN}/host/requests/1>`);
    expect(
      payload.components[0].toJSON().components.map((c) => c.custom_id),
    ).toEqual(['request-approve:1', 'request-deny:1']);
    expect(payload.allowedMentions).toEqual({ parse: [] });
    expect(row.discordPost).toEqual({
      channelId: SENT.channelId,
      messageId: SENT.id,
    });
  });

  it('uses the hosted count resolveHost already read, so there is no second organizer read', async () => {
    const { deps } = setup();
    const pastHostedCount = vi.fn(async () => 7);
    const { interaction, followUp } = commandInteraction();
    await handleRequestCommand({ ...deps, pastHostedCount }, interaction, GOOD);
    expect(pastHostedCount).not.toHaveBeenCalled();
    expect(
      (followUp.mock.calls[0]?.[0] as { content: string }).content,
    ).toContain('**Number of hosted events**: 3');
  });

  it("a Community Host's publish alerts with host, when and title", async () => {
    const { deps, alert } = setup({
      resolution: { ...HOST, tier: 'promoted' },
    });
    const { interaction } = commandInteraction();
    await handleRequestCommand(deps, interaction, GOOD);
    const text = JSON.stringify(alert.mock.calls[0][0]);
    expect(text).toContain('Community Host published an event');
    expect(text).toContain('Board game night');
    expect(text).toContain('dee');
  });

  it('alerts leadership once, plainly', async () => {
    const { deps, alert } = setup();
    const { interaction } = commandInteraction();
    await handleRequestCommand(deps, interaction, GOOD);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(alert.mock.calls[0][0])).toContain(
      'New host event request',
    );
    expect(JSON.stringify(alert.mock.calls[0][0])).not.toContain('<@');
  });

  it('nudges an unlinked member to Verify instead of failing', async () => {
    const { deps, store } = setup({ meetupId: undefined });
    const { interaction, editReply } = commandInteraction();
    await handleRequestCommand(deps, interaction, GOOD);
    expect(store.create).not.toHaveBeenCalled();
    const reply = editReply.mock.calls[0]?.[0] as unknown as {
      content: string;
    };
    expect(reply.content).toBe(UNLINKED_NUDGE(ORIGIN));
    expect(reply.content).toContain('Verify');
    expect(reply.content).toContain(`${ORIGIN}/host`);
  });

  it('refuses a blacklisted member with no row', async () => {
    const { deps, store } = setup({
      resolution: { kind: 'refused', reason: 'blacklisted' },
    });
    const { interaction } = commandInteraction();
    await expect(handleRequestCommand(deps, interaction, GOOD)).rejects.toThrow(
      /cannot request/,
    );
    expect(store.create).not.toHaveBeenCalled();
  });

  it('lets a first-time host (no role, no events) request as a regular host', async () => {
    const { deps, store } = setup({
      resolution: { kind: 'refused', reason: 'not-a-host' },
    });
    const { interaction } = commandInteraction();
    await handleRequestCommand(deps, interaction, GOOD);
    expect(store.rows[0]).toMatchObject({ tier: 'regular', source: 'discord' });
  });

  it("applies the website's date rules", async () => {
    const { deps, store } = setup();
    const { interaction } = commandInteraction();
    await expect(
      handleRequestCommand(deps, interaction, { ...GOOD, day: 3 }),
    ).rejects.toThrow('Pick a date from tomorrow on.');
    await expect(
      handleRequestCommand(deps, interaction, { ...GOOD, month: 2, day: 30 }),
    ).rejects.toThrow('Pick a date.');
    await expect(
      handleRequestCommand(deps, interaction, { ...GOOD, year: 2028 }),
    ).rejects.toThrow('within the next 365 days');
    expect(store.create).not.toHaveBeenCalled();
  });

  it('counts the cap again under the per-host lock when creating', async () => {
    const { deps, store } = setup();
    // The pre-check saw room; another request landed before the insert.
    store.countPending.mockResolvedValueOnce(0);
    store.create.mockResolvedValueOnce('full');
    const { interaction } = commandInteraction();
    await expect(handleRequestCommand(deps, interaction, GOOD)).rejects.toThrow(
      `${MAX_PENDING} requests waiting`,
    );
    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'discord' }),
      { maxPending: MAX_PENDING },
    );
  });

  it('stops at the pending cap', async () => {
    const { deps, store } = setup({
      rows: Array.from({ length: MAX_PENDING }, (_, i) =>
        eventRequestRow({
          id: String(i + 1),
          meetupMemberId: MEETUP,
          submitToken: `t${i}`.padEnd(16, 'x'),
        }),
      ),
    });
    const { interaction } = commandInteraction();
    await expect(handleRequestCommand(deps, interaction, GOOD)).rejects.toThrow(
      `${MAX_PENDING} requests waiting`,
    );
    expect(store.create).not.toHaveBeenCalled();
  });

  it('a retried interaction makes one request and points at it', async () => {
    const { deps, store } = setup();
    const first = commandInteraction();
    await handleRequestCommand(deps, first.interaction, GOOD);
    const second = commandInteraction();
    await handleRequestCommand(deps, second.interaction, GOOD);
    expect(store.create).toHaveBeenCalledTimes(1);
    expect(second.followUp).not.toHaveBeenCalled();
    const reply = second.editReply.mock.calls[0]?.[0] as unknown as {
      content: string;
    };
    expect(reply.content).toContain('already');
    expect(reply.content).toContain(`${ORIGIN}/host/requests/1`);
  });

  it("a Community Host's request is published at once and posted without live buttons", async () => {
    const { deps, store, publish } = setup({
      resolution: { ...HOST, tier: 'promoted' },
    });
    const { interaction, followUp } = commandInteraction();
    await handleRequestCommand(deps, interaction, GOOD);
    expect(store.rows[0].tier).toBe('promoted');
    expect(publish).toHaveBeenCalledWith('1', 1, MEETUP);
    const payload = followUp.mock.calls[0]?.[0] as unknown as {
      content: string;
      components: { toJSON: () => { components: { disabled?: boolean }[] } }[];
    };
    expect(payload.content).toContain('✅ Published by dee.');
    expect(
      payload.components[0].toJSON().components.every((c) => c.disabled),
    ).toBe(true);
  });
});

function buttonInteraction(customId: string) {
  const followUp = mockFn(undefined);
  const showModal = mockFn(undefined);
  const raw = {
    customId,
    user: { id: LEADER, username: 'lead', toString: () => `<@${LEADER}>` },
    followUp,
    showModal,
    client: {},
  };
  return {
    interaction: raw as unknown as ButtonInteraction,
    followUp,
    showModal,
  };
}

const replyText = (followUp: ReturnType<typeof mockFn<undefined>>) =>
  (followUp.mock.calls.at(-1)?.[0] as { content: string }).content;

describe('Approve button', () => {
  it('decides through the shared service at the version it read', async () => {
    const { deps, decide } = setup({
      rows: [eventRequestRow({ id: '17', version: 2 })],
    });
    const { interaction, followUp } = buttonInteraction('request-approve:17');
    await handleApprovePress(deps, interaction);
    expect(decide).toHaveBeenCalledWith({
      id: '17',
      version: 2,
      actor: LEADER,
      action: 'approve',
    });
    expect(replyText(followUp)).toContain('Approved and published');
    expect(
      (followUp.mock.calls[0]?.[0] as { ephemeral: boolean }).ephemeral,
    ).toBe(true);
  });

  it('a second press on the same version is stale', async () => {
    const { deps, decide } = setup({
      rows: [eventRequestRow({ id: '17' })],
      decide: (n) => {
        if (n === 1) {
          return { code: 'published', request: eventRequestRow() };
        }
        return { code: 'stale' };
      },
    });
    const first = buttonInteraction('request-approve:17');
    const second = buttonInteraction('request-approve:17');
    await handleApprovePress(deps, first.interaction);
    await handleApprovePress(deps, second.interaction);
    expect(decide).toHaveBeenCalledTimes(2);
    expect(replyText(second.followUp)).toContain(
      'Someone just acted on this request',
    );
  });

  it('a stale press still brings the post up to date', async () => {
    const decidedRow = eventRequestRow({
      id: '17',
      status: 'denied',
      version: 2,
      decidedBy: LEADER,
      denyReason: 'No',
    });
    const { deps, mirror } = setup({
      rows: [decidedRow],
      decide: () => ({ code: 'stale' }),
    });
    await handleApprovePress(
      deps,
      buttonInteraction('request-approve:17').interaction,
    );
    expect(mirror).toHaveBeenCalledTimes(1);
    expect(mirror.mock.calls[0]?.[0]).toMatchObject({
      id: '17',
      status: 'denied',
    });
  });

  it('refuses to approve a request whose start has passed, without touching it', async () => {
    const { deps, decide } = setup({
      rows: [eventRequestRow({ id: '17', startLocal: '2026-11-01T19:00' })],
    });
    const { interaction, followUp } = buttonInteraction('request-approve:17');
    await handleApprovePress(deps, interaction);
    expect(decide).not.toHaveBeenCalled();
    expect(replyText(followUp)).toContain('start time has passed');
  });

  it('points a deny of a request whose event exists at the website', async () => {
    const { deps } = setup({
      rows: [eventRequestRow({ id: '17' })],
      decide: () => ({ code: 'deny-event-exists' }),
    });
    const { interaction, followUp } = buttonInteraction('request-approve:17');
    await handleApprovePress(deps, interaction);
    expect(replyText(followUp)).toContain(`${ORIGIN}/dashboard/hosts/requests`);
    expect(replyText(followUp)).not.toMatch(/^.*Retry to finish/);
  });

  it('tells a non-leader plainly', async () => {
    const { deps } = setup({
      rows: [eventRequestRow({ id: '17' })],
      decide: () => ({ code: 'not-leadership' }),
    });
    const { interaction, followUp } = buttonInteraction('request-approve:17');
    await handleApprovePress(deps, interaction);
    expect(replyText(followUp)).toContain('Only the 1.5 Leadership Team');
  });

  it('refuses an unknown request or a foreign custom id', async () => {
    const { deps, decide } = setup({ rows: [] });
    await expect(
      handleApprovePress(
        deps,
        buttonInteraction('request-approve:17').interaction,
      ),
    ).rejects.toThrow(/no longer exists/);
    await expect(
      handleApprovePress(deps, buttonInteraction('approve').interaction),
    ).rejects.toThrow();
    expect(decide).not.toHaveBeenCalled();
  });

  it('points at the website when the publish failed', async () => {
    const { deps } = setup({
      rows: [eventRequestRow({ id: '17' })],
      decide: () => ({
        code: 'failed',
        request: eventRequestRow({ status: 'failed' }),
      }),
    });
    const { interaction, followUp } = buttonInteraction('request-approve:17');
    await handleApprovePress(deps, interaction);
    expect(replyText(followUp)).toContain(`${ORIGIN}/dashboard/hosts/requests`);
  });
});

describe('Deny button and modal', () => {
  it('opens a reason modal named after the request', async () => {
    const { interaction, showModal } = buttonInteraction('request-deny:17');
    await showDenyModal(interaction);
    const modal = (
      showModal.mock.calls[0]?.[0] as unknown as { toJSON: () => unknown }
    ).toJSON() as {
      custom_id: string;
      components: { components: { custom_id: string; max_length: number }[] }[];
    };
    expect(modal.custom_id).toBe('request-deny:17');
    expect(modal.components[0].components[0]).toMatchObject({
      custom_id: 'reason',
      max_length: 500,
    });
  });

  it('denies through the shared service with the typed reason', async () => {
    const { deps, decide } = setup({
      rows: [eventRequestRow({ id: '17', version: 3 })],
      decide: () => ({
        code: 'denied',
        request: eventRequestRow({ status: 'denied' }),
      }),
    });
    const followUp = mockFn(undefined);
    const interaction = {
      customId: 'request-deny:17',
      user: { id: LEADER, username: 'lead', toString: () => `<@${LEADER}>` },
      fields: {
        getTextInputValue: (id: string) => {
          return id === 'reason' ? 'Too soon' : '';
        },
      },
      followUp,
      client: {},
    } as unknown as ModalSubmitInteraction;
    await handleDenySubmit(deps, interaction);
    expect(decide).toHaveBeenCalledWith({
      id: '17',
      version: 3,
      actor: LEADER,
      action: 'deny',
      reason: 'Too soon',
    });
    expect(replyText(followUp)).toContain('Denied');
  });
});
