import crypto from 'crypto';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';

import { GUILD_ID } from '../../src/constants.js';
import { MeetupSnapshot } from '../../src/lib/helpers/identity/meetupSnapshot.js';
import { PostgresIdentityRepository } from '../../src/lib/repositories/postgresIdentityRepository.js';
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

    expect(await repo.getSnapshot(snap.scopeId, snap.discordUserId)).toEqual(
      snap,
    );
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
        'event',
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
      'event',
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
    expect(mine?.source).toBe('event');
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
      'event',
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
      'event',
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
        'event',
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
      'event',
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
      'event',
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
      'event',
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
        'event',
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
      'event',
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
      'event',
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
      'event',
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
    ).toEqual(snap);
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
    ).toEqual(discordSnap);
  });
});
