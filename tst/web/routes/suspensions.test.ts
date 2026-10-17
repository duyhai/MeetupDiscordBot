import { afterEach, describe, expect, it } from 'vitest';

import {
  SuspensionPageRow,
  SuspensionState,
} from '../../../src/lib/repositories/postgresSuspensionRepository.js';
import {
  DashboardPageDeps,
  registerAllProtectedRoutes,
} from '../../../src/web/routes/dashboardPages.js';
import { closeServers, makeApp, signIn } from '../dashboardHarness.js';
import {
  PAGE_NOW,
  fakeOrganizerDeps,
  fakePageDeps,
  fakeSuspensions,
  suspensionRow,
} from './pageFakes.js';

afterEach(closeServers);

const PAGE = '/dashboard/suspensions';

async function setup(
  rows: Partial<Record<SuspensionState, SuspensionPageRow[]>> = {
    active: [suspensionRow()],
  },
  pages: Partial<DashboardPageDeps> = {},
  now: Date = PAGE_NOW,
) {
  const reader = fakeSuspensions(rows);
  const { req } = await makeApp({
    now: () => now.getTime(),
    protectedRoutes: (r) =>
      registerAllProtectedRoutes(r, {
        organizer: fakeOrganizerDeps(),
        pages: fakePageDeps({
          now: () => now,
          suspensions: async () => reader,
          ...pages,
        }),
      }),
  });
  const cookie = await signIn(req);
  const get = (path: string) => req.get(path).set('Cookie', cookie);
  return { reader, get };
}

/** Page text with tags dropped and whitespace collapsed, for sentence checks. */
const words = (body: string) =>
  body
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const tbodyRows = (body: string) => {
  const tbody = /<tbody>([\s\S]*?)<\/tbody>/.exec(body)?.[1] ?? '';
  return tbody.match(/<tr>/g)?.length ?? 0;
};

describe('suspension records page', () => {
  it('defaults to active and passes Pacific today', async () => {
    // 11:30pm PDT on Sept 30: UTC has already rolled over to Oct 1.
    const { reader, get } = await setup(
      undefined,
      {},
      new Date('2026-10-01T06:30:00Z'),
    );
    const res = await get(PAGE);
    expect(res.status).toBe(200);
    expect(reader.listPage).toHaveBeenCalledWith({
      state: 'active',
      today: '2026-09-30',
      offset: 0,
      limit: 50,
    });
    expect(reader.countByState).toHaveBeenCalledWith('2026-09-30');
    expect(words(res.text)).toContain(
      'Same split as /meetup_list_suspensions: active through the last suspended day, Pacific time.',
    );
  });

  it('junk state falls back to active', async () => {
    const { reader, get } = await setup();
    for (const q of ['?state=everything', '?state=', '?state[]=voided']) {
      // eslint-disable-next-line no-await-in-loop -- one request at a time
      const res = await get(`${PAGE}${q}`);
      expect(res.status, q).toBe(200);
      expect(reader.listPage, q).toHaveBeenLastCalledWith(
        expect.objectContaining({ state: 'active' }),
      );
    }
  });

  it('shows each tab with its count, linking the other tabs', async () => {
    const { reader, get } = await setup({
      active: [suspensionRow(), suspensionRow()],
      past: [suspensionRow()],
      voided: [],
    });
    const res = await get(`${PAGE}?state=past`);
    expect(reader.listPage).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'past' }),
    );
    const text = words(res.text);
    expect(text).toContain('Active (2)');
    expect(text).toContain('Past (1)');
    expect(text).toContain('Voided (0)');
    expect(res.text).toContain('href="/dashboard/suspensions?state=active"');
    expect(res.text).toContain('href="/dashboard/suspensions?state=voided"');
    expect(text).not.toContain('Same split as');
  });

  it('shows a record: id, member, dates, duration and notes', async () => {
    const { get } = await setup({
      active: [
        suspensionRow({
          id: 42,
          memberId: '123456',
          memberName: 'Alice',
          suspendedAt: new Date('2026-09-15T00:00:00Z'),
          durationDays: 60,
          lastDay: '2026-11-13',
          notes: 'third no-show',
        }),
      ],
    });
    const res = await get(PAGE);
    const text = words(res.text);
    expect(text).toContain('#42');
    expect(text).toContain('Alice');
    expect(text).toContain('2026-09-15 through 2026-11-13');
    expect(text).toContain('60 days');
    expect(text).toContain('third no-show');
    expect(res.text).toContain('href="https://www.meetup.com/members/123456/"');
    expect(res.text).toContain(
      'href="/dashboard/no-show-history/members/123456"',
    );
    // Active rows have no void columns.
    expect(text).not.toContain('Voided by');
  });

  it('names: the stored name, then the linked name, then the id', async () => {
    const { get } = await setup({
      active: [
        suspensionRow({
          memberId: '111',
          memberName: 'Stored Sam',
          linkedName: 'Linked Lin',
        }),
        suspensionRow({
          memberId: '222',
          memberName: null,
          linkedName: 'Linked Lou',
          linkedDiscordId: '323456789012345678',
        }),
        suspensionRow({ memberId: '333', memberName: null, linkedName: null }),
      ],
    });
    const res = await get(PAGE);
    const text = words(res.text);
    expect(text).toContain('Stored Sam');
    expect(text).not.toContain('Linked Lin');
    expect(text).toContain('Linked Lou');
    expect(res.text).toContain('<bdi>333</bdi>');
    expect(res.text).toContain(
      'href="https://discord.com/users/323456789012345678"',
    );
  });

  it('shows void reason and who voided', async () => {
    const { get } = await setup({
      voided: [
        suspensionRow({
          voidedAt: new Date('2026-09-03T02:00:00Z'),
          voidedBy: '123456789012345678',
          voidReason: '<b>x</b>',
        }),
        suspensionRow({
          voidedAt: new Date('2026-09-02T02:00:00Z'),
          voidedBy: 'not-a-discord-id',
          voidReason: 'typo‮',
        }),
      ],
    });
    const res = await get(`${PAGE}?state=voided`);
    expect(res.status).toBe(200);
    expect(res.text).toContain(
      'href="https://discord.com/users/123456789012345678"',
    );
    expect(res.text).toContain('<bdi>&lt;b&gt;x&lt;/b&gt;</bdi>');
    expect(res.text).not.toContain('<b>x</b>');
    expect(res.text).toContain('<bdi>typo‮</bdi>');
    expect(res.text).not.toContain('not-a-discord-id');
    const text = words(res.text);
    // 7pm PDT on Sept 2.
    expect(text).toContain('Sep 2, 2026 7:00 PM');
    expect(text).toContain('moderator');
  });

  it('escapes names and notes', async () => {
    const { get } = await setup({
      active: [
        suspensionRow({
          memberName: '<script>alert(1)</script>‮',
          notes: '"><img src=x onerror=alert(1)>',
        }),
      ],
    });
    const res = await get(PAGE);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<script>alert(1)');
    expect(res.text).not.toContain('<img src=x');
    expect(res.text).toContain(
      '<bdi>&lt;script&gt;alert(1)&lt;/script&gt;‮</bdi>',
    );
    expect(res.text).toContain(
      '<bdi>&quot;&gt;&lt;img src=x onerror=alert(1)&gt;</bdi>',
    );
  });

  it('member links only from digit ids', async () => {
    const { get } = await setup({
      active: [
        suspensionRow({
          memberId: 'abc',
          memberName: 'No Link',
          linkedDiscordId: '12',
        }),
      ],
    });
    const res = await get(PAGE);
    expect(res.status).toBe(200);
    expect(words(res.text)).toContain('No Link');
    expect(res.text).not.toContain('meetup.com/members');
    expect(res.text).not.toContain('/no-show-history/members/');
    expect(res.text).not.toContain('discord.com/users/12"');
  });

  it('paginates at 50', async () => {
    const many = Array.from({ length: 120 }, () => suspensionRow());
    const { reader, get } = await setup({ past: many });
    const first = await get(`${PAGE}?state=past`);
    expect(tbodyRows(first.text)).toBe(50);
    expect(first.text).toContain(
      'href="/dashboard/suspensions?state=past&amp;page=2"',
    );
    const second = await get(`${PAGE}?state=past&page=2`);
    expect(reader.listPage).toHaveBeenLastCalledWith({
      state: 'past',
      today: '2026-10-05',
      offset: 50,
      limit: 50,
    });
    expect(tbodyRows(second.text)).toBe(50);
    expect(second.text).toContain(
      'href="/dashboard/suspensions?state=past&amp;page=1"',
    );
    const third = await get(`${PAGE}?state=past&page=3`);
    expect(tbodyRows(third.text)).toBe(20);
    expect(third.text).not.toContain('page=4');
  });

  it('says plainly when a tab is empty', async () => {
    const { get } = await setup({ active: [] });
    const res = await get(PAGE);
    expect(res.status).toBe(200);
    expect(words(res.text)).toContain('No active suspensions.');
  });

  it('503 when the read fails, without details', async () => {
    const { get } = await setup(undefined, {
      suspensions: () => Promise.reject(new Error('password=hunter2')),
    });
    const res = await get(PAGE);
    expect(res.status).toBe(503);
    expect(res.text).not.toContain('hunter2');
    expect(words(res.text)).toContain('Suspension records cannot be loaded');
  });

  it('503 when a query rejects', async () => {
    const reader = fakeSuspensions();
    reader.listPage.mockRejectedValue(new Error('connection reset'));
    const { get } = await setup(undefined, {
      suspensions: async () => reader,
    });
    const res = await get(PAGE);
    expect(res.status).toBe(503);
    expect(res.text).not.toContain('connection reset');
  });

  it('503, not 500, when a row has the wrong shape', async () => {
    for (const bad of [
      { suspendedAt: 'not a date' as unknown as Date },
      { suspendedAt: new Date('nope') },
      { lastDay: 42 as unknown as string },
      { durationDays: '30' as unknown as number },
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one app at a time
      const { get } = await setup({ active: [suspensionRow(bad)] });
      // eslint-disable-next-line no-await-in-loop -- one request at a time
      const res = await get(PAGE);
      expect(res.status, JSON.stringify(bad)).toBe(503);
    }
  });

  it('503 when a voided row lacks a valid voidedAt or a text field has the wrong type', async () => {
    const voided = (o: Partial<SuspensionPageRow>) =>
      suspensionRow({
        voidedAt: new Date('2026-09-02T17:00:00Z'),
        voidedBy: '123456789012345678',
        voidReason: 'dup',
        ...o,
      });
    const bad = <T>(v: unknown) => v as T;
    const cases: [SuspensionState, SuspensionPageRow][] = [
      ['voided', voided({ voidedAt: null })],
      ['voided', voided({ voidedAt: bad<Date>('2026-09-02T17:00:00Z') })],
      ['voided', voided({ voidedAt: new Date('nope') })],
      ['voided', voided({ voidReason: bad<string>(42) })],
      ['voided', voided({ voidedBy: bad<string>({ id: 1 }) })],
      ['active', suspensionRow({ notes: bad<string>(['x']) })],
      ['active', suspensionRow({ memberName: bad<string>(7) })],
      ['active', suspensionRow({ linkedName: bad<string>(true) })],
      ['active', suspensionRow({ linkedDiscordId: bad<string>(123) })],
    ];
    for (const [state, row] of cases) {
      // eslint-disable-next-line no-await-in-loop -- one app at a time
      const { get } = await setup({ [state]: [row] });
      // eslint-disable-next-line no-await-in-loop -- one request at a time
      const res = await get(`${PAGE}?state=${state}`);
      expect(res.status, `${state} ${JSON.stringify(row)}`).toBe(503);
    }
    // undefined text fields are fine.
    const { get } = await setup({
      voided: [
        voided({
          notes: bad<string>(undefined),
          linkedName: bad<string>(undefined),
        }),
      ],
    });
    expect((await get(`${PAGE}?state=voided`)).status).toBe(200);
  });
});
