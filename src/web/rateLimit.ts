/**
 * Fixed-window request limiter, per key (an IP for sign-in, a Discord user
 * id for actions). Kept in process: the bot runs on a single web dyno. The
 * map is capped so a flood of distinct keys cannot grow memory on a dyno
 * with an R14 history; when full it drops expired windows, then everything.
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
    if (this.hits.size >= this.maxKeys) {
      this.hits.clear();
    }
  }
}
