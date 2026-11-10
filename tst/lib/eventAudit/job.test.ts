import { Client } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import {
  COOLDOWN_KEY,
  EVENT_AUDIT_COOLDOWN_SEC,
  EVENT_AUDIT_INTERVAL_MS,
  EVENT_AUDIT_TICK_MS,
  EventAuditDeps,
  isEventAuditDue,
  requestEventAudit,
  runEventAuditTick,
  startEventAuditScheduler,
} from '../../../src/lib/eventAudit/job.js';
import { BACKOFF_KEY } from '../../../src/lib/eventAudit/run.js';
import { BUILD_LEASE_KEY } from '../../../src/lib/reports/buildLease.js';
import { identityDigestClaimKey } from '../../../src/lib/helpers/identity/digest.js';
import { utcDay } from '../../../src/lib/reports/period.js';
import {
  FakeEventAuditStore,
  NOW,
  fakeDeps,
  fakeReader,
  obs,
} from './fakes.js';

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

async function storeWithRun(startedAt: Date, outcome: 'saved' | 'failed') {
  const store = new FakeEventAuditStore();
  if (outcome === 'saved') {
    await store.saveRun({
      startedAt,
      finishedAt: startedAt,
      requestedBy: 'job',
      listed: 0,
      confirmed: 0,
      observations: [],
      deletedEventIds: [],
      changes: [],
    });
  } else {
    await store.recordFailedRun(startedAt, startedAt, 'job');
  }
  return store;
}

describe('isEventAuditDue', () => {
  it('is hourly from the latest saved run, ignoring failed runs, never in backoff', async () => {
    const { cache } = fakeDeps();
    expect(await isEventAuditDue(new FakeEventAuditStore(), cache, NOW)).toBe(
      true,
    );
    expect(
      await isEventAuditDue(
        await storeWithRun(minutesAgo(54), 'saved'),
        cache,
        NOW,
      ),
    ).toBe(false);
    expect(
      await isEventAuditDue(
        await storeWithRun(minutesAgo(56), 'saved'),
        cache,
        NOW,
      ),
    ).toBe(true);
    const mixed = await storeWithRun(minutesAgo(120), 'saved');
    await mixed.recordFailedRun(minutesAgo(1), minutesAgo(1), 'job');
    expect(await isEventAuditDue(mixed, cache, NOW)).toBe(true);
    await cache.set(BACKOFF_KEY, '1', 60);
    expect(await isEventAuditDue(mixed, cache, NOW)).toBe(false);
    expect(EVENT_AUDIT_INTERVAL_MS).toBe(55 * 60_000);
  });
});

describe('runEventAuditTick', () => {
  it('a due tick reads Meetup under the build lease and releases it', async () => {
    const { reader, readMeetup } = fakeReader([obs()]);
    const { deps, cache, store } = fakeDeps({ readMeetup });
    deps.now = () => new Date('2026-11-10T20:10:00Z'); // NOW itself is the quiet hour
    await runEventAuditTick(deps);
    expect(reader.listEvents).toHaveBeenCalledTimes(1);
    expect(store.runs).toHaveLength(1);
    expect(cache.values.has(BUILD_LEASE_KEY)).toBe(false);
  });

  it('does nothing in the quiet hour, while the digest runs, when the lease is held, or when not due', async () => {
    const cases: ((
      d: EventAuditDeps,
      cache: Awaited<ReturnType<EventAuditDeps['cache']>>,
    ) => Promise<void>)[] = [
      async (d) => {
        d.now = () => new Date('2026-11-10T18:10:00Z');
      },
      async (d, cache) => {
        d.now = () => new Date('2026-11-10T20:10:00Z');
        await cache.set(identityDigestClaimKey(utcDay(d.now())), '1', 60);
      },
      async (_d, cache) => {
        await cache.set(BUILD_LEASE_KEY, 'other', 60);
      },
    ];
    for (const arrange of cases) {
      const { reader, readMeetup } = fakeReader([obs()]);
      const { deps, cache } = fakeDeps({ readMeetup });
      deps.now = () => new Date('2026-11-10T20:10:00Z');
      // eslint-disable-next-line no-await-in-loop -- sequential cases
      await arrange(deps, cache);
      // eslint-disable-next-line no-await-in-loop -- sequential cases
      await runEventAuditTick(deps);
      expect(reader.listEvents).not.toHaveBeenCalled();
    }
    const heldDeps = fakeDeps({ readMeetup: fakeReader([obs()]).readMeetup });
    heldDeps.deps.now = () => new Date('2026-11-10T20:10:00Z');
    await heldDeps.cache.set(BUILD_LEASE_KEY, 'other', 60);
    await runEventAuditTick(heldDeps.deps);
    expect(heldDeps.cache.values.get(BUILD_LEASE_KEY)).toBe('other');
    const recent = await storeWithRun(
      new Date('2026-11-10T20:00:00Z'),
      'saved',
    );
    const notDue = fakeDeps({
      store: async () => recent,
      readMeetup: fakeReader([obs()]).readMeetup,
    });
    await runEventAuditTick(notDue.deps);
    expect(recent.runs).toHaveLength(1);
    expect(notDue.cache.values.has(BUILD_LEASE_KEY)).toBe(false);
  });
});

describe('requestEventAudit', () => {
  const STAFF = '123456789012345678';

  it('refuses in order: requester, quiet hour, digest, lease, cooldown', async () => {
    const { deps, cache } = fakeDeps({
      readMeetup: fakeReader([obs()]).readMeetup,
    });
    deps.now = () => new Date('2026-11-10T20:10:00Z');
    expect(await requestEventAudit(deps, 'job')).toEqual({
      status: 'bad-requester',
    });
    const quiet = fakeDeps();
    quiet.deps.now = () => new Date('2026-11-10T17:50:00Z');
    expect(await requestEventAudit(quiet.deps, STAFF)).toEqual({
      status: 'quiet-hour',
    });
    await cache.set(identityDigestClaimKey(utcDay(deps.now())), '1', 60);
    expect(await requestEventAudit(deps, STAFF)).toEqual({
      status: 'identity-sweep',
    });
    await cache.remove(identityDigestClaimKey(utcDay(deps.now())));
    await cache.set(BUILD_LEASE_KEY, 'other', 60);
    expect(await requestEventAudit(deps, STAFF)).toEqual({ status: 'busy' });
    await cache.remove(BUILD_LEASE_KEY);
    await cache.set(COOLDOWN_KEY, STAFF, 60);
    expect(await requestEventAudit(deps, STAFF)).toEqual({
      status: 'cooldown',
    });
    expect(cache.values.has(BUILD_LEASE_KEY)).toBe(false);
  });

  it('starts the run in the background, holding the lease until it is done', async () => {
    const { deps, cache, store } = fakeDeps({
      readMeetup: fakeReader([obs()]).readMeetup,
    });
    deps.now = () => new Date('2026-11-10T20:10:00Z');
    const result = await requestEventAudit(deps, STAFF);
    expect(result.status).toBe('started');
    if (result.status !== 'started') {
      throw new Error('not started');
    }
    expect(cache.ttls.get(COOLDOWN_KEY)).toBe(EVENT_AUDIT_COOLDOWN_SEC);
    expect(await result.done).toMatchObject({ ok: true, listed: 1 });
    expect(store.runs[0]).toMatchObject({
      requestedBy: STAFF,
      outcome: 'saved',
    });
    expect(cache.values.has(BUILD_LEASE_KEY)).toBe(false);
  });
});

describe('startEventAuditScheduler', () => {
  const log = () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() });
  const captureInterval = () => {
    const calls: { fn: () => void; ms: number }[] = [];
    const setIntervalFn = vi.fn((fn: () => void, ms: number) => {
      calls.push({ fn, ms });
      return 0 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setInterval;
    return { calls, setIntervalFn };
  };

  it('does not start without DATABASE_URL', () => {
    const { setIntervalFn } = captureInterval();
    const l = log();
    const makeDeps = vi.fn();
    startEventAuditScheduler({} as Client, {
      env: {},
      makeDeps,
      setIntervalFn,
      log: l,
    });
    expect(setIntervalFn).not.toHaveBeenCalled();
    expect(makeDeps).not.toHaveBeenCalled();
    expect(l.warn).toHaveBeenCalledWith(
      'Event audit job disabled: DATABASE_URL is not set',
    );
  });

  it('ticks once now and every 15 minutes, one at a time, logging failures', async () => {
    const { calls, setIntervalFn } = captureInterval();
    const l = log();
    const { deps } = fakeDeps({ readMeetup: fakeReader([obs()]).readMeetup });
    deps.now = () => new Date('2026-11-10T20:10:00Z');
    let release: (() => void) | undefined;
    const makeDeps = vi.fn(
      () =>
        new Promise<EventAuditDeps>((resolve) => {
          release = () => resolve(deps);
        }),
    );
    startEventAuditScheduler({} as Client, {
      env: { DATABASE_URL: 'postgres://x' },
      makeDeps,
      setIntervalFn,
      log: l,
    });
    expect(EVENT_AUDIT_TICK_MS).toBe(900_000);
    expect(calls[0].ms).toBe(900_000);
    expect(makeDeps).toHaveBeenCalledTimes(1);
    calls[0].fn();
    expect(makeDeps).toHaveBeenCalledTimes(1);
    release?.();
    await settle();
    await settle();
    makeDeps.mockRejectedValueOnce(new Error('no pool'));
    calls[0].fn();
    await settle();
    expect(makeDeps).toHaveBeenCalledTimes(2);
    expect(l.error).toHaveBeenCalledWith(
      'Event audit tick failed: Error: no pool',
    );
  });
});
