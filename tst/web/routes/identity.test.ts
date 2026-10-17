import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DASHBOARD_PATHS } from '../../../src/lib/reports/dashboardPaths.js';
import { IdentityChangeListItem } from '../../../src/lib/repositories/postgresIdentityRepository.js';
import {
  createDashboardRouter,
  protectedRouteList,
} from '../../../src/web/dashboardRouter.js';
import {
  DashboardPageDeps,
  registerAllProtectedRoutes,
} from '../../../src/web/routes/dashboardPages.js';
import { LoopbackResponse } from '../../setup/loopbackServer.js';
import {
  closeServers,
  makeApp,
  makeDeps,
  rawRequest,
  signIn,
} from '../dashboardHarness.js';
import {
  DISCORD_SUBJECT,
  JPEG_BYTES,
  PNG_1X1,
  WEBP_BYTES,
  fakeIdentity,
  fakeOrganizerDeps,
  fakePageDeps,
  identityChange,
} from './pageFakes.js';

const fake = vi.hoisted(() => ({ logged: [] as string[] }));

vi.mock('tslog', () => {
  const renderOne = (a: unknown) => {
    return typeof a === 'string' ? a : JSON.stringify(a);
  };
  const render = (args: unknown[]) => args.map(renderOne).join(' ');
  class Logger {
    debug = (...args: unknown[]) => fake.logged.push(render(args));

    info = (...args: unknown[]) => fake.logged.push(render(args));

    warn = (...args: unknown[]) => fake.logged.push(render(args));

    error = (...args: unknown[]) => fake.logged.push(render(args));
  }
  return { Logger };
});

afterEach(closeServers);

const PAGE = '/dashboard/identity';
const THUMB_SRC =
  /^\/dashboard\/identity\/changes\/[0-9]{1,18}\/thumb\/(old|new)$/;

type Reader = ReturnType<typeof fakeIdentity>;

async function setup(
  reader: Reader = fakeIdentity([identityChange()]),
  pages: Partial<DashboardPageDeps> = {},
  before?: (r: express.Router) => void,
) {
  const { req, server } = await makeApp({
    protectedRoutes: (r) => {
      before?.(r);
      registerAllProtectedRoutes(r, {
        organizer: fakeOrganizerDeps(),
        pages: fakePageDeps({ identity: async () => reader, ...pages }),
      });
    },
  });
  const cookie = await signIn(req);
  const get = (path: string) =>
    req
      .get(path)
      .set('Cookie', cookie)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });
  return { reader, get, server, cookie };
}

const bodyOf = (res: LoopbackResponse) => res.body as Buffer;
const textOf = (res: LoopbackResponse) => bodyOf(res).toString('utf8');
const imgSrcs = (body: string) =>
  [...body.matchAll(/<img\s[^>]*src="([^"]*)"/g)].map((m) => m[1]);

/** The filter the page passed to listChangesPage on its first call. */
const filterOf = (reader: Reader) => reader.listChangesPage.mock.calls[0][0];

describe('identity changes page', () => {
  it('filters by date, platform, member', async () => {
    const { reader, get } = await setup();
    const res = await get(
      `${PAGE}?from=2026-10-01&to=2026-10-02&platform=meetup&member=42`,
    );
    expect(res.status).toBe(200);
    expect(filterOf(reader)).toEqual({
      from: new Date('2026-10-01T07:00:00Z'),
      to: new Date('2026-10-03T07:00:00Z'),
      platform: 'meetup',
      subjectId: '42',
      beforeId: undefined,
      limit: 50,
    });
    // The form shows the validated values back.
    const text = textOf(res);
    expect(text).toContain('value="2026-10-01"');
    expect(text).toContain('value="2026-10-02"');
    expect(text).toContain('value="42"');
    expect(text).toMatch(/<option value="meetup" selected>/);
  });

  it('drops junk filter values', async () => {
    const { reader, get } = await setup();
    const res = await get(
      `${PAGE}?from=2026-13-01&to=2026-02-30&platform=x&member=4zq&before=1e3`,
    );
    expect(res.status).toBe(200);
    expect(filterOf(reader)).toEqual({
      from: undefined,
      to: undefined,
      platform: undefined,
      subjectId: undefined,
      beforeId: undefined,
      limit: 50,
    });
    const text = textOf(res);
    expect(text).not.toContain('2026-13-01');
    expect(text).not.toContain('4zq');
  });

  it('drops repeated and oversized values', async () => {
    const { reader, get } = await setup();
    await get(
      `${PAGE}?platform=discord&platform=meetup&member=${'1'.repeat(21)}&before=${'9'.repeat(19)}`,
    );
    expect(filterOf(reader)).toMatchObject({
      platform: undefined,
      subjectId: undefined,
      beforeId: undefined,
    });
  });

  it('passes the keyset cursor', async () => {
    const { reader, get } = await setup();
    await get(`${PAGE}?before=1234`);
    expect(filterOf(reader).beforeId).toBe('1234');
  });

  it('keyset paging link carries the last id and the filters', async () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      identityChange({
        id: String(500 - i),
        platform: 'meetup',
        subjectId: '42',
      }),
    );
    const { get } = await setup(fakeIdentity(rows));
    const res = await get(`${PAGE}?platform=meetup&member=42&from=2026-10-01`);
    const text = textOf(res);
    expect(text).toContain(
      'href="/dashboard/identity?platform=meetup&amp;member=42&amp;from=2026-10-01&amp;before=451"',
    );
    expect(text).toContain('Older changes');
  });

  it('has no older link when fewer than 50 rows came back', async () => {
    const { get } = await setup(fakeIdentity([identityChange()]));
    const text = textOf(await get(PAGE));
    expect(text).not.toContain('Older changes');
    expect(text).not.toContain('before=');
  });

  it('shows a newest link on an older page', async () => {
    const { get } = await setup(fakeIdentity([identityChange()]));
    const text = textOf(await get(`${PAGE}?platform=discord&before=77`));
    expect(text).toContain('href="/dashboard/identity?platform=discord"');
    expect(text).toContain('Newest changes');
  });

  it('escapes old and new values and names', async () => {
    const reader = fakeIdentity(
      [
        identityChange({
          oldValue: '"><img src=x onerror=alert(1)>',
          newValue: '<script>alert(1)</script>‮',
        }),
        identityChange({
          platform: 'meetup',
          subjectId: '42',
          field: 'name',
          oldValue: 'Jane',
          newValue: '<b>Jane</b>',
        }),
      ],
      {},
      { [DISCORD_SUBJECT]: '<i>nick</i>', '42': '<u>meetup</u>' },
    );
    const { get } = await setup(reader);
    const text = textOf(await get(PAGE));
    expect(text).not.toContain('<script>alert');
    expect(text).not.toContain('<img src=x');
    expect(text).not.toContain('<b>Jane');
    expect(text).not.toContain('<i>nick');
    expect(text).not.toContain('<u>meetup');
    expect(text).toContain('<bdi>&lt;script&gt;alert(1)&lt;/script&gt;‮</bdi>');
    expect(text).toContain(
      '<bdi>&quot;&gt;&lt;img src=x onerror=alert(1)&gt;</bdi>',
    );
    expect(text).toContain('<bdi>&lt;i&gt;nick&lt;/i&gt;</bdi>');
    expect(text).toContain('<bdi>&lt;u&gt;meetup&lt;/u&gt;</bdi>');
    // Names come from listIdentityNames for exactly the listed subjects.
    expect(reader.listIdentityNames).toHaveBeenCalledWith([
      { platform: 'discord', scopeId: 'guild', subjectId: DISCORD_SUBJECT },
      { platform: 'meetup', scopeId: 'guild', subjectId: '42' },
    ]);
  });

  it('links subjects only from digit ids, and the member filter only for digits', async () => {
    const { get } = await setup(
      fakeIdentity([
        identityChange({ platform: 'meetup', subjectId: '42' }),
        identityChange({ subjectId: DISCORD_SUBJECT }),
        identityChange({
          platform: 'meetup',
          subjectId: 'javascript:alert(1)',
        }),
      ]),
    );
    const text = textOf(await get(PAGE));
    expect(text).toContain('href="https://www.meetup.com/members/42/"');
    expect(text).toContain(
      `href="https://discord.com/users/${DISCORD_SUBJECT}"`,
    );
    expect(text).toContain(
      'href="/dashboard/identity?platform=meetup&amp;member=42"',
    );
    expect(text).toContain(
      `href="/dashboard/identity?platform=discord&amp;member=${DISCORD_SUBJECT}"`,
    );
    expect(text).not.toContain('href="javascript');
    expect(text).not.toContain('member=javascript');
    expect(text).toContain('<bdi>javascript:alert(1)</bdi>');
  });

  it('thumb img tags only for digit ids and recorded thumbs', async () => {
    const { get } = await setup(
      fakeIdentity([
        identityChange({
          id: '10',
          field: 'user_avatar',
          hasOldThumb: true,
          hasNewThumb: true,
        }),
        identityChange({
          id: '11',
          field: 'member_avatar',
          hasOldThumb: false,
          hasNewThumb: true,
        }),
        // Not a digit id: no img at all, even with thumbs recorded.
        identityChange({
          id: '12a',
          field: 'photo',
          platform: 'meetup',
          subjectId: '42',
          hasOldThumb: true,
          hasNewThumb: true,
        }),
        // A text change never carries an img.
        identityChange({ id: '13', field: 'nickname' }),
      ]),
    );
    const text = textOf(await get(PAGE));
    expect(imgSrcs(text)).toEqual([
      '/dashboard/identity/changes/10/thumb/old',
      '/dashboard/identity/changes/10/thumb/new',
      '/dashboard/identity/changes/11/thumb/new',
    ]);
    expect(text).not.toContain('/changes/12a/');
    expect(text).not.toContain('/changes/13/');
  });

  it('img tags are SafeUrl-only, lazy and carry no subject id', async () => {
    const { get } = await setup(
      fakeIdentity([
        identityChange({
          id: '10',
          platform: 'meetup',
          subjectId: '987654',
          field: 'photo',
          hasOldThumb: true,
          hasNewThumb: true,
        }),
      ]),
    );
    const text = textOf(await get(PAGE));
    const tags = text.match(/<img\s[^>]*>/g) ?? [];
    expect(tags).toHaveLength(2);
    for (const tag of tags) {
      expect(tag).toContain('loading="lazy"');
      expect(tag).toContain('width="64"');
      expect(tag).toContain('height="64"');
      expect(tag).not.toContain('987654');
      expect(tag).not.toContain('style=');
    }
    for (const src of imgSrcs(text)) {
      expect(src).toMatch(THUMB_SRC);
    }
  });

  it('503 when the read fails, logging the error name only', async () => {
    fake.logged.length = 0;
    const reader = fakeIdentity();
    const secret = new Error(`member ${DISCORD_SUBJECT} Jane`);
    secret.name = 'DatabaseError';
    reader.listChangesPage.mockRejectedValueOnce(secret);
    const { get } = await setup(reader);
    const res = await get(PAGE);
    expect(res.status).toBe(503);
    expect(textOf(res)).toContain(
      'Identity changes cannot be loaded right now',
    );
    expect(fake.logged.join('\n')).toContain('DatabaseError');
    expect(fake.logged.join('\n')).not.toContain(DISCORD_SUBJECT);
  });

  it('503 when a row has a non-string source', async () => {
    const { get } = await setup(
      fakeIdentity([
        {
          ...identityChange(),
          source: 42,
        } as unknown as IdentityChangeListItem,
      ]),
    );
    expect((await get(PAGE)).status).toBe(503);
    const { get: get2 } = await setup(
      fakeIdentity([{ ...identityChange(), source: null }]),
    );
    expect((await get2(PAGE)).status).toBe(200);
  });

  it('503 when a row is malformed', async () => {
    const bad = {
      ...identityChange(),
      detectedAt: 'not a date',
    } as unknown as IdentityChangeListItem;
    const { get } = await setup(fakeIdentity([bad]));
    expect((await get(PAGE)).status).toBe(503);
    const { get: get2 } = await setup(
      fakeIdentity([
        {
          ...identityChange(),
          platform: 'x',
        } as unknown as IdentityChangeListItem,
      ]),
    );
    expect((await get2(PAGE)).status).toBe(503);
  });

  it('503 when the reader answers something that is not a list', async () => {
    const reader = fakeIdentity();
    reader.listChangesPage.mockResolvedValueOnce(
      'nope' as unknown as IdentityChangeListItem[],
    );
    const { get } = await setup(reader);
    expect((await get(PAGE)).status).toBe(503);
  });

  it('says so when nothing matches', async () => {
    const { get } = await setup(fakeIdentity([]));
    expect(textOf(await get(PAGE))).toContain('No identity changes match');
  });
});

describe('identity thumbnail route', () => {
  const thumb = (id: string, side: string) =>
    `/dashboard/identity/changes/${id}/thumb/${side}`;

  it('thumb route serves only PNG/JPEG/WebP by magic bytes', async () => {
    const reader = fakeIdentity([], {
      '1:old': PNG_1X1,
      '2:old': Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'),
      '3:old': Buffer.from('<svg onload=alert(1)>'),
    });
    const { get } = await setup(reader);
    const png = await get(thumb('1', 'old'));
    expect(png.status).toBe(200);
    expect(png.headers['content-type']).toBe('image/png');
    expect(bodyOf(png).equals(PNG_1X1)).toBe(true);
    for (const id of ['2', '3']) {
      // eslint-disable-next-line no-await-in-loop -- one request at a time
      const res = await get(thumb(id, 'old'));
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(/^text\/html/);
      expect(textOf(res)).not.toContain('GIF89a');
      expect(textOf(res)).not.toContain('onload');
    }
  });

  it('thumb route 404s for a missing side', async () => {
    const reader = fakeIdentity([], {});
    const { get } = await setup(reader);
    expect((await get(thumb('1', 'new'))).status).toBe(404);
    expect(reader.getChangeThumb).toHaveBeenCalledWith('1', 'new');
    reader.getChangeThumb.mockClear();
    for (const path of [
      thumb('1', 'both'),
      thumb('1', 'OLD'),
      thumb('1a', 'old'),
      thumb('-1', 'old'),
      thumb('1'.repeat(19), 'old'),
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one request at a time
      const res = await get(path);
      expect(res.status).toBe(404);
    }
    expect(reader.getChangeThumb).not.toHaveBeenCalled();
  });

  it('accepts an 18-digit id', async () => {
    const reader = fakeIdentity([], {});
    const { get } = await setup(reader);
    await get(thumb('9'.repeat(18), 'old'));
    expect(reader.getChangeThumb).toHaveBeenCalledWith('9'.repeat(18), 'old');
  });

  it('a text-field change has no thumbnail', async () => {
    const reader = fakeIdentity([], {});
    reader.getChangeThumb.mockResolvedValueOnce(undefined);
    const { get } = await setup(reader);
    const res = await get(thumb('5', 'old'));
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
  });

  it('thumb response is no-store and nosniff', async () => {
    const reader = fakeIdentity([], {
      '1:old': PNG_1X1,
      '2:new': JPEG_BYTES,
      '3:old': WEBP_BYTES,
    });
    const { get } = await setup(reader);
    for (const [path, type] of [
      [thumb('1', 'old'), 'image/png'],
      [thumb('2', 'new'), 'image/jpeg'],
      [thumb('3', 'old'), 'image/webp'],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- one request at a time
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe(type);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-disposition']).toBe('inline');
      expect(res.headers['set-cookie']).toBeUndefined();
    }
  });

  it('Content-Type comes only from the magic bytes', async () => {
    const reader = fakeIdentity([], {
      // JPEG bytes on a user_avatar change, whose CDN served WebP.
      '1:new': JPEG_BYTES,
      '2:new': PNG_1X1,
      '3:old': Buffer.from('GIF89a\x01\x00', 'latin1'),
      '4:old': Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      '5:old': Buffer.from('<!doctype html><p>hi'),
      '6:old': Buffer.from('%PDF-1.7\n'),
      '7:old': Buffer.alloc(0),
    });
    const { get } = await setup(reader);
    const jpeg = await get(thumb('1', 'new'));
    expect(jpeg.headers['content-type']).toBe('image/jpeg');
    const png = await get(thumb('2', 'new'));
    expect(png.headers['content-type']).toBe('image/png');
    for (const res of [jpeg, png]) {
      expect(res.headers['content-type']).not.toContain('charset');
      expect(res.headers['content-length']).toBe(String(bodyOf(res).length));
    }
    for (const [id, marker] of [
      ['3', 'GIF89a'],
      ['4', '<svg'],
      ['5', '<!doctype html><p>hi'],
      ['6', '%PDF'],
      ['7', ''],
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one request at a time
      const res = await get(thumb(id, 'old'));
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(/^text\/html/);
      expect(textOf(res)).toContain('<!doctype html>');
      if (marker) {
        expect(textOf(res)).not.toContain(marker);
      }
    }
  });

  it('the thumb route never receives a member id', async () => {
    const reader = fakeIdentity([], { '1:old': PNG_1X1 });
    const { get } = await setup(reader);
    const res = await get(
      `${thumb('1', 'old')}?member=123&subjectId=456&memberId=789`,
    );
    expect(res.status).toBe(200);
    expect(reader.getChangeThumb).toHaveBeenCalledTimes(1);
    expect(reader.getChangeThumb).toHaveBeenCalledWith('1', 'old');
    expect(reader.listChangesPage).not.toHaveBeenCalled();
    expect(reader.listIdentityNames).not.toHaveBeenCalled();
    expect(reader.countChangesSince).not.toHaveBeenCalled();

    const router = createDashboardRouter({
      ...makeDeps().deps,
      protectedRoutes: (r) =>
        registerAllProtectedRoutes(r, {
          organizer: fakeOrganizerDeps(),
          pages: fakePageDeps(),
        }),
    });
    const thumbs = protectedRouteList(router).filter((r) =>
      r.path.includes('thumb'),
    );
    expect(thumbs.map((r) => r.path)).toEqual([DASHBOARD_PATHS.identityThumb]);
    expect(DASHBOARD_PATHS.identityThumb).not.toMatch(/:(memberId|subjectId)/);
  });

  it('skips the read when the client already went away', async () => {
    const reader = fakeIdentity([], { '1:old': PNG_1X1 });
    let destroyedBeforeRoute = false;
    const { server, cookie } = await setup(reader, {}, (r) => {
      r.use((req, _res, next) => {
        // An abandoned lazy request: the socket is gone before the route runs.
        req.socket.destroy();
        destroyedBeforeRoute = req.socket.destroyed;
        next();
      });
    });
    await rawRequest(server, 'GET', thumb('1', 'old'), {
      Cookie: cookie,
    }).catch(() => undefined);
    // Let the handler run to completion.
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(destroyedBeforeRoute).toBe(true);
    expect(reader.getChangeThumb).not.toHaveBeenCalled();
  });

  it('503 when the thumbnail read fails', async () => {
    const reader = fakeIdentity([], {});
    reader.getChangeThumb.mockRejectedValueOnce(new Error('pool'));
    const { get } = await setup(reader);
    const res = await get(thumb('1', 'old'));
    expect(res.status).toBe(503);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
  });

  it('an error after the image headers went out destroys the socket', async () => {
    const reader = fakeIdentity([], { '1:old': PNG_1X1 });
    // Make the one write fail part-way: the headers and four bytes go out,
    // then end() throws inside the route handler.
    const { server, cookie } = await setup(reader, {}, (r) => {
      r.use((_req, res, next) => {
        res.end = ((chunk: Buffer) => {
          res.write(chunk.subarray(0, 4));
          throw new Error('mid-image');
        }) as unknown as typeof res.end;
        next();
      });
    });
    fake.logged.length = 0;
    let reply: Awaited<ReturnType<typeof rawRequest>> | undefined;
    let failure: unknown;
    try {
      reply = await rawRequest(server, 'GET', thumb('1', 'old'), {
        Cookie: cookie,
      });
    } catch (error) {
      failure = error;
    }
    if (reply) {
      expect(reply.status).toBe(200);
      expect(reply.headers['content-type']).toBe('image/png');
      expect(reply.body).not.toContain('<!doctype html>');
      expect(reply.body).not.toContain('HTTP/1.1');
    } else {
      expect(String(failure)).toMatch(/ECONNRESET|socket hang up/);
    }
    expect(
      fake.logged.filter((l) =>
        l.startsWith('Dashboard error after the response started'),
      ),
    ).toHaveLength(1);
  });
});
