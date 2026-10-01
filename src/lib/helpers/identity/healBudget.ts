/**
 * How long one sweep run may spend healing baselines that have no thumbnail.
 *
 * The sweep runs inside the daily digest, after the day's claim is taken.
 * The first run after the schema migration finds ~2,079 Discord baselines
 * with no stored image; a heal fetch is typically ~100ms but bounded at 5s,
 * so a count cap alone could still stretch the digest by hours (2,079 x 5s
 * is ~3 hours). Two minutes per sweep keeps the worst case small next to
 * the sweep's own work, and well inside a 30-minute digest lease. Members
 * not reached heal on later days -- nothing is lost by waiting, since an
 * unhealed baseline only means a future change might lack its before-image.
 */
export const HEAL_BUDGET_MS = 120_000;

/**
 * A per-run allowance of time spent healing. Only time spent inside `spend`
 * counts -- the sweep's ordinary diffing is not charged against it -- and it
 * is checked before each heal, so the budget can be overrun by at most one
 * member's heal (two 5s-bounded fetches plus a write).
 *
 * `now` is injectable so tests can drive exhaustion without real waiting.
 */
export class HealBudget {
  private spentMs = 0;

  constructor(
    private readonly limitMs: number = HEAL_BUDGET_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get exhausted(): boolean {
    return this.spentMs >= this.limitMs;
  }

  async spend<T>(work: () => Promise<T>): Promise<T> {
    const start = this.now();
    try {
      return await work();
    } finally {
      this.spentMs += this.now() - start;
    }
  }
}
