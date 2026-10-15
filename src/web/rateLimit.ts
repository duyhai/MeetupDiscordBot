/**
 * Fixed-window request limiter, per key (an IP for sign-in, a Discord user
 * id for actions). Kept in process: the bot runs on a single web dyno. The
 * map is capped so a flood of distinct keys cannot grow memory on a dyno
 * with a memory-quota (R14) history. When full it first drops expired
 * windows; then, while still full, deletes the oldest-inserted key whose
 * count is strictly under the limit; failing that, the oldest key sitting
 * exactly at the limit (e.g. an "already posted" audit entry); only when
 * every key is over the limit does it delete the oldest one. A flood of
 * fresh keys therefore cannot free a key that is at or over its limit
 * while any lesser key remains.
 */
export class FixedWindowLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  get size(): number {
    return this.hits.size;
  }

  take(key: string): boolean {
    const at = this.now();
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= at) {
      if (!entry && this.hits.size >= this.maxKeys) {
        this.evict(at);
      }
      entry = { count: 0, resetAt: at + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  retryAfterSec(key: string): number {
    const entry = this.hits.get(key);
    return entry
      ? Math.max(1, Math.ceil((entry.resetAt - this.now()) / 1000))
      : 1;
  }

  private evict(at: number) {
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= at) {
        this.hits.delete(key);
      }
    }
    while (this.hits.size >= this.maxKeys) {
      this.hits.delete(this.evictionCandidate());
    }
  }

  /** Oldest key under the limit, else oldest at it, else the oldest key. */
  private evictionCandidate(): string {
    let atLimit: string | undefined;
    for (const [key, entry] of this.hits) {
      if (entry.count < this.limit) {
        return key;
      }
      if (atLimit === undefined && entry.count === this.limit) {
        atLimit = key;
      }
    }
    if (atLimit !== undefined) {
      return atLimit;
    }
    const [oldest] = this.hits.keys();
    return oldest;
  }
}
