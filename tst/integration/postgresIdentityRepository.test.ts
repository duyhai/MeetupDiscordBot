import crypto from 'crypto';
import pg from 'pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { GUILD_ID } from '../../src/constants.js';
import { MeetupSnapshot } from '../../src/lib/helpers/identity/meetupSnapshot.js';
import { identityNameKey } from '../../src/lib/helpers/identity/names.js';
import {
  MAX_THUMB_BYTES,
  PostgresIdentityRepository,
} from '../../src/lib/repositories/postgresIdentityRepository.js';
import { registerAllProtectedRoutes } from '../../src/web/routes/dashboardPages.js';
import { closeServers, makeApp, signIn } from '../web/dashboardHarness.js';
import { fakeOrganizerDeps, fakePageDeps } from '../web/routes/pageFakes.js';
import { IdentitySnapshot } from '../../src/lib/repositories/identityTypes.js';

// Exercises BYTEA round-trips, TIMESTAMPTZ ordering and the upsert conflict
// target against a real Postgres -- all things a mock would paper over.
// Requires DATABASE_URL; skipped otherwise, matching the
// PostgresMemberRepository suite. Locally: yarn test:integration:docker
const POSTGRES_AVAILABLE = Boolean(process.env.DATABASE_URL);

if (!POSTGRES_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    'Skipping PostgresIdentityRepository integration tests: set DATABASE_URL to a reachable Postgres to run them.',
  );
}

// The monitored guild, not an arbitrary string: every digest/report query is
// now scoped to (discord, GUILD_ID) and (meetup, groupId), so a fixture under
// any other scope is correctly invisible to them.
const DEFAULT_SCOPE = GUILD_ID;

// Well above anything these fixtures write, so ordinary tests never hit the
// page cap by accident -- the cap itself is exercised separately, below.
const AMPLE_LIMIT = 1000;

const freshSnapshot = (): IdentitySnapshot => ({
  scopeId: DEFAULT_SCOPE,
  discordUserId: `discord-${crypto.randomUUID()}`,
  username: 'someone',
  globalName: 'Someone',
  nickname: 'Some One',
  userAvatarHash: 'aaa',
  memberAvatarHash: null,
});

const MEETUP_SCOPE = '7595882';

const freshMeetupSnapshot = (): MeetupSnapshot => ({
  scopeId: MEETUP_SCOPE,
  meetupMemberId: `meetup-${crypto.randomUUID()}`,
  name: 'Jane D.',
  username: 'janed',
  photoId: 'p1',
});

describe.skipIf(!POSTGRES_AVAILABLE)('PostgresIdentityRepository', () => {
  let repo: PostgresIdentityRepository;

  beforeAll(async () => {
    repo = await PostgresIdentityRepository.instance();
  });

  it('round-trips a snapshot', async () => {
    const snap = freshSnapshot();
    await repo.putSnapshot(snap);

    expect(await repo.getSnapshot(snap.scopeId, snap.discordUserId)).toEqual({
      ...snap,
      // A baseline written without thumbs reads back with none, rather than
      // with the columns missing: the monitor indexes them by field name.
      userAvatarThumb: null,
      memberAvatarThumb: null,
    });
  });

  it('round-trips baseline thumbnails as bytes', async () => {
    const snap = freshSnapshot();
    // Deliberately not all-ASCII, matching the change-thumb fixture below:
    // 0xff/0xfe are invalid UTF-8 continuation bytes, so a driver that ever
    // coerced these through a string would corrupt them here and the test
    // would catch it. An all-ASCII buffer would survive that coercion.
    const userThumb = Buffer.from([0x52, 0x49, 0x46, 0x46, 0xff, 0x00, 0xfe]);
    const memberThumb = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xfd, 0xfc]);

    await repo.putSnapshot(snap, {
      userAvatarThumb: userThumb,
      memberAvatarThumb: memberThumb,
    });

    const stored = await repo.getSnapshot(snap.scopeId, snap.discordUserId);
    // These bytes ARE the before-image of every future change for this
    // member: Discord purges the old avatar, so nothing else can supply it.
    expect(stored?.userAvatarThumb?.equals(userThumb)).toBe(true);
    expect(stored?.memberAvatarThumb?.equals(memberThumb)).toBe(true);
  });

  it('leaves a stored baseline thumb alone when a put supplies none', async () => {
    const snap = freshSnapshot();
    const userThumb = Buffer.from([0x52, 0x49, 0x46, 0x46, 0xff, 0xfe]);
    await repo.putSnapshot(snap, {
      userAvatarThumb: userThumb,
      memberAvatarThumb: null,
    });

    // A nickname-only change: the caller knows nothing about avatars and
    // passes no thumbs at all.
    await repo.putSnapshot({ ...snap, nickname: 'Someone Else' });

    const stored = await repo.getSnapshot(snap.scopeId, snap.discordUserId);
    expect(stored?.nickname).toBe('Someone Else');
    // A blind `= EXCLUDED.user_avatar_thumb` would null this on every
    // non-avatar update, and the loss is permanent -- the CDN no longer has
    // the image, which is the entire reason it was stored here.
    expect(stored?.userAvatarThumb?.equals(userThumb)).toBe(true);
  });

  it('updates one baseline thumb without disturbing the other', async () => {
    const snap = freshSnapshot();
    const userThumb = Buffer.from([0x01, 0xff, 0xfe]);
    const memberThumb = Buffer.from([0x02, 0xfd, 0xfc]);
    await repo.putSnapshot(snap, {
      userAvatarThumb: userThumb,
      memberAvatarThumb: memberThumb,
    });

    const replacement = Buffer.from([0x03, 0xfb, 0xfa]);
    await repo.putSnapshot(snap, { userAvatarThumb: replacement });

    const stored = await repo.getSnapshot(snap.scopeId, snap.discordUserId);
    expect(stored?.userAvatarThumb?.equals(replacement)).toBe(true);
    // The two avatar fields change independently; a guild-avatar image must
    // survive a global-avatar change and vice versa.
    expect(stored?.memberAvatarThumb?.equals(memberThumb)).toBe(true);
  });

  it('clears a baseline thumb when null is passed explicitly', async () => {
    const snap = freshSnapshot();
    await repo.putSnapshot(snap, {
      userAvatarThumb: Buffer.from([0x01, 0xff, 0xfe]),
    });

    await repo.putSnapshot(snap, { userAvatarThumb: null });

    const stored = await repo.getSnapshot(snap.scopeId, snap.discordUserId);
    // Presence is the switch, not the value. An avatar change whose fetch
    // failed passes an explicit null, and it has to land: leaving the
    // superseded image under the new hash would make the NEXT change's
    // before-image wrong rather than merely absent.
    expect(stored?.userAvatarThumb).toBeNull();
  });

  it('overwrites an existing snapshot rather than duplicating it', async () => {
    const snap = freshSnapshot();
    await repo.putSnapshot(snap);
    await repo.putSnapshot({ ...snap, userAvatarHash: 'bbb' });

    const stored = await repo.getSnapshot(snap.scopeId, snap.discordUserId);
    expect(stored?.userAvatarHash).toBe('bbb');
  });

  it("keeps two guilds' baselines for the same member apart", async () => {
    const userId = `discord-${crypto.randomUUID()}`;
    await repo.putSnapshot({
      scopeId: 'guild-a',
      discordUserId: userId,
      username: 'someone',
      globalName: 'Someone',
      nickname: 'In Guild A',
      userAvatarHash: 'aaa',
      memberAvatarHash: null,
    });
    await repo.putSnapshot({
      scopeId: 'guild-b',
      discordUserId: userId,
      username: 'someone',
      globalName: 'Someone',
      nickname: 'In Guild B',
      userAvatarHash: 'aaa',
      memberAvatarHash: null,
    });

    // Nickname and per-guild avatar are guild-scoped facts. A single global
    // key would make these two rows overwrite each other, and every sweep
    // would then report a nickname change that never happened.
    expect((await repo.getSnapshot('guild-a', userId))?.nickname).toBe(
      'In Guild A',
    );
    expect((await repo.getSnapshot('guild-b', userId))?.nickname).toBe(
      'In Guild B',
    );
  });

  it('erases one member without touching another', async () => {
    const mine = `discord-${crypto.randomUUID()}`;
    const theirs = `discord-${crypto.randomUUID()}`;
    for (const id of [mine, theirs]) {
      // eslint-disable-next-line no-await-in-loop
      await repo.recordChanges(
        [
          {
            platform: 'discord',
            scopeId: DEFAULT_SCOPE,
            subjectId: id,
            field: 'nickname',
            oldValue: 'A',
            newValue: 'B',
          },
        ],
        'sweep',
        new Map(),
      );
    }

    const removed = await repo.deleteMemberIdentity(
      'discord',
      DEFAULT_SCOPE,
      mine,
    );

    expect(removed).toBeGreaterThan(0);
    const remaining = await repo.listChangesBetween(
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 60_000),
    );
    expect(remaining.some((r) => r.subjectId === mine)).toBe(false);
    expect(remaining.some((r) => r.subjectId === theirs)).toBe(true);
  });

  it('records platform and scope on every change', async () => {
    const id = `meetup-${crypto.randomUUID()}`;
    const start = new Date(Date.now() - 1000);
    await repo.recordChanges(
      [
        {
          platform: 'meetup',
          scopeId: '7595882',
          subjectId: id,
          field: 'photo',
          oldValue: 'p1',
          newValue: 'p2',
        },
      ],
      'sweep',
      new Map(),
    );

    const rows = await repo.listChangesBetween(
      start,
      new Date(Date.now() + 1000),
    );
    const mine = rows.find((r) => r.subjectId === id);
    // The digest and report both filter on these; a NULL here silently drops
    // Meetup rows out of every surface.
    expect(mine?.platform).toBe('meetup');
    expect(mine?.scopeId).toBe('7595882');
  });

  it('stores and returns thumbnail bytes', async () => {
    const snap = freshSnapshot();
    // Deliberately not all-ASCII: bytes like 0xff/0xfe are invalid as UTF-8
    // continuation bytes, so if the driver ever coerced this through a string
    // (e.g. Buffer.from(String(buf))) the round-trip would corrupt them.
    // Real thumbnails are binary WebP data (starting with a "RIFF" header),
    // which this fixture stands in for -- an all-ASCII buffer like [1,2,3,4]
    // would silently survive that coercion and the test would pass either way.
    const thumb = Buffer.from([0x52, 0x49, 0x46, 0x46, 0xff, 0x00, 0x89, 0xfe]);
    const start = new Date(Date.now() - 1000);

    await repo.recordChanges(
      [
        {
          platform: 'discord',
          scopeId: snap.scopeId,
          subjectId: snap.discordUserId,
          field: 'user_avatar',
          oldValue: 'aaa',
          newValue: 'bbb',
        },
      ],
      'sweep',
      new Map([
        [
          `discord:${snap.scopeId}:${snap.discordUserId}:user_avatar`,
          { oldThumb: null, newThumb: thumb },
        ],
      ]),
    );

    // listChangesBetween, not listChangesMetadataBetween: only the report path
    // selects the thumbs; the digest query is metadata-only by design.
    const rows = await repo.listChangesBetween(
      start,
      new Date(Date.now() + 60_000),
    );
    const mine = rows.find((r) => r.subjectId === snap.discordUserId);
    // BYTEA must survive the round-trip as bytes, not a hex string.
    expect(mine?.newThumb?.equals(thumb)).toBe(true);
    expect(mine?.oldThumb).toBeNull();
    expect(mine?.source).toBe('sweep');
  });

  it('records a change with no thumbnails at all', async () => {
    const snap = freshSnapshot();
    const start = new Date(Date.now() - 1000);

    await repo.recordChanges(
      [
        {
          platform: 'discord',
          scopeId: snap.scopeId,
          subjectId: snap.discordUserId,
          field: 'nickname',
          oldValue: 'A',
          newValue: 'B',
        },
      ],
      'sweep',
      new Map(),
    );

    const rows = await repo.listChangesBetween(
      start,
      new Date(Date.now() + 60_000),
    );
    const mine = rows.find((r) => r.subjectId === snap.discordUserId);
    // Thumb fetches are best-effort; a missing thumb must not lose the change.
    expect(mine?.newThumb).toBeNull();
    expect(mine?.field).toBe('nickname');

    // The digest path selects metadata only -- it must still see the change,
    // and must not carry the thumb columns at all.
    const metadata = await repo.listChangesMetadataBetween(
      start,
      new Date(Date.now() + 60_000),
    );
    const meta = metadata.find((r) => r.subjectId === snap.discordUserId);
    expect(meta?.field).toBe('nickname');
    expect(Object.keys(meta ?? {})).not.toContain('newThumb');
  });

  it('returns changes within a range and excludes those outside it', async () => {
    const snap = freshSnapshot();
    const start = new Date(Date.now() - 1000);
    await repo.recordChanges(
      [
        {
          platform: 'discord',
          scopeId: snap.scopeId,
          subjectId: snap.discordUserId,
          field: 'nickname',
          oldValue: 'A',
          newValue: 'B',
        },
      ],
      'sweep',
      new Map(),
    );

    // Read back the row's own detected_at at full precision so the boundary
    // check below sits exactly on it, rather than tens of seconds away. A
    // window that never approaches the actual timestamp can't tell `<` from
    // `<=` apart -- it would pass identically whichever comparison was used.
    //
    // Postgres's now() carries microsecond precision, but a JS Date can only
    // hold milliseconds -- round-tripping through a Date-typed argument
    // would silently floor the value below the row's real detected_at, so
    // even a broken `<=` would still exclude it and the test would lie.
    // Reading the raw text avoids that lossy round trip, letting us build an
    // upper bound that is bit-for-bit the row's own timestamp.
    const pool = (repo as unknown as { pool: pg.Pool }).pool;
    const raw = await pool.query<{ raw: string }>(
      'SELECT detected_at::text AS raw FROM member_identity_changes WHERE subject_id = $1',
      [snap.discordUserId],
    );
    // listChangesBetween is typed to take a Date, but pg accepts a raw
    // timestamptz-literal string identically -- passing the exact text keeps
    // the microsecond precision a Date object cannot hold. The cast is
    // deliberate: a Date could not carry this value without losing it.
    const exactly = raw.rows[0].raw as unknown as Date;

    const now = Date.now();
    const inRange = await repo.listChangesBetween(
      new Date(now - 60_000),
      new Date(now + 60_000),
    );
    // The upper bound here IS the change's own detected_at, read back at full
    // precision: this only proves the exclusive `<` semantics if the window
    // ends exactly where the row sits, not merely somewhere earlier.
    const outOfRange = await repo.listChangesBetween(
      new Date(start.getTime()),
      exactly,
    );

    // The report command slices by range; an off-by-one on the bounds would
    // silently hand organizers the wrong window.
    expect(inRange.some((r) => r.subjectId === snap.discordUserId)).toBe(true);
    expect(outOfRange.some((r) => r.subjectId === snap.discordUserId)).toBe(
      false,
    );
  });

  it('measures a range without transferring the thumbnails', async () => {
    const snap = freshSnapshot();
    const thumb = Buffer.alloc(1234, 7);
    const start = new Date(Date.now() - 1000);

    await repo.recordChanges(
      [
        {
          platform: 'discord',
          scopeId: snap.scopeId,
          subjectId: snap.discordUserId,
          field: 'user_avatar',
          oldValue: 'aaa',
          newValue: 'bbb',
        },
      ],
      'sweep',
      new Map([
        [
          `discord:${snap.scopeId}:${snap.discordUserId}:user_avatar`,
          { oldThumb: null, newThumb: thumb },
        ],
      ]),
    );

    const all = await repo.measureChangesBetween(
      start,
      new Date(Date.now() + 60_000),
    );
    const none = await repo.measureChangesBetween(
      new Date(Date.now() + 60_000),
      new Date(Date.now() + 120_000),
    );

    // octet_length over BYTEA must report the stored byte count, not the hex
    // representation's length -- a 2x error here would refuse valid ranges.
    expect(all.thumbBytes).toBeGreaterThanOrEqual(thumb.length);
    expect(all.changeCount).toBeGreaterThan(0);
    // coalesce, not NULL: an empty range must measure zero, not NaN.
    expect(none).toEqual({ changeCount: 0, thumbBytes: 0 });
  });

  it('returns only changes above the given id, in id order', async () => {
    const a = `discord-${crypto.randomUUID()}`;
    const b = `discord-${crypto.randomUUID()}`;
    const before = (await repo.maxChangeId()) ?? '0';
    for (const id of [a, b]) {
      // eslint-disable-next-line no-await-in-loop
      await repo.recordChanges(
        [
          {
            platform: 'discord',
            scopeId: DEFAULT_SCOPE,
            subjectId: id,
            field: 'nickname',
            oldValue: 'A',
            newValue: 'B',
          },
        ],
        'sweep',
        new Map(),
      );
    }
    const after = await repo.maxChangeId();

    const rows = await repo.listChangesMetadataAfterId(
      before,
      after,
      AMPLE_LIMIT,
    );
    const subjects = rows.map((r) => r.subjectId);

    expect(subjects).toContain(a);
    expect(subjects).toContain(b);
    // Ordering is what makes the mark meaningful: the digest advances to the
    // last id it reported, so the rows must arrive in that order.
    expect(subjects.indexOf(a)).toBeLessThan(subjects.indexOf(b));
    expect(rows.every((r) => Number(r.id) > Number(before))).toBe(true);
  });

  it('excludes the row at the mark itself, so nothing is reported twice', async () => {
    const id = `discord-${crypto.randomUUID()}`;
    await repo.recordChanges(
      [
        {
          platform: 'discord',
          scopeId: DEFAULT_SCOPE,
          subjectId: id,
          field: 'nickname',
          oldValue: 'A',
          newValue: 'B',
        },
      ],
      'sweep',
      new Map(),
    );
    const mark = await repo.maxChangeId();

    // Yesterday's digest stored `mark` after reporting that row. Today's must
    // start strictly above it -- `>=` would re-report the boundary row every
    // single day.
    const rows = await repo.listChangesMetadataAfterId(mark, mark, AMPLE_LIMIT);

    expect(rows).toHaveLength(0);
  });

  it('respects the ceiling, leaving newer rows for the next run', async () => {
    const early = `discord-${crypto.randomUUID()}`;
    const late = `discord-${crypto.randomUUID()}`;
    const before = (await repo.maxChangeId()) ?? '0';
    await repo.recordChanges(
      [
        {
          platform: 'discord',
          scopeId: DEFAULT_SCOPE,
          subjectId: early,
          field: 'nickname',
          oldValue: 'A',
          newValue: 'B',
        },
      ],
      'sweep',
      new Map(),
    );
    const ceiling = await repo.maxChangeId();
    await repo.recordChanges(
      [
        {
          platform: 'discord',
          scopeId: DEFAULT_SCOPE,
          subjectId: late,
          field: 'nickname',
          oldValue: 'A',
          newValue: 'B',
        },
      ],
      'sweep',
      new Map(),
    );

    const rows = await repo.listChangesMetadataAfterId(
      before,
      ceiling,
      AMPLE_LIMIT,
    );
    const subjects = rows.map((r) => r.subjectId);

    // The ceiling models a gateway event arriving mid-digest: it must not be
    // reported now, and (because the mark advances only to the last row
    // actually read) it must still be reportable tomorrow.
    expect(subjects).toContain(early);
    expect(subjects).not.toContain(late);
  });

  it('caps the number of rows returned at the given limit', async () => {
    const before = (await repo.maxChangeId()) ?? '0';
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await repo.recordChanges(
        [
          {
            platform: 'discord',
            scopeId: DEFAULT_SCOPE,
            subjectId: `discord-${crypto.randomUUID()}`,
            field: 'nickname',
            oldValue: 'A',
            newValue: 'B',
          },
        ],
        'sweep',
        new Map(),
      );
    }
    const after = await repo.maxChangeId();

    const rows = await repo.listChangesMetadataAfterId(before, after, 3);

    // An outage-length backlog must not be read in a single unbounded pass;
    // the caller advances the mark to the last row returned here, not to
    // `after`, so the remainder is picked up by a later run.
    expect(rows).toHaveLength(3);
  });

  it('round-trips the digest high-water mark', async () => {
    // Values derived from the clock, not fixed literals: the mark is
    // monotonic (see the next test), this suite runs against a persistent
    // database, and a fixed literal could be silently rejected by a value an
    // earlier run already left behind.
    const base = Date.now();
    const first = String(base + 100);
    await repo.setDigestCursor(first);
    expect(await repo.getDigestCursor()).toBe(first);

    // Upsert, not insert: the mark advances every day for the life of the app.
    const second = String(base + 200);
    await repo.setDigestCursor(second);
    expect(await repo.getDigestCursor()).toBe(second);
  });

  it('keeps the high-water mark monotonic when writes race out of order', async () => {
    // Two overlapping digest runs (the accepted >30-minute-lease case) can
    // finish out of order: a faster run posts through a higher id and writes
    // it, then a slower run writes a lower one. `base` is derived from the
    // clock so this value is guaranteed larger than any fixed id another test
    // in this file writes to the same key.
    const base = Date.now();
    const high = String(base + 500);
    const low = String(base + 400);

    await repo.setDigestCursor(high);
    await repo.setDigestCursor(low);

    // A blind overwrite would move the mark backwards and re-report every
    // row between `low` and `high` on the next run.
    expect(await repo.getDigestCursor()).toBe(high);
  });

  it('finds the last id before a cutoff for the first run', async () => {
    const id = `discord-${crypto.randomUUID()}`;
    await repo.recordChanges(
      [
        {
          platform: 'discord',
          scopeId: DEFAULT_SCOPE,
          subjectId: id,
          field: 'nickname',
          oldValue: 'A',
          newValue: 'B',
        },
      ],
      'sweep',
      new Map(),
    );

    const cutoff = new Date(Date.now() + 60_000);
    const boundary = await repo.changeIdBefore(cutoff);

    expect(Number(boundary)).toBeGreaterThan(0);
    // Everything already recorded is below the boundary, so the first digest
    // reports nothing older than its window rather than the whole backfill.
    const rows = await repo.listChangesMetadataAfterId(
      boundary,
      await repo.maxChangeId(),
      AMPLE_LIMIT,
    );
    expect(rows.some((r) => r.subjectId === id)).toBe(false);
  });

  it('returns 0 from changeIdBefore when nothing precedes the cutoff', async () => {
    expect(await repo.changeIdBefore(new Date(0))).toBe('0');
  });

  it('hides changes recorded under an unmonitored scope', async () => {
    const stranger = `discord-${crypto.randomUUID()}`;
    const before = (await repo.maxChangeId()) ?? '0';
    await repo.recordChanges(
      [
        {
          platform: 'discord',
          scopeId: 'some-other-guild',
          subjectId: stranger,
          field: 'nickname',
          oldValue: 'A',
          newValue: 'B',
        },
      ],
      'sweep',
      new Map(),
    );

    // M2: guildMemberUpdate already refuses foreign guilds on the write path,
    // but nothing enforced the same boundary on the read path -- a row from a
    // test server or a stale configuration would be reported to these
    // organizers as if it were theirs.
    const window = {
      from: new Date(Date.now() - 60_000),
      to: new Date(Date.now() + 60_000),
    };
    const afterId = await repo.listChangesMetadataAfterId(
      before,
      (await repo.maxChangeId()) ?? before,
      AMPLE_LIMIT,
    );
    const between = await repo.listChangesBetween(window.from, window.to);
    const metadata = await repo.listChangesMetadataBetween(
      window.from,
      window.to,
    );

    expect(afterId.some((r) => r.subjectId === stranger)).toBe(false);
    expect(between.some((r) => r.subjectId === stranger)).toBe(false);
    expect(metadata.some((r) => r.subjectId === stranger)).toBe(false);
  });

  it('excludes an unmonitored scope from the size measurement too', async () => {
    const stranger = `discord-${crypto.randomUUID()}`;
    const thumb = Buffer.alloc(5000, 3);
    const from = new Date(Date.now() - 1000);

    const baseline = await repo.measureChangesBetween(
      from,
      new Date(Date.now() + 60_000),
    );
    await repo.recordChanges(
      [
        {
          platform: 'discord',
          scopeId: 'some-other-guild',
          subjectId: stranger,
          field: 'user_avatar',
          oldValue: 'aaa',
          newValue: 'bbb',
        },
      ],
      'sweep',
      new Map([
        [
          `discord:some-other-guild:${stranger}:user_avatar`,
          { oldThumb: null, newThumb: thumb },
        ],
      ]),
    );
    const after = await repo.measureChangesBetween(
      from,
      new Date(Date.now() + 60_000),
    );

    // The report refuses oversized ranges on this measurement, so counting
    // rows it will never render would refuse ranges that actually fit.
    expect(after.changeCount).toBe(baseline.changeCount);
    expect(after.thumbBytes).toBe(baseline.thumbBytes);
  });

  it('reports storage stats', async () => {
    const stats = await repo.storageStats();

    expect(stats.changeCount).toBeGreaterThan(0);
    expect(stats.totalBytes).toBeGreaterThan(0);
  });

  it('round-trips a Meetup snapshot', async () => {
    const snap = freshMeetupSnapshot();
    await repo.putMeetupSnapshot(snap);

    expect(
      await repo.getMeetupSnapshot(snap.scopeId, snap.meetupMemberId),
    ).toEqual({ ...snap, photoThumb: null });
  });

  it('round-trips a Meetup baseline photo as bytes', async () => {
    const snap = freshMeetupSnapshot();
    // JPEG magic plus high bytes: Meetup serves JPEG, and a string coercion
    // would corrupt 0xff/0xd8 rather than merely reordering them.
    const photo = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0xfe]);

    await repo.putMeetupSnapshot(snap, { photoThumb: photo });

    const stored = await repo.getMeetupSnapshot(
      snap.scopeId,
      snap.meetupMemberId,
    );
    // The Meetup baseline keeps a photo id, never the URL behind it, so these
    // bytes are the only possible before-image for a future photo change.
    expect(stored?.photoThumb?.equals(photo)).toBe(true);
  });

  it('leaves a stored Meetup photo alone when a put supplies none', async () => {
    const snap = freshMeetupSnapshot();
    const photo = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0xfe]);
    await repo.putMeetupSnapshot(snap, { photoThumb: photo });

    // A name-only change carries no photo information.
    await repo.putMeetupSnapshot({ ...snap, name: 'Jane E.' });

    const stored = await repo.getMeetupSnapshot(
      snap.scopeId,
      snap.meetupMemberId,
    );
    expect(stored?.name).toBe('Jane E.');
    // A blind overwrite would discard the image on every name or username
    // edit, and Meetup cannot serve it again.
    expect(stored?.photoThumb?.equals(photo)).toBe(true);
  });

  it('overwrites an existing Meetup snapshot rather than duplicating it', async () => {
    const snap = freshMeetupSnapshot();
    await repo.putMeetupSnapshot(snap);
    await repo.putMeetupSnapshot({ ...snap, photoId: 'p2' });

    const stored = await repo.getMeetupSnapshot(
      snap.scopeId,
      snap.meetupMemberId,
    );
    expect(stored?.photoId).toBe('p2');
  });

  it('erases a Meetup member baseline as well as its change history', async () => {
    const snap = freshMeetupSnapshot();
    await repo.putMeetupSnapshot(snap);
    await repo.recordChanges(
      [
        {
          platform: 'meetup',
          scopeId: snap.scopeId,
          subjectId: snap.meetupMemberId,
          field: 'name',
          oldValue: 'Old Name',
          newValue: snap.name,
        },
      ],
      'sweep',
      new Map(),
    );

    const removed = await repo.deleteMemberIdentity(
      'meetup',
      snap.scopeId,
      snap.meetupMemberId,
    );

    expect(removed).toBeGreaterThan(0);
    // Before this task, deleteMemberIdentity only ever cleared the Discord
    // baseline table (member_identity). A Meetup erasure that left this row
    // behind would keep re-seeding the "before" side of the next diff from
    // identity that was supposedly erased.
    expect(
      await repo.getMeetupSnapshot(snap.scopeId, snap.meetupMemberId),
    ).toBeUndefined();
  });

  it("erasing a Meetup member's baseline leaves a Discord baseline untouched", async () => {
    const meetupSnap = freshMeetupSnapshot();
    const discordSnap = freshSnapshot();
    await repo.putMeetupSnapshot(meetupSnap);
    await repo.putSnapshot(discordSnap);

    await repo.deleteMemberIdentity(
      'meetup',
      meetupSnap.scopeId,
      meetupSnap.meetupMemberId,
    );

    // The two platforms keep separate baseline tables; a Meetup erasure must
    // not reach into member_identity and wipe an unrelated Discord baseline.
    expect(
      await repo.getSnapshot(discordSnap.scopeId, discordSnap.discordUserId),
    ).toEqual({
      ...discordSnap,
      userAvatarThumb: null,
      memberAvatarThumb: null,
    });
  });

  describe('listIdentityNames', () => {
    const subject = (
      platform: 'discord' | 'meetup',
      scopeId: string,
      subjectId: string,
    ) => ({ platform, scopeId, subjectId });

    it('returns the stored Meetup name for a Meetup subject', async () => {
      const snap = freshMeetupSnapshot();
      await repo.putMeetupSnapshot(snap);

      const names = await repo.listIdentityNames([
        subject('meetup', snap.scopeId, snap.meetupMemberId),
      ]);

      expect(
        names.get(identityNameKey('meetup', snap.scopeId, snap.meetupMemberId)),
      ).toBe('Jane D.');
    });

    it('returns the nickname for a Discord subject, falling back down the chain', async () => {
      const withNick = freshSnapshot();
      const globalOnly = { ...freshSnapshot(), nickname: null };
      const usernameOnly = {
        ...freshSnapshot(),
        nickname: null,
        globalName: null,
      };
      await repo.putSnapshot(withNick);
      await repo.putSnapshot(globalOnly);
      await repo.putSnapshot(usernameOnly);

      const names = await repo.listIdentityNames(
        [withNick, globalOnly, usernameOnly].map((snap) =>
          subject('discord', snap.scopeId, snap.discordUserId),
        ),
      );

      const nameOf = (snap: IdentitySnapshot) =>
        names.get(identityNameKey('discord', snap.scopeId, snap.discordUserId));
      expect(nameOf(withNick)).toBe('Some One');
      expect(nameOf(globalOnly)).toBe('Someone');
      expect(nameOf(usernameOnly)).toBe('someone');
    });

    it('omits a subject with no baseline or no stored name', async () => {
      const nameless = { ...freshMeetupSnapshot(), name: null };
      await repo.putMeetupSnapshot(nameless);

      const names = await repo.listIdentityNames([
        subject('meetup', nameless.scopeId, nameless.meetupMemberId),
        subject('meetup', MEETUP_SCOPE, `missing-${crypto.randomUUID()}`),
        subject('discord', DEFAULT_SCOPE, `missing-${crypto.randomUUID()}`),
      ]);

      expect(names.size).toBe(0);
    });

    it('does not cross platforms or scopes for the same subject id', async () => {
      const sharedId = `shared-${crypto.randomUUID()}`;
      await repo.putMeetupSnapshot({
        ...freshMeetupSnapshot(),
        meetupMemberId: sharedId,
      });

      const names = await repo.listIdentityNames([
        // Same id, but as a Discord subject and as a Meetup subject in
        // another group: neither is the member that was stored.
        subject('discord', MEETUP_SCOPE, sharedId),
        subject('meetup', 'another-group', sharedId),
      ]);

      expect(names.size).toBe(0);
    });

    it('resolves both platforms, and repeated subjects, in one call', async () => {
      const discord = freshSnapshot();
      const meetup = freshMeetupSnapshot();
      await repo.putSnapshot(discord);
      await repo.putMeetupSnapshot(meetup);
      const d = subject('discord', discord.scopeId, discord.discordUserId);
      const m = subject('meetup', meetup.scopeId, meetup.meetupMemberId);

      const names = await repo.listIdentityNames([d, m, d, m, m]);

      expect(names.size).toBe(2);
    });

    it('returns an empty map for no subjects', async () => {
      expect((await repo.listIdentityNames([])).size).toBe(0);
    });
  });

  describe('dashboard reads', () => {
    const poolOf = () => (repo as unknown as { pool: pg.Pool }).pool;
    /** A fresh all-digit subject id, so a filter isolates this test's rows. */
    const digits = () =>
      String(crypto.randomInt(1e9, 9e9)) + String(crypto.randomInt(1e5, 9e5));
    const PNG = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00,
    ]);
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xfe, 0x00]);

    /** `count` Meetup name changes for one subject, one second apart from `start`; ids ascending. */
    async function insertMany(
      subjectId: string,
      count: number,
      start: Date,
      scopeId = MEETUP_SCOPE,
    ): Promise<string[]> {
      const result = await poolOf().query<{ id: string }>(
        `INSERT INTO member_identity_changes
           (platform, scope_id, subject_id, field, old_value, new_value, source, detected_at)
         SELECT 'meetup', $1, $2, 'name', 'a' || g, 'b' || g, 'sweep',
                $3::timestamptz + g * interval '1 second'
           FROM generate_series(1, $4::int) g
         ORDER BY g
         RETURNING id::text AS id`,
        [scopeId, subjectId, start, count],
      );
      return result.rows.map((r) => r.id).sort((a, b) => Number(a) - Number(b));
    }

    async function recordOne(
      platform: 'discord' | 'meetup',
      scopeId: string,
      subjectId: string,
      field: 'user_avatar' | 'photo' | 'nickname' | 'name',
      thumbs?: { oldThumb: Buffer | null; newThumb: Buffer | null },
    ): Promise<string> {
      await repo.recordChanges(
        [{ platform, scopeId, subjectId, field, oldValue: 'o', newValue: 'n' }],
        'sweep',
        new Map(
          thumbs
            ? [[`${platform}:${scopeId}:${subjectId}:${field}`, thumbs]]
            : [],
        ),
      );
      const row = await poolOf().query<{ id: string }>(
        `SELECT max(id)::text AS id FROM member_identity_changes
          WHERE platform = $1 AND scope_id = $2 AND subject_id = $3`,
        [platform, scopeId, subjectId],
      );
      return row.rows[0].id;
    }

    it('listChangesPage filters by date, platform, member', async () => {
      const subject = digits();
      const other = digits();
      const base = new Date('2031-03-10T08:00:00Z');
      await insertMany(subject, 3, base); // +1s, +2s, +3s
      await insertMany(other, 2, base);
      const discordId = await recordOne(
        'discord',
        DEFAULT_SCOPE,
        subject,
        'nickname',
      );

      const bySubject = await repo.listChangesPage({ subjectId: subject });
      expect(bySubject.map((r) => r.subjectId)).toEqual([
        subject,
        subject,
        subject,
        subject,
      ]);
      expect(bySubject[0].id).toBe(discordId);

      const meetupOnly = await repo.listChangesPage({
        subjectId: subject,
        platform: 'meetup',
      });
      expect(meetupOnly).toHaveLength(3);
      expect(meetupOnly.every((r) => r.platform === 'meetup')).toBe(true);
      const discordOnly = await repo.listChangesPage({
        subjectId: subject,
        platform: 'discord',
      });
      expect(discordOnly.map((r) => r.id)).toEqual([discordId]);

      // from inclusive, to exclusive.
      const window = await repo.listChangesPage({
        subjectId: subject,
        platform: 'meetup',
        from: new Date(base.getTime() + 2000),
        to: new Date(base.getTime() + 3000),
      });
      expect(window.map((r) => r.newValue)).toEqual(['b2']);
    });

    it('keyset paging is stable', async () => {
      const subject = digits();
      const ids = await insertMany(
        subject,
        120,
        new Date('2031-04-01T00:00:00Z'),
      );
      const newestFirst = [...ids].reverse();
      // One row whose detected_at order disagrees with its id order: paging
      // by time would move it, paging by id must not.
      await poolOf().query(
        `UPDATE member_identity_changes SET detected_at = $2 WHERE id = $1::bigint`,
        [newestFirst[10], new Date('2030-01-01T00:00:00Z')],
      );

      const page1 = await repo.listChangesPage({
        subjectId: subject,
        limit: 50,
      });
      expect(page1.map((r) => r.id)).toEqual(newestFirst.slice(0, 50));

      const read2 = () =>
        repo.listChangesPage({
          subjectId: subject,
          beforeId: page1[49].id,
          limit: 50,
        });
      const page2 = await read2();
      expect(page2.map((r) => r.id)).toEqual(newestFirst.slice(50, 100));

      // A new change between page reads does not shift page 2.
      await insertMany(subject, 1, new Date('2031-04-02T00:00:00Z'));
      expect((await read2()).map((r) => r.id)).toEqual(
        newestFirst.slice(50, 100),
      );

      const page3 = await repo.listChangesPage({
        subjectId: subject,
        beforeId: page2[49].id,
        limit: 50,
      });
      expect(page3.map((r) => r.id)).toEqual(newestFirst.slice(100));
      expect(page3).toHaveLength(20);
    });

    it('orders ids as numbers across a digit boundary', async () => {
      // '9999999999' sorts above '10000000000' as text. Explicit ids far
      // above the sequence, removed again so later tests never see them.
      const subject = digits();
      const ids = ['9999999999', '10000000000'];
      try {
        await poolOf().query(
          `INSERT INTO member_identity_changes
             (id, platform, scope_id, subject_id, field, old_value, new_value, source)
           SELECT unnest($1::bigint[]), 'meetup', $2, $3, 'name', 'a', 'b', 'sweep'`,
          [ids, MEETUP_SCOPE, subject],
        );
        const page = await repo.listChangesPage({ subjectId: subject });
        expect(page.map((r) => r.id)).toEqual(['10000000000', '9999999999']);
        const older = await repo.listChangesPage({
          subjectId: subject,
          beforeId: '10000000000',
        });
        expect(older.map((r) => r.id)).toEqual(['9999999999']);
      } finally {
        await poolOf().query(
          'DELETE FROM member_identity_changes WHERE id = ANY($1::bigint[])',
          [ids],
        );
      }
    });

    it('caps the page at 50 rows', async () => {
      const subject = digits();
      await insertMany(subject, 60, new Date('2031-05-01T00:00:00Z'));
      expect(
        await repo.listChangesPage({ subjectId: subject, limit: 500 }),
      ).toHaveLength(50);
      expect(await repo.listChangesPage({ subjectId: subject })).toHaveLength(
        50,
      );
      expect(
        await repo.listChangesPage({ subjectId: subject, limit: 0 }),
      ).toHaveLength(50);
    });

    it('listChangesPage never selects thumbnail bytes', async () => {
      const subject = digits();
      await recordOne('meetup', MEETUP_SCOPE, subject, 'photo', {
        oldThumb: JPEG,
        newThumb: null,
      });
      const spy = vi.spyOn(poolOf(), 'query');
      try {
        const rows = await repo.listChangesPage({ subjectId: subject });
        const sql = String(spy.mock.calls[0][0]);
        expect(sql).not.toMatch(/\b(old|new)_thumb\s*(,|AS\b|FROM\b)/i);
        expect(sql).not.toMatch(/SELECT \*/i);
        expect(rows).toHaveLength(1);
        expect(rows[0]).not.toHaveProperty('oldThumb');
        expect(rows[0]).not.toHaveProperty('newThumb');
        expect(rows[0].hasOldThumb).toBe(true);
        expect(rows[0].hasNewThumb).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    it('applies the scope filter', async () => {
      const subject = digits();
      const foreign = await recordOne(
        'discord',
        'some-other-guild',
        subject,
        'user_avatar',
        {
          oldThumb: PNG,
          newThumb: PNG,
        },
      );
      expect(await repo.listChangesPage({ subjectId: subject })).toEqual([]);
      expect(await repo.getChangeThumb(foreign, 'old')).toBeUndefined();
      expect(await repo.getChangeThumb(foreign, 'new')).toBeUndefined();
    });

    it('getChangeThumb never returns a thumbnail over the size cap, and the route 404s', async () => {
      const subject = digits();
      const atCap = Buffer.alloc(MAX_THUMB_BYTES, 0);
      PNG.copy(atCap);
      const overCap = Buffer.alloc(MAX_THUMB_BYTES + 1, 0);
      PNG.copy(overCap);
      const id = await recordOne('meetup', MEETUP_SCOPE, subject, 'photo', {
        oldThumb: atCap,
        newThumb: overCap,
      });
      expect((await repo.getChangeThumb(id, 'old'))?.length).toBe(
        MAX_THUMB_BYTES,
      );
      expect(await repo.getChangeThumb(id, 'new')).toBeUndefined();

      // The real route over the real repository.
      const { req } = await makeApp({
        protectedRoutes: (r) =>
          registerAllProtectedRoutes(r, {
            organizer: fakeOrganizerDeps(),
            pages: fakePageDeps({ identity: async () => repo }),
          }),
      });
      const cookie = await signIn(req);
      const over = await req
        .get(`/dashboard/identity/changes/${id}/thumb/new`)
        .set('Cookie', cookie);
      expect(over.status).toBe(404);
      expect(over.headers['content-type']).toMatch(/^text\/html/);
      const at = await req
        .get(`/dashboard/identity/changes/${id}/thumb/old`)
        .set('Cookie', cookie);
      expect(at.status).toBe(200);
      expect(at.headers['content-type']).toBe('image/png');
      await closeServers();
    });

    it('getChangeThumb returns one side', async () => {
      const subject = digits();
      const id = await recordOne('meetup', MEETUP_SCOPE, subject, 'photo', {
        oldThumb: JPEG,
        newThumb: PNG,
      });
      expect((await repo.getChangeThumb(id, 'old'))?.equals(JPEG)).toBe(true);
      expect((await repo.getChangeThumb(id, 'new'))?.equals(PNG)).toBe(true);
    });

    it('getChangeThumb returns undefined for a text change, an unknown id and an out-of-scope id', async () => {
      const subject = digits();
      const text = await recordOne(
        'discord',
        DEFAULT_SCOPE,
        subject,
        'nickname',
      );
      const foreign = await recordOne(
        'meetup',
        'another-group',
        subject,
        'photo',
        {
          oldThumb: JPEG,
          newThumb: JPEG,
        },
      );
      expect(await repo.getChangeThumb(text, 'old')).toBeUndefined();
      expect(await repo.getChangeThumb(text, 'new')).toBeUndefined();
      expect(
        await repo.getChangeThumb('999999999999999999', 'old'),
      ).toBeUndefined();
      expect(await repo.getChangeThumb(foreign, 'old')).toBeUndefined();
    });

    it('getChangeThumb looks up by change id only', async () => {
      const subject = digits();
      const id = await recordOne('meetup', MEETUP_SCOPE, subject, 'photo', {
        oldThumb: JPEG,
        newThumb: null,
      });
      const spy = vi.spyOn(poolOf(), 'query');
      try {
        await repo.getChangeThumb(id, 'old');
        expect(spy).toHaveBeenCalledTimes(1);
        const [sql, params] = spy.mock.calls[0] as unknown as [
          string,
          unknown[],
        ];
        const flat = sql.replace(/\s+/g, ' ');
        expect(flat).toMatch(
          /^SELECT CASE WHEN octet_length\(old_thumb\) <= 262144 THEN old_thumb END AS thumb /,
        );
        expect(flat).toMatch(
          / FROM member_identity_changes WHERE id = \$1::bigint AND \(platform, scope_id\) IN /,
        );
        expect(sql).not.toContain('subject_id');
        expect(sql).not.toContain('new_thumb');
        expect(params).toEqual([id, GUILD_ID, MEETUP_SCOPE]);
      } finally {
        spy.mockRestore();
      }
    });

    it('getChangeThumb refuses a bad side or id without querying', async () => {
      const spy = vi.spyOn(poolOf(), 'query');
      try {
        for (const [id, side] of [
          ['1', 'both'],
          ['1', 'old_thumb'],
          ['1a', 'old'],
          ['-1', 'old'],
          ['1'.repeat(19), 'old'],
          ['', 'new'],
        ]) {
          // eslint-disable-next-line no-await-in-loop -- one at a time, each must refuse
          await expect(
            repo.getChangeThumb(id, side as 'old'),
          ).rejects.toBeInstanceOf(RangeError);
        }
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it('listChangesPage refuses a bad filter without querying', async () => {
      const spy = vi.spyOn(poolOf(), 'query');
      try {
        for (const filter of [
          { subjectId: '4a' },
          { subjectId: '1'.repeat(21) },
          { beforeId: '1'.repeat(19) },
          { beforeId: '1 OR 1=1' },
          { platform: 'x' as 'meetup' },
        ]) {
          // eslint-disable-next-line no-await-in-loop -- one at a time, each must refuse
          await expect(repo.listChangesPage(filter)).rejects.toBeInstanceOf(
            RangeError,
          );
        }
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    describe('latestStoredPhoto', () => {
      const CAP = 100;
      const img = (byte: number, size = 10) => Buffer.alloc(size, byte);
      const ago = (days: number) => new Date(Date.now() - days * 86_400_000);

      async function change(
        platform: 'discord' | 'meetup',
        scopeId: string,
        subjectId: string,
        field: string,
        thumb: Buffer,
        at: Date,
      ): Promise<void> {
        await poolOf().query(
          `INSERT INTO member_identity_changes
             (platform, scope_id, subject_id, field, old_value, new_value,
              new_thumb, source, detected_at)
           VALUES ($1, $2, $3, $4, 'o', 'n', $5, 'sweep', $6)`,
          [platform, scopeId, subjectId, field, thumb, at],
        );
      }

      it(
        'returns the newest of change and baseline images for the Meetup and Discord subjects, ' +
          'ignores other scopes and images over the cap',
        async () => {
          const meetupId = digits();
          const discordId = digits();
          await poolOf().query(
            `INSERT INTO meetup_identity (scope_id, meetup_member_id, photo_id, photo_thumb, updated_at)
           VALUES ($1, $2, 'p', $3, $4), ('999', $2, 'p', $5, now())`,
            [MEETUP_SCOPE, meetupId, img(0xa1), ago(5), img(0xa9)],
          );
          await poolOf().query(
            `INSERT INTO member_identity (scope_id, discord_user_id, member_avatar_thumb, user_avatar_thumb, updated_at)
           VALUES ($1, $2, $3, $4, $5), ('some-other-guild', $2, $6, $6, now())`,
            [DEFAULT_SCOPE, discordId, img(0xb1), img(0xc1), ago(3), img(0xb9)],
          );
          await change(
            'meetup',
            MEETUP_SCOPE,
            meetupId,
            'photo',
            img(0xd1),
            ago(4),
          );
          // Newer, but each is out of bounds: another scope, or over the cap.
          await change(
            'discord',
            'some-other-guild',
            discordId,
            'user_avatar',
            img(0xe9),
            ago(0.5),
          );
          await change('meetup', '999', meetupId, 'photo', img(0xe8), ago(0.5));
          await change(
            'discord',
            DEFAULT_SCOPE,
            discordId,
            'user_avatar',
            img(0xe7, CAP + 1),
            ago(0.4),
          );

          // Newest in scope: the Discord baseline (3 days), guild avatar first.
          expect(
            await repo.latestStoredPhoto(meetupId, discordId, CAP),
          ).toEqual(img(0xb1));
          // Without the link: the Meetup change (4 days) beats the baseline (5).
          expect(
            await repo.latestStoredPhoto(meetupId, undefined, CAP),
          ).toEqual(img(0xd1));
          // A newer Meetup change wins over everything.
          await change(
            'meetup',
            MEETUP_SCOPE,
            meetupId,
            'photo',
            img(0xf1),
            ago(1),
          );
          expect(
            await repo.latestStoredPhoto(meetupId, discordId, CAP),
          ).toEqual(img(0xf1));
          // The user avatar stands in when the guild avatar is missing.
          await poolOf().query(
            `UPDATE member_identity SET member_avatar_thumb = NULL, updated_at = now()
            WHERE scope_id = $1 AND discord_user_id = $2`,
            [DEFAULT_SCOPE, discordId],
          );
          expect(
            await repo.latestStoredPhoto(meetupId, discordId, CAP),
          ).toEqual(img(0xc1));
          expect(await repo.latestStoredPhoto(digits(), undefined, CAP)).toBe(
            undefined,
          );
        },
      );

      it('refuses ids that are not digits without a query', async () => {
        const spy = vi.spyOn(poolOf(), 'query');
        try {
          expect(await repo.latestStoredPhoto('12a', undefined, 100)).toBe(
            undefined,
          );
          expect(await repo.latestStoredPhoto('123', ' 1', 100)).toBe(
            undefined,
          );
          expect(spy).not.toHaveBeenCalled();
        } finally {
          spy.mockRestore();
        }
      });
    });

    it('countChangesSince counts in scope', async () => {
      const since = new Date(Date.now() - 1000);
      const before = await repo.countChangesSince(since);
      const subject = digits();
      await recordOne('meetup', MEETUP_SCOPE, subject, 'name');
      await recordOne('discord', DEFAULT_SCOPE, subject, 'nickname');
      await recordOne('discord', 'some-other-guild', subject, 'nickname');
      expect(await repo.countChangesSince(since)).toBe(before + 2);
    });
  });
});
