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
const FOURTH_ID = '333344455';
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
  responses?: Record<string, Buffer | null | 'too-large' | Error>;
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
    const counts = await fillBanPhotos(deps, [rosterMember()], true);
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
    await fillBanPhotos(deps, [rosterMember()], true);
    expect(storedBytes(bans)).toEqual([expect.stringContaining('user')]);
  });

  it('skips Discord when the linked member is not in the guild cache', async () => {
    const { deps, bans, fetchBytes } = fakeDeps({
      links: linked.links,
      guild: {},
      responses: { [STANDARD_URL]: image('standard') },
    });
    const counts = await fillBanPhotos(deps, [rosterMember()], true);
    expect(fetchBytes.mock.calls.map(([u]) => u)).toEqual([STANDARD_URL]);
    expect(storedBytes(bans)).toEqual([expect.stringContaining('standard')]);
    expect(counts).toMatchObject({ fromDiscord: 0, fromMeetup: 1 });
  });

  it('uses the Meetup thumbUrl only when standardUrl is over the cap', async () => {
    for (const standard of [TOO_LARGE, 'too-large' as const]) {
      const { deps, bans, fetchBytes } = fakeDeps({
        responses: { [STANDARD_URL]: standard, [THUMB_URL]: image('thumb') },
      });
      // eslint-disable-next-line no-await-in-loop -- one case at a time
      const counts = await fillBanPhotos(deps, [rosterMember()], true);
      expect(fetchBytes.mock.calls.map(([u]) => u)).toEqual([
        STANDARD_URL,
        THUMB_URL,
      ]);
      expect(storedBytes(bans)).toEqual([expect.stringContaining('thumb')]);
      expect(counts).toMatchObject({ filled: 1, fromMeetup: 1, deferred: 0 });
    }
  });

  it('defers, without the thumb or the stored photo, when standardUrl times out or fails', async () => {
    for (const standard of [null, new Error('reset'), NOT_AN_IMAGE]) {
      const { deps, bans, fetchBytes, storedPhoto } = fakeDeps({
        responses: { [STANDARD_URL]: standard, [THUMB_URL]: image('thumb') },
        stored: { [MEETUP_ID]: image('stored') },
      });
      // eslint-disable-next-line no-await-in-loop -- one case at a time
      const counts = await fillBanPhotos(deps, [rosterMember()], true);
      expect(fetchBytes.mock.calls.map(([u]) => u)).toEqual([STANDARD_URL]);
      expect(storedPhoto).not.toHaveBeenCalled();
      expect(bans.fillProfilePhoto).not.toHaveBeenCalled();
      expect(counts).toMatchObject({ filled: 0, deferred: 1, noSource: 0 });
    }
  });

  it('never requests highResUrl', async () => {
    const { deps, fetchBytes } = fakeDeps({
      responses: { [HIGHRES_URL]: image('highres') },
    });
    await fillBanPhotos(deps, [rosterMember()], true);
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
    await fillBanPhotos(
      deps,
      [
        rosterMember(MEETUP_ID, {
          id: 'p',
          standardUrl: elsewhere,
          thumbUrl: plain,
        }),
      ],
      true,
    );
    await fillBanPhotos(
      deps,
      [rosterMember(MEETUP_ID, { id: 'p', thumbUrl: lookalike })],
      true,
    );
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(bans.fillProfilePhoto).not.toHaveBeenCalled();
  });

  it('uses the stored photo only when the member is gone from a fetched roster and the guild', async () => {
    const { deps, bans, fetchBytes, storedPhoto } = fakeDeps({
      links: linked.links,
      guild: {},
      stored: { [MEETUP_ID]: image('stored') },
    });
    const counts = await fillBanPhotos(deps, [rosterMember(OTHER_ID)], true);
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(storedPhoto).toHaveBeenCalledWith(MEETUP_ID, DISCORD_ID);
    expect(storedBytes(bans)).toEqual([expect.stringContaining('stored')]);
    expect(counts).toMatchObject({ filled: 1, fromStored: 1, deferred: 0 });
  });

  it('defers a linked member missing from a guild cache the Discord sweep could not refresh', async () => {
    const setup = {
      links: linked.links,
      guild: {},
      stored: { [MEETUP_ID]: image('stored') },
    };
    const partial = fakeDeps(setup);
    const counts = await fillBanPhotos(
      partial.deps,
      [rosterMember(OTHER_ID)],
      false,
    );
    expect(partial.storedPhoto).not.toHaveBeenCalled();
    expect(partial.bans.fillProfilePhoto).not.toHaveBeenCalled();
    expect(counts).toMatchObject({ filled: 0, deferred: 1, fromStored: 0 });

    const full = fakeDeps(setup);
    const known = await fillBanPhotos(
      full.deps,
      [rosterMember(OTHER_ID)],
      true,
    );
    expect(storedBytes(full.bans)).toEqual([expect.stringContaining('stored')]);
    expect(known).toMatchObject({ filled: 1, fromStored: 1, deferred: 0 });
  });

  it('a partial guild cache does not hold back an unlinked member gone from the roster', async () => {
    const { deps, bans } = fakeDeps({
      stored: { [MEETUP_ID]: image('stored') },
    });
    const counts = await fillBanPhotos(deps, [], false);
    expect(storedBytes(bans)).toEqual([expect.stringContaining('stored')]);
    expect(counts).toMatchObject({ filled: 1, fromStored: 1 });
  });

  it('defers instead of using the stored photo when the roster was not fetched', async () => {
    const { deps, bans, storedPhoto } = fakeDeps({
      stored: { [MEETUP_ID]: image('stored') },
    });
    const counts = await fillBanPhotos(deps, undefined, true);
    expect(storedPhoto).not.toHaveBeenCalled();
    expect(bans.fillProfilePhoto).not.toHaveBeenCalled();
    expect(counts).toMatchObject({ filled: 0, deferred: 1, noSource: 0 });
  });

  it('defers instead of using Meetup or stored when the Discord avatar download fails for a present member', async () => {
    for (const guildAnswer of [null, new Error('timeout'), NOT_AN_IMAGE]) {
      const { deps, bans, fetchBytes, storedPhoto } = fakeDeps({
        ...linked,
        responses: {
          [GUILD_URL]: guildAnswer,
          [USER_URL]: image('user'),
          [STANDARD_URL]: image('standard'),
        },
        stored: { [MEETUP_ID]: image('stored') },
      });
      // Gone from the roster, still in the guild.
      // eslint-disable-next-line no-await-in-loop -- one case at a time
      const counts = await fillBanPhotos(deps, [], true);
      expect(fetchBytes.mock.calls.map(([u]) => u)).toEqual([GUILD_URL]);
      expect(storedPhoto).not.toHaveBeenCalled();
      expect(bans.fillProfilePhoto).not.toHaveBeenCalled();
      expect(counts).toMatchObject({ filled: 0, deferred: 1 });
    }
  });

  it('a Discord avatar over the cap moves on to the next avatar, then Meetup', async () => {
    const { deps, bans, fetchBytes } = fakeDeps({
      ...linked,
      responses: {
        [GUILD_URL]: 'too-large',
        [USER_URL]: TOO_LARGE,
        [STANDARD_URL]: image('standard'),
      },
    });
    await fillBanPhotos(deps, [rosterMember()], true);
    expect(fetchBytes.mock.calls.map(([u]) => u)).toEqual([
      GUILD_URL,
      USER_URL,
      STANDARD_URL,
    ]);
    expect(storedBytes(bans)).toEqual([expect.stringContaining('standard')]);
  });

  it('a member still present but with every source over the cap has no source, and stored is not read', async () => {
    const { deps, bans, storedPhoto } = fakeDeps({
      ...linked,
      responses: {
        [GUILD_URL]: TOO_LARGE,
        [USER_URL]: 'too-large',
        [STANDARD_URL]: TOO_LARGE,
        [THUMB_URL]: 'too-large',
      },
      stored: { [MEETUP_ID]: image('stored') },
    });
    const counts = await fillBanPhotos(deps, [rosterMember()], true);
    expect(storedPhoto).not.toHaveBeenCalled();
    expect(bans.fillProfilePhoto).not.toHaveBeenCalled();
    expect(counts).toMatchObject({ filled: 0, noSource: 1, deferred: 0 });
  });

  it('a gone member whose stored bytes are not an image has no source', async () => {
    const { deps, bans } = fakeDeps({
      stored: { [MEETUP_ID]: NOT_AN_IMAGE },
    });
    const counts = await fillBanPhotos(deps, [], true);
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
    await fillBanPhotos(deps, [rosterMember()], true);
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
    const counts = await fillBanPhotos(deps, [rosterMember()], true);
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
      true,
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
    await fillBanPhotos(deps, [], true);
    expect(bans.listPhotoFillCandidates).toHaveBeenCalledWith(50, '2026-10-23');
  });

  it('looks up links only for the candidates', async () => {
    const { deps, discordIdsByMeetupIds } = fakeDeps();
    await fillBanPhotos(deps, [rosterMember(), rosterMember(OTHER_ID)], true);
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
    const counts = await fillBanPhotos(deps, [], true);
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
    await fillBanPhotos(deps, [rosterMember()], true);
    expect(storedBytes(bans)).toEqual([expect.stringContaining('standard')]);
  });

  it('a failing link lookup never falls back to the stored photo', async () => {
    const { deps, bans, storedPhoto } = fakeDeps({
      stored: { [MEETUP_ID]: image('stored') },
    });
    deps.discordIdsByMeetupIds = vi.fn(async () => {
      throw new Error('db down');
    });
    const counts = await fillBanPhotos(deps, [], true);
    expect(storedPhoto).not.toHaveBeenCalled();
    expect(bans.fillProfilePhoto).not.toHaveBeenCalled();
    expect(counts).toMatchObject({ filled: 0, deferred: 1 });
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
    const run = runBanPhotoFillSafely(deps, [rosterMember()], true).then(() => {
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
    await expect(
      runBanPhotoFillSafely(deps, [], true),
    ).resolves.toBeUndefined();
  });

  it('logs counts only', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { deps } = fakeDeps({
      ...linked,
      candidates: [
        { id: 1, memberId: MEETUP_ID },
        { id: 2, memberId: OTHER_ID },
        { id: 3, memberId: THIRD_ID },
        { id: 4, memberId: FOURTH_ID },
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
    // The fourth is in the roster but its standard photo does not download.
    await runBanPhotoFillSafely(
      deps,
      [rosterMember(), rosterMember(FOURTH_ID)],
      true,
    );
    deps.bans = async () => {
      throw new Error(`member ${MEETUP_ID} at ${STANDARD_URL}`);
    };
    await runBanPhotoFillSafely(deps, [rosterMember()], true);
    const printed = log.mock.calls.flat().map(String).join('\n');
    expect(printed).toContain(
      'Ban photo fill: 1 of 4 filled (1 Discord, 0 Meetup, 0 stored), 1 without a usable photo, 1 deferred to tomorrow, 1 failed',
    );
    for (const secret of [
      MEETUP_ID,
      OTHER_ID,
      THIRD_ID,
      FOURTH_ID,
      DISCORD_ID,
      'cdn.discordapp.com',
      'meetupstatic',
    ]) {
      expect(printed).not.toContain(secret);
    }
  });
});
