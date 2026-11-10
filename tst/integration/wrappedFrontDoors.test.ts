import express from 'express';
import { CommandInteraction } from 'discord.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RedisCache } from '../../src/lib/cache/redisCache.js';
import { GqlMeetupClient } from '../../src/lib/client/meetup/gqlClient.js';
import { EventSummary } from '../../src/lib/client/meetup/types.js';
import { InMemoryMemberRepository } from '../../src/lib/repositories/inMemoryMemberRepository.js';
import {
  createBuildLimiter,
  readWrapped,
  wrappedCacheKey,
} from '../../src/lib/wrapped/cache.js';
import {
  WrappedHandlerDeps,
  runWrapped,
} from '../../src/lib/wrapped/handlers.js';
import { createHostRouter } from '../../src/web/host/hostRouter.js';
import {
  WrappedPageDeps,
  registerWrappedPage,
} from '../../src/web/host/wrappedPage.js';
import { clientFor, closeServers, listen } from '../setup/loopbackServer.js';
import { FakeCache } from '../web/fakeCache.js';
import {
  DISCORD_USER,
  HOST,
  makeHostDeps,
  signInWithDiscord,
} from '../web/host/hostHarness.js';

// As the other Redis-backed integration tests: a real Redis is the point
// (the Discord command and the website share one key space there).
const REDIS_AVAILABLE = Boolean(process.env.REDISCLOUD_URL);

if (!REDIS_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    'Skipping Wrapped front-door integration tests: set REDISCLOUD_URL to a reachable Redis to run them.',
  );
}

const ME = HOST.kind === 'host' ? HOST.meetupMemberId : '';
const USER = DISCORD_USER.id;
const GROUP = '7595882';
const NOW = new Date('2026-12-10T20:00:00Z');

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

const events: EventSummary[] = [
  {
    id: '1',
    title: 'Saturday Hike',
    dateTime: '2024-03-02T10:00:00-08:00',
    eventUrl: 'https://www.meetup.com/e/1/',
  },
  {
    id: '2',
    title: 'Trivia Night',
    dateTime: '2026-05-10T19:00:00-07:00',
    eventUrl: 'https://www.meetup.com/e/2/',
  },
];

function fakeMeetup() {
  return {
    getSelfPastRsvpEvents: vi.fn(async () => ({ events, meetupId: ME })),
    getGroupEvents: vi.fn(async () => ({
      groupByUrlname: { id: GROUP, events: page([]) },
    })),
    getEventRsvps: vi.fn(async (eventId: string) => ({
      event: { id: eventId, rsvps: page([]) },
    })),
  };
}

function commandInteraction() {
  return {
    user: { id: USER, username: 'dee', globalName: 'Dee', toString: () => '' },
    member: { displayName: 'Dee' },
    guild: { members: { fetch: vi.fn().mockResolvedValue({}) } },
    channelId: '5550001',
    inGuild: () => true,
    client: {},
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
  } as unknown as CommandInteraction & {
    editReply: ReturnType<typeof vi.fn>;
    followUp: ReturnType<typeof vi.fn>;
  };
}

(REDIS_AVAILABLE ? describe : describe.skip)(
  'Wrapped: web and Discord front doors (integration)',
  () => {
    let redis: RedisCache;
    let repo: InMemoryMemberRepository;
    // Each run gets its own Discord-free year key by clearing it first.
    const year = 2026;

    beforeAll(async () => {
      redis = await RedisCache.instance();
      repo = new InMemoryMemberRepository();
      await repo.upsert({
        discordUserId: USER,
        meetupId: ME,
        meetupName: 'Dee',
        meetupMemberUrl: null,
        onboardMethod: 'self_onboard',
        onboardedBy: null,
      });
    });

    afterAll(closeServers);

    async function webApp(limiter: WrappedPageDeps['limiter']) {
      const meetup = fakeMeetup();
      const deps: WrappedPageDeps = {
        cache: async () => redis,
        memberToken: vi.fn(async () => 'member-token'),
        meetupClient: () => meetup,
        organizerRsvps: async () => undefined,
        findByMeetupId: (meetupId) => repo.findByMeetupId(meetupId),
        isPresent: async () => true,
        displayName: async () => undefined,
        limiter,
        alert: vi.fn().mockResolvedValue(true),
        groupId: GROUP,
        now: () => NOW,
      };
      const sessions = new FakeCache();
      const { deps: hostDeps } = makeHostDeps({
        cache: async () => sessions,
        pages: (router) => registerWrappedPage(router, deps),
      });
      const app = express();
      app.set('trust proxy', 1);
      app.use('/host', createHostRouter(hostDeps));
      const req = clientFor(await listen(app));
      return { req, meetup, deps };
    }

    function discordDeps(
      meetup: ReturnType<typeof fakeMeetup>,
      limiter: WrappedHandlerDeps['limiter'],
    ): WrappedHandlerDeps & { withMeetupClient: ReturnType<typeof vi.fn> } {
      const withMeetupClient = vi.fn(
        (
          _interaction: unknown,
          fn: (
            client: GqlMeetupClient,
            tokens: { accessToken: string },
          ) => Promise<void>,
        ) => fn(meetup as unknown as GqlMeetupClient, { accessToken: 't' }),
      );
      return {
        alert: vi.fn().mockResolvedValue(true),
        cache: async () => redis,
        members: async () => repo,
        withMeetupClient,
        withOrganizerMeetup: vi.fn(),
        limiter,
        now: () => NOW,
        slowAfterMs: 10_000,
      };
    }

    it('a build on the website is what /wrapped in Discord serves, with no second build', async () => {
      await redis.remove(wrappedCacheKey(USER, year));
      const limiter = createBuildLimiter(() => NOW.getTime());
      const { req, meetup } = await webApp(limiter);
      const sid = await signInWithDiscord(req);
      const res = await req
        .get(`/host/wrapped?year=${year}`)
        .set('Cookie', sid);
      expect(res.status).toBe(200);
      expect(meetup.getSelfPastRsvpEvents).toHaveBeenCalledTimes(1);

      const stored = await readWrapped(redis, USER, year, ME);
      expect(stored?.stats.attendedThisYear).toBe(1);
      expect(stored?.stats.activeYears).toEqual([2024, 2026]);

      // The Discord command: the same key, served without Meetup, and the
      // hourly slot the website took is the one it checks.
      const discordMeetup = fakeMeetup();
      const deps = discordDeps(discordMeetup, limiter);
      const interaction = commandInteraction();
      await runWrapped(interaction, { year, refresh: false }, deps);
      expect(deps.withMeetupClient).not.toHaveBeenCalled();
      expect(interaction.followUp).toHaveBeenCalledTimes(1);
      const payload = interaction.followUp.mock.calls[0][0] as {
        embeds: { data: { title?: string } }[];
      };
      expect(payload.embeds[0].data.title).toContain(`Wrapped ${year}`);

      // A refresh from Discord now meets the slot the website spent.
      const refreshing = commandInteraction();
      await runWrapped(refreshing, { year, refresh: true }, deps);
      expect(discordMeetup.getEventRsvps).not.toHaveBeenCalled();
      expect(
        (refreshing.editReply.mock.calls.at(-1)?.[0] as { content: string })
          .content,
      ).toContain('less than an hour ago');
    });

    it('a build in Discord is what the website shows, with no token and no second build', async () => {
      await redis.remove(wrappedCacheKey(USER, year));
      const limiter = createBuildLimiter(() => NOW.getTime());
      const discordMeetup = fakeMeetup();
      const deps = discordDeps(discordMeetup, limiter);
      await runWrapped(commandInteraction(), { year, refresh: false }, deps);
      expect(await readWrapped(redis, USER, year, ME)).toBeDefined();

      const { req, meetup, deps: webDeps } = await webApp(limiter);
      const sid = await signInWithDiscord(req);
      const res = await req
        .get(`/host/wrapped?year=${year}`)
        .set('Cookie', sid);
      expect(res.status).toBe(200);
      expect(res.text).toContain(`1.5 Gen Wrapped ${year}`);
      expect(res.text).toContain('Saturday Hike');
      expect(webDeps.memberToken).not.toHaveBeenCalled();
      expect(meetup.getSelfPastRsvpEvents).not.toHaveBeenCalled();
    });
  },
);
