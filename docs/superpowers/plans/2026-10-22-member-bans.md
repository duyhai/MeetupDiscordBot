# Member Bans Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff record, list, import and lift member bans in the dashboard, each with one compressed photo that staff upload or the daily identity sweep fills in, and the no-show workspace refuses to suspend a banned member.

**Architecture:** A new `member_bans` table on the dashboard pool, created on first use under the dashboard schema advisory lock, read by explicit-column list queries that never select `photo`. Bans get a Banned tab on the Suspensions page and their own POST routes behind the router's existing CSRF/Origin/rate-limit guard, each with a live 1.5 Leadership Team check. A fixed nonce'd browser script re-encodes the picked photo on a canvas and submits base64url in a normal form post; the server re-checks type, header dimensions and size. After the daily sweeps, a guarded fill step stores a profile photo only `WHERE photo IS NULL`.

**Tech Stack:** TypeScript (Node ESM, `.js` import suffixes), Express 5, node-pg on Postgres 16, discord.js embeds, csv-parse, vitest (unit + `vitest.integration.config.ts`), supertest-style loopback harness. No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-22-member-bans-design.md` (approved by Hai 2026-10-22: "build the revised bans design, keeping photos on lifted bans"). Where this plan and the spec differ, the plan says so and why (Decisions D1–D12).

## Global Constraints

- Access: Moderator (`912474048775221270`) or 1.5 Leadership Team (`1347289004932075521`) see the dashboard. Only 1.5 Leadership Team may record, import, upload or lift a ban, checked live on every POST (`leadershipOf`, `LEADERSHIP_CHECK_DEADLINE_MS` 5 s). Cached roles only decide what a page shows.
- Every state change is a POST through `protectedRoutes`. CSRF, Origin, Sec-Fetch-Site and the per-user `actionLimiter` (30 per minute) come from `dashboardUnsafeMethodGuard`. No route adds its own.
- CSP does not change: `default-src 'none'; style-src 'nonce-…'; script-src 'nonce-…'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`. No `blob:`/`data:` image, no fetch/XHR, no worker.
- The html guard is strict: data only in allow-listed attributes as escaped strings or numbers; URL attributes take a `SafeUrl`; nothing interpolated into `id`, `name`, `type`, `method`, `on*`, `style`, `<script>` or `<style>`; `data-label` is literal only; `<noscript>` is refused by the guard; a literal `<` is `&lt;`. Scripts are `staticRaw` constants with the page nonce.
- All member-supplied text is escaped and wrapped in `<bdi>` (`memberText`). Meetup links only from all-digit ids (`memberLink`, `meetupProfileUrl`).
- Lists paginate at 50 (`PAGE_SIZE`). Photos stream one per request. Nothing reads all photos, a whole table of bytes, or the whole roster twice into memory (512 MB dyno).
- Body limit stays `32kb` for every route except `POST /dashboard/bans/:id/photo`, which gets `220kb`.
- Photo caps: at most 150 KB (`153600` bytes) and at most 512 px on either side for uploads; at most 150 KB and PNG/JPEG/WebP by magic bytes for sweep fills.
- No pings: every embed goes through `logModeration` (`allowedMentions: { parse: [] }`, no `content`), carries no photo and links the Banned tab. Nothing from the tracker (names, notes, photos) is posted to Discord, committed, or pasted into a PR.
- DDL runs in `inDashboardTransaction` (its `lock_timeout` 15 s and idle timeout 20 s) under `pg_advisory_xact_lock(DASHBOARD_LOCK_CLASS, SCHEMA_LOCK_KEY)`. A boot on an existing schema takes nothing stronger than `AccessShareLock` (catalog-guarded `CREATE INDEX`). DATE columns are written as `$n::date` and read with `to_char`.
- Every request path has a deadline: page reads `PAGE_LOAD_DEADLINE_MS` (10 s, via `load`); ban POST service calls 20 s (`BAN_REQUEST_DEADLINE_MS`); the sweep fill 90 s overall with a 60 s download budget and 5 s per fetch. A deadline never leaves an unhandled rejection.
- Errors log the error's class name only; never ids, names, notes, URLs with tokens, or bytes. The sweep fill logs counts only.
- TDD for every task. A mutation check for every security, ban-effect or alerting rule: make the stated change in `src/`, run the named test, confirm it fails, revert so `git diff` is clean, and list each result in the report.
- Unit tests: `yarn test <file>`. Integration: only throwaway containers, `docker run -d --rm --name dash-pg-test -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:16` and `docker run -d --rm --name dash-redis-test -p 127.0.0.1:56379:6379 redis:7`, run with `DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres REDISCLOUD_URL=redis://127.0.0.1:56379 yarn vitest run --config vitest.integration.config.ts <file>`. Never 5432/6379. Integration files that write shared tables use `tst/integration/isolatedSchema.ts`; catalog queries filter by `current_schema()`. Stop the containers (and colima, if you started it) afterwards.
- No production reads or writes, no Discord posts, no Meetup calls in tests or by hand. Never print tokens or secrets.
- `yarn lint` passes before each commit. Commit messages are one plain imperative sentence (no prefix) ending with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No amend, rebase, force-push, push or merge.
- PR description (when Hai asks for one) ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)` and carries: _deploys between 18:00 and 19:00 UTC restart the bot during the daily identity sweep._

## Review Focus

1. **A forged photo field**: base64 with bad characters or padding, a body over 220 KB, bytes that start `RIFF….WEBP` but carry HTML, a trailing payload, an animated or 4000 px WebP, a PNG. Expected: a fixed "photo not accepted" notice (or the 400 page for an oversized body), nothing stored, never a 500, never the bytes echoed. Tests: Task 3 (`readImageSize` vectors), Task 4 (`checkBanPhoto`), Task 6 (route).
2. **A spoofed member id** in Add or Import: `12a4`, ` 123`, `+123`, 21 digits, `١٢٣` (Arabic-Indic digits), an id in the URL path instead of the form. Expected: refused with fixed text and a row number, nothing written, no Meetup link built. Tests: Task 1 (DB CHECK), Task 4 (parser and `recordBan`), Task 5 (route).
3. **Two writers banning one member at once**: two imports, an import and an Add, or one import listing the member twice. Expected: exactly one active ban; the losing import writes no row at all and names the row. Tests: Task 1 (concurrent `importMany`), Task 4 (duplicate inside one file).
4. **Photo lifecycle races**: the sweep fill and a staff upload landing together; a lifted ban followed by a re-ban. Expected: the staff photo always wins and the sweep never replaces a photo; the lifted row keeps its photo, and the new active ban starts with the member's latest lifted photo (D8), which the sweep then leaves alone. Tests: Task 1 (upload vs fill, re-ban), Task 8 (fill skips a filled row).
5. **A banned member with workspace cards in several months** (for example September and October). Expected: every card shows the coral Banned badge and offers no Record or Link suspension; the POST refuses both with "This member is banned." in every month, even when the ban lands between page load and POST; void, hold, skip and notes still work. Tests: Task 7.

---

## Decisions this plan makes

- **D1 Task split.** Nine tasks: schema/repository; read-only Banned tab and photo GET; image header checks; CSV parser and service; add/import/lift routes; photo upload; workspace badge and refusal; sweep fill; docs and the local import tool. The suggested "Add, import and lift" task is split into service (Task 4) and routes (Task 5), and the image checks are their own task (Task 3), because each is a separate security gate a reviewer could reject alone.
- **D2 Safari and the upload format.** WebKit's canvas does not encode WebP: `toBlob(cb, 'image/webp', q)` returns a PNG blob there (the spec's fallback type). A 512 px photo as PNG is routinely over 150 KB, so a PNG fallback is not useful. The script therefore checks `blob.type`; when it is not `image/webp`, it re-encodes as `image/jpeg` with the same quality steps. JPEG through a canvas also drops all metadata. **The server accepts WebP or JPEG** (refuses PNG and everything else) and reads dimensions from the VP8/VP8L/VP8X header or the JPEG SOF marker. The SOF walk is a bounded marker loop over at most 150 KB, each step advancing at least 2 bytes, with bounds checks: cheap and safe. This widens the spec's "only bytes that sniff as WebP" and needs Hai's OK (Question Q1). If Hai says WebP only, delete the JPEG branch in Task 3 and the fallback in Task 6, and Safari users get the fixed "This browser cannot make the photo; use Chrome, Edge or Firefox" note.
- **D3 Base64url, not base64.** Standard base64 has `+` and `/`, which a form post percent-encodes to 3 bytes each, so a 150 KB photo could exceed 220 KB on the wire. Base64url (`-`, `_`, no padding) is sent unescaped: 153600 bytes become at most 204800 characters. The server accepts only `^[A-Za-z0-9_-]{1,204800}$` and decodes with `Buffer.from(s, 'base64url')`, then re-encodes and compares, so non-canonical input is refused.
- **D4 Route-specific body limit.** The 32 kB `express.urlencoded` parser runs on the outer router before the session gate and the CSRF guard (which reads `_csrf` from the parsed body). It is replaced by one dispatcher: `POST` whose `req.path` matches `BAN_PHOTO_BODY_PATH` (`/^\/bans\/[1-9][0-9]{0,8}\/photo\/?$/`, case-sensitive like the protected router) gets a `220kb` parser; everything else keeps `32kb`. Accepted residual: a signed-out client can make the server buffer up to 220 KB on that one path before the gate answers 403.
- **D5 No `<noscript>`.** The guard refuses it. The "enable JavaScript" note is rendered visible; the script hides it and un-hides the picker.
- **D6 WebP header offsets** (all little-endian; `RIFF` at 0, RIFF size at 4, `WEBP` at 8, first chunk FourCC at 12, chunk size at 16, payload at 20). Require `readUInt32LE(4) + 8 === bytes.length`.
  - `VP8 ` (lossy): frame tag bytes 20–22 with bit 0 of byte 20 clear (key frame); start code `9D 01 2A` at 23–25; width = `readUInt16LE(26) & 0x3fff`; height = `readUInt16LE(28) & 0x3fff`. Needs length ≥ 30.
  - `VP8L` (lossless): signature `0x2F` at 20; width = 1 + (`b[21]` | (`b[22]` & 0x3f) << 8); height = 1 + ((`b[22]` >> 6) | `b[23]` << 2 | (`b[24]` & 0x0f) << 10); version `b[24] >> 5` must be 0. Needs length ≥ 25.
  - `VP8X` (extended): flags at 20; refuse when the animation bit (`0x02`) is set; width = 1 + `readUIntLE(24, 3)`; height = 1 + `readUIntLE(27, 3)`. Needs length ≥ 30.
  - JPEG: from offset 2, skip `0xFF` fill bytes, read the marker; `D8`/`01`/`D0`–`D7` have no length; `D9` or `DA` before a SOF means no size; otherwise length = `readUInt16BE(p)` (≥ 2). SOF markers are `C0`–`CF` except `C4`, `C8`, `CC`: height = `readUInt16BE(p + 3)`, width = `readUInt16BE(p + 5)`. Zero sizes are refused.
- **D7 Which workspace actions a ban blocks.** `record_suspension` and `link_suspension` (they create or attach a suspension). `void`, hold, skip, reopen, notes and the warning actions stay, so a wrong record can still be voided. Spec says "offers no suspension actions"; Question Q2 asks Hai to confirm `void` stays.
- **D8 Re-ban photo.** A new ban for a member whose latest lifted ban has a photo starts with that photo (all four photo columns copied in the same `INSERT … SELECT`, bytes never pass through Node). The spec keeps photos on lifted bans "so the person can still be recognised"; carrying it forward is the same intent. The sweep then never touches it.
- **D9 Ban vs suspension serialisation.** Recording or importing a ban takes `pg_advisory_xact_lock(MEMBER_LOCK_CLASS, hashtext('suspension:' || member_id))` for each distinct key in ascending key order (keys read with `SELECT DISTINCT hashtext('suspension:' || m) AS k FROM unnest($1::text[]) m ORDER BY k`, so even colliding keys are always taken in one order), the same key `applyAction` takes for record/link. `applyAction` checks for an active ban after taking that lock. So a ban and a suspension for one member cannot interleave, and two imports cannot deadlock.
- **D10 Import results.** Refusals render the Banned tab directly with status 422 and a fixed message per error with its row number (at most 10 listed, then "and N more"); nothing from the CSV is echoed, and the textarea comes back empty. Success redirects 303 with `result=imported`. The import embed carries only the count, the actor and the link: no names or ids (spec: nothing from the tracker is posted to Discord).
- **D11 Notes column on import.** The CSV's `notes` is stored as staff-written notes. The local converter (Task 9) writes only the fixed provenance line `Imported from the no-show tracker's Banned Members tab`, which is how "the import writes only a fixed provenance line" holds.
- **D12 Sweep sources and placement.** The fill runs in `runIdentityDigestOnce` right after the two `runSweepOrDegrade` calls, before the change ceiling is read. Sources, first that yields acceptable bytes wins:
  1. Discord: the Meetup id's linked Discord id (`discordIdsByMeetupIds`) still in the guild's member cache (populated by the Discord sweep's `guild.members.fetch()`); guild avatar first, else user avatar; `avatarThumbUrl(…, 256)`.
  2. Meetup: the roster `runMeetupSweep` already fetched. The roster query today asks only `memberPhoto { id thumbUrl }`; the API's `PhotoInfo` also has `baseUrl highResUrl standardUrl` (identity spec). The query gains `standardUrl`; the fill tries `standardUrl`, then `thumbUrl`, never `highResUrl` (an unbounded original). Each fetch is capped by streaming (aborted past 153600 bytes), so a too-large standard photo falls back to the thumb with no local resizing. Sizes are unverified (no Meetup calls allowed): Question Q3.
  3. Stored identity: the newest of the member's stored `new_thumb` change images (Meetup subject, and Discord subject if linked) and baseline images (`meetup_identity.photo_thumb`, `member_identity.member_avatar_thumb`, then `user_avatar_thumb`), by `detected_at`/`updated_at`, at most 153600 bytes, in the monitored scopes.
- **D13 Refused Leadership POSTs** answer `not-leadership` / `leadership-unavailable` and post nothing (the workspace's refusal embed is not copied; YAGNI). Logged by class only.

## Questions for Hai (answered 2026-10-22: Q1, Q2 and Q4 yes as defaulted; Q3 ships as defaulted)

- **Q1** Accept JPEG uploads as well as WebP so Safari works (D2)? **Hai: yes.**
- **Q2** A banned member's card still allows voiding an existing suspension record (D7)? **Hai: yes.**
- **Q3** Meetup's `standardUrl` size is unverified; first sweep after deploy logs how many fills came from each source (counts only). Default: ship with standard-then-thumb.
- **Q4** A re-ban starts with the latest lifted photo (D8)? **Hai: yes.**

## File Structure

| File                                                                                                                                                                    | New/Mod         | Responsibility                                                             | Task    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------- | ------- |
| `src/lib/bans/types.ts`                                                                                                                                                 | new             | Ban row and insert types, caps, states                                     | 1       |
| `src/lib/repositories/postgresBanRepository.ts`                                                                                                                         | new             | `member_bans` DDL, guarded ensure, all ban SQL                             | 1       |
| `src/lib/repositories/dashboardPool.ts`                                                                                                                                 | —               | consumed (`inDashboardTransaction`, lock classes)                          | 1       |
| `tst/integration/postgresBanRepository.test.ts`                                                                                                                         | new             | schema, locks, concurrency, photo races                                    | 1       |
| `src/lib/reports/dashboardPaths.ts`                                                                                                                                     | mod             | `bans`, `banImport`, `banLift`, `banPhoto` paths                           | 2       |
| `src/web/routes/bannedTab.ts`                                                                                                                                           | new             | Banned tab markup (pure render functions)                                  | 2, 5, 6 |
| `src/web/routes/suspensions.ts`                                                                                                                                         | mod             | Banned tab in the tab nav and dispatch                                     | 2       |
| `src/web/routes/bans.ts`                                                                                                                                                | new             | ban routes: photo GET, add/import/lift/photo POST                          | 2, 5, 6 |
| `src/web/routes/dashboardPages.ts`                                                                                                                                      | mod             | `BanPageReader`, `BanActions`, `bans`, `banActions` deps; register         | 2, 5    |
| `src/web/dashboardDeps.ts`                                                                                                                                              | mod             | production wiring                                                          | 2, 5    |
| `src/web/pages.ts`                                                                                                                                                      | mod             | `img.ban-photo`, `canvas.ban-preview` styles                               | 2, 6    |
| `tst/web/routes/pageFakes.ts`                                                                                                                                           | mod             | `banRow`, `fakeBans`, `fakeBanActions`                                     | 2, 5    |
| `tst/web/routes/bans.test.ts`                                                                                                                                           | new             | tab, photo GET, POSTs                                                      | 2, 5, 6 |
| `tst/web/routes/access.test.ts`                                                                                                                                         | mod             | new unsafe routes' expected statuses                                       | 2, 5, 6 |
| `src/lib/helpers/imageBytes.ts`                                                                                                                                         | new             | `sniffImageType` (moved), `readImageSize`                                  | 3       |
| `src/web/images.ts`                                                                                                                                                     | mod             | re-export from imageBytes                                                  | 3       |
| `tst/lib/helpers/imageBytes.test.ts`                                                                                                                                    | new             | header vectors                                                             | 3       |
| `src/lib/helpers/suspensionCsv.ts`                                                                                                                                      | mod             | export shared `readCsvRecords`                                             | 4       |
| `src/lib/bans/banCsv.ts`                                                                                                                                                | new             | strict ban CSV parser, fixed error codes                                   | 4       |
| `src/lib/bans/service.ts`                                                                                                                                               | new             | record/import/lift/upload, Leadership gate, embeds                         | 4       |
| `tst/lib/bans/banCsv.test.ts`, `tst/lib/bans/service.test.ts`                                                                                                           | new             |                                                                            | 4       |
| `src/web/routes/workspaceActions.ts`                                                                                                                                    | mod             | export `withDeadline`; `banned` result text                                | 5, 7    |
| `src/web/dashboardRouter.ts`                                                                                                                                            | mod             | body-limit dispatcher                                                      | 6       |
| `src/web/pageKit.ts`                                                                                                                                                    | mod             | `BAN_PHOTO_SCRIPT`, `script: 'bans'`                                       | 6       |
| `tst/web/banPhotoScript.test.ts`, `tst/web/dashboardRouter.bodyLimit.test.ts`                                                                                           | new             |                                                                            | 6       |
| `src/lib/workspace/types.ts`, `src/lib/repositories/postgresNoShowWorkspaceRepository.ts`, `src/web/routes/workspace.ts`                                                | mod             | `banned` refusal, badge, ensure bans schema                                | 7       |
| `src/util/boundedFetch.ts`                                                                                                                                              | mod             | `fetchBytesCapped`                                                         | 8       |
| `src/lib/bans/photoFill.ts`                                                                                                                                             | new             | the sweep fill                                                             | 8       |
| `src/lib/helpers/identity/snapshot.ts`, `meetupSweep.ts`, `digest.ts`, `src/lib/client/meetup/{types,queries}.ts`, `src/lib/repositories/postgresIdentityRepository.ts` | mod             | size param, roster hand-off, fill call, `standardUrl`, `latestStoredPhoto` | 8       |
| `README.md`, the spec                                                                                                                                                   | mod             | operations notes, status                                                   | 9       |
| `.superpowers/backfill/ban_review.py`, `ban_to_import.py`                                                                                                               | new, gitignored | local tracker extraction                                                   | 9       |

---

### Task 1: `member_bans` schema and repository

**Files:**

- Create: `src/lib/bans/types.ts`, `src/lib/repositories/postgresBanRepository.ts`
- Test: `tst/integration/postgresBanRepository.test.ts`, `tst/lib/repositories/postgresBanRepository.test.ts` (query-text unit test with a stub pool)
- Also: `git add docs/superpowers/specs/2026-10-22-member-bans-design.md docs/superpowers/plans/2026-10-22-member-bans.md` in this task's commit.

**Interfaces:**

- Consumes: `inDashboardTransaction(pool, label, fn, options)`, `dashboardPool()`, `DASHBOARD_LOCK_CLASS`, `SCHEMA_LOCK_KEY`, `MEMBER_LOCK_CLASS`, `DashboardTransactionOptions` from `dashboardPool.ts`.
- Produces (`src/lib/bans/types.ts`):
  ```ts
  export const BAN_PHOTO_MAX_BYTES = 153_600;
  export const BAN_PHOTO_MAX_SIDE = 512;
  export const BAN_NAME_MAX = 500; // code points
  export const BAN_NOTES_MAX = 2000; // code points
  export const BAN_LIFT_REASON_MAX = 500; // code points
  export const BAN_IMPORT_MAX_ROWS = 200;
  export const BAN_FILL_MAX_PER_RUN = 50;
  export type BanState = 'active' | 'lifted';
  export type BanPhotoSource = 'upload' | 'profile';
  export interface BanRow {
    id: number;
    memberId: string;
    memberName: string;
    bannedOn: string | null; // 'YYYY-MM-DD'; null = date unknown
    notes: string;
    recordedBy: string;
    createdAt: Date;
    hasPhoto: boolean;
    photoSource: BanPhotoSource | null;
    photoUpdatedAt: Date | null;
    photoUpdatedBy: string | null;
    liftedAt: Date | null;
    liftedBy: string | null;
    liftReason: string | null;
  }
  export interface BanInsert {
    memberId: string;
    memberName: string;
    bannedOn: string | null;
    notes: string;
    recordedBy: string;
  }
  export type BanRecordOutcome =
    { ok: true; ban: BanRow } | { ok: false; reason: 'already-banned' };
  export type BanImportOutcome =
    | { ok: true; count: number }
    | { ok: false; reason: 'already-banned'; index: number };
  ```
- Produces (`postgresBanRepository.ts`): `BAN_SCHEMA_SQL`, `UPLOAD_PHOTO_SQL` and `FILL_PHOTO_SQL` (exported so the race test can run them on its own client), `ensureBanSchema(pool: pg.Pool, options?: DashboardTransactionOptions): Promise<void>`, and `class PostgresBanRepository` with `constructor(pool: pg.Pool, options?: DashboardTransactionOptions)`, `static instance(): Promise<PostgresBanRepository>`, and:
  - `record(input: BanInsert): Promise<BanRecordOutcome>`
  - `importMany(inputs: BanInsert[]): Promise<BanImportOutcome>` (`index` is the 0-based input that collided)
  - `lift(id: number, liftedBy: string, reason: string): Promise<BanRow | undefined>` (undefined: unknown or already lifted)
  - `setUploadedPhoto(id: number, photo: Buffer, by: string): Promise<{ ban: BanRow; replaced: boolean } | undefined>` (active bans only)
  - `fillProfilePhoto(id: number, photo: Buffer): Promise<boolean>`
  - `listPhotoFillCandidates(limit: number): Promise<{ id: number; memberId: string }[]>`
  - `listPage(options: { state: BanState; offset: number; limit: number }): Promise<BanRow[]>`
  - `countByState(): Promise<Record<BanState, number>>`
  - `getPhoto(id: number): Promise<Buffer | undefined>`
  - `activeMemberIds(memberIds: string[]): Promise<Set<string>>`
  - `deleteAllForTest(): Promise<void>`

Schema (pinned):

| Column                                  | Definition                                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `id`                                    | `SERIAL PRIMARY KEY`                                                                                     |
| `member_id`                             | `TEXT NOT NULL CHECK (member_id ~ '^[0-9]{1,20}$')`                                                      |
| `member_name`                           | `TEXT NOT NULL DEFAULT '' CHECK (length(member_name) <= 500)`                                            |
| `banned_on`                             | `DATE` (NULL = date unknown)                                                                             |
| `notes`                                 | `TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 2000)`                                                 |
| `recorded_by`                           | `TEXT NOT NULL CHECK (recorded_by ~ '^[0-9]{17,20}$')`                                                   |
| `created_at`                            | `TIMESTAMPTZ NOT NULL DEFAULT now()`                                                                     |
| `photo`                                 | `BYTEA CHECK (photo IS NULL OR octet_length(photo) BETWEEN 1 AND 153600)`                                |
| `photo_source`                          | `TEXT CHECK (photo_source IN ('upload', 'profile'))`                                                     |
| `photo_updated_at`                      | `TIMESTAMPTZ`                                                                                            |
| `photo_updated_by`                      | `TEXT CHECK (photo_updated_by IS NULL OR photo_updated_by ~ '^[0-9]{17,20}$')`                           |
| `lifted_at`, `lifted_by`, `lift_reason` | `TIMESTAMPTZ`; `TEXT CHECK (… ~ '^[0-9]{17,20}$')`; `TEXT CHECK (length(lift_reason) BETWEEN 1 AND 500)` |

Table CHECKs: `(photo IS NULL) = (photo_source IS NULL) AND (photo IS NULL) = (photo_updated_at IS NULL)`; `photo_source IS DISTINCT FROM 'upload' OR photo_updated_by IS NOT NULL`; `photo_source IS DISTINCT FROM 'profile' OR photo_updated_by IS NULL`; `(lifted_at IS NULL) = (lifted_by IS NULL) AND (lifted_at IS NULL) = (lift_reason IS NULL)`. One index, created in a `DO` block behind `to_regclass(quote_ident(current_schema()) || '.member_bans_active_member_idx') IS NULL`: `CREATE UNIQUE INDEX member_bans_active_member_idx ON member_bans (member_id) WHERE lifted_at IS NULL`.

SQL rules the tests pin:

- `ensureBanSchema` = `inDashboardTransaction` + `pg_advisory_xact_lock(DASHBOARD_LOCK_CLASS, SCHEMA_LOCK_KEY)` + `BAN_SCHEMA_SQL`; `instance()` follows `PostgresNoShowWorkspaceRepository.instance()` (singleton promise on `dashboardPool()`, cleared on failure).
- Every read lists columns explicitly from one `BAN_COLUMNS` constant that has `photo IS NOT NULL AS has_photo` and no other mention of `photo` bytes; `banned_on` read as `to_char(banned_on, 'YYYY-MM-DD')`.
- `record`/`importMany`: one `inDashboardTransaction`; member advisory locks first (D9, distinct keys in ascending key order); then per row `INSERT … SELECT $1, $2, $3::date, $4, $5, l.photo, l.photo_source, l.photo_updated_at, l.photo_updated_by FROM (SELECT 1) one LEFT JOIN LATERAL (latest lifted ban of the member with a photo, by lifted_at DESC, id DESC) l ON true ON CONFLICT (member_id) WHERE lifted_at IS NULL DO NOTHING RETURNING <BAN_COLUMNS>`. Zero rows: throw a private refusal so the transaction rolls back, return `already-banned` (with `index` for imports).
- `lift`: `UPDATE … SET lifted_at = now(), lifted_by = $2, lift_reason = $3 WHERE id = $1 AND lifted_at IS NULL RETURNING …`. Photo columns untouched.
- `setUploadedPhoto`: `WITH old AS (SELECT id, photo IS NOT NULL AS had FROM member_bans WHERE id = $1 AND lifted_at IS NULL FOR UPDATE) UPDATE member_bans b SET photo = $2, photo_source = 'upload', photo_updated_at = now(), photo_updated_by = $3 FROM old WHERE b.id = old.id RETURNING …, old.had`.
- `fillProfilePhoto`: `UPDATE member_bans SET photo = $2, photo_source = 'profile', photo_updated_at = now(), photo_updated_by = NULL WHERE id = $1 AND photo IS NULL AND lifted_at IS NULL`; true when `rowCount === 1`.
- `listPhotoFillCandidates`: active, `photo IS NULL`, `ORDER BY id`, `LIMIT least($1, 50)`.
- `listPage`: active ordered `created_at DESC, id DESC`; lifted ordered `lifted_at DESC, id DESC`; limit capped at 50 (0 or junk = 50); bad state is a `RangeError` before any query.
- `getPhoto`: `SELECT CASE WHEN octet_length(photo) <= 153600 THEN photo END AS photo FROM member_bans WHERE id = $1`; ids outside 1..2^31-1 return undefined with no query.
- `activeMemberIds`: deduped, only `^[0-9]{1,20}$`; more than 1000 left is a `RangeError` before any query; none left runs no query.

- [ ] **Step 1: Write the failing unit test** `tst/lib/repositories/postgresBanRepository.test.ts`, a stub pool recording every SQL text:
  - `list reads never select the photo bytes`: call `listPage` (both states), `countByState`, `activeMemberIds(['1'])`, `listPhotoFillCandidates(5)`; for each recorded SQL, `expect(sql.replace(/photo IS (NOT )?NULL/g, '')).not.toMatch(/\bphoto\b(?!_)/)` and `expect(sql).not.toMatch(/SELECT \*/i)`.
  - `listPage refuses a bad state before any query` (`RangeError`, zero calls).
  - `getPhoto skips the query for id 0, -1, 2**31 and 1.5`.
- [ ] **Step 2: Run it to see it fail.** `yarn test tst/lib/repositories/postgresBanRepository.test.ts` → FAIL, module not found.
- [ ] **Step 3: Write the failing integration tests** in `tst/integration/postgresBanRepository.test.ts` (isolated schema `bans`, skipped without `DATABASE_URL`):
  - `a second boot holds nothing stronger than AccessShareLock on member_bans` (the suspension test's `relationLocksDuringSchema` pattern; non-vacuous: a bare `CREATE INDEX IF NOT EXISTS member_bans_active_member_idx …` shows `member_bans:ShareLock`).
  - `ensureBanSchema waits on the schema advisory lock and fails with a lock timeout` (`lockTimeoutMs: 200`, rejects `/lock timeout/`).
  - `CHECKs refuse a non-digit member id, a 21-digit id, '١٢٣', an upload photo without photo_updated_by, a profile photo with one, a lift without a reason, a 153601-byte photo` (raw INSERT/UPDATE, each `rejects` with code `23514`).
  - `record refuses a second active ban; after lift the member can be banned again`.
  - `Review Focus 3: two concurrent importMany calls for overlapping members leave exactly one active ban per member, and the loser wrote no row` (`Promise.all` of two `importMany` calls on two repository instances over separate pools; exactly one resolves `ok:false, reason:'already-banned'`; `count(*)` equals the winner's rows).
  - `importMany rolls back every row when one collides` (3 inputs, the 3rd already banned → `{ok:false, index:2}`, table unchanged).
  - `Review Focus 4: a fill racing an upload never replaces the uploaded photo` (a test client runs `BEGIN` and `UPLOAD_PHOTO_SQL` and leaves the transaction open; `fillProfilePhoto` starts on the repository's pool and blocks on the row; the test commits; fill resolves `false`; `getPhoto` equals the upload bytes and `photoSource === 'upload'`).
  - `fill sets profile source and null updater, and never touches a lifted or already-filled ban`.
  - `setUploadedPhoto replaces a profile photo and reports replaced: true; refuses a lifted ban`.
  - `Review Focus 4: a re-ban starts with the latest lifted photo; the lifted row keeps its own`.
  - `lift keeps the photo; listPage('lifted') shows who, when, why and hasPhoto`.
  - `banned_on round-trips '2026-02-28' and null in a non-UTC process` (`TZ` already set by the suite or set `process.env.TZ='America/Los_Angeles'` before importing).
  - `getPhoto returns the bytes for one id and undefined for a ban without a photo`.
- [ ] **Step 4: Run them to see them fail.** Start the containers (Global Constraints), run the integration command on this file → FAIL, module not found.
- [ ] **Step 5: Implement** `src/lib/bans/types.ts` and `src/lib/repositories/postgresBanRepository.ts` as pinned above. Name values in errors never; a refusal is a private `BanRefusal extends Error` caught at the method boundary.
- [ ] **Step 6: Run both test files to see them pass.** Expected: PASS; integration twice in a row (the second run proves the guarded re-ensure).
- [ ] **Step 7: Mutation checks.**
  1. Select `*` in `listPage` → `list reads never select the photo bytes` fails.
  2. Drop `AND photo IS NULL` from `fillProfilePhoto` → the race test fails.
  3. Remove the `to_regclass` guard around the index → the AccessShareLock test fails.
  4. On a collision, skip that row and continue instead of rolling back → `importMany rolls back every row` fails.
  5. Remove the member advisory locks, or change the key prefix to `'ban:'` → `D9: record waits on the member suspension lock applyAction takes` fails (a test client holds `pg_advisory_xact_lock(MEMBER_LOCK_CLASS, hashtext('suspension:42'))`; `record` must show an ungranted advisory lock in `pg_locks` within 2 s and stay pending until the commit).
- [ ] **Step 8: Lint and commit.** `yarn lint` clean; `git add src/lib/bans/types.ts src/lib/repositories/postgresBanRepository.ts tst/lib/repositories/postgresBanRepository.test.ts tst/integration/postgresBanRepository.test.ts docs/superpowers/specs/2026-10-22-member-bans-design.md docs/superpowers/plans/2026-10-22-member-bans.md`; commit "Add the member_bans table and its repository".

---

### Task 2: Read-only Banned tab and the photo route

**Files:**

- Modify: `src/lib/reports/dashboardPaths.ts`, `src/web/routes/suspensions.ts`, `src/web/routes/dashboardPages.ts`, `src/web/dashboardDeps.ts`, `src/web/pages.ts` (STYLE), `tst/web/routes/pageFakes.ts`, `tst/web/routes/access.test.ts`
- Create: `src/web/routes/bannedTab.ts`, `src/web/routes/bans.ts`, `tst/web/routes/bans.test.ts`

**Interfaces:**

- Consumes: Task 1's `BanRow`, `BanState`, `PostgresBanRepository` (`listPage`, `countByState`, `getPhoto`).
- Produces:
  - `DASHBOARD_PATHS.bans = '/bans'`, `banImport = '/bans/import'`, `banLift = '/bans/:id/lift'`, `banPhoto = '/bans/:id/photo'`.
  - `export type BanPageReader = Pick<PostgresBanRepository, 'listPage' | 'countByState' | 'getPhoto' | 'activeMemberIds'>` and `DashboardPageDeps.bans: () => Promise<BanPageReader>` in `dashboardPages.ts`; production `bans: () => PostgresBanRepository.instance()`.
  - `bannedTab.ts`: `export function bannedTabPath(params?: { show?: BanState; result?: string }): string` (`/dashboard/suspensions?state=banned…`), `export function bannedTabBody(view: BannedTabView): SafeHtml` with `interface BannedTabView { show: BanState; rows: BanRow[]; counts: Record<BanState, number>; page: number; notice: SafeHtml | ''; leader: boolean; csrf: string }` (`leader`/`csrf` unused until Task 5), `export function banPhotoPath(id: number): string`.
  - `bans.ts`: `export function registerBanRoutes(router: express.Router, deps: Pick<DashboardPageDeps, 'now' | 'bans'>): void` (Task 5 widens the Pick), called from `registerDashboardPages`.
  - `pageFakes.ts`: `banRow(overrides?: Partial<BanRow>): BanRow`, `fakeBans(rows?: Partial<Record<BanState, BanRow[]>>, photos?: Record<number, Buffer>)` returning a `BanPageReader` of `vi.fn`s; `fakePageDeps` gets `bans: async () => fakeBans({ active: [banRow({ id: 1, hasPhoto: true })] }, { 1: WEBP_BYTES })`.

Rendering rules: the Suspensions tab nav gains `Banned (n)` (n = active count) linking `?state=banned`; on that tab the suspension list is not read (only `countByState(today)` for the other labels) and `load` reads `bans.listPage` + `bans.countByState`. A `show` choices nav (`Active (n)`, `Lifted (n)`; default active; anything else is active). `table.stack` with literal `data-label`s: Photo, Member, Banned, Recorded by, Notes, Photo from; lifted adds Lifted, Lifted by, Reason. Photo cell: `<img class="ban-photo" src="${localUrl(banPhotoPath(id))}" width="96" height="96" alt="Photo of the banned member" loading="lazy" />` when `hasPhoto`, else the text "No photo". Member cell: `memberLink({ id, name: memberName || memberId })` plus `(${memberId})`. Banned: the date, or "Date unknown". Photo from: "Uploaded by <discordUserLink> on <pacificDate>" or "From their profile on <pacificDate>", empty without a photo. A row failing an `isBanRow` shape check renders the 503 page (as `isPageRow`). STYLE: `img.ban-photo{display:block;width:96px;max-width:100%;height:auto;aspect-ratio:1;object-fit:cover;border-radius:8px}`.

Photo route: `GET /bans/:id/photo`; `parseRowId` on `:id` else `notFound`; `req.socket?.destroyed` → return; `load(res, 'The photo', …getPhoto(id))`; bytes must be a Buffer and `sniffImageType` known, else `notFound` (404 page, no bytes); headers exactly as the identity thumb route (`Content-Type` from the sniff, `Content-Length`, `Content-Disposition: inline`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`).

- [ ] **Step 1: Write the failing tests** in `tst/web/routes/bans.test.ts` (setup like `suspensions.test.ts`):
  - `the Suspensions tabs include Banned with the active count` (`Banned (2)`).
  - `the Banned tab shows photo, member link, id, date or Date unknown, recorder, notes and photo source` (two rows: one uploaded, one profile, one `bannedOn: null`).
  - `a ban without a photo says No photo and has no img`.
  - `a member id that is not all digits gets no Meetup link` (`memberId: '12a4'` → no `meetup.com` in the body, text shown escaped).
  - `member names and notes are escaped inside bdi` (`<script>` name → `&lt;script&gt;` inside `<bdi>`).
  - `lifted bans show who lifted, when and why, and keep the photo`.
  - `the Banned tab never reads the suspension list` (`listPage` on the suspension fake not called).
  - `a malformed ban row renders 503, not 500`.
  - `the photo route serves the sniffed type with no-store, nosniff and same-origin` (WEBP_BYTES → `image/webp`).
  - `the photo route 404s for id 0, 'abc', a ban without a photo, and bytes that sniff as nothing` (`Buffer.from('<html>')`), and the body never contains the bytes.
  - `the photo route needs a session` (no cookie → 302 to login).
  - In `access.test.ts` nothing new is needed for GET (the fake serves id 1); run it to confirm `GET /bans/:id/photo` answers 200.
- [ ] **Step 2: Run to see failures.** `yarn test tst/web/routes/bans.test.ts tst/web/routes/access.test.ts` → FAIL (no tab, 404 route).
- [ ] **Step 3: Implement** the paths, `bannedTab.ts`, the tab dispatch in `suspensions.ts` (`parseState` accepts `'banned'` as its own branch; the `SuspensionState` type is unchanged), `bans.ts` with the GET route, the deps, the fakes and the style.
- [ ] **Step 4: Run to see them pass,** plus `yarn test tst/web/routes/suspensions.test.ts tst/web/routes/responsive.test.ts tst/web/contrast.test.ts` (unchanged behaviour).
- [ ] **Step 5: Mutation checks.**
  1. Build the Meetup link as a string from `memberId` → the html guard throws, `not all digits gets no Meetup link` fails.
  2. Drop `Cache-Control: no-store` from the photo route → the headers test fails.
  3. Serve bytes whose sniff is undefined as `application/octet-stream` → the 404 test fails.
- [ ] **Step 6: Lint and commit** "Show bans on a Banned tab and serve their photos to staff".

---

### Task 3: Image header checks

**Files:**

- Create: `src/lib/helpers/imageBytes.ts`, `tst/lib/helpers/imageBytes.test.ts`
- Modify: `src/web/images.ts` (becomes `export { sniffImageType, type ThumbType } from '../lib/helpers/imageBytes.js';`)

**Interfaces:**

- Produces:

  ```ts
  export type ThumbType = 'image/png' | 'image/jpeg' | 'image/webp';
  export function sniffImageType(bytes: Buffer): ThumbType | undefined; // moved unchanged
  export interface ImageSize {
    type: 'image/webp' | 'image/jpeg';
    width: number;
    height: number;
  }
  /** WebP (VP8, VP8L, VP8X still) or JPEG (SOF) header size; undefined for anything else, malformed, truncated, animated or zero-sized. Never throws. */
  export function readImageSize(bytes: Buffer): ImageSize | undefined;
  ```

  Offsets and rules: D6.

- [ ] **Step 1: Write the failing tests** with exact vectors:
  - `VP8L 1x1`: `Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64')` → `{ type: 'image/webp', width: 1, height: 1 }`.
  - `VP8 lossy 512x384`: a 30-byte buffer built by a `vp8(width, height)` helper in the test: `RIFF`, LE size 22, `WEBP`, `VP8 `, LE size 10, bytes `00 00 00` frame tag, `9D 01 2A`, `readUInt16LE` width 512, height 384 → `{ width: 512, height: 384 }`; with scale bits set (`0xC200` for 512) the size is still 512.
  - `VP8X 640x480 still`: `vp8x(640, 480, flags = 0x10)` (alpha flag) → `{ width: 640, height: 480 }`; with `flags = 0x02` (animation) → undefined.
  - `VP8L version bits set` → undefined; `VP8 missing start code` → undefined; `VP8 non-key frame` (byte 20 bit 0 set) → undefined.
  - `RIFF size that does not match the length` (one trailing byte appended; and an HTML payload after a valid header) → undefined.
  - `a RIFF/WEBP header with chunk ALPH first` → undefined; `RIFF….AVI ` → undefined.
  - `JPEG SOF0 800x600`: `FF D8`, `FF E0 00 10` + 14 bytes, `FF C0 00 11 08 02 58 03 20` + 9 bytes → `{ type: 'image/jpeg', width: 800, height: 600 }`; with `FF FF` fill before `C0` → same; `SOF2` (`C2`) → same.
  - `JPEG that hits SOS before a SOF`, `JPEG segment length running past the end`, `length 0 or 1`, `DHT C4 is not a SOF`, `zero width` → undefined.
  - `PNG_1X1`, empty buffer, 11 bytes of `RIFF`, a 5 MB buffer of `0xFF` after `FF D8` (terminates, undefined), a non-Buffer → undefined.
  - `sniffImageType behaves as before` (the existing `tst/web/images.test.ts` stays green through the re-export).
- [ ] **Step 2: Run to see it fail.** `yarn test tst/lib/helpers/imageBytes.test.ts` → FAIL.
- [ ] **Step 3: Implement** `readImageSize` with explicit length checks before each read; JPEG walk as a `while (p + 4 <= bytes.length)` loop that always advances.
- [ ] **Step 4: Run** `yarn test tst/lib/helpers/imageBytes.test.ts tst/web/images.test.ts tst/web/routes/identity.test.ts` → PASS.
- [ ] **Step 5: Mutation checks.**
  1. Drop the RIFF size equality → `RIFF size that does not match` fails.
  2. Read VP8 width without `& 0x3fff` → the scale-bits case fails.
  3. Treat `C4` as a SOF → `DHT C4 is not a SOF` fails.
  4. Ignore the VP8X animation bit → the animated case fails.
- [ ] **Step 6: Lint and commit** "Read WebP and JPEG header sizes without decoding".

---

### Task 4: Ban CSV parser and ban service

**Files:**

- Modify: `src/lib/helpers/suspensionCsv.ts` (export `readCsvRecords`; `parseSuspensionCsv` uses it, behaviour unchanged)
- Create: `src/lib/bans/banCsv.ts`, `src/lib/bans/service.ts`, `tst/lib/bans/banCsv.test.ts`, `tst/lib/bans/service.test.ts`

**Interfaces:**

- Consumes: Task 1 types and repository methods `record`, `importMany`, `lift`, `setUploadedPhoto`; Task 3 `readImageSize`; `parseUtcDateStrict`; `pacificToday`; `fitFieldValue` and `postWithoutWaiting` from `src/lib/workspace/service.ts`; `escapeDiscordText` and `neutralizeMentions`; `PUBLIC_APP_ORIGIN`; `LogEntry`.
- Produces (`suspensionCsv.ts`): `export function readCsvRecords(rawText: string): { record: string[]; rowNumber: number }[]` (the existing csv-parse options and `startingLine`; throws csv-parse's error on malformed quoting).
- Produces (`banCsv.ts`):
  ```ts
  export const BAN_CSV_HEADER = 'member_id,member_name,banned_on,notes';
  export type BanCsvErrorCode =
    | 'unreadable'
    | 'header'
    | 'no-rows'
    | 'too-many-rows'
    | 'member-id'
    | 'name-too-long'
    | 'date'
    | 'date-out-of-range'
    | 'notes-too-long'
    | 'duplicate-member'
    | 'already-banned';
  export const BAN_CSV_ERROR_TEXT: Readonly<Record<BanCsvErrorCode, string>>;
  export interface BanCsvError {
    row: number | null;
    code: BanCsvErrorCode;
  }
  export interface ParsedBanRow {
    rowNumber: number;
    memberId: string;
    memberName: string;
    bannedOn: string | null;
    notes: string;
  }
  export function parseBanCsv(
    text: string,
    today: string,
  ): { ok: true; rows: ParsedBanRow[] } | { ok: false; errors: BanCsvError[] };
  ```
  Rules: header compared trimmed and lower-cased; member id `^[0-9]{1,20}$` (ASCII only, after trim); `banned_on` blank → null, else `parseUtcDateStrict` and `'2013-03-01' <= day <= today`; extra fields rejoin into notes (as the suspension parser); name ≤ 500 and notes ≤ 2000 code points; at most 200 data rows; a member twice is `duplicate-member` on the second row; all errors collected in row order. `BAN_CSV_ERROR_TEXT` is fixed text, e.g. `'member-id': 'member_id must be the Meetup member number, digits only.'`, `header: 'The first line must be exactly: member_id,member_name,banned_on,notes'`.
- Produces (`service.ts`):

  ```ts
  export interface BanServiceDeps {
    now(): Date;
    repository(): Promise<
      Pick<
        PostgresBanRepository,
        'record' | 'importMany' | 'lift' | 'setUploadedPhoto'
      >
    >;
    moderationLog(entry: LogEntry): Promise<unknown>;
    isLeadership(discordUserId: string): Promise<boolean>;
  }
  export type BanResultCode =
    | 'recorded'
    | 'imported'
    | 'lifted'
    | 'photo-saved'
    | 'invalid'
    | 'bad-member-id'
    | 'bad-date'
    | 'name-too-long'
    | 'notes-too-long'
    | 'already-banned'
    | 'not-active'
    | 'reason-required'
    | 'reason-too-long'
    | 'photo-not-accepted'
    | 'photo-too-large'
    | 'photo-too-big'
    | 'not-leadership'
    | 'leadership-unavailable'
    | 'error';
  interface Gate {
    actor: string;
    leadershipConfirmed?: boolean;
  }
  export function recordBan(
    deps: BanServiceDeps,
    input: Gate & {
      memberId: unknown;
      memberName: unknown;
      bannedOn: unknown;
      notes: unknown;
    },
  ): Promise<{ code: BanResultCode }>;
  export function importBans(
    deps: BanServiceDeps,
    input: Gate & { csv: unknown },
  ): Promise<
    | { code: 'imported'; count: number }
    | { code: 'import-refused'; errors: BanCsvError[] }
    | { code: BanResultCode }
  >;
  export function liftBan(
    deps: BanServiceDeps,
    input: Gate & { banId: number; reason: unknown },
  ): Promise<{ code: BanResultCode }>;
  export function uploadBanPhoto(
    deps: BanServiceDeps,
    input: Gate & { banId: number; photo: unknown },
  ): Promise<{ code: BanResultCode }>;
  export function decodePhotoField(value: unknown): Buffer | undefined; // D3
  export function checkBanPhoto(
    bytes: Buffer,
  ):
    | { ok: true; type: 'image/webp' | 'image/jpeg' }
    | {
        ok: false;
        code: 'photo-not-accepted' | 'photo-too-large' | 'photo-too-big';
      };
  export function banEntry(
    kind: 'recorded' | 'lifted' | 'photo-uploaded' | 'photo-replaced',
    ban: BanRow,
    actor: string,
  ): LogEntry;
  export function banImportEntry(count: number, actor: string): LogEntry;
  export const BANNED_TAB_URL: string; // `${PUBLIC_APP_ORIGIN}/dashboard/suspensions?state=banned`
  ```

  Behaviour: `actor` must be `^[0-9]{17,20}$` else `invalid`. Validation before the gate; the gate (as `performWorkspaceAction`: when `leadershipConfirmed !== true`, ask `deps.isLeadership`; false → `not-leadership`, throw → `leadership-unavailable`) before any repository call. `checkBanPhoto`: size > 153600 → `photo-too-large`; `readImageSize` undefined → `photo-not-accepted`; either side > 512 → `photo-too-big`. Lift reason trimmed (CRLF→LF), 1..500 code points. After a successful write, post the embed with `postWithoutWaiting` (fire and forget; a failure never changes the code). Embeds: title `Ban recorded` / `Ban lifted` / `Ban photo uploaded` / `Ban photo replaced` / `Bans imported`; fields Member (`memberText(name || 'Unknown member')` + ` (id)`), Banned (date or `Date unknown`), Notes or Reason (escaped, cut by `fitFieldValue`); description `<@actor> …` plus `\n${BANNED_TAB_URL}`; never a photo, never `content`. `Bans imported` has only `Count` and the description.

- [ ] **Step 1: Write the failing parser tests** (`banCsv.test.ts`): valid file with a blank date and a quoted multi-line note → rows with correct `rowNumber`s; BOM header accepted; `Review Focus 2` ids `12a4`, `+123`, `123` (trimmed → accepted), 21 digits, `١٢٣` → `member-id` with their rows; `2026-02-30`, `10/3/2026` → `date`; `2013-02-28` and tomorrow → `date-out-of-range`; 501-code-point name; 2001-code-point notes; 201 rows → one `too-many-rows` error with row null; `Review Focus 3` a member twice → `duplicate-member` on the later row; unbalanced quote → `unreadable`; wrong header → `header`; header only → `no-rows`; every error text in `BAN_CSV_ERROR_TEXT` contains no `${`-style data (assert no error object carries the bad value: `Object.keys(err)` is exactly `['row', 'code']`).
- [ ] **Step 2: Write the failing service tests** (`service.test.ts`, fake deps with `vi.fn`):
  - `recordBan validates before the gate and the gate before the repository` (bad id → `bad-member-id`, `isLeadership` not called; Moderator → `not-leadership`, `record` not called; Discord throws → `leadership-unavailable`; `leadershipConfirmed: true` skips `isLeadership`).
  - `recordBan maps already-banned and posts nothing on a refusal`.
  - `recordBan posts one Ban recorded embed with no content, no photo and the Banned tab link` (assert `entry` has no `content` key and `JSON.stringify(entry)` contains no base64 of a photo; `@everyone` in the name comes out neutralised).
  - `importBans returns import-refused with row numbers and never calls importMany on a parse error`; `maps importMany's already-banned index to that row's rowNumber`; `posts Bans imported with only the count` (no member id or name in `JSON.stringify(entry)`).
  - `liftBan requires a reason and maps an unknown or lifted ban to not-active`.
  - `decodePhotoField accepts base64url only` (`+`, `/`, `=`, whitespace, empty, 204801 chars, a non-string → undefined; round-trip check refuses non-canonical trailing bits).
  - `Review Focus 1: uploadBanPhoto refuses a PNG, a RIFF/WEBP header with HTML, a 513x10 WebP and 153601 bytes, without calling setUploadedPhoto`; accepts the Task 3 VP8 512x384 vector and the JPEG vector; maps `replaced` to the embed title.
  - `a moderation-log failure still returns the success code` (rejecting `moderationLog`, no unhandled rejection).
- [ ] **Step 3: Run to see them fail.** `yarn test tst/lib/bans tst/lib/helpers/suspensionCsv.test.ts` → the new files FAIL; `suspensionCsv.test.ts` passes before and after the refactor.
- [ ] **Step 4: Implement** `readCsvRecords`, `banCsv.ts`, `service.ts`.
- [ ] **Step 5: Run to see them pass.** Same command → PASS.
- [ ] **Step 6: Mutation checks.**
  1. Validate the member id with `Number.isSafeInteger(Number(id))` → the `+123` case fails.
  2. Call the repository before the gate → `validates before the gate…` fails.
  3. Add the member names to the import embed → `posts Bans imported with only the count` fails.
  4. Skip `checkBanPhoto` in `uploadBanPhoto` → the Review Focus 1 test fails.
  5. Accept standard base64 in `decodePhotoField` → its test fails.
- [ ] **Step 7: Lint and commit** "Validate, record, import, lift and audit bans in one service".

---

### Task 5: Add, import and lift routes on the Banned tab

**Files:**

- Modify: `src/web/routes/bans.ts`, `src/web/routes/bannedTab.ts`, `src/web/routes/suspensions.ts`, `src/web/routes/dashboardPages.ts`, `src/web/dashboardDeps.ts`, `src/web/routes/workspaceActions.ts` (export `withDeadline`), `tst/web/routes/pageFakes.ts`, `tst/web/routes/access.test.ts`
- Test: `tst/web/routes/bans.test.ts`

**Interfaces:**

- Consumes: Task 2 `registerBanRoutes`, `bannedTabBody`, `bannedTabPath`; Task 4 `recordBan`, `importBans`, `liftBan`, `BanResultCode`, `BanCsvError`, `BAN_CSV_ERROR_TEXT`; `leadershipOf`, `LeadershipDisplayCache`, `LEADERSHIP_CHECK_DEADLINE_MS`.
- Produces:
  - `dashboardPages.ts`: `export interface BanActions { record(input: Parameters<typeof recordBan>[1]): Promise<{ code: BanResultCode }>; import(input: Parameters<typeof importBans>[1]): ReturnType<typeof importBans>; lift(input: Parameters<typeof liftBan>[1]): Promise<{ code: BanResultCode }>; uploadPhoto(input: Parameters<typeof uploadBanPhoto>[1]): Promise<{ code: BanResultCode }> }` and `DashboardPageDeps.banActions: BanActions`; production binds each to the Task 4 function with `{ now, repository: () => PostgresBanRepository.instance(), moderationLog: workspaceModerationLog, isLeadership }`.
  - `pageFakes.ts`: `fakeBanActions()` (each method `vi.fn` resolving its success code).
  - `bans.ts`: `export const BAN_REQUEST_DEADLINE_MS = 20_000;` `export const BAN_RESULT_MESSAGES: Readonly<Record<BanResultCode, string>>;` `export function banResultNotice(code: unknown): SafeHtml | ''` (blurple for recorded/imported/lifted/photo-saved, coral otherwise; unknown codes render nothing). `registerBanRoutes` Pick widens to `'now' | 'bans' | 'banActions' | 'isLeadership'`.
  - `workspaceActions.ts`: `export async function withDeadline<T>(ms: number, fn: () => Promise<T>): Promise<T>` (existing body, now exported).

The Suspensions route's Pick adds `isLeadership` and keeps one `LeadershipDisplayCache` (as `registerWorkspaceRoutes` does) to decide whether the Banned tab shows forms.

Route rules: `POST /bans` (fields `memberId`, `memberName`, `bannedOn`, `notes`), `POST /bans/import` (field `csv`), `POST /bans/:id/lift` (field `reason`; `parseRowId` else `notFound`). Each: live `leadershipOf(deps.isLeadership, session.userId)` first ('leader' → pass `leadershipConfirmed: true`; 'not-leader' → back `not-leadership`; 'unreachable' → back `leadership-unavailable`); a repeated field (array) is `invalid`; the service call under `withDeadline(BAN_REQUEST_DEADLINE_MS, …)`, a throw or timeout → back `error`; `actor` is always `session.userId`. Back = `303` to `bannedTabPath({ result: code })`. Import: empty or missing `csv` → back `invalid`; `import-refused` → render the Banned tab (status 422) with a coral notice "Nothing was imported." and an `<ul>` of `Row N: <fixed text>` (row null → just the text), at most 10 then "…and N more"; `imported` → back `imported`. Banned tab (when the cached display check says leader): an "Add a ban" form (member id `inputmode="numeric" pattern="[0-9]{1,20}" required`, name `maxlength="500"`, date `type="date" min="2013-03-01" max="<today>"`, notes textarea `maxlength="2000"`), an "Import bans" form (textarea `name="csv"`, the header shown as a literal example), and per active row a "Lift ban" form (reason textarea `required maxlength="500"`, `button.danger`). Non-leaders see the fixed line "Only the 1.5 Leadership Team can record, import, upload or lift a ban." and no forms. Forms carry `_csrf` from the session.

- [ ] **Step 1: Write the failing tests** in `bans.test.ts`:
  - `a Moderator sees no ban forms; a Leader sees Add, Import and Lift` (display cache from `isLeadership`).
  - `POST /bans records as the session user and redirects with recorded` (perform input's `actor === USER.id`, a form `actor` field ignored).
  - `POST /bans by a Moderator is refused live even with a cached Leader page` (`isLeadership` true for the GET, false for the POST → `result=not-leadership`, `record` not called).
  - `POST /bans when Discord times out answers leadership-unavailable` (fake timers past 5 s).
  - `a service that hangs answers error after 20 s` (fake timers).
  - `Review Focus 2: a spoofed member id reaches the service as typed and the notice is fixed text` (service returns `bad-member-id`; the redirect location has only the code; the page shows `BAN_RESULT_MESSAGES['bad-member-id']`).
  - `?result=<script>` and unknown codes render no notice.
  - `an import refusal renders 422 with Row N lines and nothing from the CSV` (CSV containing `Evil<b>Name` → not in body).
  - `POST /bans/abc/lift is a 404; a missing reason redirects reason-required`.
  - `a repeated field is invalid` (`memberId=1&memberId=2`).
  - `access.test.ts`: `EXPECTED_UNSAFE_ALLOWED` gains `'POST /bans': 303`, `'POST /bans/import': 303`, `'POST /bans/:id/lift': 303`.
- [ ] **Step 2: Run to see failures.** `yarn test tst/web/routes/bans.test.ts tst/web/routes/access.test.ts` → FAIL.
- [ ] **Step 3: Implement** the routes, forms, notices, deps and fakes.
- [ ] **Step 4: Run** `yarn test tst/web` → PASS (the access matrix includes the new routes by construction).
- [ ] **Step 5: Mutation checks.**
  1. Use the display cache instead of the live check in a POST → the Moderator-refused test fails.
  2. Take `actor` from the form → the session-user test fails.
  3. Echo the CSV error's source row into the 422 page → the import-refusal test fails.
  4. Remove the deadline → the hang test fails (times out).
- [ ] **Step 6: Lint and commit** "Let the Leadership Team add, import and lift bans from the dashboard".

---

### Task 6: Photo upload: browser script, body limit and route

**Files:**

- Modify: `src/web/dashboardRouter.ts`, `src/web/pageKit.ts`, `src/web/routes/bans.ts`, `src/web/routes/bannedTab.ts`, `src/web/pages.ts` (STYLE), `tst/web/routes/access.test.ts`
- Create: `tst/web/banPhotoScript.test.ts`, `tst/web/dashboardRouter.bodyLimit.test.ts`
- Test: `tst/web/routes/bans.test.ts`

**Interfaces:**

- Consumes: Task 4 `uploadBanPhoto`, `BAN_PHOTO_MAX_BYTES`; Task 5 `BanActions.uploadPhoto`, `banResultNotice`, `withDeadline`, the Leadership route pattern.
- Produces:
  - `dashboardRouter.ts`: `export const BAN_PHOTO_BODY_PATH = /^\/bans\/[1-9][0-9]{0,8}\/photo\/?$/;` `export const BAN_PHOTO_BODY_LIMIT = '220kb';` and the dispatcher replacing the single `express.urlencoded` line (D4). The `32kb` comment stays.
  - `pageKit.ts`: `export const BAN_PHOTO_SCRIPT: SafeHtml` (one-line `staticRaw`); `dashboardPage`'s `script` option accepts `'bans'`.
  - `bannedTab.ts`: `banPhotoForm(ban: BanRow, csrf: string): SafeHtml`.
  - Route `POST /bans/:id/photo` (field `photo`), same Leadership/deadline/back rules as Task 5; `'POST /bans/:id/photo': 303` in the access matrix.

Form markup (per active ban, Leadership only; all attribute values literal except `action`, `_csrf` value):

```html
<form method="post" action="…/bans/ID/photo" data-ban-photo>
  <input type="hidden" name="_csrf" value="…" />
  <input type="hidden" name="photo" value="" />
  <p class="note attn" data-ban-photo-nojs>
    Turn on JavaScript to upload a photo. The page makes the photo smaller
    before sending it.
  </p>
  <label class="field" hidden
    >Pick a photo <input type="file" accept="image/*"
  /></label>
  <canvas class="ban-preview" width="0" height="0" hidden></canvas>
  <p class="muted" data-ban-photo-status></p>
  <button type="submit" disabled>Upload photo</button>
  <!-- or Replace photo when hasPhoto -->
</form>
```

The file input has **no `name`**: the original file (with its metadata) is never sent.

Script behaviour (fixed text; reads no data attributes' values; finds elements by position inside each `form[data-ban-photo]`):

1. Hide `[data-ban-photo-nojs]`, un-hide the label. If `createImageBitmap` or `HTMLCanvasElement.prototype.toBlob` is missing, show "This browser cannot prepare the photo. Use a current Chrome, Edge, Firefox or Safari." and stop.
2. On `change`: `createImageBitmap(file, { imageOrientation: 'from-image' })`; on failure "That file could not be read as a picture."
3. Scale `s = Math.min(1, 512 / Math.max(w, h))`; canvas `width = Math.max(1, Math.round(w * s))`, same for height; `drawImage`; un-hide the canvas (the preview; no `blob:` URL anywhere).
4. Encode: try `image/webp` at 0.8, 0.7, 0.6, 0.5; if the first blob's `type !== 'image/webp'`, use `image/jpeg` with the same steps (D2). First blob with `size <= 153600` wins; none → "That photo is still too large after compressing. Try a smaller picture."
5. `blob.arrayBuffer()` → base64url (chunked `String.fromCharCode` + `btoa`, then `+`→`-`, `/`→`_`, strip `=`) into the hidden `photo` field; status "Ready: <n> KB"; enable the button. While encoding, the button stays disabled; a second `change` restarts.
6. Submit is the normal form post.

CSP check recorded in the task report: the script uses only `createImageBitmap`, a DOM canvas on the main thread, `toBlob`, `Blob.arrayBuffer` and `btoa`, so no `worker-src`, `connect-src`, `blob:` or `data:` source is involved, and the existing CSP header test stays unchanged.

- [ ] **Step 1: Write the failing script tests** in `banPhotoScript.test.ts`, running `BAN_PHOTO_SCRIPT.value` through `new Function('document', 'createImageBitmap', 'HTMLCanvasElement', 'btoa', …)` with stubs, as `workspaceScript.test.ts` does:
  - `a 2000x1000 picture is drawn at 512x256 and a 1x1 is never enlarged`.
  - `WebP at 0.8 under the cap fills the field with base64url and enables the button`.
  - `quality steps down to 0.5 and stops there with the too-large message, button still disabled`.
  - `a browser that returns PNG for webp falls back to JPEG` (first `toBlob` yields `type: 'image/png'`; next call's type argument is `image/jpeg`).
  - `a decode failure shows the fixed message and fills nothing`.
  - `no createImageBitmap shows the fixed browser message`.
  - `the script text has no blob:, data:, fetch, XMLHttpRequest, Worker, innerHTML or getAttribute(` (string assertions on the constant).
- [ ] **Step 2: Write the failing body-limit tests** in `dashboardRouter.bodyLimit.test.ts` (harness `makeApp` with a protected test route echoing `req.body.photo.length`):
  - `a 210 KB form to /bans/1/photo reaches the route`; `to /bans/1/photo/ as well`.
  - `a 230 KB form to /bans/1/photo is the 400 page`; `a 40 KB form to /bans/1/lift is the 400 page`; `a 40 KB form to /Bans/1/photo is the 400 page`.
  - `a signed-out 210 KB post to /bans/1/photo is refused 403 and reaches no route`.
- [ ] **Step 3: Write the failing route tests** in `bans.test.ts`:
  - `a Leader sees Upload photo, Replace photo when a photo exists; a Moderator sees neither`.
  - `the file input has no name attribute and the page carries BAN_PHOTO_SCRIPT with the nonce`.
  - `the no-JavaScript note is present in the markup` (and no `<noscript>`).
  - `POST /bans/1/photo passes the raw photo field to uploadPhoto and redirects photo-saved`.
  - `Review Focus 1: a refused photo redirects with the fixed photo-not-accepted text and the location carries no data`.
  - `a Moderator's upload is refused live; the service is not called`.
  - `the CSP header is unchanged on the Banned tab` (exact string compare with `baseSecurityHeaders(nonce)`).
- [ ] **Step 4: Run to see failures.** `yarn test tst/web/banPhotoScript.test.ts tst/web/dashboardRouter.bodyLimit.test.ts tst/web/routes/bans.test.ts tst/web/routes/access.test.ts` → FAIL.
- [ ] **Step 5: Implement** the dispatcher, the script, the form, the route and STYLE `canvas.ban-preview{display:block;max-width:96px;height:auto;border-radius:8px}`.
- [ ] **Step 6: Run** `yarn test tst/web` → PASS.
- [ ] **Step 7: Mutation checks.**
  1. Give the file input `name="file"` → `has no name attribute` fails.
  2. Apply the 220 kB parser to every path → `40 KB form to /bans/1/lift` fails.
  3. Make the dispatcher regex case-insensitive → the `/Bans/` test fails.
  4. Use standard base64 in the script → the base64url test fails.
  5. Remove the JPEG fallback → the PNG-fallback test fails.
- [ ] **Step 8: Manual check (controller with Hai, not CI).** On a local dev run (no production), pick a large phone photo in desktop Chrome, desktop Safari and iPhone Safari; each shows the canvas preview and saves; open the stored photo route and confirm `Content-Type` is `image/webp` (Chrome) or `image/jpeg` (Safari); confirm with `exiftool` (or any EXIF viewer) on the downloaded bytes that no EXIF/GPS remains. Record results in the report.
- [ ] **Step 9: Lint and commit** "Upload a compressed ban photo through a fixed browser script".

---

### Task 7: Banned badge and refusal in the no-show workspace

**Files:**

- Modify: `src/lib/workspace/types.ts`, `src/lib/repositories/postgresNoShowWorkspaceRepository.ts`, `src/web/routes/workspace.ts`, `src/web/routes/workspaceActions.ts`, `src/web/routes/dashboardPages.ts` (workspace route Pick adds `bans`)
- Test: `tst/integration/postgresNoShowWorkspaceRepository.test.ts`, `tst/web/routes/workspace.test.ts`, `tst/web/routes/workspaceActions.test.ts`

**Interfaces:**

- Consumes: Task 1 `ensureBanSchema`, `PostgresBanRepository.activeMemberIds`, the `member_bans` table; Task 2 `BanPageReader`.
- Produces:
  - `ActionRefusalReason` gains `'banned'`; `export const BAN_BLOCKED_ACTIONS: readonly WorkspaceAction[] = ['record_suspension', 'link_suspension']` in `types.ts`.
  - `ensureWorkspaceSchema(pool, ensureSuspensions)` also runs `ensureBanSchema(pool)` after its own SQL.
  - `applyAction`: for an action in `BAN_BLOCKED_ACTIONS`, right after the existing member advisory lock, `SELECT 1 FROM member_bans WHERE member_id = $1 AND lifted_at IS NULL` → `refuse('banned')`.
  - `WORKSPACE_RESULT_MESSAGES.banned = 'This member is banned.'` (coral).
  - Card: `CardView.banned: boolean`; a banned card shows `<span class="badge attn">Banned</span>` in its `h2` and drops `BAN_BLOCKED_ACTIONS` from its action set. Month page reads `bans.activeMemberIds(memberIds)` inside the existing `load`; banned members are left out of the `upcoming` request. The confirm page (`workspaceSuspend`) shows "This member is banned." with no form when the member has an active ban.

- [ ] **Step 1: Write the failing integration tests** (workspace repository file):
  - `Review Focus 5: record_suspension and link_suspension are refused as banned in September and October cards of one banned member; nothing is written` (version, events and suspension counts unchanged).
  - `void, hold and edit_notes still apply to a banned member's card`.
  - `a ban recorded while a record_suspension waits on the member lock is seen` (a test client runs `BEGIN`, takes `pg_advisory_xact_lock(MEMBER_LOCK_CLASS, hashtext('suspension:' || id))`, inserts an active ban row with raw SQL; `applyAction` starts and blocks on the lock; the test commits; the outcome is `banned` and nothing was written).
  - `ensureWorkspaceSchema creates member_bans`.
- [ ] **Step 2: Write the failing page and route tests:**
  - `workspace.test.ts`: `a banned member's cards show Banned and no Record or Link button in every month` (two months' fakes); `the confirm page refuses a banned member`; `banned members are not asked for upcoming RSVPs`; `a failing bans read is the 503 page`.
  - `workspaceActions.test.ts`: `a banned refusal redirects with result=banned and shows "This member is banned."`.
- [ ] **Step 3: Run to see failures.** Unit: `yarn test tst/web/routes/workspace.test.ts tst/web/routes/workspaceActions.test.ts`; integration on the workspace repository file → FAIL.
- [ ] **Step 4: Implement** the reason, the check, the ensure, the badge and the page changes.
- [ ] **Step 5: Run to see them pass** (both commands; integration twice).
- [ ] **Step 6: Mutation checks.**
  1. Check the ban before taking the member lock → the waiting-lock test fails.
  2. Check `lifted_at IS NOT NULL` → the Review Focus 5 test fails.
  3. Hide the buttons but skip the repository check → the integration refusal test fails.
  4. Change the `applyAction` lock key prefix to `'ban:'` → the waiting-lock test fails. (The ban repository's side of the shared key is pinned by Task 1's D9 test; this task's waiting test writes the ban with raw SQL and cannot catch a change there.)
- [ ] **Step 7: Lint and commit** "Mark banned members in the workspace and refuse to suspend them".

---

### Task 8: Sweep fill of missing ban photos

**Files:**

- Modify: `src/util/boundedFetch.ts`, `src/lib/helpers/identity/snapshot.ts`, `src/lib/helpers/identity/meetupSweep.ts`, `src/lib/helpers/identity/digest.ts`, `src/lib/client/meetup/types.ts`, `src/lib/client/meetup/queries.ts`, `src/lib/repositories/postgresIdentityRepository.ts`
- Create: `src/lib/bans/photoFill.ts`, `tst/lib/bans/photoFill.test.ts`
- Test: `tst/util/boundedFetch.test.ts` (or the existing file for it), `tst/lib/helpers/identity/snapshot.test.ts`, `meetupSweep.test.ts`, `digest.test.ts`, `tst/integration/postgresIdentityRepository.test.ts`

**Interfaces:**

- Consumes: Task 1 `listPhotoFillCandidates`, `fillProfilePhoto`, `BAN_FILL_MAX_PER_RUN`, `BAN_PHOTO_MAX_BYTES`; Task 3 `sniffImageType`; `HealBudget`; `discordIdsByMeetupIds`; `snapshotMember`.
- Produces:
  - `boundedFetch.ts`: `export async function fetchBytesCapped(url: string, maxBytes: number, timeoutMs: number): Promise<Buffer | null>` — https only; null on non-2xx, a `Content-Length` over the cap, a streamed body passing the cap (reader cancelled), timeout or any error; never throws; logs the class name only.
  - `snapshot.ts`: `avatarThumbUrl(discordUserId, field, hash, guildId, size: 64 | 256 = 64)`.
  - `types.ts`/`queries.ts`: `memberPhoto: { id: string; thumbUrl: string; standardUrl?: string | null } | null`; the roster query adds `standardUrl`.
  - `meetupSweep.ts`: `runMeetupSweep` returns `{ scanned: number; changed: number; roster?: readonly MeetupGroupMember[] }` (`roster` set whenever a roster was fetched).
  - `postgresIdentityRepository.ts`: `latestStoredPhoto(meetupId: string, discordId: string | undefined, maxBytes: number): Promise<Buffer | undefined>` — one query, D12 source 3, monitored scopes via `scopeClause`, `octet_length <= $cap` in SQL, `ORDER BY at DESC LIMIT 1`; ids that fail `SUBJECT_ID` return undefined with no query.
  - `photoFill.ts`:
    ```ts
    export const BAN_FILL_DEADLINE_MS = 90_000;
    export const BAN_FILL_BUDGET_MS = 60_000;
    export const BAN_FILL_FETCH_TIMEOUT_MS = 5_000;
    export interface BanPhotoFillDeps {
      bans(): Promise<
        Pick<
          PostgresBanRepository,
          'listPhotoFillCandidates' | 'fillProfilePhoto'
        >
      >;
      discordIdsByMeetupIds(ids: string[]): Promise<Map<string, string>>;
      guildMember(
        discordId: string,
      ):
        | { userAvatarHash: string | null; memberAvatarHash: string | null }
        | undefined;
      storedPhoto(
        meetupId: string,
        discordId: string | undefined,
      ): Promise<Buffer | undefined>;
      fetchBytes(url: string): Promise<Buffer | null>;
      guildId: string;
      now(): number;
    }
    export interface BanPhotoFillCounts {
      candidates: number;
      filled: number;
      fromDiscord: number;
      fromMeetup: number;
      fromStored: number;
      noSource: number;
    }
    export async function fillBanPhotos(
      deps: BanPhotoFillDeps,
      roster: readonly MeetupGroupMember[] | undefined,
      budget?: HealBudget,
    ): Promise<BanPhotoFillCounts>;
    /** fillBanPhotos under BAN_FILL_DEADLINE_MS; never rejects; logs counts only. */
    export async function runBanPhotoFillSafely(
      deps: BanPhotoFillDeps,
      roster: readonly MeetupGroupMember[] | undefined,
    ): Promise<void>;
    export function defaultBanPhotoFillDeps(client: Client): BanPhotoFillDeps;
    ```
  - `digest.ts`: `runSweepOrDegrade<T>(platform, client, sweep: () => Promise<T>): Promise<T | undefined>`; after the two sweeps, `await runBanPhotoFillSafely(defaultBanPhotoFillDeps(client), meetup?.roster)`.

Rules: candidates at most 50; sequential; the budget is checked before each candidate and each candidate's fetches run inside `budget.spend`; a candidate's sources in D12 order; bytes accepted only when `sniffImageType` is defined and `length <= 153600`; `fillProfilePhoto` false (an upload landed) counts as not filled and moves on; one candidate's error is caught and counted, never stops the run; the roster map is built only for candidate ids (`new Map` of at most 50 entries); `guildMember` reads `client.guilds.cache.get(guildId)?.members.cache.get(id)` (no API call). Log line: `Ban photo fill: ${filled} of ${candidates} filled (${fromDiscord} Discord, ${fromMeetup} Meetup, ${fromStored} stored), ${noSource} without a usable photo`.

- [ ] **Step 1: Write the failing unit tests:**
  - `fetchBytesCapped`: `refuses http`, `returns null when Content-Length is over the cap`, `cancels a stream that passes the cap without Content-Length` (a `ReadableStream` that would yield 1 MB; assert at most cap+chunk bytes read), `returns null on 404 and on timeout`. Use `nock` (already a dev dependency) on a fake https host; no real network.
  - `avatarThumbUrl(…, 256)` ends `.webp?size=256` for both paths; the default stays 64.
  - `runMeetupSweep returns the roster it fetched` and the roster query text contains `standardUrl` and still `thumbUrl`.
  - `photoFill.test.ts` with fake deps:
    - `prefers the guild avatar of a linked member still in the server`, `falls back to the user avatar`, `skips Discord when the linked member is not in the guild cache`.
    - `uses the Meetup standardUrl, then thumbUrl when standard is too large or fails`, `never requests highResUrl`.
    - `falls back to the stored photo when neither profile yields bytes`.
    - `refuses bytes that sniff as nothing and bytes over 153600, and tries the next source`.
    - `Review Focus 4: a candidate the upload won (fillProfilePhoto false) is not counted filled and no other write is made`.
    - `stops fetching when the budget is spent; the rest wait for tomorrow`.
    - `asks for at most 50 candidates`.
    - `one candidate's error does not stop the others`.
    - `runBanPhotoFillSafely never rejects, resolves by the 90 s deadline even when a fetch hangs` (fake timers), `logs counts only` (spy logger: no digits of ids, no URLs).
  - `digest.test.ts`: `the ban fill runs after both sweeps and before the ceiling is read`; `a failing Meetup sweep still runs the fill with no roster`; `a fill that throws or hangs does not stop the digest post` (fake timers).
- [ ] **Step 2: Write the failing integration test** in `postgresIdentityRepository.test.ts`: `latestStoredPhoto returns the newest of change and baseline images for the Meetup and Discord subjects, ignores other scopes and images over the cap`.
- [ ] **Step 3: Run to see failures.** `yarn test tst/lib/bans/photoFill.test.ts tst/lib/helpers/identity tst/util` and the integration file → FAIL.
- [ ] **Step 4: Implement** in the order: `fetchBytesCapped`, `avatarThumbUrl` size, query field and roster return, `latestStoredPhoto`, `photoFill.ts`, the digest call.
- [ ] **Step 5: Run to see them pass,** plus the whole identity suite `yarn test tst/lib/helpers/identity` (no existing expectation changes other than the added query field and return field).
- [ ] **Step 6: Mutation checks.**
  1. Use `response.arrayBuffer()` without the cap → the streaming-cap test fails.
  2. Call `fillProfilePhoto` for a source whose sniff failed → the refuses-bytes test fails.
  3. Drop the `catch` in `runBanPhotoFillSafely` → `never rejects` fails.
  4. Put the fill before the Discord sweep → the ordering test fails.
  5. Log the member id → `logs counts only` fails.
- [ ] **Step 7: Lint and commit** "Fill missing ban photos from the member's profile after the daily sweep".

---

### Task 9: Docs and the local tracker extraction

**Files:**

- Modify: `README.md` (a `### Member bans` section under Deployment), `docs/superpowers/specs/2026-10-22-member-bans-design.md` (Status line and the D2/D7/D8 notes)
- Create (gitignored, never committed): `.superpowers/backfill/ban_review.py`, `.superpowers/backfill/ban_to_import.py`

**Interfaces:**

- Consumes: everything above (names only).
- Produces: documentation; local scripts using only the Python standard library (`zipfile`, `xml.etree.ElementTree`, `csv`, `re`).

README content (short): the table is created on first use; bans are dashboard-only and record-only; photo caps and formats (WebP, or JPEG from Safari); the sweep fill (18:00 UTC with the digest, at most 50 per run, never overwrites); the import procedure (review CSV, Stacey's review, paste into Import bans, upload each photo, then delete the local files); the PR note about deploys between 18:00 and 19:00 UTC. Spec: `Status: approved by Hai 2026-10-22; built per docs/superpowers/plans/2026-10-22-member-bans.md`, and under "Photos" one line each for D2 (JPEG accepted for Safari), D7 (void still allowed), D8 (re-ban photo).

Local tools (run by the controller on Hai's machine, with the workbook path Hai gives; print counts and row numbers only, never names, ids or notes):

- `ban_review.py <workbook.xlsx> <out_dir>`: reads the "Banned Members" sheet (`xl/workbook.xml` → sheet rels → sheet XML, shared strings); writes `<out_dir>/ban-review.csv` with `member_id,member_name,proposed_banned_on,confidence,keep,corrected_banned_on` (date only from the 8 notes that state one, confidence `high`/`low`, keep blank); extracts embedded pictures via `xl/drawings/drawingN.xml` (`xdr:twoCellAnchor`/`xdr:oneCellAnchor` `xdr:from/xdr:row`) and `xl/drawings/_rels`, writing `<out_dir>/<member_id>.<ext>`; prints `rows, dated, photos matched, photos unmatched`.
- `ban_to_import.py <review.csv> <out.csv>`: keeps rows unless `keep` is `no`; `corrected_banned_on` overrides; dates normalised to `YYYY-MM-DD` (accepts `M/D/YYYY`); notes column is exactly `Imported from the no-show tracker's Banned Members tab`; writes the `member_id,member_name,banned_on,notes` header; prints counts and problem row numbers.

- [ ] **Step 1: Write the README section and the spec edits.**
- [ ] **Step 2: Verify the docs.** `yarn lint` (prettier covers `.md`) → clean; `git diff --stat` shows only `README.md` and the spec.
- [ ] **Step 3: Write the two local scripts** in `.superpowers/backfill/` and confirm `git status --short` does not list them (the folder is gitignored).
- [ ] **Step 4: Self-check the converter** on a hand-made three-row review CSV in the scratchpad (one `keep=no`, one corrected `3/9/2025`, one blank date), then run `parseBanCsv` on its output through a throwaway `.mts` like `.superpowers/backfill/check.mts` → `ok: true`, 2 rows, dates `2025-03-09` and null.
- [ ] **Step 5: Run the full suites** once: `yarn test`, `yarn lint`, and the full integration suite on the throwaway containers → all PASS; stop the containers.
- [ ] **Step 6: Commit** `README.md` and the spec only: "Document member bans and their import".
