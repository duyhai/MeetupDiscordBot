import { Logger } from 'tslog';

const logger = new Logger({ name: 'dashboard' });

/** A host's count is kept this long: it changes only when one of their events ends. */
export const HOSTED_COUNT_TTL_MS = 30 * 60 * 1000;
/**
 * After a failed or timed-out read, the host is not asked about again for
 * this long: during a Meetup incident each reload would otherwise spend the
 * organizer token's budget, which publishing shares.
 */
export const HOSTED_COUNT_COOLDOWN_MS = 3 * 60 * 1000;
/** How long the queue page waits for the counts it does not have yet. */
export const HOSTED_COUNT_BUDGET_MS = 3_000;
/**
 * A read still running after this gives up its concurrency slot (and the
 * host cools down), so a hung read never blocks other hosts. The host stays
 * in flight until the read itself settles, so it is never read twice at once.
 */
export const HOSTED_COUNT_READ_TIMEOUT_MS = 60_000;
/** The most hosts one page asks Meetup about; the rest show no count. */
export const HOSTED_COUNT_MAX_HOSTS = 25;
/** Meetup reads at once for the whole cache (every page, every leader). */
export const HOSTED_COUNT_CONCURRENCY = 4;

export interface HostedCountOptions {
  now?: () => number;
  ttlMs?: number;
  cooldownMs?: number;
  budgetMs?: number;
  readTimeoutMs?: number;
  maxHosts?: number;
  concurrency?: number;
  /** True for an error meaning Meetup is rate limiting: the whole cache pauses for `cooldownMs`. */
  isRateLimit?: (error: unknown) => boolean;
}

/**
 * A 429 from the Meetup client. A numeric status (the error's, or its
 * response's) decides; the message is read only when there is none, since a
 * client error's message embeds Meetup's response body and a 500 may quote
 * "429" or "rate limit".
 */
export function looksRateLimited(error: unknown): boolean {
  const e = error as
    { status?: unknown; response?: { status?: unknown } } | undefined;
  const status =
    typeof e?.status === 'number'
      ? e.status
      : typeof e?.response?.status === 'number'
        ? e.response.status
        : undefined;
  if (status !== undefined) {
    return status === 429;
  }
  return (
    error instanceof Error &&
    /\b429\b|rate.?limit|too many requests/i.test(error.message)
  );
}

type Entry =
  | { kind: 'count'; at: number; count: number }
  | { kind: 'cooling'; at: number };

/**
 * The queue cards' "hosted before" counts (the number the Discord request
 * post shows: countHostedEvents, PAST events only), from one Meetup listing
 * per host.
 *
 * - A count is kept per host for `ttlMs`. A failed, malformed or timed-out
 *   read marks the host as cooling down for `cooldownMs`: not read again,
 *   no count shown. Expired entries are evicted when looked at.
 * - A page asks for the hosts on its cards and gets, after `budgetMs` at
 *   most, the counts there are; reads still running finish into the cache.
 * - At most `concurrency` reads hold a slot at once, across every call. A
 *   host is read once at a time and stays in flight until its read settles;
 *   a read past `readTimeoutMs` frees its slot and its late result is
 *   dropped.
 * - A rate-limit error cools that host and pauses the whole cache for
 *   `cooldownMs`: queued reads are dropped and no new ones start, so a
 *   sustained rate limit costs no Meetup calls per reload.
 *
 * The returned function never rejects, whatever `read` does.
 */
export function cachedHostedCounts(
  read: (meetupMemberId: string) => Promise<number>,
  options: HostedCountOptions = {},
): (meetupMemberIds: string[]) => Promise<Map<string, number>> {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? HOSTED_COUNT_TTL_MS;
  const cooldownMs = options.cooldownMs ?? HOSTED_COUNT_COOLDOWN_MS;
  const budgetMs = options.budgetMs ?? HOSTED_COUNT_BUDGET_MS;
  const readTimeoutMs = options.readTimeoutMs ?? HOSTED_COUNT_READ_TIMEOUT_MS;
  const maxHosts = options.maxHosts ?? HOSTED_COUNT_MAX_HOSTS;
  const concurrency = options.concurrency ?? HOSTED_COUNT_CONCURRENCY;
  const isRateLimit = options.isRateLimit ?? looksRateLimited;

  const entries = new Map<string, Entry>();
  /** Hosts whose read has not settled (including ones past the timeout). */
  const inFlight = new Set<string>();
  /** In-flight hosts past their timeout: nobody waits on them again. */
  const overdue = new Set<string>();
  /** Hosts waiting for a slot, in order. */
  const queue: string[] = [];
  const queued = new Set<string>();
  /** Reads holding a slot. */
  let running = 0;
  /** No read starts before this (a rate limit was hit). */
  let pausedUntil = 0;
  const paused = () => now() < pausedUntil;
  /** Callers waiting on a host: answered when its read settles, times out or is skipped. */
  const waiters = new Map<string, (() => void)[]>();

  // Eviction is lazy (on lookup): the map holds at most the hosts the queue
  // has shown, a few hundred entries, so no sweep is needed.
  const entryOf = (id: string): Entry | undefined => {
    const entry = entries.get(id);
    if (entry === undefined) {
      return undefined;
    }
    const life = entry.kind === 'count' ? ttlMs : cooldownMs;
    if (now() - entry.at < life) {
      return entry;
    }
    entries.delete(id);
    return undefined;
  };

  const wake = (id: string) => {
    const list = waiters.get(id);
    waiters.delete(id);
    for (const resolve of list ?? []) {
      resolve();
    }
  };
  const waitFor = (id: string) =>
    new Promise<void>((resolve) => {
      waiters.set(id, [...(waiters.get(id) ?? []), resolve]);
    });

  const cool = (id: string) => entries.set(id, { kind: 'cooling', at: now() });

  function pump(): void {
    while (running < concurrency && queue.length > 0) {
      const id = queue.shift();
      if (id === undefined) {
        return;
      }
      queued.delete(id);
      if (paused()) {
        wake(id);
      } else {
        start(id);
      }
    }
  }

  // A read that never settles keeps its host in flight (and unread) for
  // good; it gives up its slot at the timeout, so only that host is affected.
  function start(id: string): void {
    running++;
    inFlight.add(id);
    let holdsSlot = true;
    let timedOut = false;
    const freeSlot = () => {
      if (holdsSlot) {
        holdsSlot = false;
        running--;
        pump();
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      overdue.add(id);
      cool(id);
      logger.warn('Hosted count read timed out');
      wake(id);
      freeSlot();
    }, readTimeoutMs);
    timer.unref();
    Promise.resolve()
      .then(() => read(id))
      .then(
        (count) => {
          if (timedOut) {
            return;
          }
          if (Number.isInteger(count) && count >= 0) {
            entries.set(id, { kind: 'count', at: now(), count });
          } else {
            cool(id);
          }
        },
        (error: unknown) => {
          if (!timedOut) {
            cool(id);
          }
          if (isRateLimit(error)) {
            cool(id);
            pausedUntil = now() + cooldownMs;
          }
          logger.warn(
            `Hosted count read failed: ${error instanceof Error ? error.name : 'Error'}`,
          );
        },
      )
      .finally(() => {
        clearTimeout(timer);
        inFlight.delete(id);
        overdue.delete(id);
        wake(id);
        freeSlot();
      })
      .catch(() => undefined);
  }

  return async (meetupMemberIds) => {
    try {
      const ids = [...new Set(meetupMemberIds)].slice(0, maxHosts);
      const waits: Promise<void>[] = [];
      for (const id of ids) {
        if (paused()) {
          break;
        }
        if (entryOf(id) !== undefined) {
          continue;
        }
        if (overdue.has(id)) {
          continue;
        }
        if (!inFlight.has(id) && !queued.has(id)) {
          queued.add(id);
          queue.push(id);
        }
        waits.push(waitFor(id));
      }
      pump();
      if (waits.length > 0) {
        let timer: NodeJS.Timeout | undefined;
        const budget = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, budgetMs);
          timer.unref();
        });
        await Promise.race([Promise.all(waits), budget]).finally(() =>
          clearTimeout(timer),
        );
      }
      const out = new Map<string, number>();
      for (const id of ids) {
        const entry = entryOf(id);
        if (entry?.kind === 'count') {
          out.set(id, entry.count);
        }
      }
      return out;
    } catch (error: unknown) {
      logger.warn(
        `Hosted counts failed: ${error instanceof Error ? error.name : 'Error'}`,
      );
      return new Map();
    }
  };
}
