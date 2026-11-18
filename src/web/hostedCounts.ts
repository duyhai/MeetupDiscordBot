import { Logger } from 'tslog';

const logger = new Logger({ name: 'dashboard' });

/** A host's count is kept this long: it changes only when one of their events ends. */
export const HOSTED_COUNT_TTL_MS = 30 * 60 * 1000;
/** How long the queue page waits for the counts it does not have yet. */
export const HOSTED_COUNT_BUDGET_MS = 3_000;
/** A Meetup read still running after this is dropped, so a hung read never pins a host. */
export const HOSTED_COUNT_READ_TIMEOUT_MS = 60_000;
/** The most hosts one page asks Meetup about; the rest show no count. */
export const HOSTED_COUNT_MAX_HOSTS = 25;
/** Meetup reads at once, per page. */
const CONCURRENCY = 4;

export interface HostedCountOptions {
  now?: () => number;
  ttlMs?: number;
  budgetMs?: number;
  readTimeoutMs?: number;
  maxHosts?: number;
}

/**
 * The queue cards' "hosted before" counts (the number the Discord request
 * post shows: countHostedEvents, PAST events only), from one Meetup listing
 * per host. Kept per host for `ttlMs` in memory; a page asks for the hosts
 * on its cards and gets, after `budgetMs` at most, the counts it has (a
 * host still being read is absent, and its read runs on into the cache for
 * the next load). Reads are shared between pages, at most CONCURRENCY at a
 * time per call, and never reject: a failure is logged and the host is
 * absent. The returned function never rejects either.
 */
export function cachedHostedCounts(
  read: (meetupMemberId: string) => Promise<number>,
  options: HostedCountOptions = {},
): (meetupMemberIds: string[]) => Promise<Map<string, number>> {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? HOSTED_COUNT_TTL_MS;
  const budgetMs = options.budgetMs ?? HOSTED_COUNT_BUDGET_MS;
  const readTimeoutMs = options.readTimeoutMs ?? HOSTED_COUNT_READ_TIMEOUT_MS;
  const maxHosts = options.maxHosts ?? HOSTED_COUNT_MAX_HOSTS;
  const kept = new Map<string, { at: number; count: number }>();
  const inFlight = new Map<string, Promise<void>>();

  const fresh = (id: string) => {
    const hit = kept.get(id);
    return hit !== undefined && now() - hit.at < ttlMs ? hit : undefined;
  };

  /** One host's read, shared while it runs; settles (never rejects) within readTimeoutMs. */
  const readOne = (id: string): Promise<void> => {
    const running = inFlight.get(id);
    if (running !== undefined) {
      return running;
    }
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const reading = read(id).then(
      (count) => {
        if (!timedOut && Number.isInteger(count) && count >= 0) {
          kept.set(id, { at: now(), count });
        }
      },
      (error: unknown) => {
        logger.warn(
          `Hosted count read failed: ${error instanceof Error ? error.name : 'Error'}`,
        );
      },
    );
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, readTimeoutMs);
      timer.unref();
    });
    const settled = Promise.race([reading, limit]).finally(() => {
      clearTimeout(timer);
      inFlight.delete(id);
    });
    inFlight.set(id, settled);
    return settled;
  };

  return async (meetupMemberIds) => {
    const ids = [...new Set(meetupMemberIds)].slice(0, maxHosts);
    const missing = ids.filter((id) => fresh(id) === undefined);
    if (missing.length > 0) {
      // A small pool: each worker takes the next host when its last is done.
      let next = 0;
      const worker = (): Promise<void> => {
        if (next >= missing.length) {
          return Promise.resolve();
        }
        return readOne(missing[next++]).then(worker);
      };
      const all = Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, missing.length) }, worker),
      );
      let timer: NodeJS.Timeout | undefined;
      const budget = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, budgetMs);
        timer.unref();
      });
      await Promise.race([all, budget]).finally(() => clearTimeout(timer));
    }
    const out = new Map<string, number>();
    for (const id of ids) {
      const hit = fresh(id);
      if (hit !== undefined) {
        out.set(id, hit.count);
      }
    }
    return out;
  };
}
