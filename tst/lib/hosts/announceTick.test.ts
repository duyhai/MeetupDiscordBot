import { describe, expect, it, vi } from 'vitest';

import { MeetupPayloadError } from '../../../src/lib/client/meetup/payloadErrors.js';
import { AnnounceEventDetails } from '../../../src/lib/hosts/announceEvent.js';
import {
  ANNOUNCE_LEASE_KEY,
  ANNOUNCE_LEASE_TTL_SEC,
  AnnounceTickDeps,
  runAnnounceTick,
  startAnnounceScheduler,
} from '../../../src/lib/hosts/announceTick.js';
import { Announcement } from '../../../src/lib/repositories/postgresEventAnnouncementRepository.js';
import { FakeCache } from '../../web/fakeCache.js';

const NOW = new Date('2026-11-11T00:00:00Z');
const HOST = '12345';

const details = (id: string): AnnounceEventDetails => ({
  id,
  title: `Event ${id}`,
  eventUrl: `https://www.meetup.com/g/events/${id}/`,
  dateTime: '2026-11-28T19:00:00-08:00',
  createdTime: null,
  rsvpState: 'RSVP',
  hosts: [{ id: HOST, name: 'Ann' }],
});

function setup(
  options: {
    held?: string[];
    missing?: string[];
    announce?: (id: string) => Promise<void>;
    readFails?: string[];
  } = {},
) {
  const rows = new Map<string, Announcement>(
    (options.held ?? []).map((id) => [
      id,
      {
        meetupEventId: id,
        requestedBy: HOST,
        status: 'held',
        failure: null,
        requestedAt: NOW,
        completedAt: null,
        dueAt: new Date(NOW.getTime() - 1000),
      },
    ]),
  );
  const store = {
    due: vi.fn(async () =>
      [...rows.values()].filter((r) => r.status === 'held'),
    ),
    claimHeld: vi.fn(async (id: string) => {
      const row = rows.get(id);
      if (row?.status !== 'held') {
        return false;
      }
      rows.set(id, { ...row, status: 'sending' });
      return true;
    }),
    finish: vi.fn(
      async (
        id: string,
        status: Announcement['status'],
        failure: string | null = null,
      ) => {
        const row = rows.get(id);
        if (row?.status === 'sending') {
          rows.set(id, { ...row, status, failure });
        }
      },
    ),
  };
  const cache = new FakeCache();
  const deps: AnnounceTickDeps = {
    cache: async () => cache,
    announcements: async () => store,
    eventDetails: vi.fn(async (id: string) => {
      if (options.readFails?.includes(id)) {
        throw new Error('meetup down');
      }
      return options.missing?.includes(id) ? undefined : details(id);
    }),
    announce: vi.fn(options.announce ?? (async () => undefined)),
    alert: vi.fn().mockResolvedValue(true),
    now: () => NOW,
    newLeaseValue: () => 'lease-1',
  };
  return { rows, store, cache, deps };
}

describe('runAnnounceTick', () => {
  it('sends each due hold once, records it, and alerts plainly', async () => {
    const { rows, deps, cache } = setup({ held: ['1', '2'] });
    await expect(runAnnounceTick(deps)).resolves.toEqual({
      sent: 2,
      skipped: false,
    });
    expect(deps.announce).toHaveBeenCalledTimes(2);
    expect(rows.get('1')?.status).toBe('sent');
    expect(rows.get('2')?.status).toBe('sent');
    const alerts = JSON.stringify(vi.mocked(deps.alert).mock.calls);
    expect(alerts).toContain('scheduled announcement went out');
    expect(alerts).toContain('Ann');
    expect(alerts).not.toMatch(/<@&|@everyone|@here/);
    // The lease is released for the next tick.
    expect(cache.values.has(ANNOUNCE_LEASE_KEY)).toBe(false);
    // A re-tick finds nothing due: idempotent.
    await expect(runAnnounceTick(deps)).resolves.toEqual({
      sent: 0,
      skipped: false,
    });
    expect(deps.announce).toHaveBeenCalledTimes(2);
  });

  it('another process holding the lease: skipped, nothing sent', async () => {
    const { deps, cache } = setup({ held: ['1'] });
    await cache.set(ANNOUNCE_LEASE_KEY, 'theirs', ANNOUNCE_LEASE_TTL_SEC);
    await expect(runAnnounceTick(deps)).resolves.toEqual({
      sent: 0,
      skipped: true,
    });
    expect(deps.announce).not.toHaveBeenCalled();
    expect(cache.values.get(ANNOUNCE_LEASE_KEY)).toBe('theirs');
  });

  it('a row another tick claimed in between is not sent twice', async () => {
    const { store, deps } = setup({ held: ['1'] });
    store.claimHeld.mockResolvedValueOnce(false);
    await expect(runAnnounceTick(deps)).resolves.toEqual({
      sent: 0,
      skipped: false,
    });
    expect(deps.announce).not.toHaveBeenCalled();
  });

  it('a refusal is recorded and alerted; the next row still goes', async () => {
    const { rows, deps } = setup({
      held: ['1', '2'],
      announce: async (id) => {
        if (id === '1') {
          throw new MeetupPayloadError('announceEvent', [
            { code: 'NOT_ALLOWED', field: null, message: 'no' },
          ]);
        }
      },
    });
    await runAnnounceTick(deps);
    expect(rows.get('1')).toMatchObject({
      status: 'failed',
      failure: 'NOT_ALLOWED: no',
    });
    expect(rows.get('2')?.status).toBe('sent');
    expect(JSON.stringify(vi.mocked(deps.alert).mock.calls)).toContain(
      'scheduled announcement was refused',
    );
  });

  it('an event Meetup no longer has is finished as failed, with an alert', async () => {
    const { rows, deps } = setup({ held: ['1'], missing: ['1'] });
    await runAnnounceTick(deps);
    expect(rows.get('1')).toMatchObject({
      status: 'failed',
      failure: 'The event is no longer on Meetup.',
    });
    expect(deps.announce).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(deps.alert).mock.calls)).toContain(
      'no longer on Meetup',
    );
  });

  it('a Meetup read failing leaves the row held for the next tick', async () => {
    const { rows, deps, cache } = setup({ held: ['1'], readFails: ['1'] });
    await expect(runAnnounceTick(deps)).resolves.toEqual({
      sent: 0,
      skipped: false,
    });
    expect(rows.get('1')?.status).toBe('held');
    expect(cache.values.has(ANNOUNCE_LEASE_KEY)).toBe(false);
  });

  it('a store outage releases the lease and rejects', async () => {
    const { deps, cache } = setup({ held: ['1'] });
    deps.announcements = async () => {
      throw new Error('pg down');
    };
    await expect(runAnnounceTick(deps)).rejects.toThrow('pg down');
    expect(cache.values.has(ANNOUNCE_LEASE_KEY)).toBe(false);
  });
});

describe('startAnnounceScheduler', () => {
  it('ticks now and every minute, skipping a tick while one runs', async () => {
    const { deps } = setup({ held: [] });
    let release: (() => void) | undefined;
    deps.announcements = () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            due: async () => [],
            claimHeld: async () => false,
            finish: async () => undefined,
          });
      });
    const makeDeps = vi.fn(() => deps);
    let interval: (() => void) | undefined;
    startAnnounceScheduler({} as never, makeDeps, {
      env: { DATABASE_URL: 'postgres://x' },
      setIntervalFn: (fn: () => void, ms: number) => {
        expect(ms).toBe(60_000);
        interval = fn;
        return 0 as never;
      },
    });
    expect(makeDeps).toHaveBeenCalledTimes(1);
    // The tick reaches the store only after a few awaits.
    await new Promise((r) => setTimeout(r, 5));
    interval?.();
    expect(makeDeps).toHaveBeenCalledTimes(1);
    release?.();
    await new Promise((r) => setTimeout(r, 5));
    interval?.();
    expect(makeDeps).toHaveBeenCalledTimes(2);
  });

  it('never starts without DATABASE_URL', () => {
    const makeDeps = vi.fn();
    const setIntervalFn = vi.fn();
    startAnnounceScheduler({} as never, makeDeps, {
      env: {},
      setIntervalFn: setIntervalFn as never,
      log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    });
    expect(makeDeps).not.toHaveBeenCalled();
    expect(setIntervalFn).not.toHaveBeenCalled();
  });
});
