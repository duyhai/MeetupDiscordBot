# Meetup ID Storage, Bot Log Channels, and Unlinked-Member Digest

**Date:** 2026-08-14
**Status:** Approved by Hai (brainstorming session)
**Tracking for deferred work:** [#35 Drizzle ORM + event bus](https://github.com/duyhai/MeetupDiscordBot/issues/35)

## Goal

Persist the Meetup member ID of every onboarded Discord user in a durable database, so organizers can:

1. Look up which Meetup profile belongs to a Discord user (and vice versa).
2. Prevent one Meetup account from verifying multiple Discord accounts.
3. Build future features (badge refresh, no-show tracking, event stats) on top of the mapping.

Additionally, give organizers visibility into what the bot does via two new Discord log channels, and surface members who bypassed automated verification.

## Background

- The bot currently has **no persistent storage**. Redis (`REDISCLOUD_URL`, Redis Cloud addon) is a 12-hour-TTL token cache only; local dev falls back to an in-memory cache (`src/util/cache.ts`).
- The Meetup member ID (`userInfo.self.id`, plus `name`, `memberUrl`, `gender`) is already fetched during onboarding but discarded.
- Onboarding paths today:
  1. **V1 sync button** (`sync_meetup_account`) — the live button in `✅get-verified-for-full-access`. Meetup OAuth only, via `withMeetupClient` → `selfOnboardUser`.
  2. **`/meetup_self_onboard`** slash command — same helper.
  3. **V2 sync button** (`sync_meetup_account_v2`) — Discord OAuth + Meetup OAuth, pushes linked-role metadata. In code, not the live button.
  4. **Manual onboarding** (`/onboard_user` command + context menu) — mod-driven, no Meetup data. **Being deprecated** from regular processes; users must go through automated verification.
- Server structure (fetched live 2026-08-13): `📜Logs` category holds mod-bot audit feeds; `🏢1.5 Leadership Team` category holds organizer channels including `🟥📜meetup-rsvp-logs` (fed by an external service, not this codebase). Emoji convention: 🟥 = Meetup-related, 🟪 = Discord-related.
- Hosting: Heroku (`meetup-discord-bot.herokuapp.com`), single always-on dyno.

## Decisions Made During Brainstorming

| Question | Decision |
|---|---|
| Purpose of stored Meetup ID | Lookup + duplicate prevention + future-feature foundation (all of the above) |
| Log channel content | General bot-activity channel logs everything the bot does; separate anomaly/alert channel that organizers and mods keep unmuted |
| Channel placement | Activity channel in `📜Logs`; alerts channel in `🏢1.5 Leadership Team` |
| Channel creation | Claude creates both via one-off script with the bot token, then hardcodes IDs in `constants.ts` |
| Manual onboards | Get a DB row with `meetup_id = NULL` so they can be alerted on; manual flow is deprecated |
| Unlinked members | **Alert-only** daily digest to the alerts channel; no auto re-gating in this iteration |
| Architecture | Minimal: `pg` driver, one repository module, `discordLogger` helper, in-process daily job |
| Deferred | Drizzle ORM + migrations + internal event bus → issue #35. OAuth UX fixes (iPhone `Cannot GET /` session bug, return-to-Discord landing page) → separate follow-up spec |

## Design

### 1. Data model

One table, created idempotently at startup (`CREATE TABLE IF NOT EXISTS`); no migration framework yet.

```sql
CREATE TABLE IF NOT EXISTS members (
  discord_user_id    TEXT PRIMARY KEY,
  meetup_id          TEXT UNIQUE,            -- NULL for manual onboards (Postgres allows multiple NULLs)
  meetup_name        TEXT,
  meetup_member_url  TEXT,
  onboard_method     TEXT NOT NULL,          -- 'self_onboard' | 'sync_v2' | 'manual'
  onboarded_by       TEXT,                   -- mod's Discord ID; manual onboards only
  first_onboarded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 2. Database plumbing

Mirrors the existing `ApplicationCache` pattern (Redis vs in-memory selected by env var):

- `MemberRepository` interface: `upsert(member)`, `findByDiscordId(id)`, `findByMeetupId(id)`, `listAll()`, `remove(discordUserId)`.
- `PostgresMemberRepository` — used when `DATABASE_URL` is set. `pg` pool with `max: 5` (Essential-0 allows 20 connections), SSL `rejectUnauthorized: false` (Heroku requirement). Ensures schema on first use.
- `InMemoryMemberRepository` — local dev and unit tests.
- Heroku: `heroku addons:create heroku-postgresql:essential-0 -a meetup-discord-bot` (~$5/month, 1 GB, non-ephemeral). The addon injects `DATABASE_URL`.
- New dependency: `pg` (+ `@types/pg`).

### 3. Write paths

| Path | Row written |
|---|---|
| `selfOnboardUser` helper (live V1 button + `/meetup_self_onboard`) | Upsert: `meetup_id`, `meetup_name`, `meetup_member_url`, `onboard_method='self_onboard'` |
| V2 sync button handler | Same upsert with `onboard_method='sync_v2'` |
| Manual `onboardUser` (slash + context menu) | Insert/keep row: `meetup_id=NULL`, `onboard_method='manual'`, `onboarded_by=<mod's Discord ID>`. A later self-link upgrades the row in place. |

A DB write failure during onboarding must not block the user's onboarding; it is logged to the alerts channel instead.

### 4. Duplicate handling

Checks run in this order:

- **Same Meetup ID, different Discord user** → onboarding **blocked** with user-facing error ("This Meetup account is already linked to another Discord account — please contact the mods"), alert posted with both Discord IDs and the Meetup profile link. This check runs first, so a re-link to an already-claimed account is always blocked.
- **Same Discord user links a different (unclaimed) Meetup account** → allowed; row updated; alert posted (identity change worth organizer eyes).
- **Same user re-syncs same account** → refresh `meetup_name` and `last_synced_at`; activity log only.
- **Escape hatch:** `/meetup_unlink @user` slash command, restricted to moderator/organizer roles, deletes the member's row and logs an activity entry. Resolves blocks without psql access.

### 5. Log channels

Created once via `scripts/createLogChannels.ts` (bot token, inherits category permissions), IDs then hardcoded in `constants.ts`:

| Channel | Category | Constant |
|---|---|---|
| `🟥🤖meetup-bot-activity` | `📜Logs` (`932896530447364146`) | `BOT_ACTIVITY_LOG_CHANNEL_ID` |
| `🟥🚨meetup-bot-alerts` | `🏢1.5 Leadership Team` (`912463487257686066`) | `BOT_ALERTS_CHANNEL_ID` |

Renaming/repositioning later in Discord is safe; IDs are stable.

### 6. discordLogger helper

`src/lib/helpers/discordLogger.ts`:

- `logActivity(client, entry)` — green embed to the activity channel.
- `logAlert(client, entry)` — red embed to the alerts channel.
- Entries carry: title, description, optional fields (Discord user mention, Meetup profile link, onboard method), timestamp.
- **Never throws.** All Discord send failures are caught and logged to tslog only. Logging must never break a command.
- No batching in v1; activity volume (onboards, command uses) is well under Discord rate limits. Revisit if volume grows.

Event coverage:

| Event | Activity | Alert |
|---|---|---|
| Any command/button invocation (via `discordCommandWrapper` success) | ✅ | |
| Any command error (via `discordCommandWrapper` catch) | | ✅ |
| Onboard success (any path) | ✅ (with Meetup profile) | |
| Manual onboard (deprecated flow used) | ✅ | ✅ |
| Duplicate Meetup ID blocked | | ✅ |
| Meetup account changed on re-link | | ✅ |
| Non-member onboard attempt | | ✅ |
| Badge sync, event announced/created | ✅ | |
| DB write failure | | ✅ |

### 7. Daily unlinked-member digest

- Runs in-process (dyno is always on). Scheduling must survive Heroku's daily dyno cycling — a naive 24 h `setInterval` from boot may never fire. Instead: an hourly tick checks whether the current UTC hour is the target hour (17:00 UTC ≈ 9–10 am Pacific); if so, it claims the run via the existing cache's `exclusive_set` with a date-keyed key (`unlinked-digest-YYYY-MM-DD`, 12 h TTL is fine since the key encodes the date). Restarts therefore cannot skip or double-post a day.
- Logic: fetch all guild members → keep humans without the `onboarding` role (i.e. verified) → diff against `members` table → those with **no row or `meetup_id IS NULL`** are "unlinked".
- Output to alerts channel: total count first, then up to ~50 mentions chunked under the 2000-character message limit, ending "…and N more". No post when the list is empty.
- Known initial condition: on day one every pre-database member is unlinked, so the first digests will be large; the number shrinks as members use the sync button (it already advertises re-use for badge refresh).

### 8. Testing

- **Unit (vitest, no network):** in-memory repository semantics; duplicate-blocking and account-change rules; digest formatting/chunking; `discordLogger` never-throws guarantee.
- **Integration (gated, mirroring the Redis suite pattern):** Postgres repository CRUD + upsert-conflict paths against a real database, skipped with a warning unless `DATABASE_URL` is set (locally e.g. `docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=pw postgres`).

### 9. Rollout

1. Hai provisions the Heroku Postgres Essential-0 addon.
2. Deploy the feature branch; schema self-creates on boot.
3. Run `scripts/createLogChannels.ts` once; commit the resulting channel IDs in `constants.ts`; deploy.
4. Verify end-to-end from `🤖bot-testing`: test onboard → row appears, activity + alert entries post, digest posts on schedule.

## Out of Scope

- OAuth onboarding UX fixes: iPhone session loss showing `Cannot GET /` (state should ride the OAuth `state` query param instead of the session cookie), and a "Return to Discord" landing page. **Separate follow-up spec.**
- Auto re-gating (removing access from) unlinked members — revisit after digest data accumulates.
- Drizzle ORM, generated migrations, internal event bus — issue #35.
- Backfilling Meetup IDs for existing members — impossible without each member re-authorizing; the sync button handles this organically.
