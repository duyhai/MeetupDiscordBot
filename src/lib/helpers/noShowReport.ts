/**
 * Pure logic behind the monthly No Show report. The policy encoded here
 * (warn at 1, suspend at 2+, 30 days doubling per prior suspension, act 3
 * days before the member's next event) is the group's moderation policy --
 * see docs/superpowers/specs/2026-09-24-monthly-reports-automation-design.md.
 */

export function classifyNoShowCount(count: number): 'warning' | 'suspension' {
  return count >= 2 ? 'suspension' : 'warning';
}

export function recommendedSuspensionDays(priorSuspensions: number): number {
  return 30 * 2 ** priorSuspensions;
}
