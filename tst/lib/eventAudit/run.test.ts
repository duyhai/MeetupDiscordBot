import { describe, expect, it } from 'vitest';

import {
  ALERT_RATE_LIMIT_SEC,
  alertedKey,
} from '../../../src/lib/eventAudit/alerts.js';
import {
  BACKOFF_KEY,
  CONFIRM_CAP,
  UNCONFIRMED_ALERT_AFTER,
  failedAlertedKey,
  runEventAudit,
  unconfirmedAlertedKey,
} from '../../../src/lib/eventAudit/run.js';
import { utcDay } from '../../../src/lib/reports/period.js';
import {
  FakeEventAuditStore,
  HANA,
  KEN,
  NOW,
  fakeDeps,
  fakeReader,
  obs,
} from './fakes.js';

const A = obs();
const B = obs({ eventId: '311000002', title: 'Hike', hosts: [KEN] });
const C = obs({ eventId: '311000003', title: 'Dinner' });

/** A store after a baseline run over A, B and C. */
async function seeded(): Promise<FakeEventAuditStore> {
  const { deps, store } = fakeDeps({
    readMeetup: fakeReader([A, B, C]).readMeetup,
  });
  await runEventAudit(deps, 'job');
  return store;
}

describe('runEventAudit', () => {
  it('the first run ever is the baseline: snapshots, no changes, no alerts', async () => {
    const { deps, store, alerts } = fakeDeps({
      readMeetup: fakeReader([A, B, C]).readMeetup,
    });
    const outcome = await runEventAudit(deps, 'job');
    expect(outcome).toMatchObject({
      ok: true,
      listed: 3,
      confirmed: 0,
      changes: 0,
      deleted: 0,
    });
    expect(store.snapshots).toHaveLength(3);
    expect(store.changes).toEqual([]);
    expect(alerts).toEqual([]);
    expect(store.runs[0]).toMatchObject({
      requestedBy: 'job',
      outcome: 'saved',
    });
    expect(store.pruned).toHaveLength(1);
  });

  it('a new event after the baseline is created, silently', async () => {
    const store = await seeded();
    const { deps, alerts } = fakeDeps({
      store: async () => store,
      readMeetup: fakeReader([A, B, C, obs({ eventId: '311000004' })])
        .readMeetup,
    });
    await runEventAudit(deps, 'job');
    expect(store.changes.map((c) => c.kind)).toEqual(['created']);
    expect(alerts).toEqual([]);
  });

  it('an event missing from the listing that Meetup says is gone is deleted, and alerted', async () => {
    const store = await seeded();
    const { reader, readMeetup } = fakeReader([A, C], { '311000002': null });
    const { deps, alerts } = fakeDeps({ store: async () => store, readMeetup });
    const outcome = await runEventAudit(deps, 'job');
    expect(outcome).toMatchObject({
      ok: true,
      confirmed: 1,
      deleted: 1,
      changes: 1,
    });
    expect(reader.getEvent).toHaveBeenCalledWith('311000002');
    expect(store.changes[0]).toMatchObject({
      kind: 'deleted',
      eventId: '311000002',
      hosts: [KEN],
      rsvpYes: 20,
    });
    expect(store.states.get('311000002')?.deletedAt).not.toBeNull();
    expect(alerts.map((a) => a.title)).toEqual(['Event deleted: Hike']);
    expect(store.changes[0].alertedAt).not.toBeNull();
  });

  it('an event missing from the listing that Meetup still has is snapshotted and diffed (cancelled here)', async () => {
    const store = await seeded();
    const { readMeetup } = fakeReader([A, C], {
      '311000002': { ...B, status: 'CANCELLED' },
    });
    const { deps, alerts } = fakeDeps({ store: async () => store, readMeetup });
    await runEventAudit(deps, 'job');
    expect(store.changes.map((c) => c.kind)).toEqual(['cancelled']);
    expect(store.states.get('311000002')).toMatchObject({
      deletedAt: null,
      latest: { status: 'CANCELLED' },
    });
    expect(alerts.map((a) => a.title)).toEqual(['Event cancelled: Hike']);
  });

  it('a confirmation that fails leaves the event alone; the run still saves', async () => {
    const store = await seeded();
    const { readMeetup } = fakeReader([A, C], {
      '311000002': new Error('502'),
    });
    const { deps } = fakeDeps({ store: async () => store, readMeetup });
    const outcome = await runEventAudit(deps, 'job');
    expect(outcome).toMatchObject({
      ok: true,
      confirmed: 1,
      deleted: 0,
      changes: 0,
    });
    expect(store.states.get('311000002')?.deletedAt).toBeNull();
    expect(store.runs).toHaveLength(2);
  });

  it('an empty listing confirms at most CONFIRM_CAP events and deletes none without a null answer', async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      obs({ eventId: String(311000100 + i) }),
    );
    const { deps: seedDeps, store } = fakeDeps({
      readMeetup: fakeReader(many).readMeetup,
    });
    await runEventAudit(seedDeps, 'job');
    const { reader, readMeetup } = fakeReader(
      [],
      Object.fromEntries(many.map((e) => [e.eventId, new Error('down')])),
    );
    const { deps } = fakeDeps({ store: async () => store, readMeetup });
    const outcome = await runEventAudit(deps, 'job');
    expect(reader.getEvent).toHaveBeenCalledTimes(CONFIRM_CAP);
    expect(outcome).toMatchObject({
      ok: true,
      confirmed: CONFIRM_CAP,
      deleted: 0,
    });
    expect([...store.states.values()].every((s) => s.deletedAt === null)).toBe(
      true,
    );
  });

  it('an event whose start has passed is not confirmed when it leaves the listing', async () => {
    const past = obs({
      eventId: '311000009',
      startAt: new Date('2026-11-10T01:00:00Z'),
    });
    const { deps: seedDeps, store } = fakeDeps({
      readMeetup: fakeReader([A, past]).readMeetup,
    });
    await runEventAudit(seedDeps, 'job');
    const { reader, readMeetup } = fakeReader([A]);
    const { deps } = fakeDeps({ store: async () => store, readMeetup });
    await runEventAudit(deps, 'job');
    expect(reader.getEvent).not.toHaveBeenCalled();
    expect(store.changes).toEqual([]);
  });

  it('too many alertable changes in one run post one summary and mark them all', async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      obs({ eventId: String(311000200 + i) }),
    );
    const { deps: seedDeps, store } = fakeDeps({
      readMeetup: fakeReader(many).readMeetup,
    });
    await runEventAudit(seedDeps, 'job');
    const { deps, alerts } = fakeDeps({
      store: async () => store,
      readMeetup: fakeReader(many.map((e) => ({ ...e, hosts: [KEN] })))
        .readMeetup,
    });
    await runEventAudit(deps, 'job');
    expect(store.changes).toHaveLength(12);
    expect(alerts.map((a) => a.title)).toEqual([
      'Event changes: 12 in one pass',
    ]);
    expect(store.changes.every((c) => c.alertedAt !== null)).toBe(true);
  });

  it('alerts are rate-limited per event and kind; a failed post is retried next run', async () => {
    const store = await seeded();
    const first = fakeDeps({
      store: async () => store,
      readMeetup: fakeReader([{ ...A, hosts: [KEN] }, B, C]).readMeetup,
    });
    await runEventAudit(first.deps, 'job');
    expect(first.alerts).toHaveLength(1);
    expect(first.cache.ttls.get(alertedKey('311000001', 'host_changed'))).toBe(
      ALERT_RATE_LIMIT_SEC,
    );
    // Hosts change back within the window: recorded, not alerted again, but marked.
    const second = fakeDeps({
      store: async () => store,
      cache: async () => first.cache,
      readMeetup: fakeReader([A, B, C]).readMeetup,
    });
    await runEventAudit(second.deps, 'job');
    expect(store.changes.map((c) => c.kind)).toEqual([
      'host_changed',
      'host_changed',
    ]);
    expect(second.alerts).toEqual([]);
    expect(store.changes[1].alertedAt).not.toBeNull();
    // A post that does not land leaves the row for the next run and frees the key.
    const third = fakeDeps({
      store: async () => store,
      readMeetup: fakeReader([A, C], { '311000002': null }).readMeetup,
    });
    third.alert.mockResolvedValueOnce(false);
    await runEventAudit(third.deps, 'job');
    const deleted = store.changes.find((c) => c.kind === 'deleted');
    expect(deleted?.alertedAt).toBeNull();
    expect(third.cache.values.has(alertedKey('311000002', 'deleted'))).toBe(
      false,
    );
    const fourth = fakeDeps({
      store: async () => store,
      cache: async () => third.cache,
      readMeetup: fakeReader([A, C]).readMeetup,
    });
    await runEventAudit(fourth.deps, 'job');
    expect(fourth.alerts.map((a) => a.title)).toEqual(['Event deleted: Hike']);
    expect(deleted?.alertedAt).not.toBeNull();
  });

  it('a failed Meetup read is a failed run: backoff, one alert a day, nothing saved', async () => {
    const store = await seeded();
    const readMeetup = async () => {
      throw new Error('socket hang up');
    };
    const { deps, cache, alerts } = fakeDeps({
      store: async () => store,
      readMeetup,
    });
    const outcome = await runEventAudit(deps, '123456789012345678');
    expect(outcome).toMatchObject({ ok: false });
    expect(store.runs.at(-1)).toMatchObject({
      outcome: 'failed',
      requestedBy: '123456789012345678',
    });
    expect(store.snapshots).toHaveLength(3);
    expect(cache.values.has(BACKOFF_KEY)).toBe(true);
    expect(cache.values.has(failedAlertedKey(utcDay(NOW)))).toBe(true);
    expect(alerts.map((a) => a.title)).toEqual(['Event snapshot failed']);
    expect(alerts[0].description).not.toContain('socket');
    await runEventAudit(deps, 'job');
    expect(alerts).toHaveLength(1);
  });

  it('a failed save is a failed run too', async () => {
    const store = await seeded();
    store.failSave = new Error('pg down');
    const { deps, alerts } = fakeDeps({
      store: async () => store,
      readMeetup: fakeReader([A, B, C]).readMeetup,
    });
    expect(await runEventAudit(deps, 'job')).toMatchObject({ ok: false });
    expect(alerts).toHaveLength(1);
    expect(store.runs.at(-1)?.outcome).toBe('failed');
  });

  it('a vanished event whose confirmation keeps failing is counted, shown and alerted once after three runs', async () => {
    const store = await seeded();
    const { readMeetup } = fakeReader([A, C], {
      '311000002': new Error('502'),
    });
    const first = fakeDeps({ store: async () => store, readMeetup });
    await runEventAudit(first.deps, 'job');
    await runEventAudit(first.deps, 'job');
    expect(store.states.get('311000002')?.unconfirmedRuns).toBe(2);
    expect(first.alerts).toEqual([]);
    await runEventAudit(first.deps, 'job');
    expect(store.states.get('311000002')?.unconfirmedRuns).toBe(
      UNCONFIRMED_ALERT_AFTER,
    );
    expect(
      await store.unconfirmable(UNCONFIRMED_ALERT_AFTER, NOW),
    ).toHaveLength(1);
    expect(first.alerts.map((a) => a.title)).toEqual([
      'Event could not be confirmed: Hike',
    ]);
    expect(first.alerts[0].description).not.toContain('502');
    expect(first.cache.values.has(unconfirmedAlertedKey('311000002'))).toBe(
      true,
    );
    await runEventAudit(first.deps, 'job');
    expect(first.alerts).toHaveLength(1);
    // Seen again: the streak resets.
    const seen = fakeDeps({
      store: async () => store,
      readMeetup: fakeReader([A, B, C]).readMeetup,
    });
    await runEventAudit(seen.deps, 'job');
    expect(store.states.get('311000002')?.unconfirmedRuns).toBe(0);
  });

  it('an empty host read keeps the last hosts: no phantom change, and a real change after it still shows', async () => {
    const store = await seeded();
    const hostless = fakeDeps({
      store: async () => store,
      readMeetup: fakeReader([{ ...A, hosts: [] }, B, C]).readMeetup,
    });
    await runEventAudit(hostless.deps, 'job');
    expect(store.states.get('311000001')?.latest.hosts).toEqual([HANA]);
    const back = fakeDeps({
      store: async () => store,
      readMeetup: fakeReader([A, B, C]).readMeetup,
    });
    await runEventAudit(back.deps, 'job');
    expect(store.changes).toEqual([]);
    expect(back.alerts).toEqual([]);
    await runEventAudit(hostless.deps, 'job');
    const moved = fakeDeps({
      store: async () => store,
      readMeetup: fakeReader([{ ...A, hosts: [KEN] }, B, C]).readMeetup,
    });
    await runEventAudit(moved.deps, 'job');
    expect(store.changes.map((c) => [c.kind, c.oldValue, c.newValue])).toEqual([
      ['host_changed', { hosts: [HANA] }, { hosts: [KEN] }],
    ]);
  });

  it('an unconfirmed event drops off the list once its start has passed', async () => {
    const soon = obs({
      eventId: '311000009',
      title: 'Soon',
      startAt: new Date(NOW.getTime() + 3 * 60 * 60_000),
    });
    const { deps: seedDeps, store } = fakeDeps({
      readMeetup: fakeReader([A, soon]).readMeetup,
    });
    await runEventAudit(seedDeps, 'job');
    const { readMeetup } = fakeReader([A], { '311000009': new Error('502') });
    const failing = fakeDeps({ store: async () => store, readMeetup });
    await runEventAudit(failing.deps, 'job');
    await runEventAudit(failing.deps, 'job');
    await runEventAudit(failing.deps, 'job');
    expect(
      await store.unconfirmable(UNCONFIRMED_ALERT_AFTER, NOW),
    ).toHaveLength(1);
    const later = new Date(NOW.getTime() + 4 * 60 * 60_000);
    expect(await store.unconfirmable(UNCONFIRMED_ALERT_AFTER, later)).toEqual(
      [],
    );
  });

  it('every call of the run reads Meetup; the hourly rule is the job (job.test.ts)', async () => {
    const store = await seeded();
    const { reader, readMeetup } = fakeReader([A, B, C]);
    const { deps } = fakeDeps({ store: async () => store, readMeetup });
    await runEventAudit(deps, 'job');
    await runEventAudit(deps, 'job');
    expect(reader.listEvents).toHaveBeenCalledTimes(2);
    expect(store.runs).toHaveLength(3);
  });

  it('a leftover unalerted change from an earlier run is alerted', async () => {
    const store = await seeded();
    await store.saveRun({
      startedAt: NOW,
      finishedAt: NOW,
      requestedBy: 'job',
      listed: 0,
      confirmed: 0,
      observations: [],
      deletedEventIds: [],
      unconfirmedEventIds: [],
      changes: [
        {
          eventId: '311000003',
          kind: 'cancelled',
          oldValue: { status: 'ACTIVE' },
          newValue: { status: 'CANCELLED' },
          title: 'Dinner',
          startAt: C.startAt,
          eventUrl: C.eventUrl,
          hosts: [HANA],
          rsvpYes: 20,
          waitlist: 2,
        },
      ],
    });
    const { deps, alerts } = fakeDeps({
      store: async () => store,
      readMeetup: fakeReader([A, B, C]).readMeetup,
    });
    await runEventAudit(deps, 'job');
    expect(alerts.map((a) => a.title)).toEqual(['Event cancelled: Dinner']);
  });
});
