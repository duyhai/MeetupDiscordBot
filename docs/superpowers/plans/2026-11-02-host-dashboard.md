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
| `src/lib/hosts/holidays.ts` (new) | Holidays recognised from event titles by keyword (not dates; Hai's PR 128 review). |
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
  - `matchHolidays(title: string): string[]`: holiday names an event's title mentions, by word-bounded keyword (`HOLIDAYS` list, e.g. Friendsgiving → Thanksgiving, Tết/CNY → Lunar New Year, which shadows New Year's). Never by date: members spend the day itself with family, and the group's celebration is usually on another day (Hai, PR 128 review). Leadership extends the list.
  - ```ts
    export interface HostEvent { id: string; title: string; dateTime: string; eventUrl: string; type: EventType; hosts: { id: string; name: string }[] }
    export interface HostEventsDeps { fetchGroupEvents(filter: GroupEventFilter): Promise<HostEvent[]>; now(): Date }
    export function hostedEvents(deps, memberId: string, which: 'past' | 'upcoming'): Promise<HostEvent[]>; // PAST / ACTIVE, hostId filter, newest first for past, soonest first for upcoming
    export function groupCalendar(deps, weeks = 8): Promise<{ days: CalendarDay[] }>; // ACTIVE events from the Monday of this Pacific week for `weeks` weeks
    export interface CalendarDay { day: string; events: HostEvent[]; busy: 0 | 1 | 2 | 3 }
    export function attendanceUrl(eventUrl: string): string | undefined; // `${eventUrl}attendees/` for https://www.meetup.com/... URLs only
    ```
  - Production `fetchGroupEvents` = `withOrganizerMeetup` + `getPaginatedData(getGroupEvents)`, cached in-process 5 minutes per filter (max 200 entries, single-flight), so a page load is at most one Meetup round per list.
  - `busy`: 0 events → 0, 1 → 1, 2 → 2, 3+ → 3.

- [ ] **Step 1: Failing tests:** classifier table (`'[Guest Host] Board Game Night'` → games; `'Hot Pot Dinner'` → food (first type in order wins); `'Barbecue'` → social (word boundary: "bar" does not match); `'[Community Host] [Guest Host] Hike'` → outdoors); holidays (by title: Friendsgiving → Thanksgiving, Lunar New Year not also New Year's, whole words only); calendar (56 days starting Monday 2026-11-02 when now is 2026-11-03 Pacific; an event at 23:30 Pacific lands on its Pacific day; busy levels); `attendanceUrl` refuses a non-Meetup URL.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit.

### Task 8: Host pages and styling

**Files:**
- Create: `src/web/host/hostPages.ts`, `src/web/host/heatMap.ts`; modify `src/web/pages.ts` (`STYLE`, host nav).
- Test: `tst/web/host/hostPages.test.ts`, `tst/web/host/heatMap.test.ts`, `tst/web/contrast.test.ts` (new pairs).

**Interfaces:**
- Consumes: Task 6 `hostLocals`, Task 7 data functions.
- Produces: `registerHostPages(router, deps: HostPageDeps)` with `GET /` (home), `GET /calendar`, `GET /history?type=<EventType>`; `heatMap(days: Map<string, number>, endDay: string): SafeHtml` (53 weeks ending at `endDay`, Sunday-first columns, literal classes `hm0`…`hm4` for 0, 1, 2, 3–4, 5+ events, `<title>` per cell "YYYY-MM-DD: n events", plus a text total for screen readers).
- Home: greeting with `memberText(name)`, tier pill (Regular host / Community Host), upcoming hosted events (date, title, type, "View on Meetup"), the next 14 days' group load in one line, a nudge card when `discordUserId` is null ("Link your Discord account…"), links to Calendar and History. Pending approval and announced statuses arrive in PR 2/3.
- Calendar: 8-week grid (`table` with literal column headers Mon…Sun; each cell the day number, the event count with a busy class `busy0`…`busy3`, and the holidays its events' titles name), and below it a list of each day with events (time, title, hosts). On < 640 px the grid shows counts only and the list carries the detail.
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

Branch `feat/host-dashboard-create` off `main` (after PR 1, duyhai/MeetupDiscordBot#128, merged).

## Task 0 result (2026-11-03, Hai's go-ahead)

Run as a Heroku one-off by Hai at 19:3x UTC: the organizer credential created draft event 317276522 (`status: DRAFT`, `errors: []`), `deleteEvent` returned `{ success: true, errors: [] }`, and `event(317276522)` then read `null`. **The organizer credential can create and delete events.** `DeleteEventInput` is `{ eventId: ID!, removeFromCalendar: Boolean, updateSeries: Boolean }`.

Schema read without auth (`api.meetup.com/gql-ext` introspection): `Event` has `duration`, `howToFindUs`, `venue { id }`, `featuredEventPhoto { id }`, `maxTickets`, `guestLimit`, `eventHosts`, `status`; `rsvpSettings` on `Event` is only open/close times. `CreateEventInput` takes `venueId`, `howToFindUs`, `featuredPhotoId`, `duration`, `rsvpSettings`.

## Decisions (builder's calls, within the spec)

- **One table, one status machine.** `pending → publishing → published | failed`, `pending → denied`, and `failed → publishing` (retry). A promoted host's request is inserted as `pending` and published at once by the same path; the queue never shows it unless it failed.
- **Postgres compare-and-set is the only guard** against double publishing: `UPDATE … SET status = 'publishing' WHERE id = $1 AND status = ANY($allowed) AND version = $seen RETURNING *`. No Redis lock (the plan's `event-request-<id>` lock is dropped: the CAS alone admits one caller, and a lock that expires mid-publish would add a second path to reason about).
- **A stuck `publishing`** (process died mid-publish) older than 10 minutes can be retried by leadership like `failed`; a younger one cannot.
- **Resume, not repeat.** `meetup_event_id` is written the moment `createEvent` returns. A retry with an event id skips `createEvent` and only re-runs the RSVP steps. A retry with **no** event id first looks for one on Meetup (the host's upcoming events with the request's title under either prefix and its Pacific start) and adopts it, so a crash, timeout or lost write between `createEvent` and recording it never yields a second event (per-task review, 2026-11-03).
- **Owned writes.** `recordCreated` and `finish` take the version the publisher holds, so a publisher overtaken by a stuck-retry after 10 minutes changes nothing; if it had already created an event, it alerts "check for a duplicate".
- **Times.** The host picks a date (YYYY-MM-DD, tomorrow through 365 days out, Pacific) and a start time (HH:MM, 15-minute steps); stored as `start_local` text `YYYY-MM-DDTHH:MM`, sent to Meetup as `startDateTime` like the Discord flow (Meetup reads it in the group's timezone). Duration: one of PT1H, PT1H30M, PT2H, PT2H30M, PT3H, PT4H, PT5H, PT6H.
- **Title.** 1–63 characters (80 less the longer prefix, since the prefix follows the tier at publish, which may differ from the tier at submit), no line breaks, control, bidi or zero-width characters, leading `[Guest Host]`/`[Community Host]` tags stripped (`stripHostPrefix`).
- **Fresh description** = `GUEST_HOST_EVENT_DESCRIPTION`, with a Host Tip line (`getRandomTip()`) prepended for regular hosts, as the Discord flow does. The host edits the details on Meetup after publishing (they are its event host). No description field on the form.
- **Copy** keeps: title (prefix stripped), description, duration (if in the list, else PT2H), start time of day, `maxTickets → rsvpLimit` (if 1–500, else the template's 12; an uncapped source, 0, also becomes 12), `guestLimit` (0–10, else the template's), `featuredEventPhoto.id`, `venue.id`, `howToFindUs`. No tip. Only from this group's events (`group.urlname`) that the signed-in host hosted (`eventHosts[].member.id`); anything else is a 404. Event ids may be alphanumeric (older recurring events).
- **Alerts** (`logAlert`, plain embed, no mentions): new regular request; promoted host published; publish failed (with what to fix). Approve/deny themselves go to the activity log.
- **Discord `/meetup_request_event` stays untouched** and outside the queue.

## File structure

| File | Responsibility |
|---|---|
| `src/lib/repositories/postgresEventRequestRepository.ts` (new) | `event_requests` + append-only `event_request_events`; create, get, list, CAS transitions. |
| `src/lib/hosts/eventRequest.ts` (new) | Form parsing/validation (`parseRequestForm`), copy fields from a Meetup event (`copyFromEvent`), the Meetup input (`createInputFor`). Pure. |
| `src/lib/hosts/publishRequest.ts` (new) | `publishRequest(deps, id, actor)`: CAS, create (resume-aware), RSVP close + re-apply, record outcome, alert. |
| `src/lib/client/meetup/queries.ts`, `gqlClient.ts`, `mutations.ts` (modify) | `getEventForCopy(eventId)`; `createEvent` payload also selects `errors`. |
| `src/lib/client/meetup/createEventWithPhotoFallback.ts` (new), `src/commands/meetup/createEvent.ts` (modify) | `createEventWithPhotoFallback` moves out of the command file so the publish path shares it; the command imports it back. |
| `src/web/host/createPage.ts` (new) | `GET/POST /host/create`, `GET /host/requests/:id`. |
| `src/web/host/hostPages.ts` (modify) | Calendar "Host on this day" links, history "Copy" buttons, home "Your requests". |
| `src/web/routes/hostRequests.ts` (new) | Staff queue `GET /dashboard/hosts/requests`, `POST …/:id/approve`, `…/:id/deny`, `…/:id/retry`. |
| `src/web/host/hostDeps.ts`, `src/web/dashboardDeps.ts`, `src/web/routes/dashboardPages.ts`, `src/lib/reports/dashboardPaths.ts`, `src/web/pages.ts` (modify) | Wiring, nav link, paths, CSS. |

### Task 1: Event request store

**Files:** create `src/lib/repositories/postgresEventRequestRepository.ts`; test `tst/integration/postgresEventRequestRepository.test.ts`.

**Interfaces (produces):**
```ts
export type EventRequestStatus = 'pending' | 'publishing' | 'published' | 'failed' | 'denied';
export interface EventRequestFields {
  kind: 'fresh' | 'copy'; sourceEventId: string | null;
  title: string; description: string; startLocal: string; duration: string;
  rsvpLimit: number; guestLimit: number;
  featuredPhotoId: number | null; venueId: string | null; howToFindUs: string | null;
}
export interface EventRequest extends EventRequestFields {
  id: string; meetupMemberId: string; discordUserId: string | null;
  hostName: string; tier: 'regular' | 'promoted';
  status: EventRequestStatus; denyReason: string | null; failure: string | null;
  decidedBy: string | null; decidedAt: Date | null;
  meetupEventId: string | null; eventUrl: string | null;
  version: number; createdAt: Date; updatedAt: Date;
}
class PostgresEventRequestRepository {
  static instance(): Promise<PostgresEventRequestRepository>;
  create(input: EventRequestFields & { meetupMemberId; discordUserId; hostName; tier }): Promise<EventRequest>;
  get(id: string): Promise<EventRequest | undefined>;           // non-numeric id → undefined
  listForMember(meetupMemberId: string, limit = 20): Promise<EventRequest[]>; // newest first
  listByStatus(statuses: EventRequestStatus[], limit = 100): Promise<EventRequest[]>; // oldest first
  /** CAS: one caller wins. `stuckBefore`: a 'publishing' row last updated before it also counts as allowed. */
  startPublishing(id, seenVersion, actor: string, from: ('pending'|'failed'|'publishing')[], stuckBefore?: Date): Promise<EventRequest | undefined>;
  recordCreated(id, meetupEventId, eventUrl): Promise<void>;     // only while 'publishing'
  finish(id, outcome: { status: 'published' } | { status: 'failed'; failure: string }): Promise<EventRequest>;
  deny(id, seenVersion, actor, reason): Promise<EventRequest | undefined>; // pending only
}
```
Every state change bumps `version`, sets `updated_at`, and inserts an `event_request_events` row (`request_id, action, actor, detail, version, at`) in the same transaction; history is append-only (trigger, as `promoted_host_events`). CHECKs: ids by pattern, status enum, title 1–80, deny reason 1–500, failure ≤ 1000, `start_local ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$'`, `meetup_event_id` digits.

- [ ] Tests (integration, :55432): create/get round trip; `startPublishing` twice concurrently with the same version → exactly one row back; wrong version → undefined; `from` excludes the current status → undefined; stuck `publishing` admitted only before `stuckBefore`; `recordCreated` outside `publishing` is a no-op; `deny` only from `pending`; history rows per change with the produced version; history UPDATE/DELETE refused; `listForMember` newest first, other members excluded.
- [ ] FAIL → implement → PASS → commit.

### Task 2: Request rules and Meetup reads

**Files:** create `src/lib/hosts/eventRequest.ts`, `src/lib/client/meetup/createEventWithPhotoFallback.ts`; modify `queries.ts`, `gqlClient.ts`, `types.ts`, `mutations.ts`, `src/commands/meetup/createEvent.ts`; tests `tst/lib/hosts/eventRequest.test.ts`, `tst/lib/client/meetup/createEventWithPhotoFallback.test.ts` (move existing cases if any).

**Interfaces (produces):**
```ts
export const DURATIONS = ['PT1H','PT1H30M','PT2H','PT2H30M','PT3H','PT4H','PT5H','PT6H'] as const;
export type FormResult = { ok: true; value: { title; day; time; duration } } | { ok: false; errors: Partial<Record<'title'|'day'|'time'|'duration', string>> };
export function parseRequestForm(body: Record<string, unknown> | undefined, tier: HostTier, today: string /*Pacific YYYY-MM-DD*/): FormResult;
export interface CopySource { id; title; description; dateTime; duration; maxTickets; guestLimit; featuredPhotoId; venueId; howToFindUs; hostIds: string[] }
export function copyFields(source: CopySource): Omit<EventRequestFields, 'startLocal'|'kind'|'sourceEventId'> & { time: string };
export function freshFields(tier: HostTier, tip: string): Pick<EventRequestFields, 'description'|'rsvpLimit'|'guestLimit'|'featuredPhotoId'|'venueId'|'howToFindUs'>;
export function createInputFor(req: EventRequest, tierAtPublish: HostTier): CreateEventInput; // prefix by tierAtPublish, eventHosts [Number(req.meetupMemberId)], template defaults
GqlMeetupClient.getEventForCopy(eventId): Promise<CopySource | undefined>;
```
- [ ] Tests: title too long for the tier's prefix, newline, control chars, empty, prefix stripped; day today/past/>365 days refused, tomorrow accepted; time not on 15 minutes refused; unknown duration refused; arrays (repeated fields) refused; copy maps every field and falls back for out-of-range duration/limits; fresh adds the tip only for regular; `createInputFor` uses `[Community Host] ` for promoted, `[Guest Host] ` for regular, sets venue/howToFindUs only when present, `publishStatus: 'PUBLISHED'`; photo fallback behaviour unchanged.
- [ ] FAIL → implement → PASS → commit.

### Task 3: Publishing

**Files:** create `src/lib/hosts/publishRequest.ts`; test `tst/lib/hosts/publishRequest.test.ts`.

**Interfaces:**
```ts
export interface PublishDeps {
  requests: Pick<PostgresEventRequestRepository, 'get'|'startPublishing'|'recordCreated'|'finish'>;
  meetup: <T>(fn: (m: Pick<GqlMeetupClient,'createEvent'|'closeEventRsvps'|'editEvent'>) => Promise<T>) => Promise<T>; // organizer credential, NO 401 re-run of writes
  tierOf: (meetupMemberId: string) => Promise<HostTier | 'not-a-host'>;
  alert: (entry: LogEntry) => Promise<unknown>;
  now: () => Date;
}
export type PublishOutcome = { code: 'published'; request } | { code: 'failed'; request } | { code: 'stale' } | { code: 'not-found' } | { code: 'not-a-host' };
export function publishRequest(deps, id: string, seenVersion: number, actor: string, from: ('pending'|'failed'|'publishing')[]): Promise<PublishOutcome>;
```
Order: CAS (`startPublishing`, `stuckBefore = now − 10 min`) → `tierOf` (a member who is no longer a host → `finish failed` "no longer a host", alert) → if no `meetupEventId`: `createEventWithPhotoFallback`, then `recordCreated` at once → `closeEventRsvps` + `editEvent({ rsvpSettings })` → `finish published`. Any throw → `finish failed` with fixed text saying what exists ("Created <url> but the RSVP settings were not applied: set them on Meetup, then Retry" / "Nothing was created on Meetup: Retry"). `meetup` here must not reuse `withOrganizerMeetup`'s 401 re-run around writes: get the token once, one call each; a 401 is a failure (retry is safe because of resume).
- [ ] Tests: two concurrent publishes of one request → one `createEvent`; resume with an event id skips `createEvent`; prefix follows the tier at publish (promoted→regular demotion between submit and approve gives `[Guest Host] `); createEvent throws → failed "Nothing was created"; RSVP step throws → failed naming the URL; not-a-host → failed, no Meetup call; alert on failure, none on success from the queue (the route alerts), no mentions.
- [ ] FAIL → implement → PASS → commit.

### Task 4: Host create flow

**Files:** create `src/web/host/createPage.ts`; modify `hostPages.ts`, `hostDeps.ts`, `pages.ts` (CSS); tests `tst/web/host/createPage.test.ts`, `hostPages.test.ts` additions.

- `GET /host/create?day=YYYY-MM-DD` (fresh) and `GET /host/create?copy=<eventId>` (copy: 404 unless the host's own past or upcoming event). Form: title, date, start time (select, 15-minute steps), duration (select), for copy a read-only summary of what is copied. Submit button text: regular "Send for approval", promoted "Publish on Meetup".
- `POST /host/create` (router CSRF guard already applies): re-validate; copy re-reads the source from Meetup and re-checks ownership; insert. Regular → alert "New event request from <name>: <title> on <date> — review at /dashboard/hosts/requests", redirect to `/host/requests/:id`. Promoted → `publishRequest` at once, redirect to `/host/requests/:id`.
- At most 5 `pending` requests per host (refused with a message); the router's action rate limit covers bursts.
- `GET /host/requests/:id`: only the owner's (else 404). Shows status, deny reason, failure, link to the Meetup event when published, attendance link not needed.
- Home: "Your requests" (latest 10) with status pills: pending (coral "Waiting for approval"), publishing, published (green, link), denied (coral, reason), failed (coral, "Leadership has been told").
- Calendar day list and future cells: "Host on this day" → `/host/create?day=…`. History rows: "Copy" → `/host/create?copy=<id>`.
- [ ] Tests: hostile title escaped on every page; copy of someone else's event 404 (GET and POST); POST without CSRF 403; regular creates pending + alert (no `<@&` and no mentions), promoted publishes once; 6th pending refused; request page of another host 404; form errors re-render with the host's input escaped; 360 px no sideways scroll (browser check in Task 6).
- [ ] FAIL → implement → PASS → commit.

### Task 5: Leadership queue on the staff dashboard

**Files:** create `src/web/routes/hostRequests.ts`; modify `dashboardPaths.ts` (`hostRequests: '/hosts/requests'`, `hostRequestAction: '/hosts/requests/:id/:action'`), `dashboardPages.ts` (deps `eventRequests`, `publish`), `pages.ts` (nav "Host requests"), `dashboardDeps.ts`; tests `tst/web/dashboardRouter.hostRequests.test.ts`, access-matrix additions.

- GET (Moderators and Leadership): pending (oldest first), then failed and stuck publishing, then the last 20 decided. Each card: host name (`memberText`), tier, title, date/time, duration, kind (fresh / copy of <link>), submitted, hosted-event count not needed. Buttons only when `leadershipOf(...) === 'leader'`; Moderators see "Only the 1.5 Leadership Team can approve or deny."
- POST approve (`from ['pending']`), retry (`from ['failed','publishing']`), deny (reason 1–500 required): live Leadership check with `withDeadline(LEADERSHIP_CHECK_DEADLINE_MS)` exactly as `workspaceActions.ts`; refusal → `?result=not-leadership|leadership-unavailable`, throttled refusal audit; `version` form field; stale → 409 page; publish runs under `withDeadline(WORKSPACE_REQUEST_DEADLINE_MS)` (on timeout the request stays `publishing`; the page says so and the stuck rule allows a retry after 10 minutes). Activity log line for approve/deny/retry (actor `<@id>`, request id, title) with no pings.
- [ ] Tests: Moderator GET 200 without buttons; Moderator POST → not-leadership, nothing changed; Leadership approve → one `createEvent`; double approve (same version) → second 409; deny without reason → refused; Discord unreachable → leadership-unavailable; access matrix covers the new routes.
- [ ] FAIL → implement → PASS → commit.

### Task 6: Wiring and checks

- Production deps (`hostDeps.ts`, `dashboardDeps.ts`): repository instance, organizer `meetup` runner, `tierOf` via `resolveHost`, `logAlert` via the Discord client (`false` when the client is not ready; publishing never waits on Discord).
- Full `yarn test`, `yarn lint`, `tsc`, integration suite on :55432/:56379. Browser check at 360/1280, light and dark: create (fresh and copy), request page, home requests, staff queue.
- [ ] Commit; per-task reviewers; fix what they confirm; open PR with the attribution line.

# PR 3: #129 follow-ups and the calendar, history and form UI (Hai's walkthrough)

Approved by Hai (via the lead session, 2026-11-09). One PR off `main` at `66d052c`. The promotion/comments/announcing work below moves to a later PR. The publish path and alerts stay unchanged. No new dependencies. Pages stay server-rendered, with one small inline script per page (nonce, `staticRaw`) that enhances markup which already works without it. Everything must work at 360 px with no sideways scroll.

## Decisions (builder's calls)

- **Popovers without ids.** The HTML guard never interpolates `id`, and the `popover`/`popovertarget` pair needs one. Each calendar day is therefore a `<details>` element: its `<summary>` opens it with a click, a tap, Enter or Space, natively and without JS. The script adds four things:
  - hover opening for a mouse;
  - one open day at a time;
  - Escape to close (focus returns to the summary) and tap-outside to close;
  - `position: fixed` placement clamped to the viewport, so the `.table-scroll` box never clips the panel.

  Without JS, the panel opens inline inside the cell.
- **Calendar cell:** the day number is plain text. A `+` link (`aria-label="Host an event on Fri, Nov 20"`) opens the create form for that day, on every day from tomorrow on. The popover lists every event that day (time, title link, holiday badges, hosts) and ends with **Host on this day**, the same text and target as the day-by-day list. Past days keep only their date.
- **Heat map by year:**
  - Each day that has events is an SVG `<a>` to `/host/history?year=Y&day=D` (keeping `type`), with `aria-label` and a native `<title>` giving the date and each event's time and title.
  - The script replaces the native tooltip with a positioned one, shown on hover and focus. On touch, the first tap shows it and the second follows the link.
  - Empty days stay plain rects, so the map adds about one tab stop per hosted day, not 365.
  - `?year=` defaults to the current Pacific year. An invalid year, or one outside the earliest hosted year to the current one, falls back to the current year.
  - Prev is shown disabled when no hosted event is earlier than that year; Next is disabled for the current year. Both are links that keep `type`.
- **Day filter:** `?day=YYYY-MM-DD` (a real date) filters the past-events table to that day and shows "Showing <date> · Clear". Clear keeps `type` and `year`. Paging still applies.
- **Copy:** the history action reads **Copy this event** on every row, filtered or not. The fresh form gets "Or copy one of your past events", linking to My history.
- **Deny bound (A1):** `deny()` takes `{ lockTimeoutMs }`. The route passes the page's remaining time, floored to whole ms and at least 1 ms, after the `left <= 0` check.
- **Copy details on the queue (A2):**
  - The venue shows as "Venue: Meetup venue <id>", or "none (online or none set)".
  - Directions show escaped.
  - The photo shows as "Photo: Meetup photo <id>", "the group's standard photo" or "none". No thumbnail, because the staff CSP is `img-src 'self'`.
  - A copied description gets the same attention badge as a host-written one: "Description from the host's event".
- **A3:** a comment in `existingEventFilter`. The fixed ±1 day window can be off by an hour across a DST change. That is safe because `isEventFor` matches the exact Pacific start, and the window is only a prefilter that still contains it.

## Tasks

1. **Follow-ups (A1–A3):**
   - Code: `postgresEventRequestRepository.deny(…, options)`, `hostRequests.ts` (bounded deny, copy details), `eventRequest.ts` comment.
   - Tests:
     - route: the `left <= 0` branch (now advances past the deadline after the Meetup check, so deny is never called);
     - route: `deny` receives `lockTimeoutMs ≤` the remaining time;
     - route: the copy card shows the venue, directions, photo and description badge, escaped;
     - integration: deny with a short `lockTimeoutMs` while another transaction holds the row fails without committing.
2. **Calendar (B4–B6):**
   - Code: `hostPages.ts` cell markup and the popover panel, a `CALENDAR_SCRIPT` constant, CSS in `pages.ts`, and a script slot in `hostPage`/`hostLayout`.
   - Tests:
     - every future day has a `+` link with its aria-label, and day numbers are not links;
     - each popover lists every event that day, escaped, beyond what the cell shows;
     - future popovers carry "Host on this day" and past days have none;
     - the script tag carries the nonce.
3. **History (C7, C8, D9 row action):**
   - Code: `heatMap.ts` becomes a year view, `historyBody` gets the year/day query, `HISTORY_SCRIPT`.
   - Tests:
     - linked dots carry their events' times and titles, escaped;
     - empty days have no link;
     - `?year` defaults, bounds and Prev/Next disabled states;
     - `?day` filters the table, shows Clear and keeps `type`;
     - every row, filtered or not, has "Copy this event".
4. **Form (D9):** a link from the fresh form to My history; a test.
5. **Checks:**
   - `yarn test`, lint, `tsc`, and integration on :55432/:56379.
   - One reviewer per task; fix what is confirmed.
   - Browser check at 360 px and desktop, light and dark: the calendar popover (mouse, keyboard, Escape, tap outside), the heat map tooltip and filter, and year paging.

# PR 4: Link Discord from the host dashboard

Hai's call (2026-11-09): a host who signed in with Meetup and has no linked Discord account gets a **Link your Discord account** button instead of being sent to Verify in the server. The button links accounts only. It never grants server roles; joining and roles stay with Verify and the moderators.

## Decisions (builder's calls)

- **No new redirect URI:** `GET /host/link/discord` (signed-in hosts only) starts Discord's sign-in. Its one-time state is `link.` + random, sealed in the same `host_oauth_discord` cookie. The existing `/host/auth/discord/callback` sees the prefix and links instead of signing in. A linking callback with no live host session is refused.
- **Duplicates, as Verify handles them:** `linkDiscordFromWeb` in `src/lib/hosts/webLink.ts` checks both sides of the link.
  - The Meetup account already linked to a different Discord account is refused.
  - A Discord account already linked to a different Meetup account is also refused. On the website there is no Discord-side confirmation of a switch, so unlike Verify it does not move the link.
  - A concurrent link caught by the unique constraint counts as Meetup taken.
  - A `meetup_id = NULL` (manual onboard) row for that Discord user is upgraded.
- **The written row:** `onboard_method = 'web_link'`. The Meetup name is the session's name, and the profile URL is `https://www.meetup.com/members/<id>/`.
- **Logging and the session:**
  - Activity log: "Meetup account linked (host dashboard)".
  - #meetup-bot-alerts: "Duplicate Meetup link blocked (host dashboard)", plain, with no pings.
  - The session takes the new Discord id at once, and the tier is re-checked.
- **Home notices:** `?link=` carries fixed codes (linked, already, cancelled, meetup-taken, discord-taken, error), each with a fixed text.

## Tasks

1. **`webLink.ts` and its unit tests:**
   - new link;
   - already linked to this Discord;
   - Meetup taken;
   - Discord taken;
   - a manual row upgraded;
   - a unique-constraint race;
   - a store failure.
2. **Router:**
   - Code: the start route and the callback branch, the `members` and `alert` deps, and wiring in `hostDeps.ts`.
   - Tests: start sets a `link.` state and needs a session; the callback links, then refreshes the session and the home notice; cancel; exchange failure; each refusal plus its alert; no session; a sign-in state never links; a link state never signs in.
3. **Home:** the nudge becomes a button, plus the notice rendering. Tests check both, escaped.
4. **Checks:** `yarn test`, lint, `tsc`, integration; a browser check at 360 px and desktop; a review with requesting-code-review; then the PR.

# PR 5 (was PR 3): Promotion, comments, announcing

- **Promotion** (`/dashboard/hosts/candidates`): regular hosts with 20+ PAST hosted events (from the identity links' Meetup ids plus hosts seen in group events), each with heat map, count, last hosted date, issues (flagged comments first, "show all"). Promote/demote with a required reason, leadership only, live check; writes `promoted_hosts` + `promoted_host_events`; first promote is `INSERT … ON CONFLICT (meetup_member_id) DO NOTHING` (no row back = a concurrent promote won), later changes `UPDATE … SET version = version + 1, changed_at = now() WHERE version = $seen`, and each history row records the version it produced; demoting someone never promoted is refused; revokes the member's host sessions so the tier changes at once (the 10-minute re-check is the backstop); plain alert. Per-host heat map page.
- **Comments:** `event_comments` (Meetup comment id key, event id, member id, name, text, created, is_private, parent id, `flagged_at`, `flag_source`, `flag_note`). Daily sweep job (Redis lease, outside 17:45–19:00 UTC) over hosts' events from 60 days back through upcoming, `Event.comments` with replies, organizer credential. Host page `/host/comments` (own events only; private comments only to that event's hosts and leadership). **Flag write path:** a Heroku one-off script `scripts/flagComments.ts` reading JSON `{ commentId, note }[]` from stdin (no new HTTP surface). `host_issues` table for manual entries; the issues list merges both.
- **Announcing:** `event_announcements(meetup_event_id PK, announced_by, requested_at, completed_at, status)`; button on the host's upcoming events (and for leadership); insert-if-absent under a lock before calling `announceEvent`; an "already announced" error counts as done; button disabled after; plain alert. Regular hosts can announce only published events (the request has an event id). No cool-down.
- **Manual event-type correction:** `event_type_overrides(meetup_event_id PK, type, set_by, set_at)`, editable by the event's host and leadership.
