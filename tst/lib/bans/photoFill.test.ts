import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BAN_FILL_DEADLINE_MS,
  BanPhotoFillDeps,
  fillBanPhotos,
  isBanPhotoSourceUrl,
  runBanPhotoFillSafely,
} from '../../../src/lib/bans/photoFill.js';
import { BAN_PHOTO_MAX_BYTES } from '../../../src/lib/bans/types.js';
import { MeetupGroupMember } from '../../../src/lib/client/meetup/types.js';
import { HealBudget } from '../../../src/lib/helpers/identity/healBudget.js';

const GUILD = '912461362289061939';
const MEETUP_ID = '279964402';
const OTHER_ID = '311122233';
const THIRD_ID = '322233344';
const DISCORD_ID = '123456789012345678';

function pngChunk(type: string, data: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, data, Buffer.alloc(4, 0xcc)]);
}
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function ihdr(): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(1, 0);
  data.writeUInt32BE(1, 4);
  data[8] = 8;
  data[9] = 6;
  return pngChunk('IHDR', data);
}
/** A well-formed PNG whose IDAT names where it came from. */
const image = (label: string, extra: Buffer[] = []) =>
  Buffer.concat([
    PNG_SIG,
    ihdr(),
    ...extra,
    pngChunk('IDAT', Buffer.from(label)),
    pngChunk('IEND'),
  ]);
const TOO_LARGE = image('x'.repeat(BAN_PHOTO_MAX_BYTES));
const NOT_AN_IMAGE = Buffer.from('<html>not a picture</html>');

const GUILD_URL = `https://cdn.discordapp.com/guilds/${GUILD}/users/${DISCORD_ID}/avatars/gg.webp?size=256`;
const USER_URL = `https://cdn.discordapp.com/avatars/${DISCORD_ID}/uu.webp?size=256`;
const STANDARD_URL =
  'https://secure.meetupstatic.com/photos/member/a/standard.jpeg';
const THUMB_URL = 'https://secure.meetupstatic.com/photos/member/a/thumb.jpeg';
const HIGHRES_URL =
  'https://secure.meetupstatic.com/photos/member/a/highres.jpeg';

const rosterMember = (
  id = MEETUP_ID,
  photo: Record<string, unknown> | null = {
    id: 'p1',
    thumbUrl: THUMB_URL,
    standardUrl: STANDARD_URL,
    highResUrl: HIGHRES_URL,
  },
): MeetupGroupMember =>
  ({ id, name: 'Someone', username: 'someone', memberPhoto: photo }) as never;

interface FakeOptions {
  candidates?: { id: number; memberId: string }[];
  links?: Record<string, string>;
  guild?: Record<
    string,
    { userAvatarHash: string | null; memberAvatarHash: string | null }
  >;
  responses?: Record<string, Buffer | null | Error>;
  stored?: Record<string, Buffer>;
  fill?: (id: number, photo: Buffer) => Promise<boolean>;
}

function fakeDeps(options: FakeOptions = {}) {
  const bans = {
    listPhotoFillCandidates: vi.fn(
      async (_limit: number, _day: string) =>
        options.candidates ?? [{ id: 1, memberId: MEETUP_ID }],
    ),
    fillProfilePhoto: vi.fn(options.fill ?? (async () => true)),
  };
  const fetchBytes = vi.fn(async (url: string) => {
    const answer = options.responses?.[url];
    if (answer instanceof Error) {
      throw answer;
    }
    return answer ?? null;
  });
  const storedPhoto = vi.fn(
    async (meetupId: string, _discordId: string | undefined) =>
      options.stored?.[meetupId],
  );
  const discordIdsByMeetupIds = vi.fn(
    async (ids: string[]) =>
      new Map(
        ids
          .filter((id) => options.links?.[id] !== undefined)
          .map((id) => [id, options.links?.[id] ?? '']),
      ),
  );
  const guildMember = vi.fn((id: string) => options.guild?.[id]);
  const deps: BanPhotoFillDeps = {
    bans: async () => bans,
    discordIdsByMeetupIds,
    guildMember,
    storedPhoto,
    fetchBytes,
    guildId: GUILD,
    now: () => Date.now(),
  };
  return { deps, bans, fetchBytes, storedPhoto, discordIdsByMeetupIds };
}

const linked = {
  links: { [MEETUP_ID]: DISCORD_ID },
  guild: { [DISCORD_ID]: { userAvatarHash: 'uu', memberAvatarHash: 'gg' } },
};

const storedBytes = (bans: { fillProfilePhoto: ReturnType<typeof vi.fn> }) =>
  bans.fillProfilePhoto.mock.calls.map(([, photo]) => String(photo));

describe('isBanPhotoSourceUrl', () => {
  it.each([
    ['https://secure.meetupstatic.com/photos/member/a/thumb.jpeg', true],
    ['https://cdn.discordapp.com/avatars/1/a.webp?size=256', true],
    ['https://evilmeetupstatic.com/x', false],
    ['https://cdn.discordapp.com@evil.test/x', false],
    ['https://evil.test@cdn.discordapp.com/x', false],
    ['https://cdn.discordapp.com:8443/x', false],
    ['https://media.discordapp.net/x', false],
    ['https://secure.meetupstatic.com./x', false],
    ['http://cdn.discordapp.com/x', false],
    ['not a url', false],
  ])('%s -> %s', (url, expected) => {
    expect(isBanPhotoSourceUrl(url)).toBe(expected);
  });
});

describe('fillBanPhotos: sources', () => {
  it('prefers the guild avatar of a linked member still in the server', async () => {
    const { deps, bans, fetchBytes } = fakeDeps({
      ...linked,
      responses: {
        [GUILD_URL]: image('guild'),
        [USER_URL]: image('user'),
        [STANDARD_URL]: image('standard'),
      },
    });
    const counts = await fillBanPhotos(deps, [rosterMember()]);
    expect(storedBytes(bans)).toEqual([expect.stringContaining('guild')]);
    expect(fetchBytes.mock.calls.map(([u]) => u)).toEqual([GUILD_URL]);
    expect(counts).toMatchObject({ filled: 1, fromDiscord: 1, fromMeetup: 0 });
  });

  it('falls back to the user avatar', async () => {
    const { deps, bans } = fakeDeps({
      links: linked.links,
      guild: { [DISCORD_ID]: { userAvatarHash: 'uu', memberAvatarHash: null } },
      responses: { [USER_URL]: image('user') },
    });
    await fillBanPhotos(deps, [rosterMember()]);
    expect(storedBytes(bans)).toEqual([expect.stringContaining('user')]);
  });

  it('skips Discord when the linked member is not in the guild cache', async () => {
    const { deps, bans, fetchBytes } = fakeDeps({
      links: linked.links,
      guild: {},
      responses: { [STANDARD_URL]: image('standard') },
    });
    const counts = await fillBanPhotos(deps, [rosterMember()]);
    expect(fetchBytes.mock.calls.map(([u]) => u)).toEqual([STANDARD_URL]);
    expect(storedBytes(bans)).toEqual([expect.stringContaining('standard')]);
    expect(counts).toMatchObject({ fromDiscord: 0, fromMeetup: 1 });
  });

  it('uses the Meetup standardUrl, then thumbUrl when standard is too large or fails', async () => {
    for (const standard of [TOO_LARGE, null, new Error('reset')]) {
      const { deps, bans, fetchBytes } = fakeDeps({
        responses: { [STANDARD_URL]: standard, [THUMB_URL]: image('thumb') },
      });
      // eslint-disable-next-line no-await-in-loop -- one case at a time
      await fillBanPhotos(deps, [rosterMember()]);
      expect(fetchBytes.mock.calls.map(([u]) => u)).toEqual([
        STANDARD_URL,
        THUMB_URL,
      ]);
      expect(storedBytes(bans)).toEqual([expect.stringContaining('thumb')]);
    }
  });

  it('never requests highResUrl', async () => {
    const { deps, fetchBytes } = fakeDeps({
      responses: { [HIGHRES_URL]: image('highres') },
    });
    await fillBanPhotos(deps, [rosterMember()]);
    expect(fetchBytes.mock.calls.map(([u]) => u)).not.toContain(HIGHRES_URL);
  });

  it('fetches only from the Discord CDN and Meetup photo hosts', async () => {
    const elsewhere = 'https://evil.example.test/photo.png';
    const plain = 'http://secure.meetupstatic.com/photos/thumb.jpeg';
    const lookalike = 'https://meetupstatic.com.evil.test/thumb.jpeg';
    const { deps, fetchBytes, bans } = fakeDeps({
      responses: {
        [elsewhere]: image('evil'),
        [plain]: image('plain'),
        [lookalike]: image('lookalike'),
      },
    });
    await fillBanPhotos(deps, [
      rosterMember(MEETUP_ID, {
        id: 'p',
        standardUrl: elsewhere,
        thumbUrl: plain,
      }),
    ]);
    await fillBanPhotos(deps, [
      rosterMember(MEETUP_ID, { id: 'p', thumbUrl: lookalike }),
    ]);
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(bans.fillProfilePhoto).not.toHaveBeenCalled();
  });

  it('falls back to the stored photo when neither profile yields bytes', async () => {
    const { deps, bans, storedPhoto } = fakeDeps({
      ...linked,
      stored: { [MEETUP_ID]: image('stored') },
    });
    const counts = await fillBanPhotos(deps, [rosterMember()]);
    expect(storedPhoto).toHaveBeenCalledWith(MEETUP_ID, DISCORD_ID);
    expect(storedBytes(bans)).toEqual([expect.stringContaining('stored')]);
    expect(counts).toMatchObject({ filled: 1, fromStored: 1 });
  });

  it('uses the stored photo when the member is not in the roster at all', async () => {
    const { deps, bans, fetchBytes } = fakeDeps({
      stored: { [MEETUP_ID]: image('stored') },
    });
    await fillBanPhotos(deps, undefined);
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(storedBytes(bans)).toEqual([expect.stringContaining('stored')]);
  });

  it('refuses bytes that sniff as nothing and bytes over 153600, and tries the next source', async () => {
    const { deps, bans } = fakeDeps({
      ...linked,
      responses: {
        [GUILD_URL]: NOT_AN_IMAGE,
        [USER_URL]: TOO_LARGE,
        [STANDARD_URL]: NOT_AN_IMAGE,
        [THUMB_URL]: TOO_LARGE,
      },
      stored: { [MEETUP_ID]: NOT_AN_IMAGE },
    });
    const counts = await fillBanPhotos(deps, [rosterMember()]);
    expect(bans.fillProfilePhoto).not.toHaveBeenCalled();
    expect(counts).toMatchObject({ filled: 0, noSource: 1 });
  });

  it('stores only stripped bytes: a PNG source loses its text chunks', async () => {
    const tagged = image('thumb', [
      pngChunk('tEXt', Buffer.from('GPS\0home address')),
    ]);
    const { deps, bans } = fakeDeps({
      responses: { [STANDARD_URL]: tagged },
    });
    await fillBanPhotos(deps, [rosterMember()]);
    const [[, stored]] = bans.fillProfilePhoto.mock.calls;
    expect(String(stored)).not.toContain('home address');
    expect(String(stored)).toContain('thumb');
    expect(stored.length).toBeLessThan(tagged.length);
  });
});

describe('fillBanPhotos: limits and failures', () => {
  it('Review Focus 4: a candidate the upload won (fillProfilePhoto false) is not counted filled and no other write is made', async () => {
    const { deps, bans } = fakeDeps({
      ...linked,
      responses: { [GUILD_URL]: image('guild'), [THUMB_URL]: image('thumb') },
      fill: async () => false,
    });
    const counts = await fillBanPhotos(deps, [rosterMember()]);
    expect(bans.fillProfilePhoto).toHaveBeenCalledTimes(1);
    expect(counts).toMatchObject({
      candidates: 1,
      filled: 0,
      fromDiscord: 0,
      noSource: 0,
    });
  });

  it('stops fetching when the budget is spent; the rest wait for tomorrow', async () => {
    let clock = 0;
    const { deps, bans, fetchBytes } = fakeDeps({
      candidates: [
        { id: 1, memberId: MEETUP_ID },
        { id: 2, memberId: OTHER_ID },
      ],
      responses: { [STANDARD_URL]: image('standard') },
    });
    const timed = vi.fn(async (url: string) => {
      clock += 61_000;
      return fetchBytes(url);
    });
    deps.fetchBytes = timed;
    const budget = new HealBudget(60_000, () => clock);
    const counts = await fillBanPhotos(
      deps,
      [rosterMember(), rosterMember(OTHER_ID)],
      budget,
    );
    expect(timed).toHaveBeenCalledTimes(1);
    expect(bans.fillProfilePhoto).toHaveBeenCalledTimes(1);
    expect(counts).toMatchObject({ candidates: 2, filled: 1 });
  });

  it("asks for at most 50 candidates, ordered for the run's UTC day", async () => {
    const { deps, bans } = fakeDeps({ candidates: [] });
    // 23:30 Pacific on the 22nd is already the 23rd in UTC.
    deps.now = () => Date.parse('2026-10-23T06:30:00Z');
    await fillBanPhotos(deps, []);
    expect(bans.listPhotoFillCandidates).toHaveBeenCalledWith(50, '2026-10-23');
  });

  it('looks up links only for the candidates', async () => {
    const { deps, discordIdsByMeetupIds } = fakeDeps();
    await fillBanPhotos(deps, [rosterMember(), rosterMember(OTHER_ID)]);
    expect(discordIdsByMeetupIds).toHaveBeenCalledWith([MEETUP_ID]);
  });

  it("one candidate's error does not stop the others", async () => {
    const { deps, bans } = fakeDeps({
      candidates: [
        { id: 1, memberId: MEETUP_ID },
        { id: 2, memberId: OTHER_ID },
      ],
      stored: { [OTHER_ID]: image('other') },
    });
    deps.storedPhoto = vi.fn(async (id: string) => {
      if (id === MEETUP_ID) {
        throw new Error('pool exhausted');
      }
      return image('other');
    });
    const counts = await fillBanPhotos(deps, undefined);
    expect(bans.fillProfilePhoto).toHaveBeenCalledTimes(1);
    expect(bans.fillProfilePhoto.mock.calls[0][0]).toBe(2);
    expect(counts).toMatchObject({ candidates: 2, filled: 1, failed: 1 });
  });

  it('a failing link lookup still tries Meetup and stored photos', async () => {
    const { deps, bans } = fakeDeps({
      responses: { [STANDARD_URL]: image('standard') },
    });
    deps.discordIdsByMeetupIds = vi.fn(async () => {
      throw new Error('db down');
    });
    await fillBanPhotos(deps, [rosterMember()]);
    expect(storedBytes(bans)).toEqual([expect.stringContaining('standard')]);
  });
});

describe('runBanPhotoFillSafely', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('never rejects, resolves by the 90 s deadline even when a fetch hangs', async () => {
    vi.useFakeTimers();
    const { deps } = fakeDeps();
    deps.fetchBytes = vi.fn(() => new Promise<Buffer | null>(() => undefined));
    let settled = false;
    const run = runBanPhotoFillSafely(deps, [rosterMember()]).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(BAN_FILL_DEADLINE_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(settled).toBe(true);
  });

  it('never rejects when the bans read throws', async () => {
    const { deps } = fakeDeps();
    deps.bans = async () => {
      throw new Error(`connection to ${MEETUP_ID} refused`);
    };
    await expect(runBanPhotoFillSafely(deps, [])).resolves.toBeUndefined();
  });

  it('logs counts only', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { deps } = fakeDeps({
      ...linked,
      candidates: [
        { id: 1, memberId: MEETUP_ID },
        { id: 2, memberId: OTHER_ID },
        { id: 3, memberId: THIRD_ID },
      ],
      responses: { [GUILD_URL]: image('guild') },
    });
    // The third ban's lookup fails, with its id in the error.
    deps.storedPhoto = vi.fn(async (id: string) => {
      if (id === THIRD_ID) {
        throw new Error(`no row for ${THIRD_ID} at ${THUMB_URL}`);
      }
      return undefined;
    });
    await runBanPhotoFillSafely(deps, [rosterMember()]);
    deps.bans = async () => {
      throw new Error(`member ${MEETUP_ID} at ${STANDARD_URL}`);
    };
    await runBanPhotoFillSafely(deps, [rosterMember()]);
    const printed = log.mock.calls.flat().map(String).join('\n');
    expect(printed).toContain(
      'Ban photo fill: 1 of 3 filled (1 Discord, 0 Meetup, 0 stored), 1 without a usable photo, 1 failed',
    );
    for (const secret of [
      MEETUP_ID,
      OTHER_ID,
      THIRD_ID,
      DISCORD_ID,
      'cdn.discordapp.com',
      'meetupstatic',
    ]) {
      expect(printed).not.toContain(secret);
    }
  });
});
