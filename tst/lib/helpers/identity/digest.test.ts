import { Client } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DIGEST_PAGE_LIMIT,
  IDENTITY_DIGEST_UTC_HOUR,
  formatIdentityDigest,
  identityDigestClaimKey,
  identityDigestDoneKey,
  identityDigestWindow,
  runIdentityDigestOnce,
  safeErrorSummary,
} from '../../../../src/lib/helpers/identity/digest.js';
import { logAlert } from '../../../../src/lib/helpers/discordLogger.js';
import { runMeetupSweep } from '../../../../src/lib/helpers/identity/meetupSweep.js';
import {
  BAN_FILL_DEADLINE_MS,
  defaultBanPhotoFillDeps,
  runBanPhotoFillSafely,
} from '../../../../src/lib/bans/photoFill.js';
import { MeetupGroupMember } from '../../../../src/lib/client/meetup/types.js';
import { runIdentitySweep } from '../../../../src/lib/helpers/identity/sweep.js';
import { identityNameKey } from '../../../../src/lib/helpers/identity/names.js';
import { IdentityChangeRecord } from '../../../../src/lib/repositories/identityTypes.js';

const repo = vi.hoisted(() => ({
  listChangesMetadataAfterId: vi.fn(),
  maxChangeId: vi.fn(),
  changeIdBefore: vi.fn(),
  getDigestCursor: vi.fn(),
  setDigestCursor: vi.fn(),
  storageStats: vi.fn(),
  listIdentityNames: vi.fn(),
}));
const cache = vi.hoisted(() => ({
  exclusive_set: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn().mockResolvedValue(undefined),
}));
const memberRepo = vi.hoisted(() => ({
  listAll: vi.fn(),
}));

vi.mock('../../../../src/util/identityRepository.js', () => ({
  ApplicationIdentityRepository: vi.fn(async () => repo),
}));
vi.mock('../../../../src/util/cache.js', () => ({
  ApplicationCache: vi.fn(async () => cache),
}));
vi.mock('../../../../src/util/memberRepository.js', () => ({
  ApplicationMemberRepository: vi.fn(async () => memberRepo),
}));
vi.mock('../../../../src/lib/helpers/discordLogger.js', () => ({
  logAlert: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../../../src/lib/helpers/identity/sweep.js', () => ({
  runIdentitySweep: vi.fn().mockResolvedValue({ scanned: 0, changed: 0 }),
}));
vi.mock('../../../../src/lib/helpers/identity/meetupSweep.js', () => ({
  runMeetupSweep: vi.fn().mockResolvedValue({ scanned: 0, changed: 0 }),
}));
// The real runBanPhotoFillSafely (its own deadline and catch) over fake
// deps: nothing reaches Postgres, Discord or Meetup.
const banFill = vi.hoisted(() => ({
  bans: {
    listPhotoFillCandidates: vi.fn(),
    fillProfilePhoto: vi.fn(),
  },
  open: vi.fn(),
}));
vi.mock('../../../../src/lib/bans/photoFill.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../../src/lib/bans/photoFill.js')
    >();
  return {
    ...actual,
    runBanPhotoFillSafely: vi.fn(actual.runBanPhotoFillSafely),
    defaultBanPhotoFillDeps: vi.fn(() => ({
      bans: banFill.open,
      discordIdsByMeetupIds: async () => new Map(),
      guildMember: () => undefined,
      storedPhoto: async () => undefined,
      fetchBytes: async () => null,
      guildId: 'g1',
      now: () => Date.now(),
    })),
  };
});

const at = (iso: string) => new Date(iso);

const change = (
  over: Partial<IdentityChangeRecord> = {},
): IdentityChangeRecord => ({
  id: '1',
  platform: 'discord',
  scopeId: 'g1',
  subjectId: 'u1',
  field: 'user_avatar',
  oldValue: 'aaa',
  newValue: 'bbb',
  oldThumb: null,
  newThumb: null,
  detectedAt: at('2026-08-16T14:02:00Z'),
  source: 'sweep',
  ...over,
});

const stats = { changeCount: 1204, totalBytes: 64_000_000 };

const meetupChange = (over: Partial<IdentityChangeRecord> = {}) =>
  change({
    platform: 'meetup',
    scopeId: 'grp',
    subjectId: '279964402',
    field: 'photo',
    ...over,
  });
const meetupName = (name: string, subjectId = '279964402') =>
  new Map([[identityNameKey('meetup', 'grp', subjectId), name]]);
const discordName = (name: string, subjectId = 'u1') =>
  new Map([[identityNameKey('discord', 'g1', subjectId), name]]);
const PROFILE = 'https://www.meetup.com/members/279964402/';

describe('formatIdentityDigest', () => {
  it('returns undefined when there were no changes', () => {
    // A silent day must post nothing rather than an empty embed.
    expect(formatIdentityDigest([], stats, new Map())).toBeUndefined();
  });

  it('lists each change and reports storage', () => {
    const entry = formatIdentityDigest([change()], stats, new Map());

    expect(entry?.title).toContain('1');
    expect(entry?.description).toContain('<@u1>');
    expect(entry?.description).toContain('user avatar');
    expect(entry?.description).toContain('1,204 changes on record');
  });

  it('truncates a flood rather than exceeding the embed limit', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      change({ id: String(i), subjectId: `u${i}` }),
    );

    const entry = formatIdentityDigest(many, stats, new Map());

    // Discord rejects descriptions over 4096 characters outright, which would
    // turn a busy day into no digest at all.
    expect((entry?.description ?? '').length).toBeLessThanOrEqual(4096);
    // The mark still advances past truncated rows, so they are never shown by
    // a later digest -- the note must point at the one place they remain
    // visible.
    expect(entry?.description).toContain(
      'run /meetup_identity_report for the full list',
    );
  });

  it('labels which platform each change came from', () => {
    const entry = formatIdentityDigest(
      [
        change({ platform: 'discord', subjectId: 'u1' }),
        change({ platform: 'meetup', subjectId: 'm1', field: 'photo' }),
      ],
      stats,
      new Map(),
    );

    // Without the label an organizer cannot tell which profile to go look at.
    expect(entry?.description).toContain('Discord');
    expect(entry?.description).toContain('Meetup');
  });

  it('names the linked Discord member for a Meetup change', () => {
    const entry = formatIdentityDigest(
      [change({ platform: 'meetup', subjectId: 'm1', field: 'photo' })],
      stats,
      new Map([['m1', 'u1']]),
    );

    // 'member m1 changed their photo' is unactionable; '@someone' is not.
    expect(entry?.description).toContain('<@u1>');
  });

  it('falls back to the raw Meetup id when no link exists', () => {
    const entry = formatIdentityDigest(
      [change({ platform: 'meetup', subjectId: 'm1', field: 'photo' })],
      stats,
      new Map(),
    );

    // Only 9 members are linked today, so this is the common case for now.
    expect(entry?.description).toContain('m1');
    // A missing link must never render as a broken mention.
    expect(entry?.description).not.toContain('<@undefined>');
  });

  it('shows a Meetup member by name, linked to their Meetup profile', () => {
    const entry = formatIdentityDigest(
      [meetupChange()],
      stats,
      new Map(),
      meetupName('Jane D.'),
    );

    expect(entry?.description).toContain(
      `Meetup  [Jane D.](${PROFILE})  profile photo changed`,
    );
  });

  it('follows the Meetup name with the linked Discord mention', () => {
    const entry = formatIdentityDigest(
      [meetupChange()],
      stats,
      new Map([['279964402', '123']]),
      meetupName('Jane D.'),
    );

    expect(entry?.description).toContain(
      `Meetup  [Jane D.](${PROFILE}) (<@123>)  profile photo changed`,
    );
  });

  it('links the bare Meetup id when no name is stored', () => {
    const entry = formatIdentityDigest([meetupChange()], stats, new Map());

    expect(entry?.description).toContain(
      `Meetup  [279964402](${PROFILE})  profile photo changed`,
    );
  });

  it('links the bare Meetup id when the stored name is blank', () => {
    const entry = formatIdentityDigest(
      [meetupChange()],
      stats,
      new Map(),
      meetupName('  '),
    );

    expect(entry?.description).toContain(`[279964402](${PROFILE})`);
  });

  it('does not build a link from a Meetup id that is not numeric', () => {
    const entry = formatIdentityDigest(
      [meetupChange({ subjectId: '1) [x](https://evil.example' })],
      stats,
      new Map(),
    );

    expect(entry?.description).not.toContain('](https://evil.example');
    expect(entry?.description).not.toContain('meetup.com/members');
  });

  it('labels a Meetup name change with the current name, next to old and new', () => {
    const entry = formatIdentityDigest(
      [
        meetupChange({
          field: 'name',
          oldValue: 'Jane D.',
          newValue: 'J. Doe',
        }),
      ],
      stats,
      new Map(),
      meetupName('J. Doe'),
    );

    expect(entry?.description).toContain(
      `Meetup  [J. Doe](${PROFILE})  name "Jane D." → "J. Doe"`,
    );
  });

  it('labels a name change from the row itself when the baseline is gone', () => {
    // The baseline row is deleted when a member is forgotten; the change row
    // still carries the name, which beats a bare id.
    const entry = formatIdentityDigest(
      [
        meetupChange({
          field: 'name',
          oldValue: 'Jane D.',
          newValue: 'J. Doe',
        }),
      ],
      stats,
      new Map(),
    );

    expect(entry?.description).toContain(`[J. Doe](${PROFILE})`);
  });

  it('does not label a member with a photo id or a username', () => {
    const entry = formatIdentityDigest(
      [
        meetupChange({ field: 'photo', newValue: 'photo-hash' }),
        meetupChange({ field: 'username', oldValue: 'a', newValue: 'handle' }),
      ],
      stats,
      new Map(),
    );

    expect(entry?.description).not.toContain('[photo-hash]');
    expect(entry?.description).not.toContain('[handle]');
  });

  it('adds a plain-text name to a Discord row, keeping the mention', () => {
    const entry = formatIdentityDigest(
      [change()],
      stats,
      new Map(),
      discordName('Ngò 🌿'),
    );

    // A mention only renders for a viewer whose client has that user cached;
    // the text beside it is what keeps the row readable for everyone else.
    expect(entry?.description).toContain(
      'Discord  <@u1> (Ngò 🌿)  user avatar changed',
    );
  });

  it('renders a Discord row with the mention alone when no name is stored', () => {
    const entry = formatIdentityDigest([change()], stats, new Map());

    expect(entry?.description).toContain('Discord  <@u1>  user avatar changed');
  });

  it('does not give a Discord row the name of a Meetup member sharing its id', () => {
    const entry = formatIdentityDigest(
      [change({ subjectId: '279964402' })],
      stats,
      new Map(),
      meetupName('Jane D.'),
    );

    expect(entry?.description).not.toContain('Jane D.');
  });

  it('escapes a Meetup name that tries to close the link and open its own', () => {
    const entry = formatIdentityDigest(
      [meetupChange()],
      stats,
      new Map(),
      meetupName('Jane](https://evil.example) [x'),
    );

    expect(entry?.description).toContain(
      `[Jane\\)\\(https\\://evil.example\\) \\(x](${PROFILE})`,
    );
    // The only square brackets on the row are the two this code wrote.
    expect(entry?.description.match(/[[\]]/g)).toHaveLength(2);
  });

  it('keeps the link intact for a name containing square brackets', () => {
    const entry = formatIdentityDigest(
      [meetupChange()],
      stats,
      new Map(),
      meetupName('Jane [she/her]'),
    );

    expect(entry?.description).toContain(`[Jane \\(she/her\\)](${PROFILE})`);
  });

  it('falls back to the id for a Meetup name made only of invisible characters', () => {
    const entry = formatIdentityDigest(
      [meetupChange()],
      stats,
      new Map(),
      meetupName('\u200B\u3164'),
    );

    expect(entry?.description).toContain(`[279964402](${PROFILE})`);
    expect(entry?.description).not.toContain('[](');
  });

  it('shows the mention alone for a Discord name made only of invisible characters', () => {
    const entry = formatIdentityDigest(
      [change()],
      stats,
      new Map(),
      discordName('\u200B\u2060'),
    );

    expect(entry?.description).toContain('Discord  <@u1>  user avatar changed');
    expect(entry?.description).not.toContain('()');
  });

  const NOTE = '(differs only in invisible characters or spacing)';
  const rename = (oldValue: string, newValue: string) =>
    formatIdentityDigest(
      [change({ field: 'nickname', oldValue, newValue })],
      stats,
      new Map(),
    )?.description;

  it('says so when a change is only a zero-width character', () => {
    // Otherwise the row reads "Bob" -> "Bob": the edit an impersonator would
    // make is the one the digest would render as nothing having happened.
    expect(rename('Bob', 'Bo\u200Bb')).toContain(`"Bob" → "Bob" ${NOTE}`);
  });

  it('says so when a change is only a bidi override', () => {
    expect(rename('Bob', '\u202EBob')).toContain(NOTE);
  });

  it('says so when a change is only a joiner between letters', () => {
    expect(rename('Bob', 'Bo\u200Db')).toContain(NOTE);
  });

  it('says so when a change is only spacing', () => {
    expect(rename('Bob Lee', 'Bob  Lee ')).toContain(NOTE);
  });

  it('adds no note to a visible change', () => {
    expect(rename('Bob', 'B0b')).not.toContain(NOTE);
  });

  it('adds no note when a value was set or cleared', () => {
    const entry = formatIdentityDigest(
      [change({ field: 'nickname', oldValue: null, newValue: '\u200B' })],
      stats,
      new Map(),
    );

    expect(entry?.description).not.toContain(NOTE);
  });

  it('defuses mentions in a name', () => {
    const entry = formatIdentityDigest(
      [meetupChange()],
      stats,
      new Map(),
      meetupName('@everyone <@&555> <@999>'),
    );

    expect(entry?.description).not.toMatch(/(?<!\\)@everyone/);
    expect(entry?.description).not.toContain('<@&555>');
    expect(entry?.description).not.toContain('<@999>');
  });

  it('keeps a name with a newline on one row', () => {
    const entry = formatIdentityDigest(
      [meetupChange()],
      stats,
      new Map(),
      meetupName('Jane\n09:00  Discord  <@1>  user avatar changed'),
    );

    const rows = entry?.description.split('\n\n')[0].split('\n');
    expect(rows).toHaveLength(1);
  });

  it('escapes markdown in a Discord name', () => {
    const entry = formatIdentityDigest(
      [change()],
      stats,
      new Map(),
      discordName('**bold** `code` ) <@&555>'),
    );

    expect(entry?.description).toContain(
      '<@u1> (\\*\\*bold\\*\\* \\`code\\` \\) \\<\\@&555\\>)',
    );
  });

  it('escapes the old and new values of a text change', () => {
    const entry = formatIdentityDigest(
      [
        change({
          field: 'nickname',
          oldValue: '<@&555>',
          newValue: 'x\n@everyone [a](https://evil.example)',
        }),
      ],
      stats,
      new Map(),
    );

    expect(entry?.description).toContain(
      'nickname "\\<\\@&555\\>" → "x \\@everyone \\[a\\]\\(https\\://evil.example\\)"',
    );
  });

  it('still shows a dash for an absent old or new value', () => {
    const entry = formatIdentityDigest(
      [change({ field: 'nickname', oldValue: null, newValue: 'Nick' })],
      stats,
      new Map(),
    );

    expect(entry?.description).toContain('nickname "—" → "Nick"');
  });

  it('stays inside the embed limit when every row carries a long name and link', () => {
    const names = new Map<string, string>();
    const many = Array.from({ length: 300 }, (_, i) => {
      const subjectId = String(100000000 + i);
      names.set(identityNameKey('meetup', 'grp', subjectId), '*'.repeat(500));
      return meetupChange({ id: String(i), subjectId });
    });

    const entry = formatIdentityDigest(
      many,
      stats,
      new Map(many.map((c) => [c.subjectId, `9${c.subjectId}`])),
      names,
    );

    expect(entry?.description.length).toBeLessThanOrEqual(4096);
    expect(entry?.description).toContain(
      'run /meetup_identity_report for the full list',
    );
    expect(entry?.description).toContain('Storage:');
    // Truncated on a row boundary: every row shown is complete.
    const rows = entry?.description.split('\n\n')[0].split('\n') ?? [];
    rows
      .filter((row) => !row.startsWith('…and'))
      .forEach((row) => expect(row).toMatch(/profile photo changed$/));
    const shown = rows.filter((row) => !row.startsWith('…and')).length;
    expect(entry?.description).toContain(`…and ${300 - shown} more`);
  });

  it('bounds a single row no matter how long its name and values are', () => {
    const entry = formatIdentityDigest(
      [
        meetupChange({
          field: 'name',
          oldValue: 'a'.repeat(5000),
          newValue: 'b'.repeat(5000),
        }),
      ],
      stats,
      new Map(),
      meetupName('c'.repeat(5000)),
    );

    // An unbounded row would not fit, be dropped, and leave a digest that
    // reports "1 change" and shows none.
    expect(entry?.description).toContain(PROFILE);
    expect(entry?.description.length).toBeLessThan(600);
  });
});

describe('identityDigestWindow', () => {
  it('anchors both ends to the digest hour, not to the run time', () => {
    // Run time deliberately not on the hour: a `now - 24h` window would start
    // at 18:41 yesterday, so anything between yesterday's run and this one
    // falls into neither digest -- or, if a run slips earlier, into both.
    const { since, until } = identityDigestWindow(
      new Date(Date.UTC(2026, 7, 16, IDENTITY_DIGEST_UTC_HOUR, 41, 7)),
    );

    expect(until.toISOString()).toBe(
      `2026-08-16T${String(IDENTITY_DIGEST_UTC_HOUR).padStart(2, '0')}:00:00.000Z`,
    );
    expect(since.toISOString()).toBe(
      `2026-08-15T${String(IDENTITY_DIGEST_UTC_HOUR).padStart(2, '0')}:00:00.000Z`,
    );
  });

  it('makes consecutive days exactly contiguous', () => {
    const day1 = identityDigestWindow(
      new Date(Date.UTC(2026, 7, 16, IDENTITY_DIGEST_UTC_HOUR, 3)),
    );
    const day2 = identityDigestWindow(
      new Date(Date.UTC(2026, 7, 17, IDENTITY_DIGEST_UTC_HOUR, 55)),
    );

    // No gap and no overlap: every change lands in exactly one digest.
    expect(day2.since.getTime()).toBe(day1.until.getTime());
  });
});

describe('runIdentityDigestOnce', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(
      new Date(Date.UTC(2026, 7, 16, IDENTITY_DIGEST_UTC_HOUR, 5)),
    );
    cache.exclusive_set.mockResolvedValue(true);
    cache.get.mockResolvedValue(undefined);
    cache.set.mockResolvedValue(undefined);
    cache.remove.mockResolvedValue(undefined);
    repo.getDigestCursor.mockResolvedValue('100');
    repo.changeIdBefore.mockResolvedValue('0');
    repo.maxChangeId.mockResolvedValue('140');
    repo.setDigestCursor.mockResolvedValue(undefined);
    repo.listChangesMetadataAfterId.mockResolvedValue([change()]);
    repo.storageStats.mockResolvedValue(stats);
    repo.listIdentityNames.mockResolvedValue(new Map());
    memberRepo.listAll.mockResolvedValue([]);
    vi.mocked(logAlert).mockResolvedValue(true);
    vi.mocked(runIdentitySweep).mockResolvedValue({ scanned: 0, changed: 0 });
    vi.mocked(runMeetupSweep).mockResolvedValue({ scanned: 0, changed: 0 });
    banFill.open.mockResolvedValue(banFill.bans);
    banFill.bans.listPhotoFillCandidates.mockResolvedValue([]);
    banFill.bans.fillProfilePhoto.mockResolvedValue(true);
  });
  afterEach(() => vi.useRealTimers());

  const identityPosted = () =>
    vi
      .mocked(logAlert)
      .mock.calls.some(([, entry]) =>
        entry.title.startsWith('Identity changes'),
      );

  it('the ban fill runs after both sweeps and before the ceiling is read', async () => {
    const roster = [
      { id: '1', name: null, username: null, memberPhoto: null },
    ] as MeetupGroupMember[];
    vi.mocked(runMeetupSweep).mockResolvedValue({
      scanned: 1,
      changed: 0,
      roster,
    });

    await runIdentityDigestOnce(client);

    const fillAt =
      banFill.bans.listPhotoFillCandidates.mock.invocationCallOrder[0];
    expect(fillAt).toBeGreaterThan(
      vi.mocked(runIdentitySweep).mock.invocationCallOrder[0],
    );
    expect(fillAt).toBeGreaterThan(
      vi.mocked(runMeetupSweep).mock.invocationCallOrder[0],
    );
    expect(fillAt).toBeLessThan(repo.maxChangeId.mock.invocationCallOrder[0]);
    expect(defaultBanPhotoFillDeps).toHaveBeenCalledWith(client);
    expect(vi.mocked(runBanPhotoFillSafely).mock.calls[0][1]).toBe(roster);
  });

  it('a failing Meetup sweep still runs the fill with no roster', async () => {
    vi.mocked(runMeetupSweep).mockRejectedValue(new Error('meetup api down'));

    await runIdentityDigestOnce(client);

    expect(runBanPhotoFillSafely).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runBanPhotoFillSafely).mock.calls[0][1]).toBeUndefined();
    expect(banFill.bans.listPhotoFillCandidates).toHaveBeenCalled();
  });

  it('a fill that throws or hangs does not stop the digest post', async () => {
    banFill.open.mockRejectedValue(new Error('db down'));
    await runIdentityDigestOnce(client);
    expect(identityPosted()).toBe(true);

    vi.clearAllMocks();
    vi.mocked(logAlert).mockResolvedValue(true);
    vi.mocked(defaultBanPhotoFillDeps).mockImplementationOnce(() => {
      throw new Error('no pool');
    });
    await runIdentityDigestOnce(client);
    expect(identityPosted()).toBe(true);

    vi.clearAllMocks();
    vi.mocked(logAlert).mockResolvedValue(true);
    banFill.open.mockImplementation(() => new Promise(() => undefined));
    const run = runIdentityDigestOnce(client);
    await vi.advanceTimersByTimeAsync(BAN_FILL_DEADLINE_MS);
    await run;
    expect(identityPosted()).toBe(true);
    expect(cache.set).toHaveBeenCalledWith(
      'identity-digest-done-2026-08-16',
      '1',
      expect.any(Number),
    );
  });

  it('names the members in the digest from the stored baselines', async () => {
    const rows = [meetupChange(), change()];
    repo.listChangesMetadataAfterId.mockResolvedValue(rows);
    repo.listIdentityNames.mockResolvedValue(
      new Map([...meetupName('Jane D.'), ...discordName('George')]),
    );

    await runIdentityDigestOnce(client);

    expect(repo.listIdentityNames).toHaveBeenCalledWith(rows);
    const [, entry] = vi.mocked(logAlert).mock.calls[0];
    expect(entry.description).toContain(`[Jane D.](${PROFILE})`);
    expect(entry.description).toContain('<@u1> (George)');
  });

  it('still posts the digest, with ids, when the name lookup fails', async () => {
    repo.listChangesMetadataAfterId.mockResolvedValue([meetupChange()]);
    repo.listIdentityNames.mockRejectedValue(new Error('pool exhausted'));

    await runIdentityDigestOnce(client);

    // Names are decoration. Losing them must not cost the day's evidence.
    const [, entry] = vi.mocked(logAlert).mock.calls[0];
    expect(entry.description).toContain(`[279964402](${PROFILE})`);
    expect(repo.setDigestCursor).toHaveBeenCalled();
    // Exactly one post: the failure neither drops the digest nor adds an
    // alert of its own. And the day is finished, so no later tick re-runs it.
    expect(vi.mocked(logAlert)).toHaveBeenCalledTimes(1);
    expect(cache.set).toHaveBeenCalledWith(
      'identity-digest-done-2026-08-16',
      '1',
      expect.any(Number),
    );
  });

  it('looks up names only for rows that could be shown', async () => {
    const rows = Array.from({ length: 300 }, (_, i) =>
      meetupChange({ id: String(i), subjectId: String(100000000 + i) }),
    );
    repo.listChangesMetadataAfterId.mockResolvedValue(rows);

    await runIdentityDigestOnce(client);

    // The embed fits a few dozen rows; resolving names for up to
    // DIGEST_PAGE_LIMIT of them would be thousands of wasted lookups.
    const [subjects] = repo.listIdentityNames.mock.calls[0] as [unknown[]];
    expect(subjects).toEqual(rows.slice(0, 200));
  });

  const client = {} as Client;

  it('claims the day before running the sweep', async () => {
    await runIdentityDigestOnce(client);

    // Sweeping first means every dyno restart during the digest hour pays for
    // a redundant full 2,008-member pass that is then discarded at the claim.
    expect(cache.exclusive_set.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(runIdentitySweep).mock.invocationCallOrder[0],
    );
  });

  it('does no work at all when another dyno already claimed the day', async () => {
    cache.exclusive_set.mockResolvedValue(false);

    await runIdentityDigestOnce(client);

    expect(runIdentitySweep).not.toHaveBeenCalled();
    expect(runMeetupSweep).not.toHaveBeenCalled();
    expect(logAlert).not.toHaveBeenCalled();
  });

  it('runs the Meetup sweep after the Discord sweep, in the same claim', async () => {
    await runIdentityDigestOnce(client);

    // Both sweeps must land inside the try, after the Discord sweep, before
    // `until` is computed -- so a failure in either releases the claim, and
    // both sweeps' findings can reach today's digest.
    expect(
      vi.mocked(runIdentitySweep).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(runMeetupSweep).mock.invocationCallOrder[0]);
    expect(runMeetupSweep).toHaveBeenCalledWith('sweep', client);
  });

  it('still posts the digest when the Meetup sweep throws', async () => {
    vi.mocked(runMeetupSweep).mockRejectedValue(new Error('meetup api down'));

    await runIdentityDigestOnce(client);

    // A reconciliation failure must DEGRADE the digest, not cancel it. The
    // old behaviour let one 502 on one roster page propagate out, release the
    // claim, and get swallowed by the scheduler -- no digest for either
    // platform, no alert, and no later report, because the reporting window
    // only moves forward.
    const titles = vi
      .mocked(logAlert)
      .mock.calls.map(([, entry]) => entry.title);
    expect(titles).toContain('Meetup identity sweep failed');
    expect(titles.some((title) => title.startsWith('Identity changes'))).toBe(
      true,
    );
  });

  it('still posts the digest when the Discord sweep throws', async () => {
    vi.mocked(runIdentitySweep).mockRejectedValue(new Error('discord down'));

    await runIdentityDigestOnce(client);

    const titles = vi
      .mocked(logAlert)
      .mock.calls.map(([, entry]) => entry.title);
    expect(titles).toContain('Discord identity sweep failed');
    expect(titles.some((title) => title.startsWith('Identity changes'))).toBe(
      true,
    );
  });

  it('runs the Meetup sweep even after the Discord sweep threw', async () => {
    vi.mocked(runIdentitySweep).mockRejectedValue(new Error('discord down'));

    await runIdentityDigestOnce(client);

    // Independently guarded, not one shared try: the first platform failing
    // must not skip the second platform's reconciliation.
    expect(runMeetupSweep).toHaveBeenCalledTimes(1);
  });

  it('names which sweep failed and says the rest is unaffected', async () => {
    vi.mocked(runMeetupSweep).mockRejectedValue(new Error('meetup api down'));

    await runIdentityDigestOnce(client);

    const failure = vi
      .mocked(logAlert)
      .mock.calls.map(([, entry]) => entry)
      .find((entry) => entry.title === 'Meetup identity sweep failed');
    expect(failure?.description).toContain('unaffected');
  });

  it('keeps a raw upstream error body out of the sweep-failure alert', async () => {
    vi.mocked(runMeetupSweep).mockRejectedValue(
      new Error('502: {"token":"do-not-leak"}'),
    );

    await runIdentityDigestOnce(client);

    // graphql-request's ClientError embeds the whole upstream response. Only
    // errors this codebase composes itself are quoted verbatim; everything
    // else is reduced to its class name.
    const failure = vi
      .mocked(logAlert)
      .mock.calls.map(([, entry]) => entry)
      .find((entry) => entry.title === 'Meetup identity sweep failed');
    expect(failure?.description).not.toContain('do-not-leak');
    expect(failure?.description).toContain('Error');
  });

  it('quotes the message of an error it composed itself', async () => {
    const actionable = Object.assign(
      new Error('the organizer token cannot read this group'),
      { organizerSafeMessage: true },
    );
    vi.mocked(runMeetupSweep).mockRejectedValue(actionable);

    await runIdentityDigestOnce(client);

    // The whole value of the named errors is that they name the remedy;
    // reducing them to "Error" too would throw that away.
    const failure = vi
      .mocked(logAlert)
      .mock.calls.map(([, entry]) => entry)
      .find((entry) => entry.title === 'Meetup identity sweep failed');
    expect(failure?.description).toContain('cannot read this group');
  });

  it('resolves a Meetup change to its linked Discord member in the digest', async () => {
    repo.listChangesMetadataAfterId.mockResolvedValue([
      change({ platform: 'meetup', subjectId: 'm1', field: 'photo' }),
    ]);
    memberRepo.listAll.mockResolvedValue([
      { discordUserId: 'u1', meetupId: 'm1' },
    ]);

    await runIdentityDigestOnce(client);

    const [, entry] = vi.mocked(logAlert).mock.calls[0];
    expect(entry.description).toContain('<@u1>');
  });

  it('reads from the stored high-water mark, not from a time window', async () => {
    await runIdentityDigestOnce(client);

    const [afterId] = repo.listChangesMetadataAfterId.mock.calls[0] as string[];
    expect(afterId).toBe('100');
  });

  it('does not report a change that a previous digest already reported', async () => {
    // The bug this replaces: `since` was pinned to the fixed digest hour while
    // `until` ran on to whenever the sweeps finished, so the span
    // [boundary, sweep-finish] belonged to two consecutive digests. Meetup
    // rows are 100% sweep-detected and land exactly there, so every Meetup
    // change was reported twice. An id mark has no such overlap.
    const log = [
      change({ id: '100', subjectId: 'yesterday' }),
      change({ id: '101', subjectId: 'today' }),
    ];
    repo.listChangesMetadataAfterId.mockImplementation(
      async (afterId: string, throughId: string) =>
        log.filter(
          (row) =>
            Number(row.id) > Number(afterId) &&
            Number(row.id) <= Number(throughId),
        ),
    );
    repo.maxChangeId.mockResolvedValue('101');

    await runIdentityDigestOnce(client);

    const [, entry] = vi.mocked(logAlert).mock.calls[0];
    expect(entry.description).toContain('today');
    expect(entry.description).not.toContain('yesterday');
  });

  it('leaves no gap: the next run starts exactly where this one stopped', async () => {
    // Not truncated (fewer rows than DIGEST_PAGE_LIMIT), so the last row
    // returned and the ceiling that was actually read coincide.
    repo.listChangesMetadataAfterId.mockResolvedValue([change({ id: '140' })]);

    await runIdentityDigestOnce(client);

    // Consecutive coverage is (mark, ceiling] then (ceiling, next-ceiling].
    // Storing anything other than the id of the last row actually read opens
    // either a gap or an overlap.
    const stored = repo.setDigestCursor.mock.calls[0][0] as string;
    const [, through] = repo.listChangesMetadataAfterId.mock
      .calls[0] as string[];
    expect(stored).toBe(through);
  });

  it('advances the mark only to the last row returned, not the full ceiling, when the page is capped', async () => {
    // A full page (exactly DIGEST_PAGE_LIMIT rows) means the query stopped
    // short of the ceiling; the ceiling itself is far above what was read.
    const rows = Array.from({ length: DIGEST_PAGE_LIMIT }, (_, i) =>
      change({ id: String(i + 1) }),
    );
    repo.listChangesMetadataAfterId.mockResolvedValue(rows);
    repo.maxChangeId.mockResolvedValue('999999');

    await runIdentityDigestOnce(client);

    // Advancing to the pre-computed ceiling instead of the last row actually
    // read would skip every row between them forever, since the mark only
    // moves forward.
    expect(repo.setDigestCursor).toHaveBeenCalledWith(
      String(DIGEST_PAGE_LIMIT),
    );
    expect(repo.setDigestCursor).not.toHaveBeenCalledWith('999999');
  });

  it('captures rows the sweeps themselves wrote', async () => {
    // The ceiling has to be read AFTER the sweeps, or the sweeps' own
    // findings -- the changes least likely to have been caught any other way
    // -- would sit above it and wait a full day.
    await runIdentityDigestOnce(client);

    expect(repo.maxChangeId.mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(runMeetupSweep).mock.invocationCallOrder[0],
    );
  });

  it('does not skip a change recorded while the digest was being built', async () => {
    // A gateway event landing between the read and the mark being stored must
    // not be swallowed. Advancing to a ceiling fixed before the read means
    // anything later simply waits for tomorrow -- and the mark advances only
    // to the last row actually read (id 140), never to the post-read max
    // (999) that the mid-digest event bumped maxChangeId to.
    repo.maxChangeId.mockResolvedValue('140');
    repo.listChangesMetadataAfterId.mockImplementation(async () => {
      repo.maxChangeId.mockResolvedValue('999'); // an event lands mid-digest
      return [change({ id: '140' })];
    });

    await runIdentityDigestOnce(client);

    expect(repo.setDigestCursor).toHaveBeenCalledWith('140');
    expect(repo.setDigestCursor).not.toHaveBeenCalledWith('999');
  });

  it('falls back to the hour boundary on the very first run', async () => {
    repo.getDigestCursor.mockResolvedValue(undefined);
    repo.changeIdBefore.mockResolvedValue('57');

    await runIdentityDigestOnce(client);

    // With no mark and no fallback the first digest after deploy would report
    // the entire backfill -- thousands of rows -- as today's news.
    const [boundary] = repo.changeIdBefore.mock.calls[0] as Date[];
    expect(boundary.getUTCMinutes()).toBe(0);
    expect(boundary.getUTCHours()).toBe(IDENTITY_DIGEST_UTC_HOUR);
    const [afterId] = repo.listChangesMetadataAfterId.mock.calls[0] as string[];
    expect(afterId).toBe('57');
  });

  it('does not advance the mark when the post did not land', async () => {
    vi.mocked(logAlert).mockResolvedValue(false);

    await expect(runIdentityDigestOnce(client)).rejects.toThrow();

    // Advancing on an undelivered digest loses those rows permanently: the
    // next run starts above them and no later digest ever looks back.
    expect(repo.setDigestCursor).not.toHaveBeenCalled();
  });

  it('titles the digest with the range of the rows it actually contains', async () => {
    repo.listChangesMetadataAfterId.mockResolvedValue([
      change({ id: '101', detectedAt: at('2026-08-16T02:15:00Z') }),
      change({ id: '102', detectedAt: at('2026-08-16T17:45:00Z') }),
    ]);

    await runIdentityDigestOnce(client);

    // The digest no longer selects by time, so quoting a notional 24h window
    // would describe something other than what was queried.
    const [, entry] = vi.mocked(logAlert).mock.calls[0];
    expect(entry.title).toContain('2026-08-16 02:15');
    expect(entry.title).toContain('2026-08-16 17:45');
  });

  it('posts nothing and stores nothing when the change log is empty', async () => {
    repo.maxChangeId.mockResolvedValue(undefined);

    await runIdentityDigestOnce(client);

    expect(logAlert).not.toHaveBeenCalled();
    expect(repo.setDigestCursor).not.toHaveBeenCalled();
  });

  it('keeps the claim when the digest posts successfully', async () => {
    await runIdentityDigestOnce(client);

    expect(logAlert).toHaveBeenCalledTimes(1);
    expect(cache.remove).not.toHaveBeenCalled();
  });

  it('marks the day done once the digest has posted', async () => {
    await runIdentityDigestOnce(client);

    // Completion is a separate fact from "someone is working on this". Only
    // this marker makes a finished day un-repeatable; the claim is a lease.
    expect(cache.set).toHaveBeenCalledWith(
      'identity-digest-done-2026-08-16',
      '1',
      expect.any(Number),
    );
  });

  it('does no work at all when the day is already done', async () => {
    cache.get.mockResolvedValue('1');

    await runIdentityDigestOnce(client);

    // Checked BEFORE the claim: with ticks now arriving four times an hour, a
    // finished day would otherwise be re-swept and re-posted the moment the
    // lease expired.
    expect(cache.exclusive_set).not.toHaveBeenCalled();
    expect(runIdentitySweep).not.toHaveBeenCalled();
    expect(runMeetupSweep).not.toHaveBeenCalled();
    expect(logAlert).not.toHaveBeenCalled();
  });

  it('checks the done marker before attempting the claim', async () => {
    await runIdentityDigestOnce(client);

    expect(cache.get.mock.invocationCallOrder[0]).toBeLessThan(
      cache.exclusive_set.mock.invocationCallOrder[0],
    );
  });

  it('takes the claim as a short lease, not for the rest of the day', async () => {
    await runIdentityDigestOnce(client);

    // SIGTERM does not throw, so a killed run releases nothing. The lease
    // expiring is the only thing that lets a later tick pick the day back up;
    // a day-long claim means a deploy at 18:05 silently costs the whole day.
    const [, , ttl] = cache.exclusive_set.mock.calls[0] as [
      string,
      string,
      number,
    ];
    expect(ttl).toBeLessThanOrEqual(30 * 60);
    expect(ttl).toBeGreaterThan(0);
  });

  it('does not mark the day done when the post did not land', async () => {
    vi.mocked(logAlert).mockResolvedValue(false);

    await expect(runIdentityDigestOnce(client)).rejects.toThrow();

    // The done marker is what makes a day un-retryable. Writing it on a run
    // that failed to post would consume the day exactly as the old
    // never-released claim did.
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('does not mark the day done when the digest query failed', async () => {
    repo.listChangesMetadataAfterId.mockRejectedValue(new Error('db down'));

    await expect(runIdentityDigestOnce(client)).rejects.toThrow('db down');

    expect(cache.set).not.toHaveBeenCalled();
  });

  it('releases the claim when the post did not land', async () => {
    vi.mocked(logAlert).mockResolvedValue(false);

    // logAlert swallows every error, so without checking its result a Discord
    // outage yields: claim consumed, success logged, no digest, no retry.
    await expect(runIdentityDigestOnce(client)).rejects.toThrow();
    expect(cache.remove).toHaveBeenCalledWith('identity-digest-2026-08-16');
  });

  it('releases the claim when the digest query itself fails', async () => {
    // Not a sweep failure -- those degrade now. This is the digest proper
    // failing, which still has to release the day so a restart retries.
    repo.listChangesMetadataAfterId.mockRejectedValue(new Error('db down'));

    await expect(runIdentityDigestOnce(client)).rejects.toThrow('db down');
    expect(cache.remove).toHaveBeenCalledWith('identity-digest-2026-08-16');
  });

  it('surfaces the original error, not a claim-release failure', async () => {
    repo.listChangesMetadataAfterId.mockRejectedValue(new Error('db down'));
    cache.remove.mockRejectedValue(new Error('cache unavailable'));

    // A cache outage during release must not mask the real cause, and the
    // claim staying consumed either way should not turn into the wrong error.
    await expect(runIdentityDigestOnce(client)).rejects.toThrow('db down');
  });

  it('keeps the claim on a silent day, where nothing is posted', async () => {
    repo.listChangesMetadataAfterId.mockResolvedValue([]);

    await runIdentityDigestOnce(client);

    expect(logAlert).not.toHaveBeenCalled();
    expect(cache.remove).not.toHaveBeenCalled();
  });

  it('marks a silent day done so its sweeps are not repeated', async () => {
    repo.listChangesMetadataAfterId.mockResolvedValue([]);

    await runIdentityDigestOnce(client);

    // Nothing was posted, but the work was done. Re-running two full roster
    // passes to rediscover that nothing changed is pure waste.
    expect(cache.set).toHaveBeenCalledWith(
      'identity-digest-done-2026-08-16',
      '1',
      expect.any(Number),
    );
  });

  it('lets a later tick retry after a failed run released the lease', async () => {
    repo.listChangesMetadataAfterId.mockRejectedValueOnce(
      new Error('transient db blip'),
    );

    await expect(runIdentityDigestOnce(client)).rejects.toThrow();
    expect(cache.remove).toHaveBeenCalledWith('identity-digest-2026-08-16');

    // Second tick, same hour: the lease is gone and the day is not marked
    // done, so the run happens again and this time posts.
    vi.clearAllMocks();
    cache.exclusive_set.mockResolvedValue(true);
    cache.get.mockResolvedValue(undefined);
    repo.listChangesMetadataAfterId.mockResolvedValue([change()]);
    repo.storageStats.mockResolvedValue(stats);
    memberRepo.listAll.mockResolvedValue([]);
    vi.mocked(logAlert).mockResolvedValue(true);
    vi.mocked(runIdentitySweep).mockResolvedValue({ scanned: 0, changed: 0 });
    vi.mocked(runMeetupSweep).mockResolvedValue({ scanned: 0, changed: 0 });

    await runIdentityDigestOnce(client);

    expect(logAlert).toHaveBeenCalledTimes(1);
  });
});

describe('digest exports', () => {
  it('safeErrorSummary shows organizer-safe messages and only the name of anything else', () => {
    const safe = Object.assign(new Error('Meetup group is unreadable'), {
      organizerSafeMessage: true,
    });
    expect(safeErrorSummary(safe)).toBe('Meetup group is unreadable');

    // A graphql-request ClientError embeds the raw response body in its message.
    const clientErrorLike = new Error('GraphQL Error: RAW-BODY {"secret":1}');
    const summary = safeErrorSummary(clientErrorLike);
    expect(summary).toBe('Error (details in the process log)');
    expect(summary).not.toContain('RAW-BODY');

    expect(safeErrorSummary('RAW-BODY')).toBe(
      'unknown error (details in the process log)',
    );
  });

  it('the digest claim and done keys are built by the exported helpers', () => {
    expect(identityDigestClaimKey('2026-08-16')).toBe(
      'identity-digest-2026-08-16',
    );
    expect(identityDigestDoneKey('2026-08-16')).toBe(
      'identity-digest-done-2026-08-16',
    );
  });
});
