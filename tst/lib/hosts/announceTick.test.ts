import { describe, expect, it, vi } from 'vitest';

import { MeetupPayloadError } from '../../../src/lib/client/meetup/payloadErrors.js';
import { AnnounceEventDetails } from '../../../src/lib/hosts/announceEvent.js';
import {
  ANNOUNCE_LEASE_KEY,
  ANNOUNCE_LEASE_TTL_SEC,
  AnnounceTickDeps,
  STUCK_AFTER_MS,
  runAnnounceTick,
  startAnnounceScheduler,
  stuckAlertKey,
} from '../../../src/lib/hosts/announceTick.js';
import { OrganizerTokenUnavailableError } from '../../../src/lib/reports/organizerMeetup.js';
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
  rsvpsClosed: false,
  hosts: [{ id: HOST, name: 'Ann' }],
});

function setup(
  options: {
    /** Held ids, due a second ago unless `dueAgoMs` says otherwise. */
    held?: string[];
    dueAgoMs?: number;
    missing?: string[];
    announce?: (id: string) => Promise<void>;
    readFails?: string[];
    /** When other announcements went out. */
    others?: Date[];
  } = {},
) {
  const rows = new Map<string, Announcement>(
    (options.held ?? []).map((id, i) => [
      id,
      {
        meetupEventId: id,
        requestedBy: HOST,
        status: 'held',
        failure: null,
        requestedAt: NOW,
        completedAt: null,
        // Later ids are due later, so the order is fixed.
        dueAt: new Date(NOW.getTime() - (options.dueAgoMs ?? 1000) + i),
        confirmation: null,
      },
    ]),
  );
  const store = {
    due: vi.fn(async (now: Date, limit: number) =>
      [...rows.values()]
        .filter(
          (r) =>
            r.status === 'held' && (r.dueAt?.getTime() ?? 0) <= now.getTime(),
        )
        .sort((a, b) => (a.dueAt?.getTime() ?? 0) - (b.dueAt?.getTime() ?? 0))
        .slice(0, limit),
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
          rows.set(id, { ...row, status, failure, completedAt: NOW });
        }
      },
    ),
    unclaim: vi.fn(async (id: string) => {
      const row = rows.get(id);
      if (row?.status === 'sending') {
        rows.set(id, { ...row, status: 'held' });
      }
    }),
    // Real sends only: sent rows at completed_at, never held ones.
    recentSends: vi.fn(async (since: Date) =>
      [
        ...(options.others ?? []),
        ...[...rows.values()]
          .filter((r) => r.status === 'sent')
          .map((r) => r.completedAt),
      ].filter((t) => t.getTime() >= since.getTime()),
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
  const alerts = () => JSON.stringify(vi.mocked(deps.alert).mock.calls);
  return { rows, store, cache, deps, alerts };
}

describe('runAnnounceTick', () => {
  it('sends one due hold per tick, records it, and alerts plainly', async () => {
    const { rows, deps, cache, alerts } = setup({ held: ['1', '2'] });
    await expect(runAnnounceTick(deps)).resolves.toEqual({
      sent: 1,
      skipped: false,
    });
    expect(deps.announce).toHaveBeenCalledTimes(1);
    expect(deps.announce).toHaveBeenCalledWith('1');
    expect(rows.get('1')?.status).toBe('sent');
    expect(rows.get('2')?.status).toBe('held');
    expect(alerts()).toContain('scheduled announcement went out');
    expect(alerts()).toContain('Ann');
    expect(alerts()).not.toMatch(/<@&|@everyone|@here/);
    // The lease is released for the next tick.
    expect(cache.values.has(ANNOUNCE_LEASE_KEY)).toBe(false);
  });

  it('the next due row waits 30 minutes after the one that just went out, keeping its place', async () => {
    const { rows, deps } = setup({ held: ['1', '2', '3'] });
    await runAnnounceTick(deps);
    await expect(runAnnounceTick(deps)).resolves.toEqual({
      sent: 0,
      skipped: false,
    });
    expect(deps.announce).toHaveBeenCalledTimes(1);
    // Nothing is rescheduled: the waiting rows keep their times and order.
    const before = rows.get('2')?.dueAt;
    expect(rows.get('2')).toMatchObject({ status: 'held', dueAt: before });
    deps.now = () => new Date(NOW.getTime() + 30 * 60 * 1000);
    await expect(runAnnounceTick(deps)).resolves.toMatchObject({ sent: 1 });
    expect(vi.mocked(deps.announce).mock.calls.map(([id]) => id)).toEqual([
      '1',
      '2',
    ]);
  });

  it('a send by a click within the last 30 minutes holds the due row back', async () => {
    const { rows, deps } = setup({
      held: ['1'],
      others: [new Date(NOW.getTime() - 10 * 60 * 1000)],
    });
    await expect(runAnnounceTick(deps)).resolves.toEqual({
      sent: 0,
      skipped: false,
    });
    expect(deps.announce).not.toHaveBeenCalled();
    expect(rows.get('1')?.status).toBe('held');
  });

  it('overdue held rows are not sends: after an outage the backlog goes in order', async () => {
    // Three rows all an hour overdue; nothing was sent in that hour.
    const { deps } = setup({ held: ['1', '2', '3'], dueAgoMs: 60 * 60 * 1000 });
    await expect(runAnnounceTick(deps)).resolves.toMatchObject({ sent: 1 });
    expect(deps.announce).toHaveBeenCalledWith('1');
  });

  it('an unreadable first row does not block the next: the second is sent', async () => {
    const { rows, deps, alerts } = setup({
      held: ['1', '2'],
      readFails: ['1'],
      dueAgoMs: STUCK_AFTER_MS,
    });
    await expect(runAnnounceTick(deps)).resolves.toMatchObject({ sent: 1 });
    expect(deps.announce).toHaveBeenCalledTimes(1);
    expect(deps.announce).toHaveBeenCalledWith('2');
    expect(rows.get('1')?.status).toBe('held');
    expect(rows.get('2')?.status).toBe('sent');
    // The stuck one is still said, once.
    expect(alerts()).toContain('scheduled announcement is stuck');
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

  it('two ticks at once: one send', async () => {
    const { deps } = setup({ held: ['1'] });
    let release: (() => void) | undefined;
    deps.announce = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const one = runAnnounceTick(deps);
    await vi.waitFor(() => {
      expect(deps.announce).toHaveBeenCalledTimes(1);
    });
    const two = await runAnnounceTick(deps);
    expect(two).toEqual({ sent: 0, skipped: true });
    release?.();
    expect(await one).toEqual({ sent: 1, skipped: false });
    expect(deps.announce).toHaveBeenCalledTimes(1);
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

  it('a refusal is recorded and alerted', async () => {
    const { rows, deps, alerts } = setup({
      held: ['1'],
      announce: async () => {
        throw new MeetupPayloadError('announceEvent', [
          { code: 'NOT_ALLOWED', field: null, message: 'no' },
        ]);
      },
    });
    await runAnnounceTick(deps);
    expect(rows.get('1')).toMatchObject({
      status: 'failed',
      failure: 'NOT_ALLOWED: no',
    });
    expect(alerts()).toContain('scheduled announcement was refused');
  });

  it('an event Meetup no longer has is finished as failed, with an alert', async () => {
    const { rows, deps, alerts } = setup({ held: ['1'], missing: ['1'] });
    await runAnnounceTick(deps);
    expect(rows.get('1')).toMatchObject({
      status: 'failed',
      failure: 'The event is no longer on Meetup.',
    });
    expect(deps.announce).not.toHaveBeenCalled();
    expect(alerts()).toContain('no longer on Meetup');
  });

  it('a Meetup read failing leaves the row held; once 15 minutes late it is alerted once a day', async () => {
    const { rows, deps, cache, alerts } = setup({
      held: ['1'],
      readFails: ['1'],
    });
    await expect(runAnnounceTick(deps)).resolves.toEqual({
      sent: 0,
      skipped: false,
    });
    expect(rows.get('1')?.status).toBe('held');
    expect(deps.alert).not.toHaveBeenCalled();
    expect(cache.values.has(ANNOUNCE_LEASE_KEY)).toBe(false);
    // Fifteen minutes late and still unreadable: one alert, then silence.
    deps.now = () => new Date(NOW.getTime() + STUCK_AFTER_MS);
    await runAnnounceTick(deps);
    await runAnnounceTick(deps);
    expect(deps.alert).toHaveBeenCalledTimes(1);
    expect(alerts()).toContain('scheduled announcement is stuck');
    expect(alerts()).toContain('Meetup could not be asked');
    expect(cache.values.has(stuckAlertKey('1'))).toBe(true);
    expect(rows.get('1')?.status).toBe('held');
  });

  it('no organizer credential: the row stays held and the stuck alert names the login', async () => {
    const { rows, deps, alerts } = setup({
      held: ['1'],
      dueAgoMs: STUCK_AFTER_MS,
    });
    vi.mocked(deps.eventDetails).mockRejectedValueOnce(
      new OrganizerTokenUnavailableError(),
    );
    await runAnnounceTick(deps);
    expect(rows.get('1')?.status).toBe('held');
    expect(alerts()).toContain('organizer login is not usable');
    expect(alerts()).not.toContain('refused');
  });

  it('the credential going away between the read and the send puts the row back on hold', async () => {
    const { rows, deps, store, alerts } = setup({
      held: ['1'],
      announce: async () => {
        throw new OrganizerTokenUnavailableError();
      },
    });
    await expect(runAnnounceTick(deps)).resolves.toEqual({
      sent: 0,
      skipped: false,
    });
    expect(store.unclaim).toHaveBeenCalledWith('1');
    expect(rows.get('1')?.status).toBe('held');
    expect(alerts()).not.toContain('refused');
    expect(alerts()).not.toContain('not confirmed');
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
    const { deps, store } = setup({ held: [] });
    let release: (() => void) | undefined;
    deps.announcements = () =>
      new Promise((resolve) => {
        release = () => resolve(store);
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
