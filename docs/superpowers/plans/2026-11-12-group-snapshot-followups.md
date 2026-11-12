# Group snapshot follow-ups (PR 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The follow-ups agreed in the #156 reviews and seen live: snapshot members first in the backfill sweep, strict snapshot reads in the backfill, accepted short reads, a clearable undercount flag, softer rate-limit alerts, a recent-events parity check.

**Architecture:** Small changes inside the existing modules; one new table (`wrapped_backfill_deferred`) and one new column (`meetup_events.rsvps_hidden`, catalog-guarded ALTER). Executed natively (small, sequential, lead-reviewed).

**Spec:** `docs/superpowers/specs/2026-11-11-group-snapshot-design.md`, "Follow-ups after PR 2".

## Global Constraints

- No Meetup call added on any path; no RSVP data in Redis; privacy unchanged.
- Without a snapshot the backfill behaves exactly as before (existing tests unchanged).
- tsc / vitest / eslint / prettier clean; integration on the throwaway stack.

## Tasks

- [ ] **Deferred sweep**: `WrappedBackfillStore.deferMember / nextDeferred / completeDeferred / deferredCount` (Postgres CTEs, fake); the sweep's pass 1 defers stale token-path members when a snapshot is ready; pass 2 drains them under `MEMBERS_PER_TICK` / `TICK_CALL_BUDGET`; the run finishes with nothing deferred. Tests: mixed ids (token members first) build all snapshot members in tick 1 and 4 token members, the rest next tick; repository CAS and deltas.
- [ ] **Strict reads**: `SnapshotWrapped.sources(…, { strict: true })` rethrows; the backfill ends the tick (sweep and queue) on a read error. Tests: no token build, cursor unmoved.
- [ ] **Accepted short reads**: `RsvpWork.lastError`; short again after a short-read failure ⇒ `replaceRsvps(…, { hidden: true })`; `hiddenEventCount`; card line. Tests: two runs accept; a different earlier error does not.
- [ ] **Flag clears** on an agreeing cross-check (`clearFlag`). Test.
- [ ] **Rate limit**: `RateLimited` error name; alert only on a second in a row; failed ticks write the last-tick record with `error`; card shows it. Tests.
- [ ] **Comment** back above `meetup_snapshot_runs`.
- [ ] **Parity probe** on recent events (letters only) recorded in the spec.
- [ ] Verify, PR, send the lead the URL and SHAs.
