/**
 * The Wrapped backfill: builds every linked member's Wrapped for every year
 * back to their first event, into the same cache entries the page and the
 * command read, and drains the queue of throttled requests first. Paced: a
 * tick every BACKFILL_TICK_MS, at most MEMBERS_PER_TICK members and
 * TICK_CALL_BUDGET Meetup client calls a tick, one build in flight. Runs are
 * recorded in Postgres (one open at a time, resumable by cursor).
 *
 * Reads use the member's own stored token when there is one, else the
 * organizer credential (a caching client, under the report build lease so
 * the credential is never read by two jobs at once). A queued or swept build
 * takes the member's "building" lease and never spends their hourly slot.
 */
import crypto from 'node:crypto';

import dayjs from 'dayjs';
import { Client } from 'discord.js';
import { Logger } from 'tslog';

import Configuration from '../../configuration.js';
import { ApplicationCache } from '../../util/cache.js';
import { ApplicationMemberRepository } from '../../util/memberRepository.js';
import { tz } from '../../util/timezone.js';
import { isServerMember } from '../../web/host/serverJoin.js';
import { KeyValueCache } from '../cache/base.js';
import { GqlMeetupClient } from '../client/meetup/gqlClient.js';
import { EventSummary, MemberRsvpFilter } from '../client/meetup/types.js';
import { LogEntry, logAlert } from '../helpers/discordLogger.js';
import { getUsableMeetupTokens } from '../helpers/meetupTokens.js';
import { isMeetupUnauthorized } from '../helpers/organizerMeetupClient.js';
import {
  acquireBuildLease,
  identityDigestInProgress,
  releaseBuildLease,
} from '../reports/buildLease.js';
import { isQuietHour } from '../reports/buildSchedule.js';
import {
  defaultOrganizerMeetupDeps,
  withOrganizerMeetup,
} from '../reports/organizerMeetup.js';
import {
  PostgresWrappedBackfillRepository,
  WrappedBackfillStore,
} from '../repositories/postgresWrappedBackfillRepository.js';
import { MemberRecord, MemberRepository } from '../repositories/types.js';
import {
  SourceDeps,
  WrappedMeetup,
  WrappedSources,
  buildWrappedYear,
  readHostedEvents,
} from './build.js';
import {
  BUILDING_LEASE_TTL_SEC,
  CachedWrapped,
  FIRST_WRAPPED_YEAR,
  buildingKey,
  readWrapped,
  writeWrapped,
} from './cache.js';
import { BACKFILL_TICK_MS, MEMBERS_PER_TICK, NEXT_TICK_KEY } from './queue.js';

const logger = new Logger({ name: 'wrappedBackfill' });

/** Meetup client calls a tick may start builds under; a build in flight finishes. */
export const TICK_CALL_BUDGET = 150;
/** A new sweep starts this long after the last one finished. */
export const RUN_INTERVAL_MS = 20 * 60 * 60_000;
/** A current-year copy younger than this is left alone; past years are final. */
export const FRESH_CURRENT_YEAR_MS = 7 * 24 * 60 * 60_000;
export const QUEUE_MAX_ATTEMPTS = 3;
/** A queue claim older than this belongs to a tick that died. */
export const QUEUE_CLAIM_STALE_MS = 15 * 60_000;
/** Set (to the requester's Discord id) by Run now; the tick that honours it removes it. */
export const RUN_NOW_KEY = 'wrapped-backfill-run-now';
export const RUN_NOW_TTL_SEC = 60 * 60;
const NEXT_TICK_TTL_SEC = 60 * 60;

const HISTORY_FILTER: MemberRsvpFilter = {
  rsvpStatus: ['YES', 'ATTENDED'],
  eventStatus: ['PAST'],
};

/** The organizer client's reads: the member's history by id, plus the build's. */
export interface OrganizerReads extends WrappedMeetup {
  getMemberRsvpEvents(
    memberId: string,
    groupId: string,
    filter: MemberRsvpFilter,
  ): Promise<EventSummary[] | undefined>;
}

type SchedulerLog = Pick<Logger<unknown>, 'info' | 'warn' | 'error'>;

export interface BackfillDeps {
  now(): Date;
  cache(): Promise<KeyValueCache>;
  store(): Promise<WrappedBackfillStore>;
  members(): Promise<
    Pick<MemberRepository, 'listAll' | 'findByDiscordId' | 'findByMeetupId'>
  >;
  /** The member's stored Meetup access token, when usable. */
  memberToken(discordUserId: string): Promise<string | undefined>;
  memberClient(token: string): WrappedMeetup;
  /** withOrganizerMeetup with a CACHING client; `fn` may be re-run on a 401, so it only reads. */
  withOrganizer<T>(fn: (meetup: OrganizerReads) => Promise<T>): Promise<T>;
  isPresent(discordUserId: string): Promise<boolean>;
  /** Not the quiet hour and no identity digest running. */
  canStart(now: Date, cache: KeyValueCache): Promise<boolean>;
  /** #meetup-bot-alerts, plain. */
  alert(entry: LogEntry): Promise<boolean>;
  newLeaseValue(): string;
  groupId: string;
  log?: SchedulerLog;
}

export type TickOutcome =
  | { kind: 'skipped'; reason: 'guard' | 'no-work' }
  | {
      kind: 'ran';
      /** Queue entries handled (built, skipped or failed). */
      queued: number;
      /** Sweep members handled. */
      members: number;
      built: number;
      skipped: number;
      failed: number;
      calls: number;
      finishedRun: boolean;
    };

/** The Pacific year of the first event (never before FIRST_WRAPPED_YEAR) through this year. */
export function yearsFor(events: { dateTime: string }[], now: Date): number[] {
  const thisYear = tz(dayjs(now)).year();
  const first = events.reduce(
    (min, event) => Math.min(min, tz(dayjs(event.dateTime)).year()),
    thisYear,
  );
  const from = Math.max(FIRST_WRAPPED_YEAR, Math.min(first, thisYear));
  return Array.from({ length: thisYear - from + 1 }, (_, i) => from + i);
}

/** A past year's copy is final; a current-year copy keeps for a week. */
export function isFresh(
  copy: CachedWrapped | undefined,
  meetupId: string,
  year: number,
  now: Date,
): boolean {
  if (!copy || copy.meetupId !== meetupId) {
    return false;
  }
  if (year < tz(dayjs(now)).year()) {
    return true;
  }
  const builtAt = Date.parse(copy.builtAt);
  return (
    Number.isFinite(builtAt) && now.getTime() - builtAt < FRESH_CURRENT_YEAR_MS
  );
}

interface Counter {
  n: number;
}

/** The same client, counting every call against the tick's budget. */
function counting<T extends WrappedMeetup>(meetup: T, counter: Counter): T {
  const count = () => {
    counter.n += 1;
  };
  const counted: WrappedMeetup & Partial<OrganizerReads> = {
    getSelfPastRsvpEvents: (groupId) => {
      count();
      return meetup.getSelfPastRsvpEvents(groupId);
    },
    getHostedEvents: (hostId, input) => {
      count();
      return meetup.getHostedEvents(hostId, input);
    },
    getEventRsvps: (eventId, input, filter) => {
      count();
      return meetup.getEventRsvps(eventId, input, filter);
    },
  };
  if ('getMemberRsvpEvents' in meetup) {
    const organizer = meetup as unknown as OrganizerReads;
    counted.getMemberRsvpEvents = (memberId, groupId, filter) => {
      count();
      return organizer.getMemberRsvpEvents(memberId, groupId, filter);
    };
  }
  return counted as T;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error';
}

interface MemberOutcome {
  built: number;
  skipped: number;
  failed: number;
  /** The report lease is held by another build: nothing was read; try next tick. */
  leaseHeld?: boolean;
}

interface TickContext {
  deps: BackfillDeps;
  cache: KeyValueCache;
  calls: Counter;
  log: SchedulerLog;
}

/** One year: fresh or being built elsewhere → skipped; else built and written. */
async function buildYear(
  ctx: TickContext,
  meetup: WrappedMeetup,
  member: { discordUserId: string; meetupId: string },
  year: number,
  sources: WrappedSources,
): Promise<'built' | 'skipped'> {
  const { deps, cache } = ctx;
  const now = deps.now();
  const copy = await readWrapped(cache, member.discordUserId, year);
  if (isFresh(copy, member.meetupId, year, now)) {
    return 'skipped';
  }
  const lease = buildingKey(member.discordUserId, year);
  if (
    !(await cache.exclusive_set(
      lease,
      now.toISOString(),
      BUILDING_LEASE_TTL_SEC,
    ))
  ) {
    return 'skipped'; // an on-demand build is on it
  }
  try {
    const sourceDeps: SourceDeps = {
      meetup,
      findByMeetupId: async (id) => (await deps.members()).findByMeetupId(id),
      isPresent: (id) => deps.isPresent(id),
      now: () => deps.now(),
      log: (message) => ctx.log.info(message),
    };
    const wrapped = await buildWrappedYear(
      sourceDeps,
      member.meetupId,
      year,
      sources,
    );
    await writeWrapped(cache, member.discordUserId, year, wrapped, deps.now());
    return 'built';
  } finally {
    await cache.remove(lease).catch(() => undefined);
  }
}

async function buildYears(
  ctx: TickContext,
  meetup: WrappedMeetup,
  member: { discordUserId: string; meetupId: string },
  years: number[],
  sources: WrappedSources,
): Promise<MemberOutcome> {
  const outcome: MemberOutcome = { built: 0, skipped: 0, failed: 0 };
  for (const year of years) {
    // eslint-disable-next-line no-await-in-loop -- one build in flight, by design
    const result = await buildYear(ctx, meetup, member, year, sources);
    outcome[result] += 1;
  }
  return outcome;
}

/**
 * The member through the organizer credential, under the report lease:
 * history by Meetup id (undefined → not in the group: skipped), hosted
 * events, then each year.
 */
async function buildWithOrganizer(
  ctx: TickContext,
  member: { discordUserId: string; meetupId: string },
  years: number[] | undefined,
): Promise<MemberOutcome> {
  const { deps, cache } = ctx;
  const lease = deps.newLeaseValue();
  if (!(await acquireBuildLease(cache, lease))) {
    return { built: 0, skipped: 0, failed: 0, leaseHeld: true };
  }
  try {
    return await deps.withOrganizer(async (organizer) => {
      const meetup = counting(organizer, ctx.calls);
      const events = await meetup.getMemberRsvpEvents(
        member.meetupId,
        deps.groupId,
        HISTORY_FILTER,
      );
      if (events === undefined) {
        ctx.log.info(
          `Wrapped backfill: Discord user ${member.discordUserId} is not in the Meetup group; skipped`,
        );
        return { built: 0, skipped: 1, failed: 0 };
      }
      const hosted = await readHostedEvents(meetup, member.meetupId);
      return buildYears(
        ctx,
        meetup,
        member,
        years ?? yearsFor(events, deps.now()),
        { events, hosted },
      );
    });
  } finally {
    await releaseBuildLease(cache, lease);
  }
}

/**
 * One member: their own token when stored (the on-demand path's reads, with
 * the account check), falling back to the organizer path on a mismatch or a
 * refused token. Any other failure counts the member failed; the next run
 * retries them. `years` pins the queue's one year; undefined sweeps all.
 */
async function buildMember(
  ctx: TickContext,
  member: { discordUserId: string; meetupId: string },
  years: number[] | undefined,
): Promise<MemberOutcome> {
  const { deps } = ctx;
  try {
    const token = await deps.memberToken(member.discordUserId);
    if (token !== undefined) {
      try {
        const meetup = counting(deps.memberClient(token), ctx.calls);
        const { events, meetupId } = await meetup.getSelfPastRsvpEvents(
          deps.groupId,
        );
        if (meetupId === member.meetupId) {
          const hosted = await readHostedEvents(meetup, member.meetupId);
          return await buildYears(
            ctx,
            meetup,
            member,
            years ?? yearsFor(events, deps.now()),
            { events, hosted },
          );
        }
        ctx.log.info(
          `Wrapped backfill: the stored token of Discord user ${member.discordUserId} ` +
            'is for another Meetup account; using the organizer credential',
        );
      } catch (error) {
        if (!isMeetupUnauthorized(error)) {
          throw error;
        }
        ctx.log.info(
          `Wrapped backfill: the stored token of Discord user ${member.discordUserId} was refused; using the organizer credential`,
        );
      }
    }
    return await buildWithOrganizer(ctx, member, years);
  } catch (error) {
    // The class name only: a Meetup error's message carries its response.
    ctx.log.warn(
      `Wrapped backfill: Discord user ${member.discordUserId} failed: ${errorName(error)}`,
    );
    return { built: 0, skipped: 0, failed: 1 };
  }
}

function linkedOf(
  record: MemberRecord | undefined,
): { discordUserId: string; meetupId: string } | undefined {
  return record?.meetupId
    ? { discordUserId: record.discordUserId, meetupId: record.meetupId }
    : undefined;
}

/** Every linked member (both ids), in Discord id order: the sweep's list. */
async function linkedMembers(deps: BackfillDeps) {
  return (await (await deps.members()).listAll())
    .map(linkedOf)
    .filter(
      (m): m is { discordUserId: string; meetupId: string } => m !== undefined,
    )
    .sort((a, b) => a.discordUserId.localeCompare(b.discordUserId));
}

const seconds = (ms: number) => (ms / 1000).toFixed(1);

export async function runBackfillTick(
  deps: BackfillDeps,
): Promise<TickOutcome> {
  const log = deps.log ?? logger;
  const now = deps.now();
  const cache = await deps.cache();
  if (!(await deps.canStart(now, cache))) {
    return { kind: 'skipped', reason: 'guard' };
  }
  const store = await deps.store();
  const repo = await deps.members();
  const ctx: TickContext = { deps, cache, calls: { n: 0 }, log };
  const totals = { queued: 0, members: 0, built: 0, skipped: 0, failed: 0 };
  const add = (o: MemberOutcome) => {
    totals.built += o.built;
    totals.skipped += o.skipped;
    totals.failed += o.failed;
  };
  const capReached = () =>
    totals.queued + totals.members >= MEMBERS_PER_TICK ||
    ctx.calls.n >= TICK_CALL_BUDGET;
  const ran = (finishedRun: boolean): TickOutcome => ({
    kind: 'ran',
    ...totals,
    calls: ctx.calls.n,
    finishedRun,
  });

  // The queue first: one claim at a time, so a row is never taken and then
  // handed back for the cap or the budget. A row released after a failure
  // is not tried again in the same tick.
  const seen = new Set<string>();
  while (!capReached()) {
    // eslint-disable-next-line no-await-in-loop -- one build in flight, by design
    const [row] = await store.claimNext(1, QUEUE_CLAIM_STALE_MS);
    if (!row) {
      break;
    }
    if (seen.has(row.discordUserId)) {
      // eslint-disable-next-line no-await-in-loop -- one build in flight, by design
      await store.unclaim(row.discordUserId);
      break;
    }
    seen.add(row.discordUserId);
    totals.queued += 1;

    // eslint-disable-next-line no-await-in-loop -- one build in flight, by design
    const record = await repo.findByDiscordId(row.discordUserId);
    const member = linkedOf(record);
    if (!member || member.meetupId !== row.meetupId) {
      log.info(
        `Wrapped backfill: queued Wrapped for Discord user ${row.discordUserId} dropped: no longer linked`,
      );
      // eslint-disable-next-line no-await-in-loop -- one build in flight, by design
      await store.complete(row.discordUserId);
      continue;
    }

    // eslint-disable-next-line no-await-in-loop -- one build in flight, by design
    const copy = await readWrapped(cache, member.discordUserId, row.year);
    if (isFresh(copy, member.meetupId, row.year, deps.now())) {
      // eslint-disable-next-line no-await-in-loop -- one build in flight, by design
      await store.complete(row.discordUserId);
      totals.skipped += 1;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- one build in flight, by design
    const outcome = await buildMember(ctx, member, [row.year]);
    if (outcome.leaseHeld) {
      totals.queued -= 1;
      // eslint-disable-next-line no-await-in-loop -- one build in flight, by design
      await store.unclaim(row.discordUserId);
      log.info(
        'Wrapped backfill: the report build lease is held; the tick ends',
      );
      return ran(false);
    }
    add(outcome);
    if (outcome.failed > 0) {
      // eslint-disable-next-line no-await-in-loop -- one build in flight, by design
      await store.release(row.discordUserId, QUEUE_MAX_ATTEMPTS);
    } else {
      // eslint-disable-next-line no-await-in-loop -- one build in flight, by design
      await store.complete(row.discordUserId);
    }
  }

  // Then the sweep: the open run, or a new one when due or asked for.
  let run = await store.openRun();
  if (!run) {
    const runNow = await cache.get(RUN_NOW_KEY);
    const last = await store.lastFinishedRun();
    const due =
      runNow !== undefined ||
      last?.finishedAt === undefined ||
      deps.now().getTime() - last.finishedAt.getTime() >= RUN_INTERVAL_MS;
    if (!due) {
      return totals.queued > 0
        ? ran(false)
        : { kind: 'skipped', reason: 'no-work' };
    }
    const linked = await linkedMembers(deps);
    run = await store.startRun(runNow ?? 'job', linked.length);
    if (runNow !== undefined) {
      await cache.remove(RUN_NOW_KEY).catch(() => undefined);
    }
    if (!run) {
      return totals.queued > 0
        ? ran(false)
        : { kind: 'skipped', reason: 'no-work' };
    }
    log.info(
      `Wrapped backfill run ${run.id} started (${linked.length} linked members)`,
    );
  }
  const linked = await linkedMembers(deps);
  let { cursor } = run;
  const remaining = () =>
    linked.filter((m) => cursor === undefined || m.discordUserId > cursor);
  for (const member of remaining()) {
    if (capReached()) {
      break;
    }
    // eslint-disable-next-line no-await-in-loop -- one build in flight, by design
    if (!(await deps.canStart(deps.now(), cache))) {
      log.info('Wrapped backfill: the quiet hour started; the tick ends');
      break;
    }
    // eslint-disable-next-line no-await-in-loop -- one build in flight, by design
    const outcome = await buildMember(ctx, member, undefined);
    if (outcome.leaseHeld) {
      log.info(
        'Wrapped backfill: the report build lease is held; the tick ends',
      );
      break;
    }
    // eslint-disable-next-line no-await-in-loop -- one build in flight, by design
    const advanced = await store.advanceRun(
      run.id,
      cursor,
      member.discordUserId,
      {
        done: 1,
        built: outcome.built,
        skipped: outcome.skipped,
        failed: outcome.failed,
      },
    );
    if (!advanced) {
      log.warn(
        'Wrapped backfill: another process moved the run cursor; the tick ends',
      );
      return ran(false);
    }
    cursor = member.discordUserId;
    totals.members += 1;
    add(outcome);
  }
  if (remaining().length > 0) {
    return ran(false);
  }
  const finished = await store.finishRun(run.id);
  if (finished) {
    const took = finished.finishedAt
      ? finished.finishedAt.getTime() - finished.startedAt.getTime()
      : 0;
    try {
      await deps.alert({
        title: 'Wrapped backfill finished',
        description:
          `${finished.membersTotal} members: built ${finished.built}, ` +
          `skipped ${finished.skipped} fresh, failed ${finished.failed} ` +
          `(retried next run). Took ${seconds(took)} s.`,
      });
    } catch (error) {
      log.error(`Wrapped backfill summary alert failed: ${errorName(error)}`);
    }
  }
  return ran(true);
}

/** Never rejects: dependency or tick failures are logged by class name (and message, for operators). */
async function runTickSafely(
  makeDeps: () => Promise<BackfillDeps>,
  log: SchedulerLog,
  runTick: (deps: BackfillDeps) => Promise<TickOutcome>,
): Promise<void> {
  try {
    const deps = await makeDeps();
    const cache = await deps.cache();
    // The queue's "ready by" counts from here.
    await cache
      .set(
        NEXT_TICK_KEY,
        new Date(deps.now().getTime() + BACKFILL_TICK_MS).toISOString(),
        NEXT_TICK_TTL_SEC,
      )
      .catch(() => undefined);
    const outcome = await runTick(deps);
    if (outcome.kind === 'ran') {
      log.info(
        `Wrapped backfill tick: ${outcome.queued} queued, ${outcome.members} swept, ` +
          `built ${outcome.built}, skipped ${outcome.skipped}, failed ${outcome.failed}, ` +
          `${outcome.calls} Meetup calls`,
      );
    }
  } catch (error) {
    // Process log only: what reaches here is infrastructure (pg, Redis).
    log.error(`Wrapped backfill tick failed: ${String(error)}`);
  }
}

export interface BackfillSchedulerOptions {
  env?: Record<string, string | undefined>;
  setIntervalFn?: typeof setInterval;
  log?: SchedulerLog;
  /** Milliseconds since the epoch (tests). */
  now?: () => number;
  /** Tests. */
  runTick?: (deps: BackfillDeps) => Promise<TickOutcome>;
}

/**
 * Ticks once now and every BACKFILL_TICK_MS; runBackfillTick decides what is
 * due. A tick still running when the next fires is skipped (the Postgres
 * run row and the queue claims cover other processes). Without DATABASE_URL
 * there is nowhere to record runs, so it never starts.
 */
export function startWrappedBackfillScheduler(
  _client: Client,
  makeDeps: () => Promise<BackfillDeps>,
  options: BackfillSchedulerOptions = {},
): void {
  const env = options.env ?? process.env;
  const log = options.log ?? logger;
  if (!env.DATABASE_URL) {
    log.warn('Wrapped backfill disabled: DATABASE_URL is not set');
    return;
  }
  const runTick = options.runTick ?? runBackfillTick;
  let running = false;
  const tick = () => {
    if (running) {
      return;
    }
    running = true;
    runTickSafely(makeDeps, log, runTick)
      .finally(() => {
        running = false;
      })
      .catch(() => undefined);
  };
  tick();
  (options.setIntervalFn ?? setInterval)(tick, BACKFILL_TICK_MS);
}

export async function productionBackfillDeps(
  getClient: () => Client | undefined,
): Promise<BackfillDeps> {
  return {
    now: () => new Date(),
    cache: ApplicationCache,
    store: () => PostgresWrappedBackfillRepository.instance(),
    members: ApplicationMemberRepository,
    memberToken: async (discordUserId) =>
      (await getUsableMeetupTokens(await ApplicationCache(), discordUserId))
        ?.accessToken,
    memberClient: (token) => new GqlMeetupClient(token),
    // The caching client, unlike the report jobs': the backfill reads the
    // same attendee and hosted lists the on-demand build reads, and sharing
    // them across members is the point.
    withOrganizer: (fn) =>
      withOrganizerMeetup(getClient(), fn, {
        ...defaultOrganizerMeetupDeps,
        makeClient: (accessToken) => new GqlMeetupClient(accessToken),
      }),
    isPresent: (discordUserId) => isServerMember(getClient, discordUserId),
    canStart: async (now, cache) =>
      !isQuietHour(now) && !(await identityDigestInProgress(cache, now)),
    alert: async (entry) => {
      const client = getClient();
      return client ? logAlert(client, entry) : false;
    },
    newLeaseValue: () => crypto.randomUUID(),
    groupId: Configuration.meetup.groupId,
  };
}
