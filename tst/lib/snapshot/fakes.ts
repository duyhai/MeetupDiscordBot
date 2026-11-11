import {
  RsvpWorkQuery,
  SnapshotDelta,
  SnapshotKind,
  SnapshotRun,
  SnapshotStore,
} from '../../../src/lib/repositories/postgresSnapshotRepository.js';
import {
  SnapshotEvent,
  SnapshotRsvp,
} from '../../../src/lib/snapshot/meetup.js';

export interface StoredEvent extends SnapshotEvent {
  listedAt: Date;
  rsvpsFetchedAt: Date | undefined;
  deletedAt: Date | undefined;
}

const DAY_MS = 24 * 60 * 60_000;

/** The repository's contract in memory (the integration test pins the SQL). */
export class FakeSnapshotStore implements SnapshotStore {
  readonly runs: SnapshotRun[] = [];

  readonly events = new Map<string, StoredEvent>();

  readonly rsvps = new Map<string, SnapshotRsvp[]>();

  /** event_audit_state.deleted_at, by event id. */
  readonly auditDeleted = new Map<string, Date>();

  /** Every replaceRsvps call, in order. */
  readonly replaced: string[] = [];

  constructor(private readonly clock: () => Date) {}

  async openRun(): Promise<SnapshotRun | undefined> {
    const run = this.runs.find((r) => r.finishedAt === undefined);
    return run ? { ...run } : undefined;
  }

  async lastFinishedRun(): Promise<SnapshotRun | undefined> {
    const run = [...this.runs]
      .filter((r) => r.finishedAt !== undefined)
      .sort((a, b) => b.finishedAt.getTime() - a.finishedAt.getTime())[0];
    return run ? { ...run } : undefined;
  }

  async hasFinishedFull(): Promise<boolean> {
    return this.runs.some((r) => r.kind === 'full' && r.finishedAt);
  }

  async startRun(
    trigger: string,
    kind: SnapshotKind,
  ): Promise<SnapshotRun | undefined> {
    if (await this.openRun()) {
      return undefined;
    }
    const run: SnapshotRun = {
      id: this.runs.length + 1,
      trigger,
      kind,
      startedAt: this.clock(),
      finishedAt: undefined,
      listedAt: undefined,
      eventsListed: 0,
      eventsFetched: 0,
      rsvpsStored: 0,
      failed: 0,
      requests: 0,
      lastError: undefined,
    };
    this.runs.push(run);
    return { ...run };
  }

  private run(id: number): SnapshotRun {
    const run = this.runs.find((r) => r.id === id);
    if (!run) {
      throw new Error(`no run ${id}`);
    }
    return run;
  }

  async pastEventCount(): Promise<number> {
    return [...this.events.values()].filter(
      (e) => e.status === 'PAST' && !e.deletedAt,
    ).length;
  }

  async upsertEvents(events: SnapshotEvent[], listedAt: Date): Promise<void> {
    events.forEach((e) => {
      const previous = this.events.get(e.eventId);
      this.events.set(e.eventId, {
        ...e,
        listedAt,
        rsvpsFetchedAt: previous?.rsvpsFetchedAt,
        deletedAt: undefined,
      });
    });
  }

  async markDelisted(before: Date, at: Date): Promise<number> {
    let n = 0;
    this.events.forEach((e) => {
      if (!e.deletedAt && e.status !== 'ACTIVE' && e.listedAt < before) {
        e.deletedAt = at;
        n += 1;
      }
    });
    return n;
  }

  async markAuditDeletions(): Promise<number> {
    let n = 0;
    this.auditDeleted.forEach((at, id) => {
      const e = this.events.get(id);
      if (e && !e.deletedAt) {
        e.deletedAt = at;
        n += 1;
      }
    });
    return n;
  }

  async markDeleted(eventId: string, at: Date): Promise<void> {
    const e = this.events.get(eventId);
    if (e && !e.deletedAt) {
      e.deletedAt = at;
    }
  }

  async markListed(
    runId: number,
    listedAt: Date,
    eventsListed: number,
  ): Promise<void> {
    Object.assign(this.run(runId), { listedAt, eventsListed });
  }

  private needs(q: RsvpWorkQuery): StoredEvent[] {
    return [...this.events.values()]
      .filter(
        (e) =>
          !e.deletedAt &&
          e.status === 'PAST' &&
          e.dateTime <= q.now &&
          (e.rsvpsFetchedAt === undefined ||
            e.rsvpsFetchedAt < e.dateTime ||
            (e.dateTime.getTime() > q.now.getTime() - q.settleDays * DAY_MS &&
              e.rsvpsFetchedAt < q.runStartedAt)),
      )
      .sort(
        (a, b) =>
          a.dateTime.getTime() - b.dateTime.getTime() ||
          a.eventId.localeCompare(b.eventId),
      );
  }

  async eventsNeedingRsvps(
    q: RsvpWorkQuery & { limit: number; skip: string[] },
  ): Promise<{ eventId: string; dateTime: Date }[]> {
    return this.needs(q)
      .filter((e) => !q.skip.includes(e.eventId))
      .slice(0, q.limit)
      .map((e) => ({ eventId: e.eventId, dateTime: e.dateTime }));
  }

  async pendingRsvpCount(q: RsvpWorkQuery): Promise<number> {
    return this.needs(q).length;
  }

  async replaceRsvps(
    eventId: string,
    rsvps: SnapshotRsvp[],
    fetchedAt: Date,
  ): Promise<void> {
    this.replaced.push(eventId);
    this.rsvps.set(eventId, [...rsvps]);
    const e = this.events.get(eventId);
    if (e) {
      e.rsvpsFetchedAt = fetchedAt;
    }
  }

  async advance(runId: number, delta: SnapshotDelta): Promise<void> {
    const run = this.run(runId);
    run.eventsFetched += delta.eventsFetched;
    run.rsvpsStored += delta.rsvpsStored;
    run.failed += delta.failed;
  }

  async recordRequests(runId: number, calls: number): Promise<void> {
    this.run(runId).requests += calls;
  }

  async recordError(runId: number, errorName: string): Promise<void> {
    this.run(runId).lastError = errorName;
  }

  async finishRun(runId: number): Promise<SnapshotRun | undefined> {
    const run = this.run(runId);
    if (run.finishedAt) {
      return undefined;
    }
    run.finishedAt = this.clock();
    return { ...run };
  }

  async totals(): Promise<{ events: number; rsvps: number }> {
    return {
      events: this.events.size,
      rsvps: [...this.rsvps.values()].reduce((n, r) => n + r.length, 0),
    };
  }
}
