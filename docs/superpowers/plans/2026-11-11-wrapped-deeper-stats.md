# Wrapped: deeper stats and expandable sections (PR A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The `/host/wrapped` page shows ten companions (three by default), the busiest month's events, the top hosted events with attendance, the events shared with the top companion, and each top activity type's first ten events with the "still around" early cohort, all computed at build time and read from the cache.

**Architecture:** The pure stats module grows additive fields (lists of the member's own events, a per-companion list of shared event ids); a new pure `cohort.ts` ranks early-cohort Meetup ids; `companions.ts` generalises its linked-and-present walk to any limit; `build.ts` fetches hosted events with attendance through a new client query, fetches the early events' attendee lists once, and fills the cohort; the cache key bumps to `v4`; the embed folds companions past three into its count; the page renders every new list inside `<details>`.

**Tech Stack:** TypeScript ESM (`.js` imports), Express 5 with the `html` tagged template, dayjs with `tz`, discord.js v14, vitest (network blocked), Redis via `KeyValueCache`.

**Spec:** `docs/superpowers/specs/2026-11-10-wrapped-design.md`, "Addendum (2026-11-11)", section "PR A" and decisions 1 and 7.

## Global Constraints

- Another person appears only as a linked member on the server, by Discord id in the cache and display name on the page; no Meetup name or id of another person in the HTML, the cache JSON or a log.
- Companion profile link: `https://discord.com/users/<discordUserId>`, through `safeHref`. No Meetup profile of anyone else.
- Event links through `safeHref`; titles through `memberText`; dates `tz(dayjs(iso)).format('ll')`.
- Hosted attendance filter: `rsvpStatus: [YES, ATTENDED]`, read with the hosted list in one query; counted-events rule (`countsAsHosted` / `countsAsAttended`) unchanged.
- Every all-time number is as of 31 December of the Wrapped year (`yearBounds(year).end`).
- `NAMED_COMPANIONS = 10`, `COMPANION_LOOKUP_CAP = 50`; cohort: 10 named, 25 lookups, per type; `TOP_TYPES = 3`; first events per type: 10; top hosted this year: 5; `ATTENDEE_FETCH_CONCURRENCY = 5` (one `readAttendees` for the early events, skipping ids already fetched this year).
- `WRAPPED_CACHE_VERSION = 'v4'`. Only the top named companion carries `sharedEvents`.
- The embed names 3 companions; the rest join "and N other members".
- Page: `<details>`/`<summary>`, no script, CSP unchanged; 20 s wait and "still building" path unchanged; build duration logged with ids only.
- Alerts carry `describeBuildError` text, never a Meetup body. `no-await-in-loop` is an error (use `mapWithConcurrency`, or the client's disable comment).

## Review Focus

1. An event whose attendee list includes the member twice, or the member's own id in an early event: the cohort never names the member themself and never double counts (Task 2 test "excludes self and dedupes").
2. A top companion who is named but whose display name cannot be resolved at render time: folded into the count, and the "Together with" expander is not rendered for a nameless person (Task 8 test "folds an unresolvable top companion").
3. An event URL that is not plain https to www.meetup.com (`javascript:` or another host) anywhere in a new list: rendered as text, no `href` (Task 8 test "renders unsafe event URLs as text").
4. A member whose history is entirely cancelled titles or Open Houses hosted: first events empty, hosting absent, no cohort fetch (Task 1 test "no first events when nothing counts"; Task 5 test "a zero-event year makes no cohort fetch").
5. A hosted event with no attendance field in the response (an old cached page shape): counted as 0, never `NaN` (Task 4 test "attendance defaults to 0").

---

### Task 1: Pure stats: month events, first events per type, hosting rankings, shared event ids

**Files:**

- Modify: `src/lib/wrapped/stats.ts`
- Test: `tst/lib/wrapped/stats.test.ts`

**Interfaces:**

- Consumes: `countsAsAttended`, `countsAsHosted`, `classifyEventType`, `EVENT_TYPES`, `tz` (as today).
- Produces:

```ts
export interface HostedEvent extends WrappedEvent { attendance: number }   // yes+attended count at build time
export interface WrappedInput { year; selfMeetupId; attended: WrappedEvent[]; hosted: HostedEvent[]; attendeesByEvent }
export interface Companion { meetupId: string; sharedCount: number; sharedEventIds: string[] } // this year's shared events, date asc
export interface CohortMember { discordUserId: string; earlyCount: number; sharedCount: number }
export interface NamedCohort { named: CohortMember[]; otherCount: number }
export interface TopType { type: EventType; count: number; firstEvents: WrappedEvent[]; cohort: NamedCohort }
export interface HostedRanked { event: WrappedEvent; attendance: number }
export interface WrappedStats {
  …as today, with
  topTypes: TopType[];                           // cohort is { named: [], otherCount: 0 } from computeWrapped; build.ts fills it
  hosting: { thisYear; allTime; topThisYear: HostedRanked[]; allTimeBest: HostedRanked | null } | null;
  busiestMonth: { month; count; events: WrappedEvent[] } | null;   // that month's counted attended events, date asc
}
export const FIRST_EVENTS_PER_TYPE = 10; export const TOP_HOSTED = 5;
```

- [ ] **Step 1: Write the failing tests** in `tst/lib/wrapped/stats.test.ts` (extend the existing `ev`/`input` helpers; hosted fixtures become `{ ...ev(), attendance: n }`):

```ts
it('lists the busiest month’s events in date order, cancelled dropped', …)
  // three events in June (one titled 'Cancelled: Picnic'), two in March → month 5, count 2, events = the two June ones sorted asc
it('ranks hosted events this year by attendance, then earliest date, at most five', …)
  // six hosted this year with attendance 9,9,7,12,3,5 → topThisYear = [12, 9(earlier), 9(later), 7, 5]
it('finds the all-time best hosted event as of 31 Dec of the year', …)
  // a 2024 event with attendance 30, a 2026 one with 20, a 2027 one with 50 → allTimeBest is the 2024 one
it('has no hosting rankings for a member who never hosted', …)   // hosting === null
it('lists the first ten events ever of each top type, earliest first, all-time', …)
  // 12 'Trivia' (games) events 2023–2026 and 1 'Hot Pot' → topTypes[0].firstEvents has 10, first is the 2023 one, cohort = { named: [], otherCount: 0 }
it('has fewer than ten first events when the member has fewer', …)
it('no first events when nothing counts', …)   // only cancelled titles → topTypes []
it('carries each companion’s shared event ids in date order', …)
  // attendees {'2': ['self','7'], '3': ['self','7']} → companions[0] = { meetupId: '7', sharedCount: 2, sharedEventIds: ['2','3'] }
```

Update the existing assertions that use `toEqual` on companions/hosting to the new shapes.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn vitest run tst/lib/wrapped/stats.test.ts`
Expected: FAIL on the new fields (type errors / undefined).

- [ ] **Step 3: Implement** in `src/lib/wrapped/stats.ts`: the interfaces above; `busiestMonth(counts, thisYear)` returns the month's events; `topTypes(thisYear, attendedEver)` adds `firstEvents` = `attendedEver` (already cutoff-filtered and sorted) of that type, first `FIRST_EVENTS_PER_TYPE`; `rankHosted(hosted)` sorts by `attendance` desc then date asc; `rankCompanions` collects `sharedEventIds` from `thisYear` (which is date-sorted). Cutoff applies to every list.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn vitest run tst/lib/wrapped/stats.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/wrapped/stats.ts tst/lib/wrapped/stats.test.ts
git commit -m "Wrapped stats: month events, first events per type, hosted rankings, shared event ids"
```

### Task 2: Pure cohort ranking

**Files:**

- Create: `src/lib/wrapped/cohort.ts`
- Test: `tst/lib/wrapped/cohort.test.ts`

**Interfaces:**

- Consumes: `Companion`, `WrappedEvent` from `stats.ts`.
- Produces:

```ts
export interface CohortCandidate {
  meetupId: string;
  earlyCount: number;
  sharedCount: number;
}
/** Ids seen at `firstEvents` (self excluded, deduped per event) that also appear in `yearCompanions`; earlyCount desc, sharedCount desc, numeric id asc. */
export function rankCohort(
  firstEvents: WrappedEvent[],
  attendeesByEvent: Record<string, string[]>,
  yearCompanions: Companion[],
  selfMeetupId: string,
): CohortCandidate[];
/** Event ids of every type's first events, deduped, minus `alreadyFetched`. */
export function earlyEventIdsToFetch(
  topTypes: { firstEvents: WrappedEvent[] }[],
  alreadyFetched: Iterable<string>,
): string[];
```

- [ ] **Step 1: Write the failing tests**

```ts
it('ranks early-event people who also shared an event this year', …)
  // early attendees {e1:['self','a','b'], e2:['a','c']}, yearCompanions a(3), b(1) → [{a,2,3},{b,1,1}]; c absent (nothing this year)
it('excludes self and dedupes', …)   // e1: ['self','self','a','a'] → a.earlyCount 1
it('breaks ties by shared count, then numeric id', …)   // ids '10' and '9' equal counts → '9' first
it('lists early event ids to fetch once, skipping ones fetched this year', …)
```

- [ ] **Step 2: Run to verify failure** — `yarn vitest run tst/lib/wrapped/cohort.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement `src/lib/wrapped/cohort.ts`** per the signatures (same numeric `localeCompare` as `rankCompanions`).
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `git add src/lib/wrapped/cohort.ts tst/lib/wrapped/cohort.test.ts && git commit -m "Wrapped: early-cohort ranking"`.

### Task 3: Naming any ranking, to any limit

**Files:**

- Modify: `src/lib/wrapped/companions.ts`
- Test: `tst/lib/wrapped/companions.test.ts`

**Interfaces:**

- Produces:

```ts
export const NAMED_COMPANIONS = 10;
export const COMPANION_LOOKUP_CAP = 50;
export const NAMED_COHORT = 10;
export const COHORT_LOOKUP_CAP = 25;
export interface NamedCompanion {
  discordUserId: string;
  sharedCount: number;
  sharedEvents?: WrappedEvent[];
}
export interface NamedCompanions {
  named: NamedCompanion[];
  otherCount: number;
}
/** Generic walk: linked (findByMeetupId) and present, in rank order, up to `limit`, at most `lookupCap` lookups; `otherCount` = ranked.length − named.length. */
export async function nameRanked<T extends { meetupId: string }>(
  ranked: T[],
  deps: CompanionDeps,
  limit: number,
  lookupCap: number,
): Promise<{ named: (T & { discordUserId: string })[]; otherCount: number }>;
export async function nameCompanions(
  ranked: Companion[],
  deps: CompanionDeps,
): Promise<NamedCompanions>; // nameRanked(…, 10, 50) mapped to { discordUserId, sharedCount }
export async function nameCohort(
  ranked: CohortCandidate[],
  deps: CompanionDeps,
): Promise<NamedCohort>; // nameRanked(…, 10, 25) mapped to { discordUserId, earlyCount, sharedCount }
```

- [ ] **Step 1: Write the failing tests**: update "up to three" → "up to ten" (12 linked ranked → 10 named, otherCount 2); "stops after the lookup cap" with 50; `nameCohort` names at most 10 after at most 25 lookups and keeps `earlyCount`/`sharedCount`; `nameCompanions` output has no `meetupId` key (`expect(Object.keys(named[0])).toEqual(['discordUserId','sharedCount'])`).
- [ ] **Step 2: Run to verify failure** — `yarn vitest run tst/lib/wrapped/companions.test.ts`.
- [ ] **Step 3: Implement** `nameRanked` and the two wrappers (strip `meetupId` in the wrappers: it must never reach the cache).
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "Wrapped companions: name any ranking to a limit; ten companions"`.

### Task 4: Meetup client: hosted events with attendance

**Files:**

- Modify: `src/lib/client/meetup/queries.ts`, `src/lib/client/meetup/types.ts`, `src/lib/client/meetup/gqlClient.ts`
- Test: `tst/lib/client/meetup/hostedEvents.test.ts`

**Interfaces:**

- Produces:

```ts
// queries.ts
export const getHostedEvents = gql`…`   // getGroupEvents' node fields plus `attendance: rsvps(filter: { rsvpStatus: [YES, ATTENDED] }) { totalCount }`
// types.ts
export type HostedEventNode = Event & { attendance?: { totalCount?: number | null } | null };
export interface GetHostedEventsResponse { groupByUrlname: { id: string; events: PaginatedData<HostedEventNode> } }
export type GetHostedEventsInput = { urlname: string; first: number; after?: string; filter: GroupEventFilter };
// gqlClient.ts
public async getHostedEvents(hostId: string, input: PaginationInput): Promise<GetHostedEventsResponse>
  // filter { status: ['PAST'], hostId }, cached under the name 'getHostedEvents' (this.cached), counts-only logging like getGroupEvents
```

- [ ] **Step 1: Write the failing test** (nock-free: stub `client.request` on a `GqlMeetupClient('t', { bypassCache: true })` via `vi.spyOn`, as other client tests do if any; otherwise construct and assert on the query text):

```ts
it('asks for past events hosted by the member with a yes+attended count', …)   // request called with getHostedEvents, variables { urlname, first, filter: { status: ['PAST'], hostId: '42' } }; query text contains 'rsvpStatus: [YES, ATTENDED]'
it('attendance defaults to 0 when the node has none', …)   // a helper `hostedAttendance(node): number` exported from types.ts or gqlClient.ts returns 0 for null/undefined/NaN
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** query, types, method, and `export function hostedAttendance(node: HostedEventNode): number` in `types.ts`.
- [ ] **Step 4: Run to verify pass**; also `yarn tsc --noEmit -p .` (ignore pre-existing node_modules noise).
- [ ] **Step 5: Commit** — `git commit -m "Meetup client: hosted events with attendance"`.

### Task 5: Build: hosted attendance, early cohort, shared events, duration

**Files:**

- Modify: `src/lib/wrapped/build.ts`
- Modify (fakes): `tst/lib/wrapped/handlers.test.ts:107`, `tst/web/host/wrappedPage.test.ts:90`, `tst/integration/wrappedFrontDoors.test.ts:77`
- Test: `tst/lib/wrapped/build.test.ts`

**Interfaces:**

- Consumes: Tasks 1–4.
- Produces: `WrappedMeetup.getHostedEvents(hostId, input): Promise<GetHostedEventsResponse>` replaces `getGroupEvents`; `buildWrapped` signature unchanged; progress messages `'Reading your RSVPs…'`, `'Finding who you went with…'`, `'Looking back at your early events…'`.

- [ ] **Step 1: Write the failing tests** (rename the fake to `getHostedEvents`, nodes carry `attendance: { totalCount }`):

```ts
it('reads hosted events with attendance and ranks them', …)   // getHostedEvents called with ('me', paginationInput); stats.hosting.topThisYear[0].attendance === 12
it('fetches early events’ attendee lists once each, skipping ones already fetched this year', …)
  // 11 games events 2023–2026 (two in 2026); getEventRsvps ids = this year's ∪ first ten games, each once
it('fills each top type’s cohort with linked, present people who also shared an event this year', …)
it('attaches the shared events to the top companion only', …)   // named[0].sharedEvents = [trivia, hotPot]; named[1].sharedEvents undefined
it('a zero-event year makes no cohort fetch', …)   // attended only in 2024, year 2026 → getEventRsvps not called
it('logs the build duration', …)   // spy on the module logger or assert via onProgress? → use a `deps.log?: (message: string) => void` optional dep; default logger.info; test asserts the message matches /Wrapped build for Meetup member me \(2026\) took \d+ ms/
```

- [ ] **Step 2: Run to verify failure** — `yarn vitest run tst/lib/wrapped/build.test.ts`.
- [ ] **Step 3: Implement** in `build.ts`: `readHosted` via `getHostedEvents` → `HostedEvent[]` using `hostedAttendance`; after `computeWrapped`, `earlyEventIdsToFetch(stats.topTypes, Object.keys(attendeesByEvent))` → `readAttendees` for those events (look events up by id in `attendedEver`-equivalent list: history ∪ hosted), merge into the map, `rankCohort` + `nameCohort` per type, write `topTypes[i].cohort`; `named[0].sharedEvents` = `companions[0].sharedEventIds` mapped through this year's events; duration log at the end. Add `log?` to `BuildDeps`.
- [ ] **Step 4: Update the three fakes** to `getHostedEvents` and run `yarn vitest run tst/lib/wrapped tst/web/host/wrappedPage.test.ts` → PASS (the page test still renders the old shape fine until Task 8).
- [ ] **Step 5: Commit** — `git commit -m "Wrapped build: hosted attendance, early cohort, top companion's events, duration log"`.

### Task 6: Cache version v4

**Files:**

- Modify: `src/lib/wrapped/cache.ts`
- Test: `tst/lib/wrapped/cache.test.ts` (lines 70, 114, 128: `v3` → `v4`)

- [ ] **Step 1: Change the tests to `wrapped:v4:…`; run → FAIL.**
- [ ] **Step 2: Set `WRAPPED_CACHE_VERSION = 'v4'`; run → PASS.**
- [ ] **Step 3: Commit** — `git commit -m "Wrapped cache: v4 for the deeper stats shape"`.

### Task 7: Embed: three named, the rest counted

**Files:**

- Modify: `src/lib/wrapped/format.ts`
- Test: `tst/lib/wrapped/format.test.ts`

**Interfaces:** `export const EMBED_NAMED_COMPANIONS = 3;` `companionsText` shows `named.slice(0, 3)`, `others = otherCount + max(0, named.length − 3)` + unresolved.

- [ ] **Step 1: Write the failing test**: fixture with 10 named and `otherCount: 5` → private view text has three `<@…>` and ends `and 12 other members`; shared view likewise with display names. Update the `full`/`quiet` fixtures to the Task 1 shape (`topTypes` items with `firstEvents: []`, `cohort`, `hosting.topThisYear: []`, `allTimeBest: null`, `busiestMonth.events: []`).
- [ ] **Step 2: Run → FAIL.** `yarn vitest run tst/lib/wrapped/format.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run → PASS**, then `yarn vitest run tst/lib/wrapped` (handlers fixtures may need the same shape update).
- [ ] **Step 5: Commit** — `git commit -m "Wrapped embed: name three companions, count the rest"`.

### Task 8: The page: expandable sections

**Files:**

- Modify: `src/web/host/wrappedPage.ts` (`wrappedBody`, `companionsText`, new section helpers)
- Test: `tst/web/host/wrappedPage.test.ts`

**Interfaces:**

- Consumes: `CachedWrapped` v4; `displayNames: Record<string, string>` now resolved for companions **and every cohort member** (`namesFor` collects all Discord ids on the entry).
- Produces (markup; summaries are exact copy):
  - Went with the most: first 3 named as `<a href="https://discord.com/users/<id>" rel="noopener noreferrer" target="_blank"><bdi>name</bdi></a> (N events)`; if more named resolve, `<details class="more"><summary>Show all <n></summary><ul>…</ul></details>` with the rest; unresolved fold into the count.
  - Under the top companion (only when resolved and `sharedEvents` non-empty): `<details><summary>Together with <name> (<n> events)</summary><ul>` of event list items.
  - Busiest month: `<details><summary>Events that month (<n>)</summary><ul>…</ul></details>`.
  - Hosting: `<p>` as today; `<h3>Most attended this year</h3><ol>` of `title (N going)`; `<p>All-time: <link> (N going)</p>`.
  - Top activities: each `<li>` label + count, then `<details><summary>Your first <n> <label lowercased> events</summary><ul>…</ul>` and inside it `<details><summary>Still around from your early cohort (<n>)</summary>` with cohort members as profile links `(<earlyCount> early events, <sharedCount> this year)`, first 5 then a nested `<details><summary>Show all <n></summary>`; otherCount line "and N other members".
  - Event list item: `<li><time>Mar 2, 2024</time> · <a href=…>title</a></li>` (title as text when `safeHref` refuses).

- [ ] **Step 1: Write the failing tests** (extend `cached` fixture to v4 with 10 named companions `d-1..d-10`, `sharedEvents` on the first, a cohort of 7 on `food`, 6 hosted rankings, busiest-month events incl. one with `eventUrl: 'javascript:alert(1)'`; `displayName` resolves `d-1..d-9`, not `d-10`):

```ts
it('shows three companions with profile links and a "Show all" expander for the rest', …)   // 3 links before <details>, summary 'Show all 9', 'and 6 other members' (5 + unresolved d-10)
it('lists the events shared with the top companion in an expander', …)
it('lists the busiest month’s events with dates and links', …)
it('renders unsafe event URLs as text', …)   // no 'javascript:' in the HTML, title present
it('ranks hosted events with attendance and the all-time best', …)
it('expands each top type to its first events and the early cohort', …)   // 'Your first 10 food &amp; drink events', 'Still around from your early cohort (7)', five links then 'Show all 7'
it('folds an unresolvable top companion', …)   // displayName returns undefined for d-1 → no "Together with", count +1
it('a quiet year has no expanders', …)   // no '<details' in the body except none
it('never lets an unlinked attendee’s Meetup name or id reach the page or the cache', …)   // keep; extend `everything` check to cohort fixture ids
```

- [ ] **Step 2: Run → FAIL.** `yarn vitest run tst/web/host/wrappedPage.test.ts`
- [ ] **Step 3: Implement** the helpers in `wrappedPage.ts`; `namesFor` gathers ids from `companions.named` and every `topTypes[i].cohort.named`.
- [ ] **Step 4: Run → PASS**; then `yarn test` (all unit), `yarn lint`, `yarn tsc --noEmit -p .`, `yarn prettier --check "src/**/*.ts" "tst/**/*.ts" "docs/**/*.md"`.
- [ ] **Step 5: Commit** — `git commit -m "Wrapped page: expandable companions, month, hosting and early-cohort sections"`.

### Task 9: Render check, integration, PR

**Files:**

- Create (untracked, not committed): `.claude/preview.mts`, `.claude/launch.json` (copied from the sibling worktree `adoring-carson-6febb1`, extended with `registerWrappedPage` on a fake v4 entry and `resolve` returning a `member`).

- [ ] **Step 1: Integration**: start the throwaway stack (`tst/integration` README / memory: postgres:16 on :55432, redis:7 on :56379), run `yarn test:integration` with the env line; `wrappedFrontDoors` passes with the v4 shape.
- [ ] **Step 2: Preview** at 360 and 1280 px, light and dark; save four screenshots to the scratchpad; check each `<details>` opens, no horizontal scroll at 360.
- [ ] **Step 3: Push and open the PR** titled "Wrapped: deeper stats and expandable sections", body: summary, the "Together with" interpretation for Hai to confirm, the `[YES, ATTENDED]` decision for Hai to confirm, the entry size for a busy fixture (`JSON.stringify(cached).length`) and the Redis-plan question, screenshots, test commands run. Do not merge.
- [ ] **Step 4: Report** PR URL and `BASE..HEAD` SHAs to the "MeetupBot - lead" session.
