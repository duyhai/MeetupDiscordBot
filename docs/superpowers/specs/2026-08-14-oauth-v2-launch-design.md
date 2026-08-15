# Cookie-Free OAuth and Sync V2 Launch

**Date:** 2026-08-14
**Status:** Approved by Hai (brainstorming session)
**Predecessor:** `2026-08-14-meetup-id-storage-design.md` (shipped as PR #37); this spec is the OAuth follow-up it scoped out.

## Goal

Make the Meetup verification flow survive iOS browser-context switches (the "Cannot GET /" bug), smooth the double-OAuth chain, land users back in the server afterwards, and swap the live Get Verified button from the V1 flow to V2 — whose linked-role profile badge is the point of launching it.

## Background

- **Live flow (V1, `sync_meetup_account`):** Meetup OAuth only, via the `grant` library. State is a UUID bound to the clicking user in the cache (`maskedUserId-{uuid}` → Discord ID), but grant transports everything through an `express-session` cookie backed by an **in-memory** store.
- **The iPhone bug:** iOS frequently completes the OAuth round-trip in a different browser context than it started in (Discord's in-app browser → Safari, or the Meetup app intercepting the URL). The session cookie doesn't follow; grant finds no session at the callback and bails to `/`, which has no route — users see Express's `Cannot GET /`. Dyno restarts mid-flow kill the in-memory session store the same way.
- **V2 (`sync_meetup_account_v2`):** Discord OAuth (identify + role_connections.write) → Meetup OAuth → onboard + badges + **linked-role metadata push**. Implemented, persists Meetup links since PR #37, never launched as the live button. Decision: the badge is V2's raison d'être — the double OAuth stays; we make it smooth instead of removing it.
- The success landing page already deep-links to `discord://`, but lands at DM home, not the server. The Discord callback's error path returns raw JSON, not the branded page.
- The V2 handler duplicates the nickname/gender-role onboarding logic that also lives in `lib/helpers/onboardUser.ts` (pre-V2 copy-paste).

## Decisions Made During Brainstorming

| Question | Decision |
|---|---|
| Remove the Discord OAuth hop from the main flow? | **No.** The linked-role badge is V2's whole point; launching without it "is just basically V1." Double OAuth stays, made as smooth as possible. |
| OAuth client | **arctic** (v3.7.x, actively maintained, TS-first, minimal deps) behind our own thin wrapper so it stays swappable; hand-roll only if its generic client fights Meetup's endpoint. `grant` and `express-session` are removed. |
| Post-success destination | Deep link to **👋🏼welcome-to-the-server** (guild channel), web URL fallback. |
| Button swap mechanics | Bot **edits the existing get-verified message in place** to the V2 button; V1 handler code deleted immediately after. |
| iPhone verification without an iPhone | Three layers: cookie-less CI integration tests (mechanism-level proof), iPhone-owning mods smoke-test a staged button in 🤖bot-testing, alerts-channel monitoring + reversible swap script. |

## Design

### 1. OAuth provider wrapper

New `src/lib/client/oauth/providers.ts` wrapping arctic:

- `buildDiscordAuthUrl(state: string): string` — authorize URL with scopes `identify role_connections.write` and **`prompt=none`** (returning users who already granted skip the consent screen; first-timers still see it).
- `exchangeDiscordCode(code: string): Promise<Tokens>`
- `buildMeetupAuthUrl(state: string): string`
- `exchangeMeetupCode(code: string): Promise<Tokens>`

`Tokens` is the existing `{ accessToken, refreshToken, expiresAt }` shape. Discord uses arctic's first-class provider; Meetup uses arctic's generic OAuth2 client. If Meetup's token endpoint proves incompatible, only `exchangeMeetupCode` is hand-rolled (one fetch); callers never know.

### 2. State model (no cookies anywhere)

Clicking the sync button generates a UUID and caches `maskedUserId-{uuid}` → Discord user ID (existing cache, 12 h TTL). That UUID rides the `state` query parameter through the entire chain: Discord authorize → Discord callback → Meetup authorize → Meetup callback. Every callback:

1. Requires `state` present and resolvable in the cache — otherwise renders the error landing page ("link expired — go back to Discord and press the button again").
2. Exchanges the code directly with the provider.

The Discord callback additionally fetches `/users/@me` with the new token and **verifies the account matches the cached Discord ID** that clicked the button; a mismatch (forwarded/reused link) renders an error page and stores nothing.

### 3. Routes (`src/app.ts` rewrite)

| Route | Behavior |
|---|---|
| `GET /connect/discord?state=…` | Validate state → 302 to Discord authorize URL |
| `GET /connect/meetup?state=…` | Validate state → 302 to Meetup authorize URL (chain target of the Discord callback; also keeps V1's link working during Phase 1) |
| `GET /connect/discord/callback` | Validate state → exchange code → identity check → store `{id}-discord-tokens` → **307 to Meetup authorize with the same state** |
| `GET /connect/meetup/callback` | Validate state → exchange code → store `{id}-meetup-tokens` → success landing page |
| `GET /redirect/:url` | Unchanged (local-dev helper) |

`/discord-meetup-connect` (generic, no user binding) is removed; the V2 button generates the per-user `/connect/discord?state=…` link. `grant`, `express-session`, `@types/express-session`, and the `grant/request-oauth/uuid` resolution pin are deleted from `package.json`.

### 4. Landing pages

`getAuthLandingPage` gains the guild destination: success deep-links to `discord://-/channels/<GUILD_ID>/<WELCOME_CHANNEL_ID>` with `https://discord.com/channels/…` fallback (new constants `GUILD_ID = 912461362289061939`, `WELCOME_CHANNEL_ID = 1180262246685868303`). All error paths — provider denial, expired/unknown state, account mismatch, exchange failure — render the branded error page with retry guidance. No raw JSON responses remain.

### 5. V2 handler consolidation

`syncAccountV2.ts` stops duplicating onboarding logic: the currently-private `onboardUserCommon` in `lib/helpers/onboardUser.ts` is exported, and the V2 handler calls it for nickname/gender-role/onboarding-role work (single implementation of onboarding behavior). The handler keeps its V2-specific work: badge computation, `recordMeetupLink(…, 'sync_v2')`, and the linked-role `pushMetadata` call. The ephemeral link it offers becomes the per-user `/connect/discord?state=…` URL.

### 6. V1 retirement

- `scripts/swapVerifyButton.ts` (one-off, same pattern as `createLogChannels.ts`): locates the bot's message in `✅get-verified-for-full-access` (`1091256923703222293`) whose component carries custom_id `sync_meetup_account`, and edits it in place: V2 button + one added copy line about the linked-role profile badge. The script accepts a `--rollback` flag that swaps the button back to V1's custom_id — the launch's undo lever (note: after Phase 2 deletes the V1 handler, rolling back also requires deploying a revert of that deletion).
- After the swap: delete the `sync_meetup_account` handler and `create_sync_account_button` command; move the LGBTQ button/commands from `syncAccount.ts` into `src/buttonMenu/lgbtq.ts` (the file's only remaining occupant).

### 7. Testing

- **Unit:** state helper; provider wrapper URL construction (exact scopes, prompt=none, redirect URIs).
- **Integration (nock 14 intercepts native fetch; supertest):** the full chain with a **cookie-less client — every request from a fresh agent** — proving the flow cannot depend on cookies by construction. Paths: happy chain end-to-end, expired/unknown state, Discord account mismatch, provider denial, token-exchange failure — each asserting the correct landing page. Grant-era route tests are deleted with grant.
- **Manual mechanism repro (before/after evidence):** start the flow in one desktop browser, paste the authorize URL into a different browser, finish there. Pre-fix: `Cannot GET /`. Post-fix: success page.

### 8. Rollout

Two deploy phases — the V1 handler must stay alive until the swap has proven out:

1. **Phase 1 deploy:** new OAuth core + V2 handler changes + landing pages. The V1 button and handler keep working (V1's `withMeetupClient` link now flows through the rewritten cookie-free `/connect/meetup` route as well).
2. Post a V2 test button in `🤖bot-testing`. Recruit 2–3 iPhone-owning mods (at least one with the Meetup app installed — the app-interception variant); their click-through reports are the device acceptance check. One desktop run for Hai (plus the cross-browser repro above as before/after evidence).
3. Run `swapVerifyButton.ts` against the live message.
4. Monitor `🟥🚨meetup-bot-alerts` for flow failures (now visible, countable events) and watch the daily unlinked digest fall as adoption grows. Rollback = the script's `--rollback` flag, fully effective while Phase 2 hasn't shipped.
5. **Phase 2 deploy (after a clean soak, e.g. several days):** delete the V1 handler/command, move the LGBTQ pieces to `lgbtq.ts`.

## Out of Scope

- Refresh-token rotation / long-lived Meetup sessions (tokens remain cache-TTL-bound).
- Any change to onboarding *policy* (roles, nickname rules, digest cadence).
- Attendance pipeline and shared-events features (next on the board).
