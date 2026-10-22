# MeetupDiscordBot

A Discord bot for managing the 1.5 Gen Asian Meetup group

# How to fork repo and contribute back into the main repo

https://www.dataschool.io/how-to-contribute-on-github/

# How to set original repository as upstream

https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/configuring-a-remote-for-a-fork

# Development

- We recommend using VSCode for coding
- Once you install VSCode, use the `code-workspace` file to open the project
- Install the recommended plugins
- Install node js: https://nodejs.org/en/
- Install yarn: `npm install --global yarn`
- Download dependencies: `yarn`
- Run the script with `yarn dev`
- Fill out the API keys in the `.env` file
- If you are on Windows, turn off auto CRLF with this command: `git config core.autocrlf false`

# Commands

- `/meetup_identity_report [days]` — mods/organizers only. Downloads a
  self-contained HTML report of member photo and name changes over the last
  N days (default 7), with before/after thumbnails embedded, covering both
  Discord and Meetup.
- `/meetup_get_token [sweep_credential]` — sends your Meetup access token
  privately, and nothing else by default. With `sweep_credential: True`, mods
  and organizers running it in the server additionally see a long-lived
  refresh token, used to set `MEETUP_ORGANIZER_REFRESH_TOKEN` and enable
  Meetup-side identity monitoring; the bot then forgets their Meetup
  connection, so they are asked to connect again on their next Meetup
  command. See "Where the credential must come from" below.

# Testing

We have two tiers of automated tests: fast unit tests and slower integration tests that hit real services.

- Unit tests: `yarn test` — no network or external services required. Runs on the pre-push hook and in CI.
- Integration tests: `yarn test:integration` — covers OAuth routes, the GraphQL client, and Redis caching.
- Run both: `yarn test:all`
- The Redis and Postgres integration suites are gated on the `REDISCLOUD_URL` / `DATABASE_URL` env vars: if unset, they skip with a warning. To run them locally, use the Docker stack below (`yarn test:integration:docker` is the one-shot version).
- The pre-push hook only runs unit tests (integration tests need Redis) — CI runs the integration tier separately, so don't expect `git push` locally to catch integration failures.

# Local testing with Docker
The integration suite needs a real Postgres (`DATABASE_URL`) and Redis (`REDISCLOUD_URL`). A `docker-compose.yml` at the repo root spins up both locally so you don't have to install them by hand.

## Install Docker (macOS, Apple Silicon)
We recommend [Colima](https://github.com/abiosoft/colima), a lightweight Docker runtime:
```
brew install colima docker docker-compose
colima start
```
As an alternative, Docker Desktop works too:
```
brew install --cask docker
```
(then launch Docker Desktop once so the daemon is running).

## Bring up the stack and run the integration tests
```
# Start Postgres + Redis and wait until both are healthy.
yarn docker:up

# Point the tests at the containers.
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/meetup_bot
export REDISCLOUD_URL=redis://localhost:6379

# Run the integration suite (Postgres + Redis suites now execute instead of skipping).
yarn test:integration

# Tear the stack down when you're done (the Postgres data volume is preserved).
yarn docker:down
```

`yarn docker:up` prints the exact `export` lines above after the services are healthy, so you can copy them straight from its output.

For a one-shot run that boots the stack, wires the env vars, and runs the integration tests in a single command:
```
yarn test:integration:docker
```
(This leaves the containers running; use `yarn docker:down` afterwards.)

The Postgres data volume survives `yarn docker:down`. If the schema ever changes shape or you want a clean slate, reset with `docker compose down -v`.

# Deployment

### Where have we met?

`WHERE_HAVE_WE_MET_LOOKUP` (optional) chooses how `/where_have_we_met` reads
the other person's attendance:

- unset, or any other value: check the attendee list of each event the
  requester went to. Works for any member; the default.
- `member-rsvps`: read the other person's RSVP list directly. Two requests
  instead of one per event, but not yet verified for a requester who isn't an
  organizer, and it doesn't fall back to attendee lists if it fails.

### Identity monitoring

**The schema migrates itself on deploy.** Production already holds the
identity tables from an earlier release (PR #61), in an older shape and with
live data. The first identity query after the new code boots runs a one-way
migration that reshapes them in place, preserving every change row, id and
stored image (see `src/lib/repositories/identitySchema.ts` and the
"Migrating the deployed schema" section of the Meetup identity spec). Two
consequences:

- **Rolling back the release does not roll back the schema.** The previous
  code cannot read the migrated tables, so a rollback leaves identity
  monitoring broken until rolled forward again.
- During the deploy's dyno overlap, the old dyno's identity writes fail once
  the new one has migrated. That window is seconds; the next sweep catches
  anything it missed.

**Discord needs no backfill.** Production's ~2,079 Discord baselines survive
the migration, so existing members are already baselined and will not be
reported as changed. What they lack is a stored avatar image (the column did
not exist before), so each sweep also *heals* baselines that have an avatar
hash but no image -- up to two minutes of fetching per sweep, so the whole
guild heals over the first few daily sweeps rather than in one. A member
whose image has not healed yet still has any change recorded; it just lacks a
before-image.

**Meetup does need a backfill**, once, so its ~6,000 existing members are not
reported as changed on the first digest. The backfill script opens its own
Postgres connection pool on top of whatever the running dyno already holds,
so run it outside a deploy window, not concurrently with one.

Each first sighting also fetches that member's current photo into the
baseline -- the bytes a future change is shown against -- so the backfill
makes one bounded HTTP request per photo and takes substantially longer than
a later sweep: budget roughly 15-30 minutes. Any photo it fails to fetch is
healed by later sweeps, the same way as the Discord side.

**Never run the backfill during hour 18 UTC.** The scheduled sweep makes the
same full roster pass at that hour. Two passes racing each other can each
diff a member before the other advances the baseline, so the same change is
recorded twice.

1. Deploy (merge to `main`). The migration runs on the first identity query.
2. Get the sweep's credential from a **dedicated Meetup account**: one that
   is an organizer of the group and that nobody uses for their own Meetup
   commands. Sign in to meetup.com as that account, run
   `/meetup_get_token sweep_credential:True` in the server as an organizer,
   copy the refresh token from the reply, and set it as
   `MEETUP_ORGANIZER_REFRESH_TOKEN` in Heroku config. See "Where the
   credential must come from" below before doing this.
3. Run the Meetup backfill and confirm it reports 0 changes:

       DATABASE_URL=$(heroku config:get DATABASE_URL -a meetup-discord-bot) \
       MEETUP_KEY=$(heroku config:get MEETUP_KEY -a meetup-discord-bot) \
       MEETUP_SECRET=$(heroku config:get MEETUP_SECRET -a meetup-discord-bot) \
       MEETUP_ORGANIZER_REFRESH_TOKEN=$(heroku config:get MEETUP_ORGANIZER_REFRESH_TOKEN -a meetup-discord-bot) \
       yarn tsx scripts/backfillMeetupIdentity.ts

The Discord backfill script (`scripts/backfillIdentityBaseline.ts`) remains
for a fresh database. Running it against production is harmless but
unnecessary: with baselines present it behaves like a sweep, recording any
genuine drift as `backfill`-sourced changes.

Either backfill script exiting non-zero (including "0 scanned") means something is
wrong with credentials or connectivity, not that the roster is empty --
resolve it before the next digest runs.

#### Where the credential must come from

A Meetup grant must have exactly one thing refreshing it. The sweep refreshes
its credential every day, and the bot also refreshes each member's own
connection whenever they use a Meetup command. If both held the same grant
and Meetup rotates refresh tokens, each refresh would invalidate the other
holder's copy: the sweep would stop, or the member would be asked to
reconnect, at random.

So the seed must never be a token whose owner also uses Meetup commands:

- Use a dedicated Meetup account for monitoring, with organizer access to the
  group so it can read the roster.
- The refresh token is only shown with `sweep_credential: True`. Without the
  option the command shows an access token and leaves your connection alone.
- `/meetup_get_token` returns the token of whichever Meetup account your
  Discord user is connected with. If the reply comes back **without** a
  "connect your Meetup account" prompt first, it is from a connection saved
  earlier -- most likely your own account. Discard it, sign in to meetup.com
  as the dedicated account, and run the command again; this time you will be
  prompted, and the reply is the dedicated account's token.
- Showing the refresh token hands the connection over: the bot forgets it
  straight after the reply, so the sweep is the only holder. The next Meetup
  command you run will ask you to connect again -- sign back in to meetup.com
  as yourself first.

#### Replacing the Meetup organizer credential

Which steps you need depends on whether the *stored* credential still works.
The sweep resolves the stored pair first and only falls back to the config
var, so the two cases are genuinely different:

- **The grant was revoked or expired** (the sweep is alerting). The quickest
  fix is the dashboard's Renew organizer login page
  (`/dashboard/organizer-login`), signed in to Meetup as the dedicated
  account. The config var still works as a fallback: once Meetup definitely
  rejects the stored refresh token (`invalid_grant`, or a bare 401), the
  sweep tries `MEETUP_ORGANIZER_REFRESH_TOKEN`. A timeout, outage, 5xx, 429
  or `invalid_client` never falls through to it -- the stored token may be
  fine. So, signed in to meetup.com as the dedicated account (see above), run
  `/meetup_get_token sweep_credential:True`, copy the refresh token, set
  `MEETUP_ORGANIZER_REFRESH_TOKEN`.
- **The stored pair is still valid but you want a different grant** -- a new
  organizer, or rotating away from someone leaving. Setting the config var
  alone changes nothing, because the still-working stored pair keeps winning.
  Clear the stored row first, then set the var:

      DATABASE_URL=$(heroku config:get DATABASE_URL -a meetup-discord-bot) \
      yarn tsx scripts/backfillMeetupIdentity.ts --clear-credential

  Then set `MEETUP_ORGANIZER_REFRESH_TOKEN` to the new refresh token, obtained
  from the dedicated account as above. The
  next sweep seeds from it and stores the result.

Either way the new token must belong to the organizer account on record
(below): a token of any other Meetup account is refused before it is stored
or used, and the sweep alerts instead.

Revoking the old grant itself is done from Meetup's application settings;
clearing the row only stops this bot from using it.

#### Changing the recorded organizer account

The bot records the organizer account's Meetup member id (in
`oauth_credential_meta`) the first time it sees a working credential, and
from then on refuses any refreshed, seeded or renewed token that belongs to a
different account -- a personal account must never become the sweep
credential. There is no admin page for changing it yet. To move the sweep to
a different dedicated account:

1. Set `MEETUP_ORGANIZER_MEMBER_ID` in Heroku config to the new account's
   Meetup member id (digits only).
2. Delete the recorded id (this also clears any open failure episode):

       heroku pg:psql -a meetup-discord-bot
       DELETE FROM oauth_credential_meta WHERE key = 'meetup_organizer';

3. Renew from the dashboard (`/dashboard/organizer-login`) while signed in to
   Meetup as the new account. The page checks the account against
   `MEETUP_ORGANIZER_MEMBER_ID` and records it.

### Member bans

Bans live on the Suspensions page's **Banned** tab of the staff dashboard.
They are records only: the bot never removes anyone from Discord or Meetup;
staff do that by hand. Moderators and the 1.5 Leadership Team see the tab;
only the 1.5 Leadership Team can add, import, lift or upload a photo, checked
live with Discord on every action. The no-show workspace marks a banned
member's cards and refuses to record or link a suspension for them.

- **Table.** `member_bans` is created on first use under the dashboard schema
  lock. No migration step is needed on deploy.
- **Photos.** One photo per ban, at most 150 KB. An upload is re-encoded in
  the browser to WebP (JPEG on Safari) at most 512 px on a side; the server
  accepts only WebP or JPEG, re-checks the size and strips metadata. A lifted
  ban keeps its photo, and a re-ban starts with it.
- **Sweep fill.** At 18:00 UTC, with the identity digest, the bot fills a
  photo into active bans that have none: the linked Discord avatar, else the
  Meetup photo, else the newest stored identity image. At most 50 bans per
  run, a 90 s limit, and it never replaces a photo. It logs counts only.
  Sweep photos are kept small only by asking Discord for `size=256` and
  Meetup for `standardUrl` (then `thumbUrl`) and by the 150 KB cap; there is
  no 512 px check on them, unlike uploads.
- **Not yet checked on Safari or iPhone.** The upload has been exercised in
  Chrome (WebP, and the forced JPEG fallback) but not on a real Safari or
  iPhone. Someone must upload a photo from each before staff rely on uploads.
- **Importing the tracker's bans.** Run the local scripts in
  `.superpowers/backfill/` (gitignored): `ban_review.py` writes
  `ban-review.csv` and the extracted photos; after Stacey reviews it,
  `ban_to_import.py` turns it into the import CSV. Paste that into **Import
  bans**, upload each photo with **Upload photo**, then delete the local
  files. Nothing from the tracker is committed, put in a PR or posted to
  Discord.
- **Deploys.** Deploys between 18:00 and 19:00 UTC restart the bot during the
  daily identity sweep.
