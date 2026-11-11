# Wrapped on the Website Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A linked member (host or not) signs in to the host dashboard and sees their 1.5 Gen Wrapped at `/host/wrapped?year=YYYY`, built and cached through the same code, cache key, hourly slot and lease as the Discord `/wrapped` command.

**Architecture:** `resolveHost` learns a `member` outcome and `HostSession` a `role`; the gated router allows a member only Home, Wrapped and Logout. A new `src/web/host/wrappedPage.ts` orchestrates read-cache → stored member token → lease → `buildWrapped` (20 s deadline, `announcePage` pattern) and renders the page with `hostLayout`. `src/lib/wrapped` is reused as is, except one additive stats field (`activeYears`), a past-year TTL and the three #138 cosmetic notes.

**Tech Stack:** TypeScript ESM (`.js` imports), Express 5, `html` tagged template (`src/web/html.ts`), dayjs + `tz`, vitest (network blocked), Redis via `KeyValueCache`.

**Spec:** `docs/superpowers/specs/2026-11-10-wrapped-design.md` (the 2026-11-10 addendum "Wrapped on the website").

## Global Constraints

- Member role may reach exactly: `GET /host`, `GET /host/wrapped`, `POST /host/wrapped/rebuild`, `POST /host/logout`. Everything else: the existing 403 text.
- Cache key `wrapped:v3:<discordUserId>:<year>`; lease `wrapped:building:<discordUserId>:<year>` with `BUILDING_LEASE_TTL_SEC`; limiter: the module-level `wrappedBuildLimiter`, key = Discord user id.
- Past-year TTL 365 days; current year unchanged (1 February of year+1, minimum 86 400 s).
- Deadline 20 000 ms; the build continues after the page answers.
- Never a 500; Meetup errors → 503 page + alert with `describeBuildError` text; slot released when claimed.
- No unlinked person's name or Meetup id in HTML, cache or logs; display names through `memberText`.
- No inline script on the Wrapped page; same CSP/CSRF as the rest of `src/web/host`.
- `no-await-in-loop` is an error; lint, `tsc --noEmit` and prettier clean.

## Review Focus

1. A pre-change host session in Redis (no `role`) must still work after deploy → read as `host` (Task 2).
2. A member whose stored token belongs to another Meetup account → "account-mismatch" page, nothing cached, slot kept (Task 5).
3. Discord builds at 10:00, the web asks at 10:30 with no cache (relink) → the hourly message, not a second build (Task 5).
4. A build that outlives the 20 s deadline and then fails → alert once, lease released, no unhandled rejection (Task 5).
5. `?year=` of `2015`, `1999`, `abc`, next year → only in-range years build; others fall back to this year (Task 5).

---

### Task 1: Stats `activeYears`, cache v3 and past-year TTL, cosmetic notes

**Files:**

- Modify: `src/lib/wrapped/stats.ts`, `src/lib/wrapped/cache.ts`, `src/lib/wrapped/format.ts`, `src/lib/wrapped/handlers.ts`
- Test: `tst/lib/wrapped/{stats,cache,format,handlers}.test.ts`, `tst/integration/wrappedCache.test.ts` (fixture gains `activeYears`)

**Interfaces:**

- Produces: `WrappedStats.activeYears: number[]` (ascending, distinct Pacific years of counted attended events, no cutoff); `WRAPPED_CACHE_VERSION = 'v3'`; `wrappedTtlSec(year, now)` returns `365 * 86400` when `year < tz(now).year()`; `PAST_YEAR_TTL_SEC` exported.

- [ ] Tests: `computeWrapped` returns `activeYears: [2024, 2026, 2027]` for `[future, hotPot, hike, trivia]` with year 2026 (not cut off), and `[]` with no events; `wrappedCacheKey('d1', 2026)` is `wrapped:v3:d1:2026`; `wrappedTtlSec(2025, 2026-12-10)` is `31536000`; `wrappedTtlSec(2026, 2027-01-15)` is 365 d (2026 is past in Jan 2027) and `wrappedTtlSec(2027, 2027-01-15)` is until 2028-02-01; shared view renders `Alex N.` unchanged and `-# sub` without a leading `-#`; in `handlers.test.ts` a build failure whose `alert` rejects still ends with `replies.buildFailed` in place and no thrown error.
- [ ] Run `yarn vitest run tst/lib/wrapped` → the new cases fail.
- [ ] Implement; update every fixture object typed `CachedWrapped`/`WrappedStats` with `activeYears`.
- [ ] `yarn vitest run tst/lib/wrapped` passes. Commit "Wrapped: activeYears, past-year TTL, review notes".

### Task 2: Eligibility `member`, session `role`, member route gate, nav

**Files:**

- Modify: `src/lib/hosts/eligibility.ts`, `src/web/host/hostSession.ts`, `src/web/host/hostRouter.ts`, `src/web/host/hostLayout.ts`
- Test: `tst/lib/hosts/eligibility.test.ts`, `tst/web/host/hostRouter.member.test.ts` (new), `tst/web/host/hostRouter.session.test.ts`

**Interfaces:**

- Produces: `HostResolution` adds `{ kind: 'member'; meetupMemberId; discordUserId }`; `HostSession.role: 'host' | 'member'`; `MEMBER_PATHS` (exported from `hostRouter.ts`) = `['/', '/wrapped', '/wrapped/rebuild', '/logout']`; `NOT_LINKED_MEETUP_MESSAGE` in `hostLayout.ts`; `hostLayout({ user: { username, csrfToken, role? } })` filters nav: member → Home · Wrapped; host → Home · Calendar · My history · Wrapped (`HOST_NAV_ITEMS` gains `{ key: 'wrapped', path: '/host/wrapped', label: 'Wrapped' }`).
- `admit()`: `member` → session `{ tier: 'regular', role: 'member' }`; `host` → `role: 'host'`. Gate re-check patches `role`. `liveSession` fills `role: 'host'` when absent. `isExtra` accepts `role` undefined/'host'/'member'.
- A member-role request to a path outside `MEMBER_PATHS` → `fail(res, 403)` in `protectedRouter`, after the unsafe-method guard, before `pages`.

- [ ] Tests: eligibility `member` for linked non-host (count read), `not-linked` for unlinked Meetup non-host, `publishTier(member) === 'regular'`; router matrix with `resolve` → member: `/host` 200 (text contains "Your Wrapped", not "Your upcoming events", not "Host an event"), `/host/wrapped` reaches the pages hook (echo route), and 403 for `/host/calendar`, `/host/history`, `/host/create`, `POST /host/link/discord`, `POST /host/verify/finish`, `POST /host/events/1/announce`; a host still gets 200 on an echo `/calendar`; the stored session has `"role":"member"`; a session JSON written without `role` is read as host (echo prints `host`); re-check from host to member succeeds (no sign-out) and back.
- [ ] Run → fail. Implement. Run `yarn vitest run tst/web/host tst/lib/hosts` → pass. Commit "Host dashboard: linked members get a member role".

### Task 3: `displayName` through the bot

**Files:** Modify `src/web/host/serverJoin.ts`; test `tst/web/host/serverJoin.test.ts`.

**Interfaces:** `displayName(getClient, discordUserId, timeoutMs = 2000): Promise<string | undefined>`: guild member cache hit → `member.displayName`; else `guild.members.fetch(id)` raced against the timeout; Unknown Member/User, timeout, no client → `undefined`.

- [ ] Tests (fake client with `guilds.fetch` → `{ members: { cache: Map, fetch } }`): cache hit without fetch; fetch fallback; unknown → undefined; no client → undefined.
- [ ] Implement, run, commit "serverJoin: displayName via the bot".

### Task 4: `wrappedPage.ts` orchestration and rendering

**Files:**

- Create: `src/web/host/wrappedPage.ts`
- Test: `tst/web/host/wrappedPage.test.ts`

**Interfaces:**

```ts
export interface WrappedPageDeps {
  cache: () => Promise<KeyValueCache>; // ApplicationCache, not the 2 s timed one
  memberToken: (discordUserId: string) => Promise<string | undefined>;
  meetupClient: (accessToken: string) => WrappedMeetup;
  organizerRsvps: BuildDeps['organizerRsvps'];
  findByMeetupId: CompanionDeps['findByMeetupId'];
  isPresent: CompanionDeps['isPresent'];
  displayName: (discordUserId: string) => Promise<string | undefined>;
  limiter: FixedWindowLimiter; // wrappedBuildLimiter in production
  alert: (entry: LogEntry) => Promise<unknown>;
  groupId: string;
  now?: () => Date;
  deadlineMs?: number; // 20_000
}
export const WRAPPED_PATH = '/host/wrapped';
export const FIRST_WRAPPED_YEAR = 2015;
export function wrappedYear(query: unknown, now: Date): number;
export function yearList(
  thisYear: number,
  ...wrapped: (CachedWrapped | undefined)[]
): number[]; // desc
export function wrappedBody(args: {
  session: HostSession;
  wrapped: CachedWrapped;
  years: number[];
  displayNames: Record<string, string>;
  notice?: SafeHtml | '';
}): SafeHtml;
export function registerWrappedPage(
  router: express.Router,
  deps: WrappedPageDeps,
): void; // GET /wrapped, POST /wrapped/rebuild
```

- Notice codes for `?notice=`: `rate-limited` (with minutes in a second param `?retry=N`), `mismatch`, `not-in-group`, `building`, `slow`, `failed`, `no-token`; each a fixed text.
- A session with `discordUserId === null` → a page with the link nudge (200), no Meetup call.

- [ ] Tests, each through `createHostRouter` + `registerWrappedPage` with the hostHarness and a fake `WrappedMeetup` (as `tst/lib/wrapped/handlers.test.ts` builds one): cache hit renders without `memberToken`; `wrappedYear` cases from Review Focus 5; `yearList(2026, w2024{activeYears:[2019,2021,2024]}, undefined)` → `[2026, 2024, 2021, 2019]`; miss + token → builds, writes `wrapped:v3:<id>:2026`, renders, and afterwards `limiter.take(id)` is false; limiter already taken → `rate-limited` notice, no Meetup call, cached copy shown when present; lease held → `building` page; `deadlineMs: 5` with a slow Meetup → `slow` page, then the cache fills and the lease is gone; Meetup `ClientError` with a sentinel body → 503, sentinel absent from HTML and alert, alert contains "HTTP 500", `limiter.take` true again; no token → connect page linking `/host/auth/meetup/start`; unlinked session → link nudge; zero-event fixture renders "quiet year"; privacy: an unlinked attendee `{ id: 'ghost-7', name: 'Ghost Person' }` appears nowhere in the HTML, a linked present one appears by `displayName`, an unresolvable linked one is folded into the count; `POST /wrapped/rebuild` with CSRF rebuilds and 303s to `/host/wrapped?year=2026`.
- [ ] Run → fail. Implement. Run → pass. Commit "Host dashboard: /host/wrapped".

### Task 5: Home page for members, wiring, preview

**Files:**

- Modify: `src/web/host/hostPages.ts` (member home branch; Wrapped button on the host home), `src/web/host/hostDeps.ts` (register `registerWrappedPage` with production deps), `src/web/host/hostLayout.ts` (login copy mentions members)
- Test: `tst/web/host/hostPages.test.ts`, `tst/web/host/hostDeps.test.ts`
- Preview: `.claude/preview.mts`, `.claude/launch.json` (copied from `.claude/worktrees/adoring-carson-6febb1/.claude/`, extended with a fake Wrapped + member sign-in), gitignored if `.claude/` is not tracked.

- [ ] Tests: member home shows the Wrapped card and link status, calls no `fetchGroupEvents`; host home still lists events and gains a "Your Wrapped" button; `hostRouterFromEnv` wires `registerWrappedPage` (deps test asserts the route answers when configured).
- [ ] Implement; run `yarn test`; preview at 360/1280 light/dark via the Browser pane; commit "Host dashboard: member home, Wrapped wiring, preview".

### Task 6: Integration test across both front doors

**Files:** Create `tst/integration/wrappedFrontDoors.test.ts`.

- [ ] With `RedisCache.instance()`: build through `registerWrappedPage`'s app (fake Meetup) → `readWrapped(cache, id, year, meetupId)` returns it with TTL ≈ season; then `runWrapped` (mock interaction, `cache: () => redis`) replies with the embed and never calls its Meetup client; reverse: `writeWrapped` as Discord would, then the web page renders it without `memberToken`.
- [ ] Run `yarn test:integration tst/integration/wrappedFrontDoors.test.ts` against redis :56379. Commit.

### Task 7: Finish

- [ ] `yarn lint`, `npx tsc --noEmit`, `npx prettier --check`, `yarn test`, integration. Push, open the PR (do not merge), report PR URL and BASE..HEAD to the "MeetupBot - lead" session.
