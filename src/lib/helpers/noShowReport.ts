/**
 * Pure logic behind the monthly No Show report. The policy encoded here
 * (warn at 1, suspend at 2+, 30 days doubling per prior suspension, act 3
 * days before the member's next event) is the group's moderation policy --
 * see docs/superpowers/specs/2026-09-24-monthly-reports-automation-design.md.
 */

/**
 * Callers count no-shows in the trailing 12 months from today, and only those
 * after the member's most recent suspension -- the no-shows that led to a
 * suspension never count toward the next one. That counting lives where the
 * count is computed; this only classifies the result.
 */
export function classifyNoShowCount(count: number): 'warning' | 'suspension' {
  // A count of zero means there is nothing to act on; classifying it as a
  // warning would warn a member who did nothing wrong.
  if (count < 1) {
    throw new RangeError(
      `classifyNoShowCount needs a count >= 1, got ${count}`,
    );
  }
  return count >= 2 ? 'suspension' : 'warning';
}

export function recommendedSuspensionDays(priorSuspensions: number): number {
  return 30 * 2 ** priorSuspensions;
}
