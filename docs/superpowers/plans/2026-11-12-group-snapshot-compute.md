# Group snapshot compute (PR 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Wrapped from the group snapshot (no Meetup call) whenever it can serve the member, keep today's token path as the fallback, sweep the backfill over the snapshot in minutes, and add the leadership "Refresh snapshot now" button.

**Architecture:** `PostgresSnapshotRepository` gains read methods (`SnapshotReader`). `src/lib/snapshot/wrapped.ts` turns them into `WrappedSources` plus an attendee reader, with the path choice (ready, member present, optional self-count cross-check). `build.ts` gets an attendee seam so `buildWrappedYear` reads attendees from either Meetup or the snapshot; `buildWrappedFromSnapshot` is the no-token build. The Discord command, the web page and the backfill try the snapshot first. Executed natively (lead wants speed); PR is based on #155's branch.

**Tech Stack:** TypeScript (ESM), node-pg, vitest, Express, discord.js.

**Spec:** `docs/superpowers/specs/2026-11-11-group-snapshot-design.md` (PR 2 sections, "Decisions after the builder check" 1, "Notes for PR 2", and the lead's notes below).

## Global Constraints

- Read only `status = 'PAST' AND deleted_at IS NULL` events; RSVPs with status `YES` or `ATTENDED` count (WAITLIST never counts).
- The Wrapped JSON shape is unchanged; **no `WRAPPED_CACHE_VERSION` bump**. Privacy unchanged: other people only as linked Discord ids and counts.
- Path choice (`SnapshotWrapped.sources`): undefined (token path) when no full pull has finished, when the member has no stored RSVP and no hosted event, or when a cross-check count from the member's stored token exceeds the local count by more than `SNAPSHOT_COUNT_SLACK = 2`. A reader error falls back to the token path (logged by class).
- On-demand builds keep the lease, the hourly limiter (`claimBuild` before building), the entry write and the queue drop exactly as today.
- Backfill: snapshot-built members don't count against `MEMBERS_PER_TICK` or `TICK_CALL_BUDGET`; at most `SNAPSHOT_MEMBERS_PER_TICK = 100` a tick. With a snapshot, a current-year copy is fresh when built after the latest finished snapshot run.
- Schema: the three `rsvp_*` columns also get a catalog-guarded `ALTER` (the `dashboard_notices.claimed_at` pattern), per the lead.
- Refresh snapshot now mirrors Run now (leadership, live check, audit, fixed notices); sets `SNAPSHOT_RUN_NOW_KEY`.
- tsc / vitest / eslint / prettier clean; integration on the throwaway stack.

## Review Focus

1. **Snapshot ready but the member is new** (joined after the last run): no rows ⇒ token path, not an empty Wrapped. Test in Task 2.
2. **Postgres down during the choice**: the build still happens via the token path. Test in Task 2 (reader throws ⇒ undefined).
3. **A member with no stored token on the web**: the snapshot path builds without the "connect Meetup" page. Test in Task 4.
4. **Hosted attendance**: local YES+ATTENDED row count, falling back to `yes_count` for an event whose RSVPs were never read. Test in Task 1.
5. **Snapshot and token builds agree** on the same data (same `CachedWrapped` apart from `builtAt`). Test in Task 2.

---

### Task 1: Reader queries and the schema ALTERs

**Files:** Modify `src/lib/repositories/postgresSnapshotRepository.ts`, `src/lib/repositories/dashboardPool.ts`; Test `tst/integration/postgresSnapshotRepository.test.ts`.

**Produces** (`SnapshotReader`, implemented by the repository):

- `isReady(): Promise<boolean>` (= `hasFinishedFull`)
- `updatedAt(): Promise<Date | undefined>` (latest finished run's `finished_at`)
- `memberEvents(meetupId): Promise<EventSummary[]>` — PAST, live, the member's row YES/ATTENDED; `eventUrl` falls back to `https://www.meetup.com/<urlname>/events/<id>/`.
- `hostedEvents(meetupId): Promise<HostedEvent[]>` — PAST, live, `meetupId = ANY(host_ids)`; attendance as Review Focus 4.
- `attendeesOf(eventIds: string[]): Promise<Record<string, string[]>>` — YES/ATTENDED member ids per event.

- [ ] Tests: each query against seeded rows (deleted/ACTIVE/CANCELLED excluded, WAITLIST excluded, URL fallback, attendance fallback); schema created on a table without the columns gains them.
- [ ] Implement; run integration; commit.

### Task 2: Attendee seam, snapshot build, path choice

**Files:** Modify `src/lib/wrapped/build.ts`; Create `src/lib/snapshot/wrapped.ts`; Tests `tst/lib/snapshot/wrapped.test.ts`, existing `tst/lib/wrapped/build.test.ts` unchanged and passing.

**Produces:**

- `type AttendeeReader = (events: WrappedEvent[], firstPageOnly: boolean) => Promise<{ byEvent: Record<string, string[]>; partial: Set<string> }>`; `SourceDeps` gains `attendees?: AttendeeReader` and `meetup` becomes optional (one of the two required at runtime).
- `interface SnapshotWrapped { sources(linkedMeetupId: string, selfPastCount?: () => Promise<number | undefined>): Promise<WrappedSources | undefined>; attendees: AttendeeReader; updatedAt(): Promise<Date | undefined> }`
- `snapshotWrapped(reader: SnapshotReader): SnapshotWrapped`
- `buildWrappedFromSnapshot(deps: SnapshotBuildDeps, linkedMeetupId: string, year: number, sources: WrappedSources): Promise<BuildResult>` with `SnapshotBuildDeps = Pick<BuildDeps, 'claimBuild' | 'findByMeetupId' | 'isPresent' | 'now' | 'log' | 'onProgress'> & { attendees: AttendeeReader }`.
- `storedTokenSelfCount(discordUserId): Promise<number | undefined>` (production: stored token → `getSelfPastRsvpCount`; any error → undefined).

- [ ] Tests: path choice cases (not ready, absent, cross-check over/under slack, count error ignored, reader error ⇒ undefined); snapshot build makes zero Meetup calls and equals the token build on the same fixture; `claimBuild` false ⇒ rate-limited; the entry JSON has no Meetup id but the member's own.
- [ ] Implement; run; commit.

### Task 3: `/wrapped` in Discord

**Files:** Modify `src/lib/wrapped/handlers.ts`; Test `tst/lib/wrapped/handlers.test.ts`.

`WrappedHandlerDeps` gains `snapshot?(): Promise<SnapshotWrapped>` and `selfPastCount?(discordUserId): Promise<number | undefined>`. After the lease: snapshot sources ⇒ `buildAndReply` with the snapshot build (no `withMeetupClient`, no OAuth hop); else today's path. `buildAndReply` takes a `build(shared)` closure instead of `meetup`.

- [ ] Tests: snapshot member builds with no `withMeetupClient` call and the limiter taken; refresh rebuilds from the snapshot; limiter refusal unchanged; no snapshot ⇒ today's path.
- [ ] Implement; run; commit.

### Task 4: `/host/wrapped`

**Files:** Modify `src/web/host/wrappedPage.ts` (+ production deps where it is wired); Test `tst/web/host/wrappedPage.test.ts`.

`WrappedPageDeps` gains the same two optional deps. `build()` takes `accessToken | undefined` and `sources | undefined`. No token + snapshot sources ⇒ builds (no connect page).

- [ ] Tests: snapshot build without a token renders; rebuild POST uses the snapshot; no snapshot and no token ⇒ the connect page as today.
- [ ] Implement; run; commit.

### Task 5: Backfill over the snapshot

**Files:** Modify `src/lib/wrapped/backfill.ts`; Test `tst/lib/wrapped/backfill.test.ts`, `tst/lib/wrapped/backfillFakes.ts`.

`BackfillDeps` gains `snapshot?(): Promise<SnapshotWrapped>`. Per member: snapshot sources ⇒ build every year from them (no lease on the organizer credential, no calls), counted against `SNAPSHOT_MEMBERS_PER_TICK`; else today's path under today's caps. `isFresh(copy, meetupId, year, now, snapshotAt?)`.

- [ ] Tests: 100 snapshot members in one tick with zero Meetup calls; a 101st waits; mixed with token members; current-year copy older than the snapshot is rebuilt, newer skipped; queue entries drain through the snapshot.
- [ ] Implement; run; commit.

### Task 6: Refresh snapshot now

**Files:** Modify `src/web/routes/wrappedBackfill.ts`, `src/lib/reports/dashboardPaths.ts` (`snapshotRefresh: '/wrapped/snapshot/run'`), `src/web/dashboardDeps.ts`, `src/web/routes/dashboardPages.ts`; Test `tst/web/routes/wrappedBackfill.test.ts`, `tst/lib/reports/dashboardPaths.test.ts` if it pins paths.

`WrappedBackfillControl.refreshSnapshot(requestedBy): Promise<RunNowOutcome>`; notices `snapshot-requested`, `snapshot-already-running`, `snapshot-already-requested`; audit "Group snapshot refresh requested".

- [ ] Tests: the POST matrix as Run now's; button hidden while a snapshot run is open.
- [ ] Implement; run; commit.

### Task 7: Verify and PR

- [ ] tsc, vitest, eslint, prettier, integration; spec notes from the lead's PR 1 re-review; PR against `claude/group-snapshot-ingest` (retarget to `main` once #155 merges); send the lead URL + SHAs.
