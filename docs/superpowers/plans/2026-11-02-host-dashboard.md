# Host Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give hosts their own signed-in site (`/host`) to pick a day, see their hosting pattern, create or copy events, announce them, and read their comments; and give the 1.5 Leadership Team the approval queue and promotion tools on the staff dashboard.

**Architecture:** A second Express router mounted at `/host`, built from the staff dashboard's security pieces (HMAC'd OAuth cookie, Redis sessions with revocation, nonce CSP, CSRF guard, rate limits, the `html` guard) but with its own cookies, MAC domains and session key, keyed by **Meetup member id**. Every Meetup read and write goes through the shared organizer credential (`withOrganizerMeetup`). Leadership pages live on the existing staff dashboard (`/dashboard/hosts/...`), so Moderators can view them through the existing gate, and actions check the 1.5 Leadership Team role live.

**Tech Stack:** TypeScript ESM (imports end in `.js`), Express 5, discord.js/discordx, pg, Redis, vitest, nock (network blocked in every test).

**Spec:** `docs/superpowers/specs/2026-11-02-host-dashboard-design.md` (PR duyhai/MeetupDiscordBot#126). Builds on `2026-10-15-staff-dashboard-design.md` and `2026-10-17-dashboard-two-tone-design.md`.

## Step 0 findings (2026-11-03, read-only)

1. **Organizer credential can write (by evidence, not by a real write).**
   - Grant: every Meetup token this app holds, the organizer credential and members' personal tokens alike, comes from the same OAuth client with the `basic` scope (`BASIC_MEETUP_AUTH_SCOPES`, `buildMeetupAuthUrl`). The Discord approve flow already calls `createEvent`, `closeEventRsvps`, `editEvent` and `announceEvent` with personal tokens of that scope, so the scope is not what gates these mutations.
   - Account: the organizer credential's account matches `MEETUP_ORGANIZER_MEMBER_ID` and its group membership is `status: LEADER, role: ASST_ORGANIZER`. Meetup's help ("Managing a leadership team") says Assistant Organizers can "Schedule, edit, and cancel events" and "Contact members". The Discord approve flow admits any `LEADER`, so the same rights already create events today.
   - Remaining risk: only a real write proves it. **PR 2 starts with a gated check**: with Hai's go-ahead, create one `publishStatus: DRAFT` event with the organizer credential and delete it. Nothing in PR 1 writes to Meetup.
2. **Event hosts can take attendance.** Meetup's help ("Managing a leadership team", Event hosts section) lists for a non-leadership event host: "Manage attendees", "Close or open RSVPs" and "Check-in attendees". The attendee list's check-in actions include No show. The attendance link is the event's attendee page, `<eventUrl>attendees/`.
3. **Venue can be set.** `CreateEventInput` has `venueId: String`, `venueIds: [String!]`, `venueOptions`, `venueVisibility`, `howToFindUs` and `location`. Copy sets `venueId` from the source event's `venue.id` and copies `howToFindUs`. (The design's "CreateEventInput has no venue field" is out of date.)
4. Also seen: `Event` has no "announced" field, so announcing is tracked in our own table (PR 3). `AnnounceEventPayload` has `errors: [PayloadError!]`.

## Global Constraints

- Promoted prefix: `[Community Host] ` in one exported constant `COMMUNITY_HOST_PREFIX`; regular stays `[Guest Host] `.
- Leadership = role `1347289004932075521` (`SERVER_ROLES.leadership`) only, checked live at the moment of each approve/deny/promote/demote/override. Moderators view only.
- Alerts: plain messages in `#meetup-bot-alerts` (`BOT_ALERTS_CHANNEL_ID`, 1537755631602237473), `allowedMentions: { parse: [] }`, never a role ping.
- Promotion candidates: regular hosts with **20+** hosted (PAST) events.
- Tier re-check: every **10 minutes** (`ROLE_RECHECK_MS`); session lifetime 12 h absolute.
- Announce: host-triggered only, at most once per event, recorded before calling, under a lock.
- No-shows: a link to Meetup's attendee page; nothing stored, nothing written to Meetup.
- The bot stores comments only; flags come from Hai's task through a narrow write path.
- Never call `updateGroupMembershipRole`. Hosts never get organizer rights.
- Every page: `Cache-Control: no-store`, nonce CSP from `baseSecurityHeaders`, all markup through `html`, no inline `style=`, literal class names only, CSS only in `STYLE` (`src/web/pages.ts`).
- Two-Tone: blurple = action, coral = attention, green = done; works at 360 px with no sideways page scroll.
- Integration tests: throwaway `postgres:16` on :55432 and `redis:7` on :56379, never the dev stack on 5432.
- Every new `@Discord()` class is registered in `src/commands/index.ts`.

## Review Focus

1. **A staff cookie or OAuth cookie presented to `/host` (and the reverse).** Must be refused: different MAC domains (`host-sid:`, `host-oauth:`) and cookie names/paths. Test in Task 2 and Task 6.
2. **A Discord user with no linked Meetup account signs in with Discord.** Expect a page that says to sign in with Meetup or link in Discord, and no session. Test in Task 6.
3. **A Meetup callback whose state is not ours, or a `host-` state replayed in another browser.** `/connect/meetup/callback` forwards only `host-` states without touching Redis; the host completion route needs the sealed cookie. Test in Task 5 and Task 6.
4. **A host who loses eligibility (blacklisted, or the organizer credential is down) mid-session.** Re-check at 10 minutes: ineligible → every session of that member revoked, 403; Meetup unreachable → 503 and the session kept. Test in Task 6.
5. **Hostile event titles and names** (HTML, RTL overrides, very long) on home, calendar and history. Escaped, wrapped in `<bdi>`, no layout break. Test in Task 8.

---

# PR 1: Sign-in (Discord and Meetup), host home, calendar, history

Branch `feat/host-dashboard-signin` off `main`. No Meetup writes, no new Discord commands.

## File structure

| File | Responsibility |
|---|---|
| `src/web/session.ts` (modify) | `SessionStore` gains options (key prefix, revocation prefix, user-id pattern, extra-field check); MAC domain parameter on sign/verify. Defaults unchanged. |
| `src/web/oauthCookie.ts` (modify) | MAC domain parameter, default `oauth:`. |
| `src/web/pages.ts` (modify) | `layout` gains `site: 'staff' \| 'host'` (brand, nav, sign-out path, title suffix); host nav; host and heat-map/calendar CSS in `STYLE`. |
| `src/lib/repositories/postgresPromotedHostRepository.ts` (new) | `promoted_hosts` + `promoted_host_events` schema; `isPromoted(memberId)`. Writes come in PR 3. |
| `src/lib/hosts/eligibility.ts` (new) | `resolveHost(deps, who)` → eligible/refused + tier; Meetup blacklist constant. |
| `src/lib/hosts/eventTypes.ts` (new) | Keyword event-type classifier, `stripHostPrefix`. |
| `src/lib/hosts/holidays.ts` (new) | US holidays computed per year + static cultural dates. |
| `src/lib/hosts/hostEvents.ts` (new) | Organizer reads: hosted past/upcoming events, group calendar; short in-process cache. |
| `src/web/host/meetupSignIn.ts` (new) | Meetup authorize URL with a `host-` state, code exchange reuse, minimal `self { id name }` lookup. |
| `src/web/host/hostRouter.ts` (new) | Public sign-in routes, gate with tier re-check, unsafe-method guard, logout, error handler. |
| `src/web/host/hostPages.ts` (new) | Home, calendar, history pages; heat map SVG. |
| `src/web/host/hostDeps.ts` (new) | Production wiring, `hostRouterFromEnv`. |
| `src/app.ts` (modify) | Forward `host-` Meetup states; mount `/host`. |

### Task 1: Plan and Step 0 record

**Files:** Create `docs/superpowers/plans/2026-11-02-host-dashboard.md`.

- [ ] **Step 1:** Commit this plan: `git commit -m "Plan the host dashboard"`.

### Task 2: Session and cookie primitives take a domain

**Files:**
- Modify: `src/web/session.ts`, `src/web/oauthCookie.ts`
- Test: `tst/web/session.test.ts`, `tst/web/oauthCookie.test.ts`

**Interfaces:**
- Produces:
  - `signSessionId(sid, secret, domain = 'sid')`, `verifySignedSessionId(value, secret, domain = 'sid')`.
  - `sealOAuthCookie(payload, secret, domain = 'oauth')`, `openOAuthCookie(value, secret, now, domain = 'oauth')`.
  - `interface SessionStoreOptions<S> { keyPrefix: string; validAfterPrefix: string; userIdPattern: RegExp; isExtra?: (v: Record<string, unknown>) => boolean }`, and `DASHBOARD_SESSION_OPTIONS` (today's values: `dashboard-session-`, `dashboard-user-valid-after-`, `/^[0-9]{17,20}$/`).
  - `class SessionStore<S extends DashboardSession = DashboardSession>`: `constructor(cache, now = Date.now, options = DASHBOARD_SESSION_OPTIONS)`; `create(user: Omit<S, 'csrfToken' | 'createdAt' | 'roleCheckedAt'>)`; `markRoleChecked(sid, session, patch?: Partial<S>)` (patch lets the tier change on re-check).

- [ ] **Step 1: Failing tests**
  - `a host-domain session id does not verify as a staff one`: `verifySignedSessionId(signSessionId('x', S, 'host-sid'), S)` is `undefined`, and the reverse.
  - `a host-domain OAuth cookie does not open as a staff one`, likewise.
  - `options change the Redis keys`: a store with `keyPrefix: 'host-session-'` writes a key starting `host-session-`; `revokeUser('12345')` with `userIdPattern: /^[0-9]{1,20}$/` writes `host-user-valid-after-12345`.
  - `isExtra rejects a stored session missing an extra field`.
  - `markRoleChecked applies the patch`.
- [ ] **Step 2:** `yarn vitest run tst/web/session.test.ts tst/web/oauthCookie.test.ts` → FAIL.
- [ ] **Step 3:** Implement. The MAC input becomes `${domain}:${value}`.
- [ ] **Step 4:** Run the whole `tst/web` suite → PASS (staff behaviour unchanged).
- [ ] **Step 5:** Commit.

### Task 3: Promoted-hosts table (read side)

**Files:**
- Create: `src/lib/repositories/postgresPromotedHostRepository.ts`
- Test: `tst/integration/postgresPromotedHostRepository.test.ts`

**Interfaces:**
- Produces: `PostgresPromotedHostRepository.instance()`, `isPromoted(meetupMemberId: string): Promise<boolean>`, `PROMOTED_HOST_SCHEMA`.
- Schema (ensured on first use, like the other repositories):
  - `promoted_hosts(meetup_member_id TEXT PRIMARY KEY, active BOOLEAN NOT NULL, reason TEXT NOT NULL, changed_by TEXT NOT NULL, changed_at TIMESTAMPTZ NOT NULL, version INT NOT NULL DEFAULT 1)`.
  - `promoted_host_events(id BIGSERIAL PRIMARY KEY, meetup_member_id TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('promote','demote')), reason TEXT NOT NULL, actor_discord_id TEXT NOT NULL, version INT NOT NULL, at TIMESTAMPTZ NOT NULL)`, append-only (a trigger refuses UPDATE and DELETE).

- [ ] **Step 1: Failing test** (`isolatedSchema`): an empty table → `false`; a row `active = true` → `true`; `active = false` → `false`; a non-digit id → `false` without querying.
- [ ] **Step 2:** Run with `DATABASE_URL=postgres://postgres:postgres@localhost:55432/postgres yarn test:integration tst/integration/postgresPromotedHostRepository.test.ts` → FAIL.
- [ ] **Step 3:** Implement, following `PostgresBanRepository`'s instance/schema pattern.
- [ ] **Step 4:** PASS. **Step 5:** Commit.

### Task 4: Who is a host, and which tier

**Files:**
- Create: `src/lib/hosts/eligibility.ts`; modify `src/constants.ts` (add `GUEST_HOST_MEETUP_BLACKLIST: string[] = []`, `COMMUNITY_HOST_PREFIX = '[Community Host] '`, `GUEST_HOST_PREFIX = '[Guest Host] '`).
- Test: `tst/lib/hosts/eligibility.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type HostTier = 'regular' | 'promoted';
  export interface HostResolveDeps {
    discordIdForMeetup(meetupId: string): Promise<string | undefined>;
    meetupIdForDiscord(discordId: string): Promise<string | undefined>;
    hasGuestHostRole(discordId: string): Promise<boolean>; // live; throws when Discord is unreachable
    pastHostedCount(meetupId: string): Promise<number>;    // organizer credential; throws when unreadable
    isPromoted(meetupId: string): Promise<boolean>;
  }
  export type HostResolution =
    | { kind: 'host'; meetupMemberId: string; discordUserId?: string; tier: HostTier; hostedCount: number }
    | { kind: 'refused'; reason: 'not-linked' | 'blacklisted' | 'not-a-host' };
  export function resolveHost(deps: HostResolveDeps, who: { meetupMemberId: string } | { discordUserId: string }): Promise<HostResolution>;
  ```
- Rules (spec "Users and tiers"): Discord path with no linked Meetup id → `not-linked`. Blacklisted if the Discord id is in `GUEST_HOST_BLACKLIST` or the Meetup id is in `GUEST_HOST_MEETUP_BLACKLIST` → `blacklisted` (checked before any Meetup read). Host if Guest Host role (when a Discord id is known) or `pastHostedCount ≥ 1`. Tier `promoted` if `isPromoted`. A dependency that throws propagates (the caller answers 503).

- [ ] **Step 1: Failing tests:** one per rule, for both paths: `discord path, linked, Guest Host role → host regular`; `meetup path, unlinked, 3 past events → host regular, no discordUserId`; `meetup path, linked Discord id blacklisted → blacklisted, pastHostedCount not called`; `meetup id blacklisted`; `0 events and no role → not-a-host`; `promoted row → tier promoted`; `discord path unlinked → not-linked`; `pastHostedCount throws → rejects`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit.

### Task 5: Meetup sign-in plumbing

**Files:**
- Create: `src/web/host/meetupSignIn.ts`; modify `src/lib/client/oauth/providers.ts` (export `meetupRedirectUri`), `src/app.ts`.
- Test: `tst/web/host/meetupSignIn.test.ts`, `tst/app.test.ts` (add cases).

**Interfaces:**
- Produces:
  - `HOST_STATE_PREFIX = 'host-'`; `newHostState(): string` (`host-` + 32 random base64url chars); `isHostState(s: string): boolean` (`/^host-[A-Za-z0-9_-]{32,64}$/`).
  - `buildHostMeetupAuthUrl(state: string): string` (same authorize endpoint, client, `basic` scope and redirect URI as `buildMeetupAuthUrl`).
  - `fetchMeetupSelf(accessToken: string): Promise<{ id: string; name: string }>`: `query { self { id name } }` on `Configuration.meetup.endpoint`, `boundedFetch` 10 s, id must match `/^[0-9]{1,20}$/`. Never logs the body. The token is used once and dropped.
- `app.ts`: in `meetupConnectCallbackHandler`, before `resolveOAuthState`, an `isHostState(state)` state is forwarded `302` to `/host/auth/meetup/complete?state=…&code=…&error=…` (each a single string, as for `organizer-renew`). Redis is not read or written.

- [ ] **Step 1: Failing tests:** `forwards a host- state without reading Redis` (cache spy untouched, Location path exact); `a host- state with extra params forwards only state, code, error`; `a malformed host- state is not forwarded` (falls through to the expired page); `fetchMeetupSelf rejects a non-digit id`; nock for the GraphQL call.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit.

### Task 6: The host router

**Files:**
- Create: `src/web/host/hostRouter.ts`, `src/web/host/hostSession.ts`; modify `src/web/pages.ts` (`layout` `site`, host login/error pages), `src/web/discordOAuth.ts` (`hostRedirectUri()`, `buildHostLoginUrl`, `exchangeHostCode` sharing the existing code with a redirect parameter).
- Test: `tst/web/host/hostHarness.ts`, `tst/web/host/hostRouter.auth.test.ts`, `tst/web/host/hostRouter.session.test.ts`.

**Interfaces:**
- Consumes: Task 2 primitives, Task 4 `resolveHost`, Task 5 helpers, `baseSecurityHeaders`, `FixedWindowLimiter`, cookies helpers.
- Produces:
  ```ts
  export interface HostSession extends DashboardSession { // userId = Meetup member id, username = display name
    discordUserId: string | null; tier: HostTier; via: 'discord' | 'meetup';
  }
  export const HOST_SESSION_OPTIONS: SessionStoreOptions<HostSession>; // 'host-session-', 'host-user-valid-after-', /^[0-9]{1,20}$/
  export interface HostRouterDeps {
    cache: () => Promise<KeyValueCache>;
    resolve: (who: { meetupMemberId: string } | { discordUserId: string }) => Promise<HostResolution>;
    discord: DashboardOAuth;                 // host redirect URI
    meetup: { buildAuthUrl(state: string): string; exchangeCode(code: string): Promise<string>; fetchSelf(token: string): Promise<{ id: string; name: string }> };
    sessionSecret: string; origin: string; requireHttps?: boolean;
    audit: (entry: LogEntry) => Promise<unknown>;
    now?: () => number; loginLimiter?: FixedWindowLimiter; actionLimiter?: FixedWindowLimiter; refusedAuditLimiter?: FixedWindowLimiter;
    pages?: (router: express.Router) => void; // mounted behind the gate and the guard
  }
  export function createHostRouter(deps: HostRouterDeps): express.Router;
  export function hostLocals(res: Response): { session: HostSession; sid: string; nonce: string };
  ```
- Routes: `GET /login`; `GET /auth/discord/start`, `GET /auth/discord/callback`; `GET /auth/meetup/start`, `GET /auth/meetup/complete`; gated `POST /logout`, plus `pages`. Cookies: `host_oauth` (path `/host/auth`, MAC domain `host-oauth`, holds state + PKCE verifier for Discord or state alone for Meetup, plus which provider), `host_sid` (path `/host`, MAC domain `host-sid`).
- Gate: same as the staff gate, but the re-check calls `resolve({ meetupMemberId })` (Meetup path) and also the Discord id when the session has one: `host` → `markRoleChecked(sid, session, { tier, discordUserId })`; `refused` → `revokeUser(memberId)`, audit "Host session ended", 403; throw → 503, session kept. Single-flight per member, like `recheckRole`.
- Copy (fixed text): refused `not-linked` → "Your Discord account is not linked to Meetup yet. Sign in with Meetup instead, or press Verify in our Discord server to link it."; `not-a-host`/`blacklisted` → 403 "The host dashboard is for members who have hosted an event with us." (the same text for both, so a blacklist is not revealed).

- [ ] **Step 1: Failing tests** (harness mirrors `tst/web/dashboardHarness.ts`): signed-out GET → 302 `/host/login`; Discord sign-in → `host_sid` set, `resolve` called with `{ discordUserId }`; Meetup start → Location is the Meetup URL with a `host-` state and `host_oauth` set; Meetup complete without the cookie → 400; with the cookie but another state → 400; happy path → session with `via: 'meetup'`; `not-linked` → 403 with the link copy, no cookie; `not-a-host` → 403; a `dash_sid` cookie signed by the staff domain → treated as signed out; tier re-check after 10 min: promoted → session tier updated; refused → 403 and a second browser's session also refused; resolve throws → 503 and the session still works after; POST without CSRF → 403; `/host/logout` clears the cookie; every response carries the CSP and `no-store`.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit.

### Task 7: Host data (organizer reads, types, holidays)

**Files:**
- Create: `src/lib/hosts/eventTypes.ts`, `src/lib/hosts/holidays.ts`, `src/lib/hosts/hostEvents.ts`; modify `src/lib/client/meetup/queries.ts` + `gqlClient.ts` only if the existing `getGroupEvents` lacks a needed field (it has id, title, dateTime, eventUrl, eventHosts, status).
- Test: `tst/lib/hosts/eventTypes.test.ts`, `tst/lib/hosts/holidays.test.ts`, `tst/lib/hosts/hostEvents.test.ts`.

**Interfaces:**
- Produces:
  - `EVENT_TYPES = ['games','food','outdoors','active','arts','nightlife','learning','social'] as const`, `EventType`, `EVENT_TYPE_LABELS: Record<EventType, string>`, `classifyEventType(title: string): EventType` (first keyword match after `stripHostPrefix`, word-boundary, case-insensitive; `social` when nothing matches), `stripHostPrefix(title)` (removes a leading `[Guest Host] ` or `[Community Host] `, repeatedly).
    - Keywords: games: board game, game night, trivia, mahjong, poker, escape room, puzzle; food: dinner, lunch, brunch, breakfast, food, boba, cafe, coffee, dim sum, hot pot, hotpot, kbbq, bbq, ramen, potluck, baking, cooking, restaurant, tea; outdoors: hike, hiking, beach, picnic, park, camping, kayak, biking, bike, garden; active: volleyball, badminton, basketball, pickleball, tennis, bowling, climbing, bouldering, yoga, run, running, gym, soccer, dance, dancing, skating; arts: museum, art, painting, pottery, craft, movie, film, concert, theater, theatre, book club, photography; nightlife: karaoke, bar, drinks, happy hour, club, rooftop, wine; learning: workshop, talk, panel, class, networking, career, language.
  - `calendarDates(fromDay: string, toDay: string): { day: string; name: string; kind: 'holiday' | 'cultural' }[]` (YYYY-MM-DD, Pacific). US federal holidays computed by rule (New Year's Day, MLK Day 3rd Mon Jan, Presidents Day 3rd Mon Feb, Memorial Day last Mon May, Juneteenth Jun 19, Independence Day Jul 4, Labor Day 1st Mon Sep, Columbus/Indigenous Peoples' Day 2nd Mon Oct, Veterans Day Nov 11, Thanksgiving 4th Thu Nov, Christmas Dec 25) plus Valentine's Day, Mother's Day (2nd Sun May), Father's Day (3rd Sun Jun), Halloween, Christmas Eve, New Year's Eve. `CULTURAL_DATES` static list (leadership adds more): Lunar New Year 2026-02-17, 2027-02-06, 2028-01-26; Mid-Autumn Festival 2026-09-25, 2027-09-15, 2028-10-03.
  - ```ts
    export interface HostEvent { id: string; title: string; dateTime: string; eventUrl: string; type: EventType; hosts: { id: string; name: string }[] }
    export interface HostEventsDeps { fetchGroupEvents(filter: GroupEventFilter): Promise<HostEvent[]>; now(): Date }
    export function hostedEvents(deps, memberId: string, which: 'past' | 'upcoming'): Promise<HostEvent[]>; // PAST / ACTIVE, hostId filter, newest first for past, soonest first for upcoming
    export function groupCalendar(deps, weeks = 8): Promise<{ days: CalendarDay[] }>; // ACTIVE events from the Monday of this Pacific week for `weeks` weeks
    export interface CalendarDay { day: string; events: HostEvent[]; busy: 0 | 1 | 2 | 3; dates: { name: string; kind: 'holiday' | 'cultural' }[] }
    export function attendanceUrl(eventUrl: string): string | undefined; // `${eventUrl}attendees/` for https://www.meetup.com/... URLs only
    ```
  - Production `fetchGroupEvents` = `withOrganizerMeetup` + `getPaginatedData(getGroupEvents)`, cached in-process 5 minutes per filter (max 200 entries, single-flight), so a page load is at most one Meetup round per list.
  - `busy`: 0 events → 0, 1 → 1, 2 → 2, 3+ → 3.

- [ ] **Step 1: Failing tests:** classifier table (`'[Guest Host] Board Game Night'` → games; `'Hot Pot Dinner'` → food (first type in order wins); `'Barbecue'` → social (word boundary: "bar" does not match); `'[Community Host] [Guest Host] Hike'` → outdoors); holidays (2026: Thanksgiving 2026-11-26, Memorial Day 2026-05-25, MLK 2026-01-19; range filter inclusive); calendar (56 days starting Monday 2026-11-02 when now is 2026-11-03 Pacific; an event at 23:30 Pacific lands on its Pacific day; busy levels); `attendanceUrl` refuses a non-Meetup URL.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit.

### Task 8: Host pages and styling

**Files:**
- Create: `src/web/host/hostPages.ts`, `src/web/host/heatMap.ts`; modify `src/web/pages.ts` (`STYLE`, host nav).
- Test: `tst/web/host/hostPages.test.ts`, `tst/web/host/heatMap.test.ts`, `tst/web/contrast.test.ts` (new pairs).

**Interfaces:**
- Consumes: Task 6 `hostLocals`, Task 7 data functions.
- Produces: `registerHostPages(router, deps: HostPageDeps)` with `GET /` (home), `GET /calendar`, `GET /history?type=<EventType>`; `heatMap(days: Map<string, number>, endDay: string): SafeHtml` (53 weeks ending at `endDay`, Sunday-first columns, literal classes `hm0`…`hm4` for 0, 1, 2, 3–4, 5+ events, `<title>` per cell "YYYY-MM-DD: n events", plus a text total for screen readers).
- Home: greeting with `memberText(name)`, tier pill (Regular host / Community Host), upcoming hosted events (date, title, type, "View on Meetup"), the next 14 days' group load in one line, a nudge card when `discordUserId` is null ("Link your Discord account…"), links to Calendar and History. Pending approval and announced statuses arrive in PR 2/3.
- Calendar: 8-week grid (`table` with literal column headers Mon…Sun; each cell the day number, the event count with a busy class `busy0`…`busy3`, and holiday names), and below it a list of each day with events (time, title, hosts). On < 640 px the grid shows counts only and the list carries the detail.
- History: type filter as links (`?type=`; an unknown value is ignored), heat map for the last 53 weeks of the host's past events, counts per type, and the past-events list (date, title, type, "View on Meetup", "Take attendance on Meetup" via `attendanceUrl`), paginated 50 (`paging.ts`).
- A Meetup outage renders the 503 "unavailable" page (`OrganizerTokenUnavailableError` or any fetch error), never a partial page.

- [ ] **Step 1: Failing tests:** each page 200 for a host, hostile titles (`<script>`, `"><img>`, U+202E) escaped in `<bdi>`; unknown `?type=x` → unfiltered; empty history → "No past events yet"; Meetup failure → 503 page; heat-map cell count 371 (53×7) and class mapping; contrast pairs for the new busy/heat colours (3:1 non-text against `--surface`, both modes).
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit.

### Task 9: Production wiring

**Files:**
- Create: `src/web/host/hostDeps.ts`; modify `src/app.ts`, `src/index.ts` (hand the Discord client to the host deps on ready, like `setDashboardClient`).
- Test: `tst/web/host/hostDeps.test.ts`, `tst/integration/app.routes.test.ts` (add `/host` cases).

**Interfaces:**
- Produces: `hostRouterFromEnv(env = process.env): express.Router` (disabled page when `DASHBOARD_SESSION_SECRET` is missing, like the staff one); `setHostClient(client)`.
- Production deps: `resolve` from Task 4 with `PostgresMemberRepository` (`findByMeetupId`, `findByDiscordId`), `discordRoleCheck(getClient, SERVER_ROLES.guest_host)`, organizer `getGroupEventsCount({ status: ['PAST'], hostId })`, `PostgresPromotedHostRepository.isPromoted`; cache = the dashboard's timed cache; audit = `logActivity` (no pings).

- [ ] **Step 1: Failing tests:** `/host/login` 200 through `app` with CSP; `/host` signed out → 302; `/connect/meetup/callback?state=host-…` → 302 to `/host/auth/meetup/complete`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Full `yarn test`, `yarn lint`, `yarn tsc --noEmit`, integration suite on :55432/:56379 → all PASS. Commit.
- [ ] **Step 6:** Browser check at 360/768/1280, light and dark, through the real router with fixture data: login, home, calendar, history, error page.

**Hai, before PR 1 works in production:** add `https://meetup-discord-bot.herokuapp.com/host/auth/discord/callback` as a redirect URI in the Discord developer portal (OAuth2). Meetup needs nothing: the Meetup sign-in reuses `/connect/meetup/callback`. No new config vars.

---

# PR 2: Create/copy, approval queue, promoted direct publish

Detailed per-task steps get written when PR 1 merges; the decisions are fixed here.

- **Task 0 (gated on Hai):** confirm the organizer credential can write: one `createEvent` with `publishStatus: DRAFT`, then `deleteEvent`, run as a Heroku one-off outside 18:00–19:00 UTC. If it fails, stop and report.
- **`event_requests` table:** `id`, `meetup_member_id`, `discord_user_id` (nullable), `kind` (`fresh`/`copy`), `source_event_id`, `title`, `description`, `start_at`, `duration_min`, `rsvp_limit`, `guest_limit`, `featured_photo_id`, `venue_id`, `how_to_find_us`, `status` (`pending`/`approved`/`denied`/`publishing`/`published`/`failed`), `deny_reason`, `decided_by`, `decided_at`, `meetup_event_id`, `event_url`, `version`, timestamps; plus `event_request_events` append-only history.
- **Create page** (`/host/create`, `/host/create?copy=<eventId>`): day picked from the calendar; fresh pre-fills `GUEST_HOST_EVENT_DESCRIPTION` (regular hosts get the Host Tip prepended, as the Discord flow does); copy only from the host's own past events (checked against `eventHosts`), keeps title minus prefix, description, duration, start time, RSVP settings, featured photo, venue id and how-to-find-us, no tip added.
- **One publish path** `publishRequest(requestId)`: organizer credential, under a Redis lock `event-request-<id>`, status `pending → publishing` by compare-and-set before any Meetup call; prefix `GUEST_HOST_PREFIX` or `COMMUNITY_HOST_PREFIX` by the tier at submit time re-checked at publish; `eventHosts: [host]`; close RSVPs and re-apply `rsvpSettings`; `createEventWithPhotoFallback`. The created event id is written as soon as `createEvent` returns, so a retry continues from "created" instead of creating again; failure text says what was created and what to fix by hand.
- **Queue** on the staff dashboard (`/dashboard/hosts/requests`): Moderators view; Approve / Deny (reason required) are 1.5 Leadership Team only, checked live; stale `version` refused.
- **Promoted publish:** immediate `publishRequest`, then the plain alert. **Regular submit:** plain alert "new request". The Discord `/meetup_request_event` flow is untouched and does not appear in the queue (builder's call: it already has its own Approve/Deny message).
- Tests: approve idempotency under concurrent clicks (two approvals → one `createEvent`), prefix per tier, copy fidelity, a host cannot copy someone else's event.

# PR 3: Promotion, comments, announcing

- **Promotion** (`/dashboard/hosts/candidates`): regular hosts with 20+ PAST hosted events (from the identity links' Meetup ids plus hosts seen in group events), each with heat map, count, last hosted date, issues (flagged comments first, "show all"). Promote/demote with a required reason, leadership only, live check; writes `promoted_hosts` + `promoted_host_events`; first promote is `INSERT … ON CONFLICT (meetup_member_id) DO NOTHING` (no row back = a concurrent promote won), later changes `UPDATE … SET version = version + 1, changed_at = now() WHERE version = $seen`, and each history row records the version it produced; demoting someone never promoted is refused; revokes the member's host sessions so the tier changes at once (the 10-minute re-check is the backstop); plain alert. Per-host heat map page.
- **Comments:** `event_comments` (Meetup comment id key, event id, member id, name, text, created, is_private, parent id, `flagged_at`, `flag_source`, `flag_note`). Daily sweep job (Redis lease, outside 17:45–19:00 UTC) over hosts' events from 60 days back through upcoming, `Event.comments` with replies, organizer credential. Host page `/host/comments` (own events only; private comments only to that event's hosts and leadership). **Flag write path:** a Heroku one-off script `scripts/flagComments.ts` reading JSON `{ commentId, note }[]` from stdin (no new HTTP surface). `host_issues` table for manual entries; the issues list merges both.
- **Announcing:** `event_announcements(meetup_event_id PK, announced_by, requested_at, completed_at, status)`; button on the host's upcoming events (and for leadership); insert-if-absent under a lock before calling `announceEvent`; an "already announced" error counts as done; button disabled after; plain alert. Regular hosts can announce only published events (the request has an event id). No cool-down.
- **Manual event-type correction:** `event_type_overrides(meetup_event_id PK, type, set_by, set_at)`, editable by the event's host and leadership.
