import crypto from 'crypto';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';

import { GUILD_ID } from '../../src/constants.js';
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

const freshSnapshot = (): IdentitySnapshot => ({
  scopeId: DEFAULT_SCOPE,
  discordUserId: `discord-${crypto.randomUUID()}`,
  username: 'someone',
  globalName: 'Someone',
  nickname: 'Some One',
  userAvatarHash: 'aaa',
  memberAvatarHash: null,
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

  it('hides changes recorded under an unmonitored scope', async () => {
    const stranger = `discord-${crypto.randomUUID()}`;
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
    const between = await repo.listChangesBetween(window.from, window.to);
    const metadata = await repo.listChangesMetadataBetween(
      window.from,
      window.to,
    );

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
});
