import { ClientError } from 'graphql-request';
import { beforeEach, describe, expect, it } from 'vitest';

import { FakeCache } from '../../web/fakeCache.js';
import {
  PaginatedData,
  PaginationInput,
  SnapshotEventNode,
  SnapshotRsvpNode,
} from '../../../src/lib/client/meetup/types.js';
import { LogEntry } from '../../../src/lib/helpers/discordLogger.js';
import { BUILD_LEASE_KEY } from '../../../src/lib/reports/buildLease.js';
import {
  SNAPSHOT_RUN_INTERVAL_MS,
  SNAPSHOT_RUN_NOW_KEY,
  SNAPSHOT_TICK_CALL_BUDGET,
  SnapshotDeps,
  resetSkipped,
  runSnapshotTick,
} from '../../../src/lib/snapshot/ingest.js';
import { SnapshotMeetup } from '../../../src/lib/snapshot/read.js';
import { FakeSnapshotStore } from './fakes.js';

const START = new Date('2026-11-11T20:00:00Z');
const DAY = 24 * 60 * 60_000;

function page<T>(nodes: T[], next: string | undefined): PaginatedData<T> {
  return {
    edges: nodes.map((node) => ({ node })),
    pageInfo: {
      hasNextPage: next !== undefined,
      hasPreviousPage: false,
      startCursor: '',
      endCursor: next ?? '',
    },
    totalCount: nodes.length,
  };
}

interface FakeEvent {
  id: string;
  status: 'PAST' | 'ACTIVE' | 'CANCELLED';
  daysAgo: number;
  members: number;
}

/** A group on Meetup: listing pages of 100, RSVP pages of 100. */
class FakeGroup implements SnapshotMeetup {
  events: FakeEvent[] = [];

  /** Event ids whose RSVP read throws this. */
  failing = new Map<string, Error>();

  gone = new Set<string>();

  /** Every listing call throws this while set. */
  listingError: Error | undefined;

  rsvpReads: string[] = [];

  /** Fail every call after this many with a 401, once. */
  unauthorizedAfter: number | undefined;

  private calls = 0;

  constructor(private readonly clock: () => Date) {}

  private tick(): void {
    this.calls += 1;
    if (
      this.unauthorizedAfter !== undefined &&
      this.calls > this.unauthorizedAfter
    ) {
      this.unauthorizedAfter = undefined;
      throw new ClientError({ status: 401, headers: new Headers() } as never, {
        query: '',
      });
    }
  }

  async getGroupEventsForSnapshot(
    input: PaginationInput,
    filter: { status?: string[] },
  ): Promise<PaginatedData<SnapshotEventNode>> {
    this.tick();
    if (this.listingError) {
      throw this.listingError;
    }
    const matching = this.events.filter((e) =>
      (filter.status ?? []).includes(e.status),
    );
    const from = Number(input.after ?? 0);
    const slice = matching.slice(from, from + input.first);
    const next =
      from + input.first < matching.length
        ? String(from + input.first)
        : undefined;
    return page(
      slice.map((e) => ({
        id: e.id,
        title: `Event ${e.id}`,
        status: e.status,
        dateTime: new Date(
          this.clock().getTime() - e.daysAgo * DAY,
        ).toISOString(),
        eventUrl: `https://www.meetup.com/g/events/${e.id}/`,
        eventHosts: [{ member: { id: '1' } }],
        attendance: { totalCount: e.members },
        waitlist: { totalCount: 0 },
      })),
      next,
    );
  }

  async getEventRsvpsForSnapshot(
    eventId: string,
    input: PaginationInput,
  ): Promise<PaginatedData<SnapshotRsvpNode> | null> {
    this.tick();
    this.rsvpReads.push(eventId);
    const failure = this.failing.get(eventId);
    if (failure) {
      throw failure;
    }
    if (this.gone.has(eventId)) {
      return null;
    }
    const event = this.events.find((e) => e.id === eventId);
    const total = event?.members ?? 0;
    const from = Number(input.after ?? 0);
    const count = Math.min(input.first, total - from);
    return page(
      Array.from({ length: Math.max(0, count) }, (_, i) => ({
        status: 'YES',
        member: { id: String(1000 + from + i) },
      })),
      from + input.first < total ? String(from + input.first) : undefined,
    );
  }
}

function setup() {
  let now = START.getTime();
  const clock = () => new Date(now);
  const store = new FakeSnapshotStore(clock);
  const cache = new FakeCache();
  const group = new FakeGroup(clock);
  const alerts: LogEntry[] = [];
  let open = true;
  let organizerRuns = 0;
  const deps: SnapshotDeps = {
    now: () => {
      now += 1; // every read of the clock moves it a little
      return new Date(now);
    },
    cache: async () => cache,
    store: async () => store,
    withOrganizer: async (fn) => {
      organizerRuns += 1;
      try {
        return await fn(group);
      } catch (error) {
        if (error instanceof ClientError && error.response.status === 401) {
          organizerRuns += 1;
          return fn(group);
        }
        throw error;
      }
    },
    canStart: async () => open,
    alert: async (entry) => {
      alerts.push(entry);
      return true;
    },
    newLeaseValue: () => 'lease',
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };
  return {
    deps,
    store,
    cache,
    group,
    alerts,
    advance: (ms: number) => {
      now += ms;
    },
    close: () => {
      open = false;
    },
    organizerRuns: () => organizerRuns,
  };
}

const past = (n: number, from = 0, members = 5): FakeEvent[] =>
  Array.from({ length: n }, (_, i) => ({
    id: String(100 + from + i),
    status: 'PAST' as const,
    daysAgo: 1000 - from - i,
    members,
  }));

async function tickUntilFinished(env: ReturnType<typeof setup>) {
  for (let i = 0; i < 50; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- ticks in order
    const outcome = await runSnapshotTick(env.deps);
    if (outcome.kind !== 'ran' || outcome.finished) {
      return outcome;
    }
  }
  throw new Error('never finished');
}

beforeEach(() => resetSkipped());

describe('runSnapshotTick', () => {
  it('a first run is full: lists, reads oldest first under the budget, resumes, finishes', async () => {
    const env = setup();
    env.group.events = [
      ...past(200),
      { id: '999', status: 'ACTIVE', daysAgo: -3, members: 9 },
    ];
    const first = await runSnapshotTick(env.deps);
    expect(first).toMatchObject({ kind: 'ran', listed: true, finished: false });
    const run = env.store.runs[0];
    expect(run.kind).toBe('full');
    expect(env.store.events.size).toBe(201);
    // 3 listing calls (2 PAST pages, 1 ACTIVE), then one call per event.
    expect(first.kind === 'ran' && first.calls).toBe(SNAPSHOT_TICK_CALL_BUDGET);
    expect(env.group.rsvpReads.slice(0, 3)).toEqual(['100', '101', '102']);
    expect(env.store.replaced).not.toContain('999');

    const rest = await tickUntilFinished(env);
    expect(rest).toMatchObject({ kind: 'ran', finished: true, listed: false });
    expect(env.store.replaced).toHaveLength(200);
    expect(new Set(env.store.replaced).size).toBe(200);
    expect(env.store.runs[0]).toMatchObject({
      eventsFetched: 200,
      rsvpsStored: 1000,
      requests: 203,
    });
    expect(await env.cache.get(BUILD_LEASE_KEY)).toBeUndefined();
    expect(env.alerts.map((a) => a.title)).toEqual(['Group snapshot finished']);
    expect(env.alerts[0].description).toContain('201 events and 1000 RSVPs');
  });

  it('is not due again for 20 h; the next run is incremental and quiet; Run now starts one', async () => {
    const env = setup();
    env.group.events = past(3);
    await tickUntilFinished(env);
    expect(await runSnapshotTick(env.deps)).toEqual({
      kind: 'skipped',
      reason: 'not-due',
    });
    await env.cache.set(SNAPSHOT_RUN_NOW_KEY, '123456789012345678', 60);
    const asked = await runSnapshotTick(env.deps);
    expect(asked).toMatchObject({ kind: 'ran', finished: true });
    expect(env.store.runs[1]).toMatchObject({
      kind: 'incremental',
      trigger: '123456789012345678',
    });
    expect(await env.cache.get(SNAPSHOT_RUN_NOW_KEY)).toBeUndefined();
    env.advance(SNAPSHOT_RUN_INTERVAL_MS);
    await runSnapshotTick(env.deps);
    expect(env.store.runs[2].kind).toBe('incremental');
    expect(env.alerts).toHaveLength(1); // the full run's summary only
  });

  it('an incremental run reads new and settling events only', async () => {
    const env = setup();
    env.group.events = [
      ...past(2),
      { id: '50', status: 'PAST', daysAgo: 3, members: 4 },
    ];
    await tickUntilFinished(env);
    env.group.rsvpReads = [];
    env.advance(SNAPSHOT_RUN_INTERVAL_MS);
    env.group.events.push({
      id: '51',
      status: 'PAST',
      daysAgo: 0.1,
      members: 2,
    });
    await tickUntilFinished(env);
    expect(env.group.rsvpReads.sort()).toEqual(['50', '51']);
  });

  it('a short listing marks nothing deleted; a complete one marks the missing', async () => {
    const env = setup();
    env.group.events = past(100);
    await tickUntilFinished(env);
    env.group.events = past(90);
    env.advance(SNAPSHOT_RUN_INTERVAL_MS);
    await tickUntilFinished(env);
    expect(env.store.runs[1].lastError).toBe('ShortListing');
    expect(await env.store.pastEventCount()).toBe(100);

    env.group.events = past(99);
    env.advance(SNAPSHOT_RUN_INTERVAL_MS);
    await tickUntilFinished(env);
    expect(await env.store.pastEventCount()).toBe(99);
    expect(env.store.events.get('199')?.deletedAt).toBeInstanceOf(Date);
  });

  it('applies the event audit’s confirmed deletions in the listing phase', async () => {
    const env = setup();
    env.group.events = past(2);
    env.store.auditDeleted.set('101', START);
    await tickUntilFinished(env);
    expect(env.store.events.get('101')?.deletedAt).toEqual(START);
    expect(env.store.replaced).toEqual(['100']);
  });

  it('reads a big event across all its pages, even past the budget', async () => {
    const env = setup();
    env.group.events = [...past(146), ...past(1, 146, 450)];
    const first = await runSnapshotTick(env.deps);
    // 2 listing + 1 ACTIVE + 146 small events = 149 calls; the big one starts and reads 5 pages.
    expect(first.kind === 'ran' && first.calls).toBe(154);
    expect(env.store.rsvps.get('246')).toHaveLength(450);
  });

  it('skips an event that keeps failing for the run, counts it, and retries it next run', async () => {
    const env = setup();
    env.group.events = past(3);
    env.group.failing.set('101', new TypeError('bad'));
    const done = await tickUntilFinished(env);
    expect(done).toMatchObject({ kind: 'ran', finished: true });
    expect(env.store.runs[0].failed).toBe(1);
    expect(env.store.replaced).toEqual(['100', '102']);
    env.group.failing.clear();
    env.advance(SNAPSHOT_RUN_INTERVAL_MS);
    await tickUntilFinished(env);
    expect(env.store.replaced).toContain('101');
  });

  it('three failures in a row end the tick as a failure, and those events are not skipped', async () => {
    const env = setup();
    env.group.events = past(4);
    ['100', '101', '102'].forEach((id) =>
      env.group.failing.set(id, new TypeError('down')),
    );
    const outcome = await runSnapshotTick(env.deps);
    expect(outcome).toEqual({
      kind: 'failed',
      runId: 1,
      error: 'TypeError',
    });
    expect(env.store.runs[0].lastError).toBe('TypeError');
    env.group.failing.clear();
    await tickUntilFinished(env);
    expect(env.store.replaced.sort()).toEqual(['100', '101', '102', '103']);
  });

  it('an event Meetup no longer has is marked deleted, not failed', async () => {
    const env = setup();
    env.group.events = past(2);
    env.group.gone.add('100');
    await tickUntilFinished(env);
    expect(env.store.events.get('100')?.deletedAt).toBeInstanceOf(Date);
    expect(env.store.runs[0].failed).toBe(0);
    expect(env.store.replaced).toEqual(['101']);
  });

  it('a 401 mid-tick re-runs the reads without counting or replacing twice', async () => {
    const env = setup();
    env.group.events = past(5);
    env.group.unauthorizedAfter = 5; // listing (2 calls) + 3 events, then a 401
    const outcome = await runSnapshotTick(env.deps);
    expect(env.organizerRuns()).toBe(2);
    expect(outcome).toMatchObject({ kind: 'ran', finished: true, fetched: 5 });
    expect(env.store.replaced).toEqual(['100', '101', '102', '103', '104']);
    expect(env.store.runs[0].eventsFetched).toBe(5);
  });

  it('the guard, a held lease and a closing window defer cleanly', async () => {
    const env = setup();
    env.group.events = past(3);
    await env.cache.set(BUILD_LEASE_KEY, 'someone-else', 60);
    expect(await runSnapshotTick(env.deps)).toEqual({
      kind: 'skipped',
      reason: 'lease',
    });
    expect(env.group.rsvpReads).toEqual([]);
    await env.cache.remove(BUILD_LEASE_KEY);
    env.close();
    expect(await runSnapshotTick(env.deps)).toEqual({
      kind: 'skipped',
      reason: 'guard',
    });
  });

  it('a tick that throws releases the lease and alerts once a day, by class name only', async () => {
    const env = setup();
    env.group.events = past(3);
    env.group.listingError = new RangeError('secret Meetup body');
    expect(await runSnapshotTick(env.deps)).toMatchObject({ kind: 'failed' });
    expect(await runSnapshotTick(env.deps)).toMatchObject({ kind: 'failed' });
    expect(await env.cache.get(BUILD_LEASE_KEY)).toBeUndefined();
    expect(env.alerts).toHaveLength(1);
    expect(env.alerts[0].title).toBe('Group snapshot is failing');
    expect(env.alerts[0].description).toContain('RangeError');
    expect(env.alerts[0].description).not.toContain('secret');
    expect(env.alerts[0].description).not.toContain('open for');
    // A day later, with the run still open for over 24 h: the alert says so.
    env.advance(DAY + 60_000);
    await runSnapshotTick(env.deps);
    expect(env.alerts[1].description).toContain('has been open for 24 h');
    env.group.listingError = undefined;
    expect(await tickUntilFinished(env)).toMatchObject({ finished: true });
  });

  it('another process holding the open run: this one starts nothing', async () => {
    const env = setup();
    env.group.events = past(1);
    env.store.startRun = async () => undefined;
    expect(await runSnapshotTick(env.deps)).toEqual({
      kind: 'skipped',
      reason: 'not-due',
    });
    expect(env.group.rsvpReads).toEqual([]);
  });

  it('no alert mentions anyone', async () => {
    const env = setup();
    env.group.events = past(2);
    await tickUntilFinished(env);
    env.alerts.forEach((a) => {
      expect(`${a.title} ${a.description}`).not.toMatch(/<@|@everyone|@here/);
    });
  });
});
