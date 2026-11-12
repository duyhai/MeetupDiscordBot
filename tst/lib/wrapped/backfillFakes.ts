import {
  BackfillRun,
  QueueRow,
  RunDelta,
  WrappedBackfillStore,
} from '../../../src/lib/repositories/postgresWrappedBackfillRepository.js';
import { WrappedEntryStore } from '../../../src/lib/repositories/postgresWrappedEntryRepository.js';
import { CachedWrapped } from '../../../src/lib/wrapped/cache.js';

/**
 * The repository's contract in memory: one open run at a time, a cursor
 * that is a compare-and-set, a queue with one row per member, oldest first,
 * claims that go stale. `clock` stands in for the database clock.
 */
export class FakeBackfillStore implements WrappedBackfillStore {
  clock: () => number;

  readonly runs: BackfillRun[] = [];

  readonly queue = new Map<
    string,
    QueueRow & { claimedAt: number | undefined }
  >();

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  async openRun(): Promise<BackfillRun | undefined> {
    return this.runs.find((run) => run.finishedAt === undefined);
  }

  async lastFinishedRun(): Promise<BackfillRun | undefined> {
    return [...this.runs]
      .filter((run) => run.finishedAt !== undefined)
      .sort((a, b) => b.finishedAt.getTime() - a.finishedAt.getTime())[0];
  }

  async startRun(
    trigger: string,
    membersTotal: number,
  ): Promise<BackfillRun | undefined> {
    if (await this.openRun()) {
      return undefined;
    }
    const run: BackfillRun = {
      id: this.runs.length + 1,
      trigger,
      startedAt: new Date(this.clock()),
      finishedAt: undefined,
      membersTotal,
      membersDone: 0,
      built: 0,
      skipped: 0,
      failed: 0,
      requests: 0,
      cursor: undefined,
    };
    this.runs.push(run);
    return { ...run };
  }

  async advanceRun(
    id: number,
    from: string | undefined,
    to: string,
    delta: RunDelta,
  ): Promise<boolean> {
    const run = this.runs.find((r) => r.id === id);
    if (!run || run.finishedAt !== undefined || run.cursor !== from) {
      return false;
    }
    run.cursor = to;
    run.membersDone += delta.done;
    run.built += delta.built;
    run.skipped += delta.skipped;
    run.failed += delta.failed;
    return true;
  }

  /** Deferred Discord ids per run. */
  readonly deferred = new Map<number, Set<string>>();

  async deferMember(
    id: number,
    from: string | undefined,
    to: string,
  ): Promise<boolean> {
    const run = this.runs.find((r) => r.id === id);
    if (!run || run.finishedAt !== undefined || run.cursor !== from) {
      return false;
    }
    run.cursor = to;
    const set = this.deferred.get(id) ?? new Set<string>();
    set.add(to);
    this.deferred.set(id, set);
    return true;
  }

  async nextDeferred(id: number, limit: number): Promise<string[]> {
    return [...(this.deferred.get(id) ?? [])].sort().slice(0, limit);
  }

  async completeDeferred(
    id: number,
    discordUserId: string,
    delta: RunDelta,
  ): Promise<boolean> {
    const run = this.runs.find((r) => r.id === id);
    const set = this.deferred.get(id);
    if (!run || run.finishedAt !== undefined || !set?.delete(discordUserId)) {
      return false;
    }
    run.membersDone += delta.done;
    run.built += delta.built;
    run.skipped += delta.skipped;
    run.failed += delta.failed;
    return true;
  }

  async deferredCount(id: number): Promise<number> {
    return this.deferred.get(id)?.size ?? 0;
  }

  async recordRequests(id: number, calls: number): Promise<void> {
    const run = this.runs.find((r) => r.id === id);
    if (run) {
      run.requests += calls;
    }
  }

  async finishRun(id: number): Promise<BackfillRun | undefined> {
    const run = this.runs.find((r) => r.id === id);
    if (!run || run.finishedAt !== undefined) {
      return undefined;
    }
    run.finishedAt = new Date(this.clock());
    return { ...run };
  }

  async enqueue(row: {
    discordUserId: string;
    meetupId: string;
    year: number;
  }): Promise<'queued' | { already: number }> {
    const existing = this.queue.get(row.discordUserId);
    if (existing) {
      return { already: existing.year };
    }
    this.queue.set(row.discordUserId, {
      ...row,
      queuedAt: new Date(this.clock()),
      attempts: 0,
      claimedAt: undefined,
    });
    return 'queued';
  }

  private ordered(): (QueueRow & { claimedAt: number | undefined })[] {
    return [...this.queue.values()].sort(
      (a, b) =>
        a.queuedAt.getTime() - b.queuedAt.getTime() ||
        a.discordUserId.localeCompare(b.discordUserId),
    );
  }

  async position(
    discordUserId: string,
  ): Promise<{ position: number; row: QueueRow } | undefined> {
    const index = this.ordered().findIndex(
      (row) => row.discordUserId === discordUserId,
    );
    if (index < 0) {
      return undefined;
    }
    const { claimedAt: _claimedAt, ...row } = this.ordered()[index];
    return { position: index + 1, row };
  }

  async queueLength(): Promise<number> {
    return this.queue.size;
  }

  async claimNext(limit: number, staleMs: number): Promise<QueueRow[]> {
    const now = this.clock();
    const taken = this.ordered()
      .filter(
        (row) => row.claimedAt === undefined || row.claimedAt < now - staleMs,
      )
      .slice(0, limit);
    return taken.map((row) => {
      row.claimedAt = now;
      const { claimedAt: _claimedAt, ...plain } = row;
      return plain;
    });
  }

  async complete(discordUserId: string, year?: number): Promise<void> {
    const row = this.queue.get(discordUserId);
    if (row && (year === undefined || row.year === year)) {
      this.queue.delete(discordUserId);
    }
  }

  async unclaim(discordUserId: string): Promise<void> {
    const row = this.queue.get(discordUserId);
    if (row) {
      row.claimedAt = undefined;
    }
  }

  async release(
    discordUserId: string,
    maxAttempts: number,
  ): Promise<'released' | 'dropped'> {
    const row = this.queue.get(discordUserId);
    if (!row) {
      return 'dropped';
    }
    row.attempts += 1;
    row.claimedAt = undefined;
    if (row.attempts >= maxAttempts) {
      this.queue.delete(discordUserId);
      return 'dropped';
    }
    return 'released';
  }
}

/** The entry table in memory: one row per member and year, the member's meetup id beside it. */
export class FakeEntryStore implements WrappedEntryStore {
  readonly rows = new Map<
    string,
    { meetupId: string; wrapped: CachedWrapped; builtAt: Date }
  >();

  readonly puts: { discordUserId: string; year: number }[] = [];

  private key(discordUserId: string, year: number): string {
    return `${discordUserId}:${year}`;
  }

  async get(
    discordUserId: string,
    year: number,
  ): Promise<CachedWrapped | undefined> {
    return this.rows.get(this.key(discordUserId, year))?.wrapped;
  }

  async put(
    discordUserId: string,
    year: number,
    wrapped: CachedWrapped,
    builtAt: Date,
  ): Promise<void> {
    for (const [key, row] of this.rows) {
      if (
        key.startsWith(`${discordUserId}:`) &&
        row.meetupId !== wrapped.meetupId
      ) {
        this.rows.delete(key);
      }
    }
    this.rows.set(this.key(discordUserId, year), {
      meetupId: wrapped.meetupId,
      wrapped,
      builtAt,
    });
    this.puts.push({ discordUserId, year });
  }

  async count(): Promise<number> {
    return this.rows.size;
  }
}
