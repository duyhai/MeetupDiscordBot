import crypto from 'node:crypto';

import { CommandInteraction } from 'discord.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RedisCache } from '../../src/lib/cache/redisCache.js';
import { EventSummary } from '../../src/lib/client/meetup/types.js';
import { ensureDashboardSchema } from '../../src/lib/repositories/dashboardPool.js';
import { InMemoryMemberRepository } from '../../src/lib/repositories/inMemoryMemberRepository.js';
import { PostgresWrappedBackfillRepository } from '../../src/lib/repositories/postgresWrappedBackfillRepository.js';
import { PostgresWrappedEntryRepository } from '../../src/lib/repositories/postgresWrappedEntryRepository.js';
import {
  BackfillDeps,
  OrganizerReads,
  runBackfillTick,
} from '../../src/lib/wrapped/backfill.js';
import {
  createBuildLimiter,
  readWrapped,
  wrappedCacheKey,
} from '../../src/lib/wrapped/cache.js';
import {
  WrappedHandlerDeps,
  runWrapped,
} from '../../src/lib/wrapped/handlers.js';
import { useIsolatedSchema } from './isolatedSchema.js';

// Real Postgres (the runs and the queue) and real Redis (the cache the page
// and the command read): the point is that a tick writes exactly what they
// serve.
const AVAILABLE = Boolean(
  process.env.DATABASE_URL && process.env.REDISCLOUD_URL,
);

if (!AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    'Skipping Wrapped backfill tick integration tests: set DATABASE_URL and REDISCLOUD_URL to run them.',
  );
}

const GROUP = '7595882';
// The real clock: the runs' timestamps come from Postgres's own clock, and
// "due" compares the two.
const NOW = new Date();
/** Unique per run (digits only: Discord ids are snowflakes); the Redis key space is shared with other test files. */
const suffix = String(Date.now()).slice(-9);
const TOKEN_USER = `1${suffix}0001`.padEnd(18, '0');
const ORG_USER = `1${suffix}0002`.padEnd(18, '0');
const TOKEN_MEETUP = `mt-${suffix}`;
const ORG_MEETUP = `mo-${suffix}`;

const ev = (id: string, iso: string, title: string): EventSummary => ({
  id: `${suffix}-${id}`,
  title,
  dateTime: iso,
  eventUrl: `https://www.meetup.com/e/${id}/`,
});

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

const THIS_YEAR = NOW.getUTCFullYear();
const tokenEvents = [
  ev('a1', `${THIS_YEAR - 1}-03-02T10:00:00-08:00`, 'Hike'),
  ev('a2', `${THIS_YEAR}-05-10T19:00:00-07:00`, 'Trivia'),
];
const orgEvents = [ev('b1', `${THIS_YEAR}-07-04T10:00:00-07:00`, 'Picnic')];

/** An unlinked attendee at every event: must never reach a stored entry. */
const GHOST = { id: `ghost-${suffix}`, name: `Ghost Sentinel ${suffix}` };

function fakeMeetup(events: EventSummary[], meetupId: string) {
  return {
    getSelfPastRsvpEvents: vi.fn(async () => ({ events, meetupId })),
    getHostedEvents: vi.fn(async () => ({
      groupByUrlname: { id: GROUP, events: page([]) },
    })),
    getEventRsvps: vi.fn(async (eventId: string) => ({
      event: {
        id: eventId,
        rsvps: page([
          {
            status: 'YES' as const,
            member: { ...GHOST, memberUrl: '', gender: 'NONE' as never },
          },
        ]),
      },
    })),
  };
}

(AVAILABLE ? describe : describe.skip)(
  'Wrapped backfill tick (integration)',
  () => {
    let schema: { drop(): Promise<void> };
    let redis: RedisCache;
    let store: PostgresWrappedBackfillRepository;
    let entries: PostgresWrappedEntryRepository;
    let repo: InMemoryMemberRepository;
    let deps: BackfillDeps;
    const memberMeetup = fakeMeetup(tokenEvents, TOKEN_MEETUP);
    const organizerHistory = vi.fn(async (meetupId: string) => {
      return meetupId === ORG_MEETUP ? orgEvents : undefined;
    });

    beforeAll(async () => {
      schema = await useIsolatedSchema('wrapped_backfill_tick');
      store = await PostgresWrappedBackfillRepository.instance();
      entries = await PostgresWrappedEntryRepository.instance();
      await ensureDashboardSchema(
        (store as unknown as { pool: import('pg').Pool }).pool,
      );
      redis = await RedisCache.instance();
      repo = new InMemoryMemberRepository();
      for (const [discordUserId, meetupId] of [
        [TOKEN_USER, TOKEN_MEETUP],
        [ORG_USER, ORG_MEETUP],
      ]) {
        // eslint-disable-next-line no-await-in-loop -- test setup
        await repo.upsert({
          discordUserId,
          meetupId,
          meetupName: null,
          meetupMemberUrl: null,
          onboardMethod: 'self_onboard',
          onboardedBy: null,
        });
      }
      deps = {
        now: () => new Date(),
        cache: async () => redis,
        store: async () => store,
        entries: async () => entries,
        members: async () => repo,
        memberToken: async (id) => {
          return id === TOKEN_USER ? 'member-token' : undefined;
        },
        memberClient: () => memberMeetup,
        withOrganizer: async (fn) => {
          const organizer: OrganizerReads = {
            ...fakeMeetup([], ''),
            getMemberRsvpEvents: organizerHistory,
          };
          return fn(organizer);
        },
        isPresent: async () => true,
        canStart: async () => true,
        alert: vi.fn(async () => true),
        newLeaseValue: () => crypto.randomUUID(),
        groupId: GROUP,
      };
    });

    afterAll(async () => {
      await Promise.all(
        [TOKEN_USER, ORG_USER].flatMap((id) =>
          [THIS_YEAR - 1, THIS_YEAR].map((year) =>
            redis.remove(wrappedCacheKey(id, year)),
          ),
        ),
      );
      await schema.drop();
    });

    it('drains a queued year into the cache entry the command then serves without Meetup', async () => {
      // A recent finished run, so the sweep is not due.
      const run = await store.startRun('job', 2);
      await store.finishRun(run.id);
      expect(
        await store.enqueue({
          discordUserId: ORG_USER,
          meetupId: ORG_MEETUP,
          year: THIS_YEAR,
        }),
      ).toBe('queued');

      const outcome = await runBackfillTick(deps);

      expect(outcome).toMatchObject({ kind: 'ran', queued: 1, built: 1 });
      expect(await store.queueLength()).toBe(0);
      const copy = await readWrapped(redis, ORG_USER, THIS_YEAR, ORG_MEETUP);
      expect(copy?.stats).toMatchObject({
        year: THIS_YEAR,
        attendedThisYear: 1,
      });
      expect(organizerHistory).toHaveBeenCalledWith(
        ORG_MEETUP,
        GROUP,
        expect.objectContaining({ eventStatus: ['PAST'] }),
      );

      // The Discord command reads the same entry: no Meetup, no slot.
      const withMeetupClient = vi.fn();
      const handlerDeps: WrappedHandlerDeps = {
        alert: vi.fn(async () => true),
        cache: async () => redis,
        members: async () => repo,
        withMeetupClient: withMeetupClient,
        withOrganizerMeetup: vi.fn(),
        limiter: createBuildLimiter(() => NOW.getTime()),
        now: () => NOW,
        slowAfterMs: 50,
        queue: async () => store,
      };
      const interaction = {
        user: {
          id: ORG_USER,
          username: 'o',
          globalName: 'O',
          toString: () => '',
        },
        member: { displayName: 'O' },
        guild: { members: { fetch: vi.fn().mockResolvedValue({}) } },
        channelId: '5550001',
        inGuild: () => true,
        client: {},
        editReply: vi.fn().mockResolvedValue(undefined),
        followUp: vi.fn().mockResolvedValue(undefined),
      } as unknown as CommandInteraction & {
        followUp: ReturnType<typeof vi.fn>;
      };
      await runWrapped(
        interaction,
        { year: THIS_YEAR, refresh: false },
        handlerDeps,
      );
      expect(withMeetupClient).not.toHaveBeenCalled();
      expect(interaction.followUp).toHaveBeenCalledTimes(1);
      expect(handlerDeps.limiter.take(ORG_USER)).toBe(true);
    });

    it('a due run sweeps both members (token and organizer paths) into every year, then is fresh', async () => {
      // Make the last run old enough.
      await (store as unknown as { pool: import('pg').Pool }).pool.query(
        "UPDATE wrapped_backfill_runs SET finished_at = finished_at - interval '1 day'",
      );

      const first = await runBackfillTick(deps);

      // The organizer-path member's one year was built by the drain and is
      // fresh with no earlier year: skipped without a call. The token-path
      // member is swept.
      expect(first).toMatchObject({
        kind: 'ran',
        members: 1,
        finishedRun: true,
      });
      // A past year lives in Postgres only; the current year has a hot copy.
      expect(await entries.get(TOKEN_USER, THIS_YEAR - 1)).toBeDefined();
      expect(
        await readWrapped(redis, TOKEN_USER, THIS_YEAR - 1, TOKEN_MEETUP),
      ).toBeUndefined();
      expect(
        await readWrapped(redis, TOKEN_USER, THIS_YEAR, TOKEN_MEETUP),
      ).toBeDefined();
      expect(
        (await readWrapped(redis, ORG_USER, THIS_YEAR, ORG_MEETUP))?.stats
          .attendedThisYear,
      ).toBe(1);
      expect((await store.lastFinishedRun())?.membersDone).toBe(2);

      await (store as unknown as { pool: import('pg').Pool }).pool.query(
        "UPDATE wrapped_backfill_runs SET finished_at = finished_at - interval '1 day'",
      );
      const again = await runBackfillTick(deps);
      // Every year is fresh (last year final, this year built just now): both
      // members are skipped from the stored entries without a Meetup call.
      expect(again).toMatchObject({
        kind: 'ran',
        built: 0,
        calls: 0,
        finishedRun: true,
      });
    });

    it("never stores an unlinked attendee's Meetup name or id in wrapped_entries or the Redis hot copy", async () => {
      const pool = (store as unknown as { pool: import('pg').Pool }).pool;
      const rows = await pool.query<{ payload: string }>(
        'SELECT payload::text AS payload FROM wrapped_entries',
      );
      expect(rows.rowCount).toBeGreaterThan(0);
      const stored = rows.rows.map((r) => r.payload).join('\n');
      expect(stored).not.toContain(GHOST.id);
      expect(stored).not.toContain(GHOST.name);
      // The ghost was an "other member": counted, never named.
      expect(stored).toMatch(/"otherCount":\s*1/);
      const hot = await redis.get(wrappedCacheKey(TOKEN_USER, THIS_YEAR));
      expect(hot).toBeDefined();
      expect(hot).not.toContain(GHOST.id);
      expect(hot).not.toContain(GHOST.name);
    });

    it('a tick with nothing due is no work', async () => {
      expect(await runBackfillTick(deps)).toEqual({
        kind: 'skipped',
        reason: 'no-work',
      });
    });
  },
);
