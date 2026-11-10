import {
  ButtonInteraction,
  CommandInteraction,
  PermissionFlagsBits,
} from 'discord.js';
import { ClientError } from 'graphql-request';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { KeyValueCache } from '../../../src/lib/cache/base.js';
import { GqlMeetupClient } from '../../../src/lib/client/meetup/gqlClient.js';
import { EventSummary } from '../../../src/lib/client/meetup/types.js';
import { InMemoryMemberRepository } from '../../../src/lib/repositories/inMemoryMemberRepository.js';
import {
  CachedWrapped,
  createBuildLimiter,
  readWrapped,
  shareGuardKey,
  writeWrapped,
} from '../../../src/lib/wrapped/cache.js';
import { replies, shareCustomId } from '../../../src/lib/wrapped/format.js';
import {
  WrappedHandlerDeps,
  runShare,
  runWrapped,
} from '../../../src/lib/wrapped/handlers.js';

class FakeCache implements KeyValueCache {
  readonly data = new Map<string, string>();

  async get(key: string) {
    return this.data.get(key);
  }

  async set(key: string, value: string) {
    this.data.set(key, value);
  }

  async remove(key: string) {
    this.data.delete(key);
  }

  async exclusive_set(key: string, value: string) {
    if (this.data.has(key)) {
      return false;
    }
    this.data.set(key, value);
    return true;
  }

  async set_existing(key: string, value: string) {
    if (!this.data.has(key)) {
      return false;
    }
    this.data.set(key, value);
    return true;
  }
}

const GROUP = '7595882';
const CHANNEL = '5550001';

function ev(id: string, iso: string, title = `Event ${id}`): EventSummary {
  return {
    id,
    title,
    dateTime: iso,
    eventUrl: `https://www.meetup.com/e/${id}/`,
  };
}

const page = <T>(nodes: T[]) => ({
  pageInfo: {
    hasNextPage: false,
    hasPreviousPage: false,
    startCursor: null as string | null,
    endCursor: null as string | null,
  },
  totalCount: nodes.length,
  edges: nodes.map((node) => ({ node })),
});

function fakeMeetup({
  meetupId = 'me',
  events = [
    ev('1', '2024-03-02T10:00:00-08:00', 'Hike'),
    ev('2', '2026-05-10T19:00:00-07:00', 'Trivia'),
  ],
  delayMs = 0,
  attendees = {},
  rsvpsError,
}: {
  meetupId?: string;
  events?: EventSummary[];
  delayMs?: number;
  attendees?: Record<string, { id: string; name: string }[]>;
  rsvpsError?: Error;
} = {}) {
  const wait = () =>
    new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    });
  return {
    getSelfPastRsvpEvents: vi.fn(async () => {
      await wait();
      return { events, meetupId };
    }),
    getGroupEvents: vi.fn(() =>
      Promise.resolve({ groupByUrlname: { id: GROUP, events: page([]) } }),
    ),
    getEventRsvps: vi.fn((eventId: string) => {
      if (rsvpsError) {
        return Promise.reject(rsvpsError);
      }
      return Promise.resolve({
        event: {
          id: eventId,
          rsvps: page(
            (attendees[eventId] ?? []).map(({ id, name }) => ({
              status: 'YES' as const,
              member: { id, name, memberUrl: '', gender: 'NONE' as never },
            })),
          ),
        },
      });
    }),
  };
}

const cached: CachedWrapped = {
  meetupId: 'me',
  stats: {
    year: 2026,
    firstEvent: null,
    attendedThisYear: 3,
    attendedAllTime: 3,
    topTypes: [],
    hosting: null,
    busiestMonth: null,
    longestStreakMonths: 1,
  },
  companions: { named: [], otherCount: 0 },
  builtAt: '2026-12-01T20:00:00.000Z',
};

interface Harness {
  deps: WrappedHandlerDeps;
  cache: FakeCache;
  repo: InMemoryMemberRepository;
  meetup: ReturnType<typeof fakeMeetup>;
  clock: { now: number };
  withMeetupClient: ReturnType<typeof vi.fn>;
  withOrganizerMeetup: ReturnType<typeof vi.fn>;
  alert: ReturnType<typeof vi.fn>;
}

function harness(meetup = fakeMeetup()): Harness {
  const cache = new FakeCache();
  const repo = new InMemoryMemberRepository();
  const clock = { now: Date.parse('2026-12-10T20:00:00Z') };
  const withMeetupClient = vi.fn(
    (
      _interaction: unknown,
      fn: (
        client: GqlMeetupClient,
        tokens: { accessToken: string },
      ) => Promise<void>,
    ) => fn(meetup as unknown as GqlMeetupClient, { accessToken: 't' }),
  );
  const withOrganizerMeetup = vi.fn();
  const alert = vi.fn().mockResolvedValue(true);
  const deps: WrappedHandlerDeps = {
    alert,
    cache: () => Promise.resolve(cache),
    members: () => Promise.resolve(repo),
    withMeetupClient,
    withOrganizerMeetup,
    limiter: createBuildLimiter(() => clock.now),
    now: () => new Date(clock.now),
    slowAfterMs: 50,
  };
  return {
    deps,
    cache,
    repo,
    meetup,
    clock,
    withMeetupClient,
    withOrganizerMeetup,
    alert,
  };
}

function commandInteraction({
  inGuild = true,
  memberFetchFails = false,
}: { inGuild?: boolean; memberFetchFails?: boolean } = {}) {
  const guild = inGuild
    ? {
        members: {
          fetch: vi.fn((id: string) => {
            if (memberFetchFails) {
              return Promise.reject(new Error('Unknown Member'));
            }
            return Promise.resolve({ id, displayName: `Name ${id}` });
          }),
        },
      }
    : null;
  return {
    user: {
      id: 'u1',
      username: 'jane',
      globalName: 'Jane G',
      toString: () => '<@u1>',
      send: vi.fn().mockResolvedValue(undefined),
    },
    member: inGuild ? { displayName: 'Jane' } : null,
    guild,
    channelId: CHANNEL,
    inGuild: () => inGuild,
    client: {},
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
  } as unknown as CommandInteraction & {
    editReply: ReturnType<typeof vi.fn>;
    followUp: ReturnType<typeof vi.fn>;
    user: { send: ReturnType<typeof vi.fn> };
  };
}

type Payload = {
  content?: string;
  embeds?: { data: { title?: string } }[];
  components?: { toJSON(): { components: { custom_id?: string }[] } }[];
};

const payloads = (fn: ReturnType<typeof vi.fn>) =>
  fn.mock.calls.map((call) => call[0] as Payload);
const contents = (fn: ReturnType<typeof vi.fn>) =>
  payloads(fn).map((p) => p.content);
const embedTitles = (fn: ReturnType<typeof vi.fn>) =>
  payloads(fn).flatMap((p) => (p.embeds ?? []).map((e) => e.data.title));

async function link(repo: InMemoryMemberRepository, meetupId = 'me') {
  await repo.upsert({
    discordUserId: 'u1',
    meetupId,
    meetupName: 'Jane',
    meetupMemberUrl: null,
    onboardMethod: 'self_onboard',
    onboardedBy: null,
  });
}

describe('runWrapped', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it('nudges an unlinked member and never touches Meetup', async () => {
    const interaction = commandInteraction();

    await runWrapped(interaction, { year: 2026, refresh: false }, h.deps);

    expect(contents(interaction.editReply)).toContain(replies.notLinked);
    expect(h.withMeetupClient).not.toHaveBeenCalled();
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it('builds, caches and replies privately with a share button', async () => {
    await link(h.repo);
    const interaction = commandInteraction();

    await runWrapped(interaction, { year: 2026, refresh: false }, h.deps);

    expect(embedTitles(interaction.followUp)).toEqual([
      "🎁 Jane's 1.5 Gen Wrapped 2026",
    ]);
    const [payload] = payloads(interaction.followUp);
    expect(payload).toMatchObject({ ephemeral: true });
    expect(payload.components?.[0].toJSON().components[0].custom_id).toBe(
      shareCustomId(2026, CHANNEL),
    );
    expect(
      (await readWrapped(h.cache, 'u1', 2026, 'me'))?.stats.attendedThisYear,
    ).toBe(1);
    expect(h.withOrganizerMeetup).not.toHaveBeenCalled();
  });

  it('serves a cached Wrapped without building or spending the limiter', async () => {
    await link(h.repo);
    await writeWrapped(h.cache, 'u1', 2026, cached);
    const interaction = commandInteraction();

    await runWrapped(interaction, { year: 2026, refresh: false }, h.deps);

    expect(embedTitles(interaction.followUp)).toHaveLength(1);
    expect(h.withMeetupClient).not.toHaveBeenCalled();
    expect(h.deps.limiter.take('u1')).toBe(true);
  });

  it('rebuilds on refresh and overwrites the cache', async () => {
    await link(h.repo);
    await writeWrapped(h.cache, 'u1', 2026, cached);
    const interaction = commandInteraction();

    await runWrapped(interaction, { year: 2026, refresh: true }, h.deps);

    expect(h.withMeetupClient).toHaveBeenCalledTimes(1);
    expect((await readWrapped(h.cache, 'u1', 2026, 'me'))?.builtAt).toBe(
      '2026-12-10T20:00:00.000Z',
    );
  });

  it('refuses a second build within the hour and shows the cached copy', async () => {
    await link(h.repo);
    await runWrapped(
      commandInteraction(),
      { year: 2026, refresh: false },
      h.deps,
    );
    h.clock.now += 10 * 60 * 1000;
    const interaction = commandInteraction();

    await runWrapped(interaction, { year: 2026, refresh: true }, h.deps);

    expect(h.withMeetupClient).toHaveBeenCalledTimes(2);
    // The cheap history read runs (it decides whether the slot is spent at
    // all); the costly hosted/attendee scan does not.
    expect(h.meetup.getSelfPastRsvpEvents).toHaveBeenCalledTimes(2);
    expect(h.meetup.getGroupEvents).toHaveBeenCalledTimes(1);
    const last = payloads(interaction.editReply).at(-1);
    expect(last?.content).toBe(replies.rateLimited(50));
    expect(last?.embeds).toHaveLength(1);
  });

  it('reports an account mismatch and caches nothing', async () => {
    h = harness(fakeMeetup({ meetupId: 'someone-else' }));
    await link(h.repo);
    const interaction = commandInteraction();

    await runWrapped(interaction, { year: 2026, refresh: false }, h.deps);

    expect(contents(interaction.editReply)).toContain(replies.accountMismatch);
    expect(await readWrapped(h.cache, 'u1', 2026, 'me')).toBeUndefined();
    // Reconnecting and trying again must not be met with "try in 59 minutes".
    expect(h.deps.limiter.take('u1')).toBe(true);
  });

  it('delivers a slow build by DM with the share button carrying the channel', async () => {
    h = harness(fakeMeetup({ delayMs: 120 }));
    await link(h.repo);
    const interaction = commandInteraction();

    await runWrapped(interaction, { year: 2026, refresh: false }, h.deps);

    expect(contents(interaction.editReply)).toContain(replies.stillBuilding);
    const [dm] = payloads(interaction.user.send);
    expect(dm.components?.[0].toJSON().components[0].custom_id).toBe(
      shareCustomId(2026, CHANNEL),
    );
    expect(embedTitles(interaction.followUp)).toEqual([]);
  });

  it('falls back to the ephemeral follow-up when the DM is refused', async () => {
    h = harness(fakeMeetup({ delayMs: 120 }));
    await link(h.repo);
    const interaction = commandInteraction();
    interaction.user.send.mockRejectedValue(
      new Error('Cannot send messages to this user'),
    );

    await runWrapped(interaction, { year: 2026, refresh: false }, h.deps);

    expect(embedTitles(interaction.followUp)).toHaveLength(1);
  });

  it('never shows Meetup response text to members or staff, and refunds the slot', async () => {
    const SENTINEL = 'RAW-MEETUP-BODY-7f3a';
    h = harness(
      fakeMeetup({
        rsvpsError: new ClientError(
          {
            status: 500,
            headers: new Headers(),
            body: SENTINEL,
            errors: [{ message: SENTINEL }],
          } as never,
          { query: 'q' },
        ),
      }),
    );
    await link(h.repo);
    const interaction = commandInteraction();

    await expect(
      runWrapped(interaction, { year: 2026, refresh: false }, h.deps),
    ).rejects.toMatchObject({
      message: replies.buildFailed,
      alertHandled: true,
    });

    const everything = JSON.stringify([
      interaction.editReply.mock.calls,
      interaction.followUp.mock.calls,
      h.alert.mock.calls,
    ]);
    expect(everything).not.toContain(SENTINEL);
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.alert.mock.calls[0])).toContain('HTTP 500');
    expect(await readWrapped(h.cache, 'u1', 2026, 'me')).toBeUndefined();
    // A transient failure must not lock the member out for an hour.
    expect(h.deps.limiter.take('u1')).toBe(true);
  });

  it('rebuilds when the member has linked a different Meetup account since', async () => {
    await link(h.repo);
    await writeWrapped(h.cache, 'u1', 2026, { ...cached, meetupId: 'old' });
    const interaction = commandInteraction();

    await runWrapped(interaction, { year: 2026, refresh: false }, h.deps);

    expect(h.withMeetupClient).toHaveBeenCalledTimes(1);
    expect((await readWrapped(h.cache, 'u1', 2026, 'me'))?.meetupId).toBe('me');
  });

  it('tells a second concurrent run that a build is already under way', async () => {
    // Slow enough to overlap, under the 50 ms slow-build threshold.
    h = harness(fakeMeetup({ delayMs: 20 }));
    await link(h.repo);
    const first = commandInteraction();
    const second = commandInteraction();

    await Promise.all([
      runWrapped(first, { year: 2026, refresh: false }, h.deps),
      runWrapped(second, { year: 2026, refresh: false }, h.deps),
    ]);

    expect(h.meetup.getSelfPastRsvpEvents).toHaveBeenCalledTimes(1);
    expect(contents(second.editReply)).toContain(replies.alreadyBuilding);
    expect(embedTitles(first.followUp)).toHaveLength(1);
    // The lease is released once the build is done.
    expect([...h.cache.data.keys()].some((k) => k.includes('building'))).toBe(
      false,
    );
  });

  it("never lets an unlinked attendee's Meetup name or id reach the embed or the cache", async () => {
    h = harness(
      fakeMeetup({
        attendees: {
          '2': [
            { id: 'me', name: 'Jane' },
            { id: '424242', name: 'Zed Unlinked' },
            { id: '777', name: 'Linked Pal' },
          ],
        },
      }),
    );
    await link(h.repo);
    await h.repo.upsert({
      discordUserId: 'pal',
      meetupId: '777',
      meetupName: 'Linked Pal',
      meetupMemberUrl: null,
      onboardMethod: 'self_onboard',
      onboardedBy: null,
    });
    const interaction = commandInteraction();

    await runWrapped(interaction, { year: 2026, refresh: false }, h.deps);

    const embedJson = JSON.stringify(payloads(interaction.followUp));
    expect(embedJson).toContain('<@pal>');
    expect(embedJson).toContain('1 other member');
    expect(embedJson).not.toContain('424242');
    expect(embedJson).not.toContain('Zed Unlinked');
    expect(embedJson).not.toContain('Linked Pal');
    const cacheJson = JSON.stringify([...h.cache.data.values()]);
    expect(cacheJson).not.toContain('424242');
    expect(cacheJson).not.toContain('Zed');
    expect(cacheJson).not.toContain('777');
  });

  it('offers no share button when run in a DM', async () => {
    await link(h.repo);
    const interaction = commandInteraction({ inGuild: false });

    await runWrapped(interaction, { year: 2026, refresh: false }, h.deps);

    const [payload] = payloads(interaction.followUp);
    expect(payload.components ?? []).toHaveLength(0);
    expect(embedTitles(interaction.followUp)).toEqual([
      "🎁 Jane G's 1.5 Gen Wrapped 2026",
    ]);
  });
});

function buttonInteraction({
  customId = shareCustomId(2026, CHANNEL),
  memberFetchFails = false,
  canView = true,
  memberCanSend = true,
  botCanSend = true,
  channelFetchFails = false,
  sendFails = false,
}: {
  customId?: string;
  memberFetchFails?: boolean;
  canView?: boolean;
  memberCanSend?: boolean;
  botCanSend?: boolean;
  channelFetchFails?: boolean;
  sendFails?: boolean;
} = {}) {
  const send = sendFails
    ? vi.fn().mockRejectedValue(new Error('Missing Permissions'))
    : vi.fn().mockResolvedValue(undefined);
  const channel = {
    id: CHANNEL,
    isTextBased: () => true,
    isDMBased: () => false,
    guild: {
      members: {
        fetch: vi.fn((id: string) => {
          if (memberFetchFails) {
            return Promise.reject(new Error('Unknown Member'));
          }
          if (id === 'gone') {
            return Promise.reject(new Error('Unknown Member'));
          }
          return Promise.resolve({
            id,
            displayName: id === 'u1' ? 'Jane' : `Pal ${id}`,
          });
        }),
      },
    },
    isThread: () => false,
    permissionsFor: (who: { id: string }) => ({
      has: (bits: bigint | bigint[]) => {
        const wanted = Array.isArray(bits) ? bits : [bits];
        if (who.id === 'bot') {
          return botCanSend;
        }
        return wanted.every((bit) => {
          if (bit === PermissionFlagsBits.ViewChannel) {
            return canView;
          }
          if (bit === PermissionFlagsBits.SendMessages) {
            return memberCanSend;
          }
          return false;
        });
      },
    }),
    send,
  };
  const fetch = channelFetchFails
    ? vi.fn().mockRejectedValue(new Error('Unknown Channel'))
    : vi.fn().mockResolvedValue(channel);
  return {
    interaction: {
      customId,
      user: { id: 'u1', username: 'jane', toString: () => '<@u1>' },
      client: { user: { id: 'bot' }, channels: { fetch } },
      editReply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
    } as unknown as ButtonInteraction & {
      editReply: ReturnType<typeof vi.fn>;
      followUp: ReturnType<typeof vi.fn>;
    },
    send,
  };
}

describe('runShare', () => {
  let h: Harness;

  beforeEach(async () => {
    h = harness();
    await link(h.repo);
    await writeWrapped(h.cache, 'u1', 2026, cached);
  });

  it("posts the clicker's own Wrapped with no mentions parsed", async () => {
    const { interaction, send } = buttonInteraction();

    await runShare(interaction, h.deps);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({
      content: '<@u1> shared their 1.5 Gen Wrapped 2026',
      allowedMentions: { parse: [] },
    });
    expect(embedTitles(send)).toEqual(["🎁 Jane's 1.5 Gen Wrapped 2026"]);
    expect(contents(interaction.followUp)).toContain(replies.shared);
  });

  it('names companions by server display name in the public post, without tags', async () => {
    await writeWrapped(h.cache, 'u1', 2026, {
      ...cached,
      companions: {
        named: [
          { discordUserId: 'd2', sharedCount: 4 },
          { discordUserId: 'gone', sharedCount: 3 },
        ],
        otherCount: 5,
      },
    });
    const { interaction, send } = buttonInteraction();

    await runShare(interaction, h.deps);

    const json = JSON.stringify(
      (send.mock.calls[0][0] as { embeds: { toJSON(): unknown }[] }).embeds.map(
        (e) => e.toJSON(),
      ),
    );
    expect(json).not.toContain('<@');
    expect(json).toContain('Pal d2 (4 events)');
    // The one who has left the server since is folded into the count.
    expect(json).toContain('6 other members');
    expect(json).not.toContain('gone');
  });

  it('refuses a second share in the same channel that day', async () => {
    const first = buttonInteraction();
    await runShare(first.interaction, h.deps);
    const second = buttonInteraction();

    await runShare(second.interaction, h.deps);

    expect(second.send).not.toHaveBeenCalled();
    expect(contents(second.interaction.editReply)).toContain(
      replies.alreadyShared,
    );
  });

  it('tells a member with no cached Wrapped to rebuild', async () => {
    h.cache.data.clear();
    const { interaction, send } = buttonInteraction();

    await runShare(interaction, h.deps);

    expect(send).not.toHaveBeenCalled();
    expect(contents(interaction.editReply)).toContain(replies.shareExpired);
  });

  it('refuses when the clicker can no longer view the channel and releases the guard', async () => {
    const { interaction, send } = buttonInteraction({ memberFetchFails: true });

    await runShare(interaction, h.deps);

    expect(send).not.toHaveBeenCalled();
    expect(contents(interaction.editReply)).toContain(replies.cannotShareHere);
    expect(h.cache.data.has(shareGuardKey('u1', 2026, CHANNEL))).toBe(false);
  });

  it('refuses when the channel is hidden from the clicker', async () => {
    const { interaction, send } = buttonInteraction({ canView: false });

    await runShare(interaction, h.deps);

    expect(send).not.toHaveBeenCalled();
    expect(contents(interaction.editReply)).toContain(replies.cannotShareHere);
  });

  it('refuses when the clicker cannot post in the channel', async () => {
    const { interaction, send } = buttonInteraction({ memberCanSend: false });

    await runShare(interaction, h.deps);

    expect(send).not.toHaveBeenCalled();
    expect(contents(interaction.editReply)).toContain(replies.cannotShareHere);
    expect(h.cache.data.has(shareGuardKey('u1', 2026, CHANNEL))).toBe(false);
  });

  it('refuses when the bot cannot post there and releases the guard', async () => {
    const { interaction, send } = buttonInteraction({ botCanSend: false });

    await runShare(interaction, h.deps);

    expect(send).not.toHaveBeenCalled();
    expect(contents(interaction.editReply)).toContain(replies.cannotShareHere);
    expect(h.cache.data.has(shareGuardKey('u1', 2026, CHANNEL))).toBe(false);
  });

  it('treats a channel it cannot fetch as unshareable', async () => {
    const { interaction } = buttonInteraction({ channelFetchFails: true });

    await runShare(interaction, h.deps);

    expect(contents(interaction.editReply)).toContain(replies.cannotShareHere);
    expect(h.cache.data.has(shareGuardKey('u1', 2026, CHANNEL))).toBe(false);
  });

  it('releases the guard when the post itself fails', async () => {
    const { interaction } = buttonInteraction({ sendFails: true });

    await expect(runShare(interaction, h.deps)).rejects.toThrow(
      'Missing Permissions',
    );
    expect(h.cache.data.has(shareGuardKey('u1', 2026, CHANNEL))).toBe(false);
  });

  it('rejects a malformed custom id', async () => {
    const { interaction } = buttonInteraction({ customId: 'wrapped_share:x' });

    await expect(runShare(interaction, h.deps)).rejects.toThrow();
  });
});
