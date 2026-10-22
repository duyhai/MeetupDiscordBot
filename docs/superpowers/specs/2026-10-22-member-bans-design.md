# Member bans

Status: draft for Hai's approval (revised 2026-10-22).

## Why

Staff keep banned members in a "Banned Members" tab of the no-show tracker workbook, outside the bot. Hai asked to import the 15 banned members along with the historical suspensions (2026-10-19). He also asked for a stored, compressed photo of each banned member, so that a returning member can be recognised (2026-10-22). Today the bot has no concept of a ban.

## Decisions Hai made (2026-10-22)

- **Storage.** Bans get their own table, separate from suspensions.
  - A ban never counts toward the 30/60/120-day ladder.
  - A ban never shows as an active suspension.
  - A ban has no length.
- **Undated bans.** Import them as "date unknown". Stacey can add a date in the review file.
- **Effect.** Record and show only. Discord and Meetup access stay manual.
- **Photo.** One photo per ban, compressed. It lives in the ban table itself, the way identity thumbnails live in their rows.
- **Dashboard only.** Bans are managed in the dashboard. There are no Discord commands for bans.
- **Sweep fills, never overwrites.** The daily identity sweep fills in a missing photo from the member's profile. It never replaces a photo already on record, so a banned member cannot swap our photo for an unrecognisable one.

## Goals

- Record, list and lift bans in the dashboard, with who did it and when.
- Keep one compressed photo per ban, uploaded by staff or filled in by the sweep.
- Import the tracker's 15 bans and their 15 embedded photos after a review step.

## Non-goals

- No automatic enforcement: no kicks, no role changes, no Meetup removal.
- No alert when a banned member links an account or rejoins.
- No import of the tracker's free-text ban notes.
- No new runtime dependency.

## Anti-goals (failures even if it "works")

- A ban changing any suspension length or count.
- A stored photo that keeps its original metadata (EXIF or GPS), or is larger than the caps below.
- The sweep replacing a photo that is already on record.
- A photo served to anyone other than signed-in staff, or cached.
- Any ping. Moderation-log embeds use `allowedMentions: { parse: [] }` and never contain the photo.

## Data model: `member_bans`, one table, created on first use under the existing locks

| Column | Notes |
|---|---|
| `id` | serial |
| `member_id` | text; Meetup id, digits only |
| `member_name` | text |
| `banned_on` | date, nullable; NULL means "date unknown" |
| `notes` | text; staff-written. The import writes only a fixed provenance line. |
| `recorded_by` | Discord id |
| `created_at` | |
| `photo` | bytea, nullable |
| `photo_source` | `'upload'` or `'profile'` |
| `photo_updated_at` | |
| `photo_updated_by` | Discord id, or NULL when the sweep filled it |
| `lifted_at`, `lifted_by`, `lift_reason` | |

- **Lifting.** A ban is lifted the way a suspension is voided: the row stays and gains who lifted it, when and why.
- **One active ban.** A partial unique index allows at most one active (unlifted) ban per member.
- **Reads.** List reads select explicit columns and never `photo`. The photo is read only by the photo route, one row per request. This is the same pattern as identity thumbnails.

## Photos

### Staff upload (dashboard, Leadership only)

- **In the browser.** A small fixed script (a nonce'd `staticRaw`, the same pattern as the copy script) runs when staff pick a file:
  1. It decodes the image with `createImageBitmap`.
  2. It draws it on a canvas, scaled so the longest side is at most 512 px (never enlarged).
  3. It exports WebP at quality 0.8, stepping down to 0.5 until the result is under 150 KB.
  4. It puts the base64 result into a hidden field and submits the form.
- **Effect on metadata.** Re-encoding through a canvas drops all metadata, including location.
- **Fallback.** Without JavaScript, the form shows a fixed note asking staff to enable it. Nothing else changes.
- **Server checks.** The server trusts nothing from the browser. On the upload route it:
  - uses a route-specific body limit of about 220 KB;
  - requires the CSRF token, the router's unsafe-method guard and the per-user rate limit;
  - runs a live Leadership check, the same as workspace record and void;
  - decodes the base64;
  - accepts only bytes that sniff as WebP (the existing `sniffImageType`);
  - reads the width and height from the WebP header (VP8, VP8L or VP8X) and refuses anything over 512 px on either side or over 150 KB;
  - stores the bytes with `photo_source='upload'`.

  An upload replaces any existing photo, including one the sweep filled in. Staff can always correct the photo; the sweep cannot.
- **CSP.** Unchanged. The page doesn't preview through a `blob:` URL; the preview is the canvas itself, so `img-src` stays `'self'`. The upload is a normal form post, so `connect-src` stays `'none'`.

### Sweep fill (daily identity sweep, never overwrites)

- **When it runs.** After its normal work, the sweep reads the active bans with `photo IS NULL`. The list is small, at most 15 today, and capped at 50 per run.
- **Source order:**
  1. The member's current Discord avatar, if their Meetup id is linked to a Discord account still in the server. It comes from Discord's CDN at `?size=256` in WebP, the same CDN resizing the identity sweep already uses.
  2. Otherwise, their current Meetup photo from the roster the sweep already fetched. The builder picks the largest Meetup-provided size that stays within the caps, and never resizes locally.
  3. Otherwise, the most recent identity thumbnail already stored for that member (Discord or Meetup). This covers members who have left the server or the group.
- **What it stores.** The bytes only if they sniff as PNG, JPEG or WebP and are at most 150 KB. They are stored as-is: the CDNs strip metadata from resized images. The row gets `photo_source='profile'` and `photo_updated_by` NULL.
- **Overwrite guard.** The update is `... WHERE id = $1 AND photo IS NULL`, so the sweep can never replace a photo, even if a staff upload lands at the same moment.
- **Scheduling and logging.** The fill follows the sweep's existing window (18:00 UTC) and its download budget. It logs counts only.

### Serving

- **Route:** `GET /dashboard/bans/:id/photo`, for signed-in staff only.
- **Headers:** `Content-Type` comes from the sniffed bytes, plus `nosniff` and `no-store`. This is the same handling as `getChangeThumb`.
- **No photo:** a 404 with nothing in the body. The page shows "No photo".

## Dashboard

### Banned tab

The Suspensions page gets a Banned tab, Two-Tone styled, with stacked cards on phones.

- **Who sees it.** Moderators and Leadership can see bans. Only the 1.5 Leadership Team can record, import, upload or lift one: the forms are hidden for others, and every POST runs the live check.
- **Active bans.** Each card shows:
  - the photo (about 96 px), or "No photo";
  - name and member id, linked to Meetup only when the id is all digits;
  - the ban date, or "Date unknown";
  - who recorded it;
  - notes;
  - where the photo came from: "Uploaded by …" or "From their profile on …".

  Leadership also sees "Upload photo" (or "Replace photo") and "Lift ban" (reason required).
- **Lifted bans.** Each shows who lifted it, when and why. The photo is kept, so the person can still be recognised if they return.
- **Add ban (Leadership).** A form with member id, name, optional date and notes. It refuses a second active ban for the same member.
- **Import bans (Leadership).** A textarea where staff paste CSV text with the columns `member_id,member_name,banned_on,notes`; `banned_on` may be blank.
  - It uses the same strict parser rules as the suspension import.
  - Results are shown with fixed text plus row numbers.
  - The whole import is one transaction: if any row is bad, nothing is written.

### Workspace

A banned member's card shows a coral "Banned" badge and offers no suspension actions. The action POST refuses them too, with the fixed message "This member is banned."

### Audit

Every record, import, upload and lift posts one moderation-log embed with no pings and no photo. A sweep fill posts nothing; it is logged as a count only.

## Importing the tracker's 15 bans

1. A local script reads the "Banned Members" tab and writes `.superpowers/backfill/ban-review.csv` (gitignored). The columns are: id, name, proposed date (from the 8 notes that have one), confidence, keep and corrected date.
2. The same script extracts the 15 embedded pictures, matched to their rows by cell anchors, into the same gitignored folder, named by member id.
3. After Stacey's review, Hai pastes the converted CSV into "Import bans", then uploads each photo through "Upload photo". The browser compresses each one as described above.
4. The local photo files are then deleted.

Nothing from the tracker is committed, pasted into a PR, or posted to Discord. If a photo is missing, the next sweep fills it from the profile.

## Left to the builder

- The exact Meetup photo size, if the roster offers several.
- The index choices.
- The Banned tab's page size.
- The exact wording.

## Open points for Hai

- **Keeping photos after a ban is lifted.** I chose to keep the photo on a lifted ban so a returning person can still be recognised. Say if a lifted ban should drop its photo.
