import { vi } from 'vitest';

import {
  AuditMeetupReader,
  ReadMeetup,
} from '../../../src/lib/eventAudit/meetup.js';
import {
  EventAuditDeps,
  EventAuditStore,
} from '../../../src/lib/eventAudit/run.js';
import {
  EventChange,
  EventChangeKind,
  EventObservation,
  EventSnapshot,
} from '../../../src/lib/eventAudit/types.js';
import { LogEntry } from '../../../src/lib/helpers/discordLogger.js';
import {
  ChangeFilter,
  EventAuditRun,
  EventHistory,
  EventState,
  RunWrite,
} from '../../../src/lib/repositories/postgresEventAuditRepository.js';
import { FakeCache } from '../../web/fakeCache.js';

export const NOW = new Date('2026-11-10T18:00:00Z');
export const START = new Date('2026-12-06T03:00:00Z');
export const HANA = { id: '4242', name: 'Hana' };
export const KEN = { id: '5151', name: 'Ken' };

export const obs = (
  overrides: Partial<EventObservation> = {},
): EventObservation => ({
  eventId: '311000001',
  title: 'Board games',
  status: 'ACTIVE',
  startAt: START,
  duration: 'PT2H',
  eventUrl: 'https://www.meetup.com/g/events/311000001/',
  venueId: '27',
  photoId: null,
  hosts: [HANA],
  rsvpYes: 20,
  waitlist: 2,
  rsvpsClosed: false,
  lastEditedAt: null,
  ...overrides,
});

/** In-memory store with the repository's semantics the run relies on. */
export class FakeEventAuditStore implements EventAuditStore {
  runs: EventAuditRun[] = [];

  snapshots: EventSnapshot[] = [];

  states = new Map<string, EventState>();

  changes: EventChange[] = [];

  pruned: Date[] = [];

  private nextId = 1;

  /** Rejects saveRun when set. */
  failSave: Error | undefined;

  async latestRun(): Promise<EventAuditRun | undefined> {
    return [...this.runs].sort(
      (a, b) => b.startedAt.getTime() - a.startedAt.getTime(),
    )[0];
  }

  async latestSavedRun(): Promise<EventAuditRun | undefined> {
    return [...this.runs]
      .filter((r) => r.outcome === 'saved')
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
  }

  async hasAnyState(): Promise<boolean> {
    return this.states.size > 0;
  }

  async liveStates(): Promise<EventState[]> {
    return [...this.states.values()].filter((s) => s.deletedAt === null);
  }

  async saveRun(
    write: RunWrite,
  ): Promise<{ runId: number; changes: EventChange[] }> {
    if (this.failSave) {
      throw this.failSave;
    }
    const runId = this.nextId++;
    this.runs.push({
      id: runId,
      startedAt: write.startedAt,
      finishedAt: write.finishedAt,
      requestedBy: write.requestedBy,
      listed: write.listed,
      confirmed: write.confirmed,
      changes: write.changes.length,
      outcome: 'saved',
    });
    for (const o of write.observations) {
      const snapshot: EventSnapshot = {
        ...o,
        id: this.nextId++,
        runId,
        takenAt: write.startedAt,
      };
      this.snapshots.push(snapshot);
      const state = this.states.get(o.eventId);
      this.states.set(o.eventId, {
        eventId: o.eventId,
        latest: snapshot,
        firstSeenAt: state?.firstSeenAt ?? write.startedAt,
        lastSeenAt: write.startedAt,
        deletedAt: null,
      });
    }
    for (const id of write.deletedEventIds) {
      const state = this.states.get(id);
      if (state && state.deletedAt === null) {
        state.deletedAt = write.finishedAt;
      }
    }
    const changes = write.changes.map((c): EventChange => ({
      ...c,
      id: this.nextId++,
      runId,
      detectedAt: write.finishedAt,
      actor: null,
      alertedAt: null,
    }));
    this.changes.push(...changes);
    return { runId, changes };
  }

  async recordFailedRun(
    startedAt: Date,
    finishedAt: Date,
    requestedBy: string,
  ): Promise<void> {
    this.runs.push({
      id: this.nextId++,
      startedAt,
      finishedAt,
      requestedBy,
      listed: null,
      confirmed: null,
      changes: null,
      outcome: 'failed',
    });
  }

  async unalerted(
    kinds: EventChangeKind[],
    limit = 50,
  ): Promise<EventChange[]> {
    return this.changes
      .filter((c) => c.alertedAt === null && kinds.includes(c.kind))
      .slice(0, limit);
  }

  async markAlerted(ids: number[], at: Date): Promise<void> {
    for (const c of this.changes) {
      if (ids.includes(c.id) && c.alertedAt === null) {
        c.alertedAt = at;
      }
    }
  }

  async prune(
    now: Date,
  ): Promise<{ snapshots: number; changes: number; states: number }> {
    this.pruned.push(now);
    return { snapshots: 0, changes: 0, states: 0 };
  }

  async listChanges(filter: ChangeFilter, limit = 50): Promise<EventChange[]> {
    return [...this.changes]
      .reverse()
      .filter((c) => filter.kind === undefined || c.kind === filter.kind)
      .filter(
        (c) =>
          filter.hostId === undefined ||
          c.hosts.some((h) => h.id === filter.hostId),
      )
      .filter((c) => filter.from === undefined || c.detectedAt >= filter.from)
      .filter((c) => filter.to === undefined || c.detectedAt < filter.to)
      .filter((c) => filter.beforeId === undefined || c.id < filter.beforeId)
      .slice(0, limit);
  }

  async eventHistory(eventId: string): Promise<EventHistory | undefined> {
    const state = this.states.get(eventId);
    if (!state) {
      return undefined;
    }
    return {
      state,
      changes: [...this.changes].reverse().filter((c) => c.eventId === eventId),
      snapshots: [...this.snapshots]
        .reverse()
        .filter((s) => s.eventId === eventId),
    };
  }
}

/**
 * A reader over fixed lists: `listed` is what the listing returns; `byId`
 * answers getEvent (an Error value throws; absent is null).
 */
export function fakeReader(
  listed: EventObservation[],
  byId: Record<string, EventObservation | null | Error> = {},
  options: { fallback?: boolean } = {},
) {
  const reader = {
    listEvents: vi.fn(async () => listed),
    getEvent: vi.fn(async (id: string) => {
      const answer = byId[id] ?? null;
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
    }),
    usingFallback: () => options.fallback ?? false,
  } satisfies AuditMeetupReader;
  const readMeetup: ReadMeetup = (fn) => fn(reader);
  return { reader, readMeetup };
}

export function fakeDeps(
  overrides: Partial<EventAuditDeps> & {
    store?: () => Promise<EventAuditStore>;
  } = {},
) {
  const cache = new FakeCache();
  const store = new FakeEventAuditStore();
  const alerts: LogEntry[] = [];
  const alert = vi.fn(async (entry: LogEntry) => {
    alerts.push(entry);
    return true;
  });
  let tick = 0;
  const deps: EventAuditDeps = {
    now: () => new Date(NOW.getTime() + tick++ * 1000),
    cache: async () => cache,
    store: async () => store,
    readMeetup: fakeReader([]).readMeetup,
    alert,
    newLeaseValue: () => 'lease-1',
    ...overrides,
  };
  return { deps, cache, store, alerts, alert };
}
