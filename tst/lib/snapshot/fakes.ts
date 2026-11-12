import { EventSummary } from '../../../src/lib/client/meetup/types.js';
import {
  RsvpWork,
  RsvpWorkQuery,
  SnapshotDelta,
  SnapshotKind,
  SnapshotReader,
  SnapshotRun,
  SnapshotStore,
} from '../../../src/lib/repositories/postgresSnapshotRepository.js';
import { HostedEvent } from '../../../src/lib/wrapped/stats.js';
import {
  SnapshotEvent,
  SnapshotRsvp,
} from '../../../src/lib/snapshot/meetup.js';

export interface StoredEvent extends SnapshotEvent {
  listedAt: Date;
  rsvpsFetchedAt: Date | undefined;
  deletedAt: Date | undefined;
  rsvpFailures: number;
  rsvpFailedAt: Date | undefined;
  rsvpError: string | undefined;
  rsvpsHidden: boolean;
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
        rsvpFailures: previous?.rsvpFailures ?? 0,
        rsvpFailedAt: previous?.rsvpFailedAt,
        rsvpError: previous?.rsvpError,
        rsvpsHidden: previous?.rsvpsHidden ?? false,
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
          (e.rsvpFailedAt === undefined || e.rsvpFailedAt < q.runStartedAt) &&
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
    q: RsvpWorkQuery & { limit: number },
  ): Promise<RsvpWork[]> {
    return this.needs(q)
      .slice(0, q.limit)
      .map((e) => ({
        eventId: e.eventId,
        dateTime: e.dateTime,
        yesCount: e.yesCount,
        lastError: e.rsvpError,
      }));
  }

  async recordRsvpFailure(
    eventId: string,
    errorName: string,
    at: Date,
  ): Promise<void> {
    const e = this.events.get(eventId);
    if (e) {
      e.rsvpFailures += 1;
      e.rsvpFailedAt = at;
      e.rsvpError = errorName;
    }
  }

  async failingEventCount(): Promise<number> {
    return [...this.events.values()].filter(
      (e) => e.rsvpFailures > 0 && !e.deletedAt,
    ).length;
  }

  async pendingRsvpCount(q: RsvpWorkQuery): Promise<number> {
    return this.needs(q).length;
  }

  async hiddenEventCount(): Promise<number> {
    return [...this.events.values()].filter(
      (e) => e.rsvpsHidden && !e.deletedAt,
    ).length;
  }

  async replaceRsvps(
    eventId: string,
    rsvps: SnapshotRsvp[],
    fetchedAt: Date,
    options: { hidden?: boolean } = {},
  ): Promise<void> {
    this.replaced.push(eventId);
    this.rsvps.set(eventId, [...rsvps]);
    const e = this.events.get(eventId);
    if (e) {
      e.rsvpsFetchedAt = fetchedAt;
      e.rsvpFailures = 0;
      e.rsvpFailedAt = undefined;
      e.rsvpError = undefined;
      e.rsvpsHidden = options.hidden === true;
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

  async recordError(
    runId: number,
    errorName: string | undefined,
  ): Promise<void> {
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

/** A SnapshotReader over plain data: events with their YES/ATTENDED attendee ids. */
export class FakeSnapshotReader implements SnapshotReader {
  ready = true;

  failing: Error | undefined;

  finishedAt: Date | undefined = new Date('2026-11-12T06:00:00Z');

  attendeeReads = 0;

  constructor(
    readonly events: (EventSummary & { hosts?: string[] })[],
    readonly attendees: Record<string, string[]>,
  ) {}

  private check(): void {
    if (this.failing) {
      throw this.failing;
    }
  }

  async isReady(): Promise<boolean> {
    this.check();
    return this.ready;
  }

  async updatedAt(): Promise<Date | undefined> {
    this.check();
    return this.finishedAt;
  }

  async memberEvents(meetupId: string): Promise<EventSummary[]> {
    this.check();
    return this.events
      .filter((e) => (this.attendees[e.id] ?? []).includes(meetupId))
      .map(({ hosts: _hosts, ...e }) => e);
  }

  async hostedEvents(meetupId: string): Promise<HostedEvent[]> {
    this.check();
    return this.events
      .filter((e) => (e.hosts ?? []).includes(meetupId))
      .map(({ hosts: _hosts, ...e }) => ({
        ...e,
        attendance: (this.attendees[e.id] ?? []).length,
      }));
  }

  readonly flagged = new Map<string, { snapshot: number; self: number }>();

  async isFlagged(meetupId: string): Promise<boolean> {
    this.check();
    return this.flagged.has(meetupId);
  }

  async flagUndercounted(
    meetupId: string,
    snapshotCount: number,
    selfCount: number,
  ): Promise<void> {
    this.flagged.set(meetupId, { snapshot: snapshotCount, self: selfCount });
  }

  async clearFlag(meetupId: string): Promise<void> {
    this.flagged.delete(meetupId);
  }

  async attendeesOf(eventIds: string[]): Promise<Record<string, string[]>> {
    this.check();
    this.attendeeReads += 1;
    return Object.fromEntries(
      eventIds.map((id) => [id, [...(this.attendees[id] ?? [])]]),
    );
  }
}
