/* eslint-disable @typescript-eslint/no-unsafe-assignment -- expect.objectContaining() matchers */
import crypto from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RedisCache } from '../../src/lib/cache/redisCache.js';
import { ensureDashboardSchema } from '../../src/lib/repositories/dashboardPool.js';
import { InMemoryMemberRepository } from '../../src/lib/repositories/inMemoryMemberRepository.js';
import { PostgresSnapshotRepository } from '../../src/lib/repositories/postgresSnapshotRepository.js';
import { PostgresWrappedBackfillRepository } from '../../src/lib/repositories/postgresWrappedBackfillRepository.js';
import { PostgresWrappedEntryRepository } from '../../src/lib/repositories/postgresWrappedEntryRepository.js';
import {
  buildWrappedFromSnapshot,
  snapshotWrapped,
} from '../../src/lib/snapshot/wrapped.js';
import { buildWrapped } from '../../src/lib/wrapped/build.js';
import {
  BackfillDeps,
  runBackfillTick,
} from '../../src/lib/wrapped/backfill.js';
import { wrappedCacheKey } from '../../src/lib/wrapped/cache.js';
import { readEntry } from '../../src/lib/wrapped/store.js';
import { useIsolatedSchema } from './isolatedSchema.js';

// Real Postgres (the snapshot, the runs, the entries) and Redis: a tick over
// a seeded snapshot writes exactly the entry the page and the command read,
// with no Meetup call at all.
const AVAILABLE = Boolean(
  process.env.DATABASE_URL && process.env.REDISCLOUD_URL,
);

if (!AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    'Skipping Wrapped-from-snapshot integration tests: set DATABASE_URL and REDISCLOUD_URL to run them.',
  );
}

const suffix = String(Date.now()).slice(-9);
const USER = `2${suffix}0001`.padEnd(18, '0');
const FRIEND = `2${suffix}0002`.padEnd(18, '0');
const ME = `7${suffix}`;
const PAL = `8${suffix}`;
const GHOST = `9${suffix}`; // unlinked: must never reach an entry
const THIS_YEAR = new Date().getUTCFullYear();

(AVAILABLE ? describe : describe.skip)(
  'Wrapped from the group snapshot (integration)',
  () => {
    let schema: { drop(): Promise<void> };
    let redis: RedisCache;
    let snapshot: PostgresSnapshotRepository;
    let entries: PostgresWrappedEntryRepository;
    let deps: BackfillDeps;
    const meetupCalls = vi.fn();

    beforeAll(async () => {
      schema = await useIsolatedSchema('wrapped_from_snapshot');
      const store = await PostgresWrappedBackfillRepository.instance();
      const pool = (store as unknown as { pool: import('pg').Pool }).pool;
      await ensureDashboardSchema(pool);
      snapshot = new PostgresSnapshotRepository(pool);
      entries = await PostgresWrappedEntryRepository.instance();
      redis = await RedisCache.instance();

      const at = (y: number, m: number) =>
        new Date(Date.UTC(y, m, 10, 3, 0, 0));
      const listed = new Date();
      await snapshot.upsertEvents(
        [
          [`${suffix}1`, at(THIS_YEAR - 1, 2), 'Board game night', [ME]],
          [`${suffix}2`, at(THIS_YEAR, 3), 'Hot pot dinner', []],
          [`${suffix}3`, at(THIS_YEAR, 5), 'Board games again', [ME]],
        ].map(([eventId, dateTime, title, hostIds]) => ({
          eventId: eventId as string,
          title: title as string,
          dateTime: dateTime as Date,
          eventUrl: null,
          status: 'PAST' as const,
          hostIds: hostIds as string[],
          yesCount: 3,
          waitlistCount: 0,
        })),
        listed,
      );
      for (const id of [`${suffix}1`, `${suffix}2`, `${suffix}3`]) {
        // eslint-disable-next-line no-await-in-loop -- test setup
        await snapshot.replaceRsvps(
          id,
          [
            { memberId: ME, status: 'ATTENDED' },
            { memberId: PAL, status: 'YES' },
            { memberId: GHOST, status: 'YES' },
          ],
          listed,
        );
      }
      const run = await snapshot.startRun('job', 'full');
      await snapshot.finishRun(run.id);

      const repo = new InMemoryMemberRepository();
      for (const [discordUserId, meetupId] of [
        [USER, ME],
        [FRIEND, PAL],
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
      const noMeetup = () => {
        meetupCalls();
        throw new Error('no Meetup call expected');
      };
      deps = {
        now: () => new Date(),
        cache: async () => redis,
        store: async () => store,
        entries: async () => entries,
        members: async () => repo,
        memberToken: async () => undefined,
        memberClient: noMeetup,
        withOrganizer: async () => noMeetup(),
        isPresent: async () => true,
        canStart: async () => true,
        alert: vi.fn(async () => true),
        newLeaseValue: () => crypto.randomUUID(),
        groupId: '7595882',
        snapshot: async () => snapshotWrapped(snapshot),
      };
    });

    afterAll(async () => {
      await Promise.all(
        [USER, FRIEND].flatMap((id) =>
          [THIS_YEAR - 1, THIS_YEAR].map((year) =>
            redis.remove(wrappedCacheKey(id, year)),
          ),
        ),
      );
      await schema.drop();
    });

    it('a tick builds every year of every member from the snapshot, with no Meetup call', async () => {
      const outcome = await runBackfillTick(deps);
      expect(outcome).toMatchObject({ kind: 'ran', calls: 0, failed: 0 });
      expect(meetupCalls).not.toHaveBeenCalled();

      const now = new Date();
      const tiers = { cache: redis, entries };
      const mine = await readEntry(tiers, USER, THIS_YEAR, ME, now);
      expect(mine?.stats).toMatchObject({
        attendedThisYear: 2,
        hosting: expect.objectContaining({ thisYear: 1, allTime: 2 }),
      });
      expect(mine?.companions.named).toEqual([
        expect.objectContaining({ discordUserId: FRIEND, sharedCount: 2 }),
      ]);
      expect(mine?.companions.otherCount).toBe(1);
      const lastYear = await readEntry(tiers, USER, THIS_YEAR - 1, ME, now);
      expect(lastYear?.stats.attendedThisYear).toBe(1);
      for (const entry of [mine, lastYear]) {
        expect(JSON.stringify(entry)).not.toContain(GHOST);
        expect(JSON.stringify(entry)).not.toContain(`"${PAL}"`);
      }
    });

    it('the snapshot build equals the token build on the same data, every year (real repository)', async () => {
      const me = `5${suffix}`;
      const pal = `6${suffix}`;
      const id = (n: number) => `${suffix}9${n}`;
      const at = (y: number, m: number, d = 10) =>
        new Date(Date.UTC(y, m, d, 3, 0, 0));
      type Seed = {
        n: number;
        when: Date;
        title: string;
        status?: 'PAST' | 'CANCELLED';
        hosts?: string[];
        yes?: number;
        rsvps: [string, 'YES' | 'ATTENDED' | 'WAITLIST'][];
      };
      const seeds: Seed[] = [
        {
          n: 1,
          when: at(THIS_YEAR - 2, 1),
          title: 'Hike',
          rsvps: [
            [me, 'ATTENDED'],
            [pal, 'YES'],
          ],
        },
        {
          n: 2,
          when: at(THIS_YEAR - 1, 4),
          title: 'Board game night',
          hosts: [me],
          yes: 7,
          rsvps: [
            [me, 'YES'],
            [pal, 'ATTENDED'],
            [GHOST, 'YES'],
          ],
        },
        {
          n: 3,
          when: at(THIS_YEAR - 1, 6),
          title: 'Picnic (cancelled)',
          rsvps: [
            [me, 'YES'],
            [pal, 'YES'],
          ],
        },
        {
          n: 4,
          when: at(THIS_YEAR, 2),
          title: '[Open House] Drop-in',
          hosts: [me],
          yes: 4,
          rsvps: [
            [me, 'ATTENDED'],
            [pal, 'YES'],
          ],
        },
        {
          n: 5,
          when: at(THIS_YEAR, 3),
          title: 'Hot pot dinner',
          hosts: [me],
          yes: 12,
          rsvps: [
            [me, 'YES'],
            [pal, 'YES'],
            [GHOST, 'ATTENDED'],
          ],
        },
        {
          n: 6,
          when: at(THIS_YEAR, 5),
          title: 'Trivia',
          rsvps: [
            [me, 'WAITLIST'],
            [pal, 'YES'],
          ],
        },
        {
          n: 7,
          when: at(THIS_YEAR, 7),
          title: 'Karaoke',
          status: 'CANCELLED',
          hosts: [me],
          rsvps: [[me, 'YES']],
        },
      ];
      const listed = new Date();
      await snapshot.upsertEvents(
        seeds.map((e) => ({
          eventId: id(e.n),
          title: e.title,
          dateTime: e.when,
          eventUrl: `https://www.meetup.com/g/events/${id(e.n)}/`,
          status: e.status ?? 'PAST',
          hostIds: e.hosts ?? [],
          yesCount:
            e.yes ?? e.rsvps.filter(([, st]) => st !== 'WAITLIST').length,
          waitlistCount: 0,
        })),
        listed,
      );
      for (const e of seeds) {
        // eslint-disable-next-line no-await-in-loop -- test setup
        await snapshot.replaceRsvps(
          id(e.n),
          e.rsvps.map(([memberId, status]) => ({ memberId, status })),
          listed,
        );
      }

      // The token path's view of the same group: PAST events only.
      const past = seeds.filter((e) => (e.status ?? 'PAST') === 'PAST');
      const summary = (e: Seed) => ({
        id: id(e.n),
        title: e.title,
        dateTime: e.when.toISOString(),
        eventUrl: `https://www.meetup.com/g/events/${id(e.n)}/`,
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
      const meetup = {
        getSelfPastRsvpEvents: async () => ({
          events: past
            .filter((e) =>
              e.rsvps.some(([m, st]) => m === me && st !== 'WAITLIST'),
            )
            .map(summary),
          meetupId: me,
        }),
        getHostedEvents: async () => ({
          groupByUrlname: {
            id: 'g',
            events: page(
              past
                .filter((e) => e.hosts?.includes(me))
                .map((e) => ({
                  ...summary(e),
                  eventHosts: [],
                  maxTickets: 0,
                  status: 'PAST' as const,
                  attendance: { totalCount: e.yes ?? 0 },
                })),
            ),
          },
        }),
        getEventRsvps: async (eventId: string) => ({
          event: {
            id: eventId,
            rsvps: page(
              (seeds.find((e) => id(e.n) === eventId)?.rsvps ?? [])
                .filter(([, st]) => st !== 'WAITLIST')
                .map(([m]) => ({
                  status: 'YES' as const,
                  member: {
                    id: m,
                    name: `N ${m}`,
                    memberUrl: '',
                    gender: 'NONE' as never,
                  },
                })),
            ),
          },
        }),
      };
      const linkedIds: Record<string, string> = { [pal]: FRIEND };
      const naming = {
        findByMeetupId: async (m: string) => {
          return linkedIds[m]
            ? {
                discordUserId: linkedIds[m],
                meetupId: m,
                meetupName: null,
                meetupMemberUrl: null,
                onboardMethod: 'self_onboard' as const,
                onboardedBy: null,
                firstOnboardedAt: listed,
                lastSyncedAt: listed,
              }
            : undefined;
        },
        isPresent: async () => true,
        now: () => listed,
        log: () => undefined,
      };
      const snap = snapshotWrapped(snapshot);
      const sources = await snap.sources(me);
      expect(sources).toBeDefined();
      for (const year of [THIS_YEAR - 2, THIS_YEAR - 1, THIS_YEAR]) {
        // eslint-disable-next-line no-await-in-loop -- one year at a time
        const fromSnapshot = await buildWrappedFromSnapshot(
          { ...naming, attendees: snap.attendees },
          me,
          year,
          sources,
        );
        // eslint-disable-next-line no-await-in-loop -- see above
        const fromToken = await buildWrapped(
          { ...naming, meetup, organizerRsvps: async () => undefined },
          me,
          year,
          'g',
        );
        if (fromSnapshot.kind !== 'built' || fromToken.kind !== 'built') {
          throw new Error('both should build');
        }
        const { builtFrom, ...same } = fromSnapshot.wrapped;
        expect(builtFrom).toBe('snapshot');
        expect(same).toEqual(fromToken.wrapped);
        expect(JSON.stringify(same)).not.toContain(GHOST);
      }
      // Spot-check what the data says, so equality is not two empty builds.
      const now = await buildWrappedFromSnapshot(
        { ...naming, attendees: snap.attendees },
        me,
        THIS_YEAR,
        sources,
      );
      if (now.kind !== 'built') {
        throw new Error('built');
      }
      // Open House counts as attended, not hosted; the cancelled-status
      // event and the WAITLIST RSVP count nowhere.
      expect(now.wrapped.stats.attendedThisYear).toBe(2);
      expect(now.wrapped.stats.hosting).toMatchObject({
        thisYear: 1,
        allTime: 2,
      });
      expect(now.wrapped.stats.hosting?.topThisYear[0]?.attendance).toBe(12);
    });
  },
);
