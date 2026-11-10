import {
  ButtonInteraction,
  CommandInteraction,
  PermissionFlagsBits,
} from 'discord.js';
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
}: { meetupId?: string; events?: EventSummary[]; delayMs?: number } = {}) {
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
    getEventRsvps: vi.fn((eventId: string) =>
      Promise.resolve({ event: { id: eventId, rsvps: page([]) } }),
    ),
  };
}

const cached: CachedWrapped = {
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
  const deps: WrappedHandlerDeps = {
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
      (await readWrapped(h.cache, 'u1', 2026))?.stats.attendedThisYear,
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
    expect((await readWrapped(h.cache, 'u1', 2026))?.builtAt).toBe(
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
    expect(h.meetup.getSelfPastRsvpEvents).toHaveBeenCalledTimes(1);
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
    expect(await readWrapped(h.cache, 'u1', 2026)).toBeUndefined();
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
}: { customId?: string; memberFetchFails?: boolean; canView?: boolean } = {}) {
  const send = vi.fn().mockResolvedValue(undefined);
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
          return Promise.resolve({ id, displayName: 'Jane' });
        }),
      },
    },
    permissionsFor: () => ({
      has: (bit: bigint) => bit === PermissionFlagsBits.ViewChannel && canView,
    }),
    send,
  };
  return {
    interaction: {
      customId,
      user: { id: 'u1', username: 'jane', toString: () => '<@u1>' },
      client: { channels: { fetch: vi.fn().mockResolvedValue(channel) } },
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

  it('rejects a malformed custom id', async () => {
    const { interaction } = buttonInteraction({ customId: 'wrapped_share:x' });

    await expect(runShare(interaction, h.deps)).rejects.toThrow();
  });
});
