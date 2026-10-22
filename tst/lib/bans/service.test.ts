import { afterEach, describe, expect, it, vi } from 'vitest';

import { BanRow } from '../../../src/lib/bans/types.js';
import {
  BANNED_TAB_URL,
  BanServiceDeps,
  banEntry,
  checkBanPhoto,
  decodePhotoField,
  importBans,
  liftBan,
  recordBan,
  uploadBanPhoto,
} from '../../../src/lib/bans/service.js';

const LEAD = '223456789012345678';
const NOW = new Date('2026-10-22T18:00:00Z');

function ban(overrides: Partial<BanRow> = {}): BanRow {
  return {
    id: 7,
    memberId: '424242',
    memberName: 'Ann',
    bannedOn: '2026-10-01',
    notes: '',
    recordedBy: LEAD,
    createdAt: NOW,
    hasPhoto: false,
    photoSource: null,
    photoUpdatedAt: null,
    photoUpdatedBy: null,
    liftedAt: null,
    liftedBy: null,
    liftReason: null,
    ...overrides,
  };
}

function fakeDeps(leader: boolean | Error = true) {
  const repo = {
    record: vi.fn(async () => ({ ok: true as const, ban: ban() })),
    importMany: vi.fn(async (inputs: unknown[]) => ({
      ok: true as const,
      count: inputs.length,
    })),
    lift: vi.fn(async () =>
      ban({ liftedAt: NOW, liftedBy: LEAD, liftReason: 'r' }),
    ),
    setUploadedPhoto: vi.fn(async () => ({
      ban: ban({ hasPhoto: true }),
      replaced: false,
    })),
  };
  const deps = {
    now: () => NOW,
    repository: vi.fn(async () => repo),
    moderationLog: vi.fn(async () => true),
    isLeadership: vi.fn(async () => {
      if (leader instanceof Error) throw leader;
      return leader;
    }),
  } satisfies BanServiceDeps;
  return { deps, repo };
}

/** Lets fire-and-forget posts settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const recordInput = (overrides: Record<string, unknown> = {}) => ({
  actor: LEAD,
  memberId: '424242',
  memberName: 'Ann',
  bannedOn: '2026-10-01',
  notes: 'Harassed members',
  ...overrides,
});

// Image vectors as in tst/lib/helpers/imageBytes.test.ts.
function riff(fourCC: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(20);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(12 + payload.length, 4);
  head.write('WEBP', 8, 'latin1');
  head.write(fourCC, 12, 'latin1');
  head.writeUInt32LE(payload.length, 16);
  return Buffer.concat([head, payload]);
}
function vp8(width: number, height: number): Buffer {
  const payload = Buffer.alloc(10);
  Buffer.from([0x9d, 0x01, 0x2a]).copy(payload, 3);
  payload.writeUInt16LE(width, 6);
  payload.writeUInt16LE(height, 8);
  return riff('VP8 ', payload);
}
const segment = (marker: number, payload: Buffer) => {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
};
function jpeg(width: number, height: number, ...extra: Buffer[]): Buffer {
  const sof = Buffer.alloc(15);
  sof[0] = 8;
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = 3;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0')),
    ...extra,
    segment(0xc0, sof),
    Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0]),
    Buffer.from('scan'),
    Buffer.from([0xff, 0xd9]),
  ]);
}
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recordBan', () => {
  it('validates before the gate and the gate before the repository', async () => {
    for (const memberId of ['12a4', '+123', '١٢٣', '1'.repeat(21), 7]) {
      const { deps, repo } = fakeDeps();
      // eslint-disable-next-line no-await-in-loop
      expect(await recordBan(deps, recordInput({ memberId }))).toEqual({
        code: 'bad-member-id',
      });
      expect(deps.isLeadership).not.toHaveBeenCalled();
      expect(repo.record).not.toHaveBeenCalled();
    }
    const cases: [Record<string, unknown>, string][] = [
      [{ bannedOn: '2026-02-30' }, 'bad-date'],
      [{ bannedOn: '2026-10-23' }, 'bad-date'],
      [{ bannedOn: '2013-02-28' }, 'bad-date'],
      [{ memberName: 'n'.repeat(501) }, 'name-too-long'],
      [{ notes: 'x'.repeat(2001) }, 'notes-too-long'],
      [{ actor: 'not-an-id' }, 'invalid'],
      [{ memberName: ['a'] }, 'invalid'],
    ];
    for (const [overrides, code] of cases) {
      const { deps, repo } = fakeDeps();
      // eslint-disable-next-line no-await-in-loop
      expect(await recordBan(deps, recordInput(overrides))).toEqual({ code });
      expect(deps.isLeadership).not.toHaveBeenCalled();
      expect(repo.record).not.toHaveBeenCalled();
    }

    const moderator = fakeDeps(false);
    expect(await recordBan(moderator.deps, recordInput())).toEqual({
      code: 'not-leadership',
    });
    expect(moderator.deps.repository).not.toHaveBeenCalled();
    expect(moderator.repo.record).not.toHaveBeenCalled();

    const down = fakeDeps(new Error('discord down'));
    expect(await recordBan(down.deps, recordInput())).toEqual({
      code: 'leadership-unavailable',
    });
    expect(down.repo.record).not.toHaveBeenCalled();
    await settle();
    expect(moderator.deps.moderationLog).not.toHaveBeenCalled();
    expect(down.deps.moderationLog).not.toHaveBeenCalled();

    const confirmed = fakeDeps(false);
    expect(
      await recordBan(
        confirmed.deps,
        recordInput({ leadershipConfirmed: true, bannedOn: '' }),
      ),
    ).toEqual({ code: 'recorded' });
    expect(confirmed.deps.isLeadership).not.toHaveBeenCalled();
    expect(confirmed.repo.record).toHaveBeenCalledWith({
      memberId: '424242',
      memberName: 'Ann',
      bannedOn: null,
      notes: 'Harassed members',
      recordedBy: LEAD,
    });
  });

  it('trims the member id, name and notes and turns CRLF into LF', async () => {
    const { deps, repo } = fakeDeps();
    await recordBan(
      deps,
      recordInput({
        memberId: ' 424242 ',
        memberName: ' Ann ',
        notes: ' one\r\ntwo ',
      }),
    );
    expect(repo.record).toHaveBeenCalledWith(
      expect.objectContaining({
        memberId: '424242',
        memberName: 'Ann',
        notes: 'one\ntwo',
      }),
    );
  });

  it('maps already-banned and posts nothing on a refusal', async () => {
    const { deps, repo } = fakeDeps();
    repo.record.mockResolvedValueOnce({
      ok: false,
      reason: 'already-banned',
    } as never);
    expect(await recordBan(deps, recordInput())).toEqual({
      code: 'already-banned',
    });
    await settle();
    expect(deps.moderationLog).not.toHaveBeenCalled();
  });

  it('posts one Ban recorded embed with no content, no photo and the Banned tab link', async () => {
    const { deps, repo } = fakeDeps();
    repo.record.mockResolvedValueOnce({
      ok: true,
      ban: ban({ memberName: '@everyone <@&1> **Ann**', notes: '@here hi' }),
    });
    expect(await recordBan(deps, recordInput())).toEqual({ code: 'recorded' });
    await settle();
    expect(deps.moderationLog).toHaveBeenCalledTimes(1);
    const [entry] = deps.moderationLog.mock.calls[0] as unknown as [
      Record<string, unknown>,
    ];
    expect(entry.title).toBe('Ban recorded');
    expect(Object.keys(entry)).not.toContain('content');
    expect(entry.description).toContain(`<@${LEAD}>`);
    expect(entry.description).toContain(`\n${BANNED_TAB_URL}`);
    expect(BANNED_TAB_URL).toBe(
      'https://meetup-discord-bot.herokuapp.com/dashboard/suspensions?state=banned',
    );
    const text = JSON.stringify(entry);
    expect(text).not.toContain('Ann');
    expect(text).not.toContain('@everyone');
    expect(text).not.toContain('@here');
    expect(text).not.toContain('<@&1>');
    expect(text).toContain('424242');
    expect(text).toContain('2026-10-01');
  });

  it('a moderation-log failure still returns the success code', async () => {
    const { deps } = fakeDeps();
    deps.moderationLog.mockRejectedValue(new Error('discord down'));
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      expect(await recordBan(deps, recordInput())).toEqual({
        code: 'recorded',
      });
      await settle();
      await settle();
      expect(deps.moderationLog).toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('importBans', () => {
  const header = 'member_id,member_name,banned_on,notes';

  it('returns import-refused with row numbers and never calls importMany on a parse error', async () => {
    const { deps, repo } = fakeDeps();
    const result = await importBans(deps, {
      actor: LEAD,
      csv: `${header}\n12a4,A,,\n111,B,2026-02-30,`,
    });
    expect(result).toEqual({
      code: 'import-refused',
      errors: [
        { row: 2, code: 'member-id' },
        { row: 3, code: 'date' },
      ],
    });
    expect(deps.isLeadership).not.toHaveBeenCalled();
    expect(repo.importMany).not.toHaveBeenCalled();
    expect(await importBans(deps, { actor: LEAD, csv: 5 })).toEqual({
      code: 'invalid',
    });
  });

  it("maps importMany's already-banned index to that row's rowNumber", async () => {
    const { deps, repo } = fakeDeps();
    repo.importMany.mockResolvedValueOnce({
      ok: false,
      reason: 'already-banned',
      index: 1,
    } as never);
    const result = await importBans(deps, {
      actor: LEAD,
      csv: `${header}\n111,A,,"two\nlines"\n222,B,,`,
    });
    expect(result).toEqual({
      code: 'import-refused',
      errors: [{ row: 4, code: 'already-banned' }],
    });
    await settle();
    expect(deps.moderationLog).not.toHaveBeenCalled();
  });

  it('posts Bans imported with only the count', async () => {
    const { deps, repo } = fakeDeps();
    const result = await importBans(deps, {
      actor: LEAD,
      csv: `${header}\n987654,Secret Name,,secret note\n876543,Other Name,2026-01-01,`,
    });
    expect(result).toEqual({ code: 'imported', count: 2 });
    expect(repo.importMany).toHaveBeenCalledWith([
      {
        memberId: '987654',
        memberName: 'Secret Name',
        bannedOn: null,
        notes: 'secret note',
        recordedBy: LEAD,
      },
      {
        memberId: '876543',
        memberName: 'Other Name',
        bannedOn: '2026-01-01',
        notes: '',
        recordedBy: LEAD,
      },
    ]);
    await settle();
    const [entry] = deps.moderationLog.mock.calls[0] as unknown as [
      Record<string, unknown>,
    ];
    expect(entry.title).toBe('Bans imported');
    expect(entry.fields).toEqual([{ name: 'Count', value: '2' }]);
    const text = JSON.stringify(entry);
    for (const secret of ['987654', '876543', 'Secret', 'Other', 'note']) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain(BANNED_TAB_URL);
  });

  it('a Moderator gets not-leadership after a clean parse', async () => {
    const { deps, repo } = fakeDeps(false);
    expect(
      await importBans(deps, { actor: LEAD, csv: `${header}\n111,A,,` }),
    ).toEqual({ code: 'not-leadership' });
    expect(repo.importMany).not.toHaveBeenCalled();
  });
});

describe('liftBan', () => {
  it('requires a reason and maps an unknown or lifted ban to not-active', async () => {
    const { deps, repo } = fakeDeps();
    for (const reason of ['', '   ', undefined, 5]) {
      // eslint-disable-next-line no-await-in-loop
      const result = await liftBan(deps, { actor: LEAD, banId: 7, reason });
      expect(
        result.code === 'reason-required' || result.code === 'invalid',
      ).toBe(true);
    }
    expect(
      await liftBan(deps, { actor: LEAD, banId: 7, reason: 'r'.repeat(501) }),
    ).toEqual({ code: 'reason-too-long' });
    expect(
      await liftBan(deps, { actor: LEAD, banId: 0, reason: 'ok' }),
    ).toEqual({ code: 'invalid' });
    expect(repo.lift).not.toHaveBeenCalled();
    expect(deps.isLeadership).not.toHaveBeenCalled();

    repo.lift.mockResolvedValueOnce(undefined);
    expect(
      await liftBan(deps, { actor: LEAD, banId: 7, reason: 'appeal' }),
    ).toEqual({ code: 'not-active' });
    expect(
      await liftBan(deps, { actor: LEAD, banId: 7, reason: ' appeal\r\nok ' }),
    ).toEqual({ code: 'lifted' });
    expect(repo.lift).toHaveBeenLastCalledWith(7, LEAD, 'appeal\nok');
    await settle();
    const [entry] = deps.moderationLog.mock.calls[0] as unknown as [
      { title: string; fields: { name: string; value: string }[] },
    ];
    expect(entry.title).toBe('Ban lifted');
    expect(entry.fields.map((f) => f.name)).toContain('Reason');
  });

  it('a blank reason is reason-required', async () => {
    const { deps } = fakeDeps();
    expect(
      await liftBan(deps, { actor: LEAD, banId: 7, reason: '  ' }),
    ).toEqual({ code: 'reason-required' });
  });
});

describe('decodePhotoField', () => {
  it('accepts base64url only', () => {
    const bytes = Buffer.from([0xfb, 0xff, 0xbf, 0x01]);
    expect(decodePhotoField(bytes.toString('base64url'))).toEqual(bytes);
    for (const bad of [
      bytes.toString('base64'), // '+' and '/'
      `${bytes.toString('base64url')}==`,
      '+/8=',
      'ab cd',
      'abcd\n',
      '',
      'A'.repeat(204_801),
      'QQ=',
      'QR', // non-canonical trailing bits ('QQ' is canonical)
      'A', // a single trailing character decodes to nothing
      5,
      null,
      ['QQ'],
    ]) {
      expect(decodePhotoField(bad), String(bad).slice(0, 20)).toBeUndefined();
    }
    expect(decodePhotoField('QQ')).toEqual(Buffer.from('A'));
    expect(decodePhotoField('A'.repeat(204_800))).toHaveLength(153_600);
  });
});

describe('checkBanPhoto', () => {
  it('strips metadata and checks the caps on the stripped bytes', () => {
    const gps = segment(0xe1, Buffer.from('Exif\0\0GPS-LAT-51.5'));
    const checked = checkBanPhoto(jpeg(400, 300, gps));
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.type).toBe('image/jpeg');
    expect(checked.bytes.toString('latin1')).not.toContain('GPS-LAT');
    expect(checked.bytes).toEqual(jpeg(400, 300));
    // Over the cap only because of its metadata: accepted once stripped.
    const bulky = segment(0xe1, Buffer.alloc(60_000, 0x41));
    const big = jpeg(400, 300, bulky, bulky, bulky);
    expect(big.length).toBeGreaterThan(153_600);
    const stripped = checkBanPhoto(big);
    expect(stripped.ok && stripped.bytes.length).toBeLessThan(200);
  });

  it('refuses a PNG, HTML in a WEBP header, a 513x10 WebP and 153601 bytes', () => {
    expect(checkBanPhoto(PNG_1X1)).toEqual({
      ok: false,
      code: 'photo-not-accepted',
    });
    // A well-formed PNG with a real size is still refused for uploads.
    const png = Buffer.concat([
      PNG_1X1.subarray(0, 16),
      Buffer.from([0, 0, 0, 64, 0, 0, 0, 64]),
      PNG_1X1.subarray(24),
    ]);
    expect(checkBanPhoto(png)).toEqual({
      ok: false,
      code: 'photo-not-accepted',
    });
    const html = Buffer.concat([
      Buffer.from('RIFF\x20\x00\x00\x00WEBP', 'latin1'),
      Buffer.from('<html><script>x</script>'),
    ]);
    expect(checkBanPhoto(html)).toEqual({
      ok: false,
      code: 'photo-not-accepted',
    });
    expect(checkBanPhoto(vp8(513, 10))).toEqual({
      ok: false,
      code: 'photo-too-big',
    });
    expect(checkBanPhoto(vp8(10, 513))).toEqual({
      ok: false,
      code: 'photo-too-big',
    });
    const scan = Buffer.alloc(153_601 - jpeg(10, 10).length, 0x55);
    const huge = Buffer.concat([
      jpeg(10, 10).subarray(0, -2),
      scan,
      Buffer.from([0xff, 0xd9]),
    ]);
    expect(huge.length).toBe(153_601);
    expect(checkBanPhoto(huge)).toEqual({ ok: false, code: 'photo-too-large' });
    expect(checkBanPhoto(vp8(512, 384))).toEqual({
      ok: true,
      type: 'image/webp',
      bytes: vp8(512, 384),
    });
  });
});

describe('uploadBanPhoto', () => {
  it('Review Focus 1: refuses forged photos without calling setUploadedPhoto', async () => {
    const { deps, repo } = fakeDeps();
    const forged = [
      PNG_1X1,
      Buffer.from('RIFF\x20\x00\x00\x00WEBP<html>', 'latin1'),
      vp8(513, 10),
    ];
    for (const bytes of forged) {
      // eslint-disable-next-line no-await-in-loop
      const result = await uploadBanPhoto(deps, {
        actor: LEAD,
        banId: 7,
        photo: bytes.toString('base64url'),
      });
      expect(result.code).toMatch(/^photo-/);
    }
    expect(
      await uploadBanPhoto(deps, { actor: LEAD, banId: 7, photo: 'a+b/' }),
    ).toEqual({ code: 'photo-not-accepted' });
    expect(repo.setUploadedPhoto).not.toHaveBeenCalled();
    expect(deps.isLeadership).not.toHaveBeenCalled();
  });

  it('accepts the VP8 512x384 and JPEG vectors, stores stripped bytes, and maps replaced to the title', async () => {
    const { deps, repo } = fakeDeps();
    expect(
      await uploadBanPhoto(deps, {
        actor: LEAD,
        banId: 7,
        photo: vp8(512, 384).toString('base64url'),
      }),
    ).toEqual({ code: 'photo-saved' });
    expect(repo.setUploadedPhoto).toHaveBeenLastCalledWith(
      7,
      vp8(512, 384),
      LEAD,
    );
    repo.setUploadedPhoto.mockResolvedValueOnce({
      ban: ban({ hasPhoto: true }),
      replaced: true,
    });
    const gps = segment(0xe1, Buffer.from('Exif\0\0GPS'));
    expect(
      await uploadBanPhoto(deps, {
        actor: LEAD,
        banId: 7,
        photo: jpeg(512, 512, gps).toString('base64url'),
      }),
    ).toEqual({ code: 'photo-saved' });
    expect(repo.setUploadedPhoto).toHaveBeenLastCalledWith(
      7,
      jpeg(512, 512),
      LEAD,
    );
    await settle();
    const titles = deps.moderationLog.mock.calls.map(
      (call) => (call as unknown as [{ title: string }])[0].title,
    );
    expect(titles).toEqual(['Ban photo uploaded', 'Ban photo replaced']);
    const text = JSON.stringify(deps.moderationLog.mock.calls);
    expect(text).not.toContain(vp8(512, 384).toString('base64'));
    expect(text).not.toContain(vp8(512, 384).toString('base64url'));
  });

  it('a lifted or unknown ban is not-active; a Moderator is not-leadership', async () => {
    const { deps, repo } = fakeDeps();
    repo.setUploadedPhoto.mockResolvedValueOnce(undefined);
    expect(
      await uploadBanPhoto(deps, {
        actor: LEAD,
        banId: 7,
        photo: vp8(10, 10).toString('base64url'),
      }),
    ).toEqual({ code: 'not-active' });
    const moderator = fakeDeps(false);
    expect(
      await uploadBanPhoto(moderator.deps, {
        actor: LEAD,
        banId: 7,
        photo: vp8(10, 10).toString('base64url'),
      }),
    ).toEqual({ code: 'not-leadership' });
    expect(moderator.repo.setUploadedPhoto).not.toHaveBeenCalled();
  });
});

describe('banEntry', () => {
  it('shows the member id only, the date or Date unknown, and never carries a photo', () => {
    const entry = banEntry(
      'photo-replaced',
      ban({ bannedOn: null, memberName: '', hasPhoto: true }),
      LEAD,
    );
    expect(entry.title).toBe('Ban photo replaced');
    expect(entry.fields).toEqual([
      { name: 'Member', value: '424242' },
      { name: 'Banned', value: 'Date unknown' },
    ]);
    expect(Object.keys(entry).sort()).toEqual([
      'description',
      'fields',
      'title',
    ]);
  });

  it('never posts the tracker name, for every kind', () => {
    const named = ban({
      memberName: 'Tracker Name Secret',
      liftReason: 'appeal',
      liftedAt: NOW,
      liftedBy: LEAD,
    });
    for (const kind of [
      'recorded',
      'lifted',
      'photo-uploaded',
      'photo-replaced',
    ] as const) {
      const entry = banEntry(kind, named, LEAD);
      expect(JSON.stringify(entry), kind).not.toContain('Tracker Name');
      expect(entry.fields?.[0], kind).toEqual({
        name: 'Member',
        value: '424242',
      });
      expect(entry.description, kind).toContain(BANNED_TAB_URL);
    }
  });

  it('a member id that is not digits shows as unknown id', () => {
    const entry = banEntry('recorded', ban({ memberId: '12a4' }), LEAD);
    expect(entry.fields?.[0]).toEqual({ name: 'Member', value: 'unknown id' });
  });
});
