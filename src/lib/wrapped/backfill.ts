/**
 * The Wrapped backfill: builds every linked member's Wrapped for every year
 * back to their first event, into the same two-tier store the page and the
 * command read (store.ts: Postgres for every year, Redis for the current
 * year), and drains the queue of throttled requests first. Paced: a tick
 * every BACKFILL_TICK_MS, at most MEMBERS_PER_TICK builds and
 * TICK_CALL_BUDGET Meetup client calls a tick, one build in flight. Runs are
 * recorded in Postgres (one open at a time, resumable by cursor).
 *
 * Reads use the member's own stored token when there is one, else the
 * organizer credential (under the report build lease, so the credential is
 * never read by two jobs at once). Both clients bypass the Redis request
 * cache: instead a per-run, in-process memo of attendee Meetup ids (ids
 * only, never names, never persisted, cleared when the run ends) makes an
 * event shared by many members a single read per run, and early-cohort
 * events read their first page of attendees only. A queued or swept build
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
import {
  GqlMeetupClient,
  MeetupGroupUnreadableError,
} from '../client/meetup/gqlClient.js';
import {
  EventSummary,
  GetEventRsvpsResponse,
  MemberRsvpFilter,
  PaginationInput,
  RsvpFilter,
} from '../client/meetup/types.js';
import { LogEntry, logAlert } from '../helpers/discordLogger.js';
import { getUsableMeetupTokens } from '../helpers/meetupTokens.js';
import { isMeetupUnauthorized } from '../helpers/organizerMeetupClient.js';
import {
  acquireBuildLease,
  identityDigestInProgress,
  releaseBuildLease,
} from '../reports/buildLease.js';
import { canStartMonthBuild } from '../reports/buildSchedule.js';
import {
  OrganizerTokenUnavailableError,
  defaultOrganizerMeetupDeps,
  withOrganizerMeetup,
} from '../reports/organizerMeetup.js';
import { utcDay } from '../reports/period.js';
import {
  BackfillRun,
  PostgresWrappedBackfillRepository,
  WrappedBackfillStore,
} from '../repositories/postgresWrappedBackfillRepository.js';
import {
  PostgresWrappedEntryRepository,
  WrappedEntryStore,
} from '../repositories/postgresWrappedEntryRepository.js';
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
} from './cache.js';
import { BACKFILL_TICK_MS, MEMBERS_PER_TICK, NEXT_TICK_KEY } from './queue.js';
import { WrappedTiers, readEntry, writeEntry } from './store.js';

const logger = new Logger({ name: 'wrappedBackfill' });

/** Meetup client calls a tick may start builds under; a build in flight finishes. */
export const TICK_CALL_BUDGET = 150;
/** A new sweep starts this long after the last one finished. */
export const RUN_INTERVAL_MS = 20 * 60 * 60_000;
/** A current-year copy younger than this is left alone. */
export const FRESH_CURRENT_YEAR_MS = 7 * 24 * 60 * 60_000;
export const QUEUE_MAX_ATTEMPTS = 3;
/** A queue claim older than this belongs to a tick that died. */
export const QUEUE_CLAIM_STALE_MS = 15 * 60_000;
/** Set (to the requester's Discord id) by Run now; the tick that honours it removes it. */
export const RUN_NOW_KEY = 'wrapped-backfill-run-now';
export const RUN_NOW_TTL_SEC = 2 * 60 * 60;
/** `<prefix><discordUserId>`: the member a process is sweeping right now. */
export const MEMBER_LEASE_KEY_PREFIX = 'wrapped-backfill-member:';
const MEMBER_LEASE_TTL_SEC = 15 * 60;
/** At most this many events' attendee ids in the per-run memo. */
export const MEMO_MAX_EVENTS = 3000;
const NEXT_TICK_TTL_SEC = 60 * 60;
const FAILING_ALERT_TTL_SEC = 26 * 60 * 60;
const failingAlertKey = (day: string) => `wrapped-backfill-alerted-${day}`;

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
  /** The durable Wrapped store (Postgres). */
  entries(): Promise<WrappedEntryStore>;
  members(): Promise<
    Pick<MemberRepository, 'listAll' | 'findByDiscordId' | 'findByMeetupId'>
  >;
  /** The member's stored Meetup access token, when usable. */
  memberToken(discordUserId: string): Promise<string | undefined>;
  memberClient(token: string): WrappedMeetup;
  /**
   * withOrganizerMeetup. On a 401 the helper refreshes the token and runs
   * `fn` again from the start; everything `fn` writes is idempotent (a
   * year already written is fresh and skipped), only the call count is
   * paid twice.
   */
  withOrganizer<T>(fn: (meetup: OrganizerReads) => Promise<T>): Promise<T>;
  isPresent(discordUserId: string): Promise<boolean>;
  /** Whether a build may start now: inside the sweep window and no digest running. */
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

/**
 * A past year's copy is final only once it was built after that year ended
 * (Pacific): a December copy misses the year's last events. A current-year
 * copy keeps for a week.
 */
export function isFresh(
  copy: CachedWrapped | undefined,
  meetupId: string,
  year: number,
  now: Date,
): boolean {
  if (!copy || copy.meetupId !== meetupId) {
    return false;
  }
  const builtAt = Date.parse(copy.builtAt);
  if (!Number.isFinite(builtAt)) {
    return false;
  }
  if (year < tz(dayjs(now)).year()) {
    const yearEnd = tz(dayjs(now)).year(year).startOf('year').add(1, 'year');
    return builtAt >= yearEnd.valueOf();
  }
  return now.getTime() - builtAt < FRESH_CURRENT_YEAR_MS;
}

interface Counter {
  n: number;
}

/**
 * The per-run memo: attendee Meetup ids by event id, with whether the list
 * is complete (a first-page read of a bigger event is not). In process
 * only, never persisted, dropped when the run that filled it ends.
 */
interface RunMemo {
  runId: number | undefined;
  lists: Map<string, { ids: string[]; complete: boolean }>;
}

const memo: RunMemo = { runId: undefined, lists: new Map() };
/** The cursor a partial memo page carries: a full reader coming back with it gets the whole list read. */
const MEMO_CURSOR = 'memo';

/** Tests: how many events the memo holds. */
export function memoSize(): number {
  return memo.lists.size;
}

function memoFor(runId: number): RunMemo['lists'] {
  if (memo.runId !== runId) {
    memo.runId = runId;
    memo.lists = new Map();
  }
  return memo.lists;
}

function clearMemo(): void {
  memo.runId = undefined;
  memo.lists = new Map();
}

function memoPage(
  eventId: string,
  ids: string[],
  complete: boolean,
): GetEventRsvpsResponse {
  return {
    event: {
      id: eventId,
      rsvps: {
        pageInfo: {
          hasNextPage: !complete,
          hasPreviousPage: false,
          startCursor: null,
          endCursor: complete ? null : MEMO_CURSOR,
        },
        totalCount: ids.length,
        edges: ids.map((id) => ({
          node: {
            status: 'YES' as const,
            member: { id, name: '', memberUrl: '', gender: 'NONE' as never },
          },
        })),
      },
    },
  };
}

/**
 * The same client, counting every call against the tick's budget and
 * serving attendee lists from the memo when it has them (the first page of
 * an event, which is the whole list for most events).
 */
function instrumented<T extends WrappedMeetup>(
  meetup: T,
  counter: Counter,
  lists: RunMemo['lists'],
): T {
  const count = () => {
    counter.n += 1;
  };
  const pending = new Map<string, string[]>();
  /** Every page of an event from the start, counted: the whole list. */
  const readAll = async (
    eventId: string,
    first: number,
    filter?: RsvpFilter,
  ): Promise<string[]> => {
    const ids: string[] = [];
    let after: string | undefined;
    for (;;) {
      count();
      // eslint-disable-next-line no-await-in-loop -- pages in order
      const page = await meetup.getEventRsvps(
        eventId,
        { first, after },
        filter,
      );
      ids.push(...page.event.rsvps.edges.map((edge) => edge.node.member.id));
      if (!page.event.rsvps.pageInfo.hasNextPage) {
        return ids;
      }
      after = page.event.rsvps.pageInfo.endCursor ?? undefined;
    }
  };
  const getEventRsvps = async (
    eventId: string,
    input: PaginationInput,
    filter?: RsvpFilter,
  ): Promise<GetEventRsvpsResponse> => {
    const known = lists.get(eventId);
    if (known && !input.after) {
      return memoPage(eventId, known.ids, known.complete);
    }
    if (known && input.after === MEMO_CURSOR) {
      // A full reader past a partial first page: read the whole list now
      // (Meetup never issued that cursor), remember it complete, and hand
      // over the ids the partial page did not have.
      const all = await readAll(eventId, input.first, filter);
      lists.set(eventId, { ids: all, complete: true });
      const seen = new Set(known.ids);
      return memoPage(
        eventId,
        all.filter((id) => !seen.has(id)),
        true,
      );
    }
    count();
    const response = await meetup.getEventRsvps(eventId, input, filter);
    const { rsvps } = response.event;
    const ids = [
      ...(input.after ? (pending.get(eventId) ?? []) : []),
      ...rsvps.edges.map((edge) => edge.node.member.id),
    ];
    if (rsvps.pageInfo.hasNextPage) {
      pending.set(eventId, ids);
      if (!input.after && !known && lists.size < MEMO_MAX_EVENTS) {
        lists.set(eventId, { ids, complete: false });
      }
    } else {
      pending.delete(eventId);
      if (lists.size < MEMO_MAX_EVENTS || lists.has(eventId)) {
        lists.set(eventId, { ids, complete: true });
      }
    }
    return response;
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
    getEventRsvps,
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
  /** The sweep window closed (or the budget ran out) between years: the member is not done. */
  interrupted?: boolean;
  /** The interruption was the tick's call budget, not the window. */
  budgetSpent?: boolean;
  /** The organizer credential or the group is unreadable: nothing about this member; the tick ends. */
  fatal?: unknown;
}

/** Not the member's fault: the credential or the group, so no member is counted failed for it. */
function isInfrastructureFailure(error: unknown): boolean {
  return (
    error instanceof OrganizerTokenUnavailableError ||
    error instanceof MeetupGroupUnreadableError
  );
}

interface TickContext {
  deps: BackfillDeps;
  tiers: WrappedTiers;
  calls: Counter;
  lists: RunMemo['lists'];
  log: SchedulerLog;
}

type Member = { discordUserId: string; meetupId: string };

/** One year: fresh or being built elsewhere → skipped; else built and written to both tiers. */
async function buildYear(
  ctx: TickContext,
  meetup: WrappedMeetup,
  member: Member,
  year: number,
  sources: WrappedSources,
): Promise<'built' | 'skipped'> {
  const { deps, tiers } = ctx;
  const now = deps.now();
  const copy = await readEntry(
    tiers,
    member.discordUserId,
    year,
    member.meetupId,
    now,
  );
  if (isFresh(copy, member.meetupId, year, now)) {
    return 'skipped';
  }
  const lease = buildingKey(member.discordUserId, year);
  if (
    !(await tiers.cache.exclusive_set(
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
      { earlyFirstPageOnly: true },
    );
    await writeEntry(tiers, member.discordUserId, year, wrapped, deps.now());
    return 'built';
  } finally {
    await tiers.cache.remove(lease).catch(() => undefined);
  }
}

/** Each year in turn; stops (interrupted) when the sweep window closes. */
async function buildYears(
  ctx: TickContext,
  meetup: WrappedMeetup,
  member: Member,
  years: number[],
  sources: WrappedSources,
): Promise<MemberOutcome> {
  const outcome: MemberOutcome = { built: 0, skipped: 0, failed: 0 };
  for (const year of years) {
    if (ctx.calls.n >= TICK_CALL_BUDGET) {
      // Over budget: the next year waits for the next tick.
      outcome.interrupted = true;
      outcome.budgetSpent = true;
      return outcome;
    }
    // eslint-disable-next-line no-await-in-loop -- one build in flight, by design
    if (!(await ctx.deps.canStart(ctx.deps.now(), ctx.tiers.cache))) {
      outcome.interrupted = true;
      return outcome;
    }
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
  member: Member,
  years: number[] | undefined,
): Promise<MemberOutcome> {
  const { deps, tiers } = ctx;
  const lease = deps.newLeaseValue();
  if (!(await acquireBuildLease(tiers.cache, lease))) {
    return { built: 0, skipped: 0, failed: 0, leaseHeld: true };
  }
  try {
    // withOrganizerMeetup's contract is a read-only callback (it may re-run
    // it on a 401). This one writes entries, idempotently: a re-run finds
    // what the first pass wrote fresh and skips it.
    return await deps.withOrganizer(async (organizer) => {
      const meetup = instrumented(organizer, ctx.calls, ctx.lists);
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
    await releaseBuildLease(tiers.cache, lease);
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
  member: Member,
  years: number[] | undefined,
): Promise<MemberOutcome> {
  const { deps } = ctx;
  try {
    const token = await deps.memberToken(member.discordUserId);
    if (token !== undefined) {
      try {
        const meetup = instrumented(
          deps.memberClient(token),
          ctx.calls,
          ctx.lists,
        );
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
    if (isInfrastructureFailure(error)) {
      return { built: 0, skipped: 0, failed: 0, fatal: error };
    }
    // The class name only: a Meetup error's message carries its response.
    ctx.log.warn(
      `Wrapped backfill: Discord user ${member.discordUserId} failed: ${errorName(error)}`,
    );
    return { built: 0, skipped: 0, failed: 1 };
  }
}

function linkedOf(record: MemberRecord | undefined): Member | undefined {
  return record?.meetupId
    ? { discordUserId: record.discordUserId, meetupId: record.meetupId }
    : undefined;
}

/** Code-unit order, the same the cursor comparison uses. */
function byId(a: Member, b: Member): number {
  if (a.discordUserId === b.discordUserId) {
    return 0;
  }
  return a.discordUserId < b.discordUserId ? -1 : 1;
}

/** Every linked member (both ids), in Discord id order: the sweep's list. */
async function linkedMembers(deps: BackfillDeps): Promise<Member[]> {
  return (await (await deps.members()).listAll())
    .map(linkedOf)
    .filter((m): m is Member => m !== undefined)
    .sort(byId);
}

const seconds = (ms: number) => (ms / 1000).toFixed(1);

/** "Wrapped backfill is failing", once per UTC day, by error class only. */
async function alertFailingOnce(
  deps: Pick<BackfillDeps, 'now' | 'alert'>,
  cache: KeyValueCache,
  error: unknown,
  log: SchedulerLog,
): Promise<void> {
  try {
    const key = failingAlertKey(utcDay(deps.now()));
    if (await cache.exclusive_set(key, '1', FAILING_ALERT_TTL_SEC)) {
      const posted = await deps.alert({
        title: 'Wrapped backfill is failing',
        description:
          `The Wrapped backfill tick failed: ${errorName(error)}. ` +
          'It retries every 5 minutes; details are in the process log. This alert repeats at most once a day.',
      });
      if (!posted) {
        await cache.remove(key).catch(() => undefined);
      }
    }
  } catch (alertError) {
    log.error(
      `Wrapped backfill failure alert failed: ${errorName(alertError)}`,
    );
  }
}

function stopReason(outcome: MemberOutcome): string {
  if (outcome.leaseHeld) {
    return 'Wrapped backfill: the report build lease is held; the tick ends';
  }
  if (outcome.budgetSpent) {
    return 'Wrapped backfill: the call budget is spent; the tick ends';
  }
  return 'Wrapped backfill: the sweep window closed; the tick ends';
}

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
  const tiers: WrappedTiers = { cache, entries: await deps.entries() };
  const repo = await deps.members();
  const calls: Counter = { n: 0 };
  const totals = { queued: 0, members: 0, built: 0, skipped: 0, failed: 0 };
  const add = (o: MemberOutcome) => {
    totals.built += o.built;
    totals.skipped += o.skipped;
    totals.failed += o.failed;
  };
  const capReached = () =>
    totals.queued + totals.members >= MEMBERS_PER_TICK ||
    calls.n >= TICK_CALL_BUDGET;
  const ran = (finishedRun: boolean): TickOutcome => ({
    kind: 'ran',
    ...totals,
    calls: calls.n,
    finishedRun,
  });
  // The memo belongs to the open run (filled across its ticks). With no run
  // open the drain gets one for this tick only, dropped when the tick ends.
  const openRun = await store.openRun();
  const ctx: TickContext = {
    deps,
    tiers,
    calls,
    lists: openRun
      ? memoFor(openRun.id)
      : new Map<string, { ids: string[]; complete: boolean }>(),
    log,
  };
  let runId: number | undefined = openRun?.id;
  let recorded = 0;
  const settle = async (): Promise<void> => {
    if (runId !== undefined && calls.n > recorded) {
      await store
        .recordRequests(runId, calls.n - recorded)
        .catch(() => undefined);
      recorded = calls.n;
    }
  };
  const fatal = async (error: unknown): Promise<TickOutcome> => {
    log.error(`Wrapped backfill: ${errorName(error)}; the tick ends`);
    await alertFailingOnce(deps, cache, error, log);
    return ran(false);
  };

  try {
    // The queue first: one claim at a time, so a row is never taken and then
    // handed back for the cap or the budget. A row that fails stays claimed
    // until the tick ends, so it cannot block the rows behind it.
    const failedRows: string[] = [];
    try {
      while (!capReached()) {
        // eslint-disable-next-line no-await-in-loop -- one build in flight, by design
        const [row] = await store.claimNext(1, QUEUE_CLAIM_STALE_MS);
        if (!row) {
          break;
        }
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
        const copy = await readEntry(
          tiers,
          member.discordUserId,
          row.year,
          member.meetupId,
          deps.now(),
        );
        if (isFresh(copy, member.meetupId, row.year, deps.now())) {
          // eslint-disable-next-line no-await-in-loop -- one build in flight, by design
          await store.complete(row.discordUserId);
          totals.skipped += 1;
          continue;
        }
        // eslint-disable-next-line no-await-in-loop -- one build in flight, by design
        const outcome = await buildMember(ctx, member, [row.year]);
        if (outcome.leaseHeld || outcome.interrupted || outcome.fatal) {
          totals.queued -= 1;
          // eslint-disable-next-line no-await-in-loop -- one build in flight, by design
          await store.unclaim(row.discordUserId);
          if (outcome.fatal) {
            // eslint-disable-next-line no-await-in-loop -- the tick ends here
            return await fatal(outcome.fatal);
          }
          log.info(stopReason(outcome));
          return ran(false);
        }
        add(outcome);
        if (outcome.failed > 0) {
          failedRows.push(row.discordUserId);
        } else {
          // eslint-disable-next-line no-await-in-loop -- one build in flight, by design
          await store.complete(row.discordUserId);
        }
      }
    } finally {
      for (const id of failedRows) {
        // eslint-disable-next-line no-await-in-loop -- a few small writes
        if ((await store.release(id, QUEUE_MAX_ATTEMPTS)) === 'dropped') {
          log.warn(
            `Wrapped backfill: queued Wrapped for Discord user ${id} dropped after ${QUEUE_MAX_ATTEMPTS} attempts`,
          );
        }
      }
    }

    // Then the sweep: the open run, or a new one when due or asked for.
    let run = openRun;
    if (!run) {
      const runNow = await cache.get(RUN_NOW_KEY);
      const last = await store.lastFinishedRun();
      const due =
        runNow !== undefined ||
        last?.finishedAt === undefined ||
        deps.now().getTime() - last.finishedAt.getTime() >= RUN_INTERVAL_MS;
      const noWork = (): TickOutcome => {
        return totals.queued > 0
          ? ran(false)
          : { kind: 'skipped', reason: 'no-work' };
      };
      if (!due) {
        return noWork();
      }
      const linked = await linkedMembers(deps);
      run = await store.startRun(runNow ?? 'job', linked.length);
      if (runNow !== undefined) {
        await cache.remove(RUN_NOW_KEY).catch(() => undefined);
      }
      if (!run) {
        return noWork();
      }
      runId = run.id;
      ctx.lists = memoFor(run.id);
      log.info(
        `Wrapped backfill run ${run.id} started (${linked.length} linked members)`,
      );
    }
    const thisRun = run.id;
    const thisYear = tz(dayjs(deps.now())).year();
    const linked = await linkedMembers(deps);
    let { cursor } = run;
    const remaining = () =>
      linked.filter((m) => cursor === undefined || m.discordUserId > cursor);
    for (const member of remaining()) {
      // A member whose current year is fresh and whose previous year is
      // final (or who has no earlier year: the current entry lists every
      // active year) has nothing to build: skipped with no Meetup call and
      // no slot.
      // eslint-disable-next-line no-await-in-loop -- two small reads, one member at a time
      const [current, previous] = await Promise.all([
        tiers.entries?.get(member.discordUserId, thisYear),
        tiers.entries?.get(member.discordUserId, thisYear - 1),
      ]);
      const now = deps.now();
      const noEarlierYear =
        current !== undefined &&
        current.stats.activeYears.every((year) => year >= thisYear);
      if (
        isFresh(current, member.meetupId, thisYear, now) &&
        (noEarlierYear || isFresh(previous, member.meetupId, thisYear - 1, now))
      ) {
        // eslint-disable-next-line no-await-in-loop -- one build in flight, by design
        const moved = await store.advanceRun(
          thisRun,
          cursor,
          member.discordUserId,
          {
            done: 1,
            built: 0,
            skipped: 1,
            failed: 0,
          },
        );
        if (!moved) {
          log.warn(
            'Wrapped backfill: another process moved the run cursor; the tick ends',
          );
          return ran(false);
        }
        cursor = member.discordUserId;
        totals.skipped += 1;
        continue;
      }
      if (capReached()) {
        break;
      }
      // eslint-disable-next-line no-await-in-loop -- one build in flight, by design
      if (!(await deps.canStart(deps.now(), cache))) {
        log.info('Wrapped backfill: the sweep window closed; the tick ends');
        break;
      }
      // A short lease on the member, so two processes on the same cursor do
      // not both read them; the holder advances the cursor past them.
      const memberLease = `${MEMBER_LEASE_KEY_PREFIX}${member.discordUserId}`;
      // eslint-disable-next-line no-await-in-loop -- one build in flight, by design
      const leased = await cache.exclusive_set(
        memberLease,
        deps.newLeaseValue(),
        MEMBER_LEASE_TTL_SEC,
      );
      if (!leased) {
        log.info(
          `Wrapped backfill: Discord user ${member.discordUserId} is being built by another process; the tick ends`,
        );
        break;
      }
      let outcome: MemberOutcome;
      try {
        // eslint-disable-next-line no-await-in-loop -- one build in flight, by design
        outcome = await buildMember(ctx, member, undefined);
      } finally {
        // eslint-disable-next-line no-await-in-loop -- one build in flight, by design
        await cache.remove(memberLease).catch(() => undefined);
      }
      if (outcome.fatal) {
        add({ ...outcome, failed: 0 });
        // eslint-disable-next-line no-await-in-loop -- the tick ends here
        return await fatal(outcome.fatal);
      }
      if (outcome.leaseHeld || outcome.interrupted) {
        add({ ...outcome, failed: 0 });
        log.info(stopReason(outcome));
        break;
      }
      // eslint-disable-next-line no-await-in-loop -- one build in flight, by design
      const advanced = await store.advanceRun(
        thisRun,
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
    await settle();
    let finished: BackfillRun | undefined;
    try {
      finished = await store.finishRun(thisRun);
    } finally {
      clearMemo();
      runId = undefined;
    }
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
            `(retried next run); ${finished.requests} Meetup client calls. ` +
            `Took ${seconds(took)} s.`,
        });
      } catch (error) {
        log.error(`Wrapped backfill summary alert failed: ${errorName(error)}`);
      }
    }
    return ran(true);
  } finally {
    // Whatever the exit: the tick's calls on the run, and no memo outliving
    // a tick that left no run open.
    await settle();
    if (runId === undefined) {
      clearMemo();
    }
  }
}

/**
 * Never rejects. A failing tick (pg, Redis, the schema) is logged in full to
 * the process log and, once per UTC day, alerted by error class only.
 */
async function runTickSafely(
  makeDeps: () => Promise<BackfillDeps>,
  log: SchedulerLog,
  runTick: (deps: BackfillDeps) => Promise<TickOutcome>,
): Promise<void> {
  let deps: BackfillDeps | undefined;
  try {
    deps = await makeDeps();
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
    log.error(`Wrapped backfill tick failed: ${String(error)}`);
    if (!deps) {
      return;
    }
    try {
      await alertFailingOnce(deps, await deps.cache(), error, log);
    } catch (alertError) {
      log.error(
        `Wrapped backfill failure alert failed: ${errorName(alertError)}`,
      );
    }
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
 * run row, the member lease and the queue claims cover other processes).
 * Without DATABASE_URL there is nowhere to record runs or entries, so it
 * never starts.
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
  // Both clients bypass the Redis request cache (spec decision 10): the
  // backfill's reads are shared through the per-run memo instead, and the
  // 30 MB Redis plan is left to the hot entries, sessions and tokens.
  return {
    now: () => new Date(),
    cache: ApplicationCache,
    store: () => PostgresWrappedBackfillRepository.instance(),
    entries: () => PostgresWrappedEntryRepository.instance(),
    members: ApplicationMemberRepository,
    memberToken: async (discordUserId) =>
      (await getUsableMeetupTokens(await ApplicationCache(), discordUserId))
        ?.accessToken,
    memberClient: (token) => new GqlMeetupClient(token, { bypassCache: true }),
    withOrganizer: (fn) =>
      withOrganizerMeetup(getClient(), fn, {
        ...defaultOrganizerMeetupDeps,
        makeClient: (accessToken) =>
          new GqlMeetupClient(accessToken, { bypassCache: true }),
      }),
    isPresent: (discordUserId) => isServerMember(getClient, discordUserId),
    // The report job's window rule (no start from 17:45 UTC until 19:00)
    // and no overlap with a running identity digest.
    canStart: async (now, cache) =>
      canStartMonthBuild(now) && !(await identityDigestInProgress(cache, now)),
    alert: async (entry) => {
      const client = getClient();
      return client ? logAlert(client, entry) : false;
    },
    newLeaseValue: () => crypto.randomUUID(),
    groupId: Configuration.meetup.groupId,
  };
}
