import { Logger } from 'tslog';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatHallOfFamePost } from '../../../src/lib/helpers/hallOfFame.js';
import { formatHostingStatsText } from '../../../src/lib/reports/hallOfFameReport.js';
import { Period } from '../../../src/lib/reports/period.js';
import {
  HallOfFameEvent,
  HallOfFamePayload,
  MemberRef,
} from '../../../src/lib/reports/types.js';
import {
  COPY_SCRIPT,
  PAGE_LOAD_DEADLINE_MS,
} from '../../../src/web/pageKit.js';
import {
  DashboardPageDeps,
  registerAllProtectedRoutes,
} from '../../../src/web/routes/dashboardPages.js';
import { commandPeriodLabel } from '../../../src/web/routes/hallOfFame.js';
import { neutralizeMentions } from '../../../src/lib/helpers/neutralizeMentions.js';
import {
  closeServers,
  makeApp,
  rawRequest,
  signIn,
} from '../dashboardHarness.js';
import {
  PAGE_NOW,
  REAL_EVENT_URL,
  SEPT,
  SeedRow,
  fakeMemberLinks,
  fakeOrganizerDeps,
  fakePageDeps,
  fakeSnapshots,
  hofPayload,
  seedRow,
} from './pageFakes.js';

afterEach(closeServers);

async function setup(
  rows: SeedRow[] = [seedRow('hall_of_fame', SEPT, hofPayload())],
  pages: Partial<DashboardPageDeps> = {},
) {
  const snapshots = fakeSnapshots(rows);
  const { req, server } = await makeApp({
    now: () => PAGE_NOW.getTime(),
    protectedRoutes: (r) =>
      registerAllProtectedRoutes(r, {
        organizer: fakeOrganizerDeps(),
        pages: fakePageDeps({ snapshots: async () => snapshots, ...pages }),
      }),
  });
  const cookie = await signIn(req);
  const get = (path: string) => req.get(path).set('Cookie', cookie);
  return { req, server, cookie, snapshots, get };
}

const MONTH = '/dashboard/hall-of-fame/2026-09';

const unescape = (text: string) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

/** The hosts table body: one <tr> per host row. */
const hostRows = (body: string) => {
  const tbody = /<tbody>([\s\S]*?)<\/tbody>/.exec(body)?.[1] ?? '';
  return tbody.match(/<tr>/g)?.length ?? 0;
};

describe('Hall of Fame month page', () => {
  it('escapes host names and event titles', async () => {
    const { get } = await setup();
    const res = await get(MONTH);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<script>alert');
    expect(res.text).not.toContain('<img src=x');
    expect(res.text).toMatch(/<bdi>&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  it('labels the per-event number RSVPs, never attendance', async () => {
    const { get } = await setup();
    const res = await get(MONTH);
    expect(res.text).toContain('7 RSVPs / 10 spots');
    expect(res.text).not.toMatch(/attend/i);
  });

  it('member links come from digit ids, never memberUrl', async () => {
    const { get } = await setup();
    const res = await get(MONTH);
    expect(res.text).not.toContain('evil.example');
    expect(res.text).toContain('href="https://www.meetup.com/members/1000/"');
  });

  it('event links pass safeHref or render as text', async () => {
    const { get } = await setup();
    const res = await get(MONTH);
    expect(res.text).not.toContain('href="javascript:');
    expect(res.text).not.toContain('javascript:alert');
    expect(res.text).toContain(`href="${REAL_EVENT_URL}"`);
  });

  it('copy text comes from a readonly textarea value', async () => {
    const { get } = await setup();
    const res = await get(MONTH);
    expect(res.text).toContain(
      '<textarea id="hof-post" class="copy" readonly>',
    );
    const scripts = [
      ...res.text.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g),
    ];
    expect(scripts).toHaveLength(1);
    expect(scripts[0][1]).toMatch(/^ nonce="[^"]+"$/);
    expect(scripts[0][2]).toBe(COPY_SCRIPT.value);
  });

  it("copy text matches the command's ready-to-post block", async () => {
    const payload = hofPayload();
    const { get } = await setup([seedRow('hall_of_fame', SEPT, payload)]);
    const res = await get(MONTH);
    const raw =
      /<textarea id="hof-post" class="copy" readonly>([\s\S]*?)<\/textarea>/.exec(
        res.text,
      )?.[1];
    const expected = formatHostingStatsText(payload, {
      periodLabel: '2026 September',
      showDates: false,
      includeLinks: false,
    }).split('----- READY TO POST -----\n\n')[1];
    expect(expected).toContain('Hall of Fame — 2026 September');
    // The page applies neutralizeMentions to the command's text. This
    // fixture's "<script>…</script>" host name is the only thing it touches.
    expect(neutralizeMentions(expected)).toBe(
      expected.replaceAll('</script>', '</\u200bscript>'),
    );
    expect(unescape(raw ?? '')).toBe(neutralizeMentions(expected));
  });

  it('neutralises @everyone, @here and <@…> mentions in the copy text only', async () => {
    const payload = hofPayload();
    payload.hosts[0].host = { ...payload.hosts[0].host, name: '@everyone' };
    payload.hosts[0].events[1] = {
      ...payload.hosts[0].events[1],
      title: '<@&123> and <@!456> and <@789> @here',
    };
    const { get } = await setup([seedRow('hall_of_fame', SEPT, payload)]);
    const res = await get(MONTH);
    const raw = unescape(
      /<textarea id="hof-post" class="copy" readonly>([\s\S]*?)<\/textarea>/.exec(
        res.text,
      )?.[1] ?? '',
    );
    const ZWSP = '\u200b';
    expect(raw).toContain(`@${ZWSP}everyone`);
    expect(raw).toContain(
      `<@${ZWSP}&123> and <@${ZWSP}!456> and <@${ZWSP}789> @${ZWSP}here`,
    );
    expect(raw).not.toMatch(/@everyone|@here|<@[&!0-9]/);
    // The command's own text is untouched: it is the shared formatter's.
    const command = formatHostingStatsText(payload, {
      periodLabel: '2026 September',
      showDates: false,
      includeLinks: false,
    }).split('----- READY TO POST -----\n\n')[1];
    expect(command).toContain('@everyone');
    expect(raw).toBe(neutralizeMentions(command));
    // The visible table shows the names and titles as stored.
    const table = /<tbody>([\s\S]*?)<\/tbody>/.exec(res.text)?.[1] ?? '';
    expect(table).toContain('<bdi>@everyone</bdi>');
    expect(table).toContain(
      '&lt;@&amp;123&gt; and &lt;@!456&gt; and &lt;@789&gt; @here',
    );
    expect(table).not.toContain(ZWSP);
  });

  it('commandPeriodLabel is the command label', () => {
    expect(commandPeriodLabel(SEPT)).toBe('2026 September');
    expect(commandPeriodLabel({ year: 2025, month: 1 })).toBe('2025 January');
  });

  it('paginates hosts at 50', async () => {
    const { get } = await setup();
    const first = await get(MONTH);
    expect(hostRows(first.text)).toBe(50);
    expect(first.text).toContain(`href="${MONTH}?page=2"`);
    expect(first.text).toContain('members/1049/');
    expect(first.text).not.toContain('members/1050/');
    const second = await get(`${MONTH}?page=2`);
    expect(hostRows(second.text)).toBe(10);
    expect(second.text).toMatch(/<td[^>]*>\s*51\s*<\/td>/);
    expect(second.text).toMatch(/<td[^>]*>\s*60\s*<\/td>/);
    expect(second.text).toContain('members/1050/');
    expect(second.text).not.toContain('members/1049/');
  });

  it('says not built yet with no snapshot, and offers a refresh', async () => {
    const { get } = await setup();
    const res = await get('/dashboard/hall-of-fame/2026-08');
    expect(res.status).toBe(200);
    expect(res.text).toContain('have not been built yet');
    expect(res.text).toContain('action="/dashboard/reports/2026-08/refresh"');
  });

  it("a month before the group's first is not found and offers no refresh", async () => {
    const { get, snapshots } = await setup();
    const before = await get('/dashboard/hall-of-fame/2013-02');
    expect(before.status).toBe(404);
    expect(before.text).not.toContain('/refresh"');
    expect(snapshots.getCurrent).not.toHaveBeenCalled();
    const first = await get('/dashboard/hall-of-fame/2013-03');
    expect(first.status).toBe(200);
    expect(first.text).toContain('action="/dashboard/reports/2013-03/refresh"');
  });

  it('the refresh form carries the CSRF token and its return page', async () => {
    const { get } = await setup();
    const res = await get(MONTH);
    expect(res.text).toContain('action="/dashboard/reports/2026-09/refresh"');
    expect(res.text).toMatch(/name="_csrf" value="[^"]+"/);
    expect(res.text).toContain('name="return" value="hall-of-fame"');
  });

  it('404 for a malformed or future month', async () => {
    const { get, snapshots, server, cookie } = await setup();
    for (const path of ['2026-9', '2026-13', '2026-11', '2026-09x']) {
      // eslint-disable-next-line no-await-in-loop -- one request at a time, so a failure names its path
      const res = await get(`/dashboard/hall-of-fame/${path}`);
      expect(res.status, path).toBe(404);
    }
    // Sent byte for byte: an HTTP client would resolve the dot segment.
    const dots = await rawRequest(
      server,
      'GET',
      '/dashboard/hall-of-fame/%2E%2E',
      {
        Cookie: cookie,
      },
    );
    expect(dots.status).toBe(404);
    expect(snapshots.getCurrent).not.toHaveBeenCalled();
  });

  it('503 without details when the snapshot read fails', async () => {
    const { get } = await setup(undefined, {
      snapshots: () => Promise.reject(new Error('password=hunter2')),
    });
    const res = await get(MONTH);
    expect(res.status).toBe(503);
    expect(res.text).not.toContain('hunter2');
    const list = await get('/dashboard/hall-of-fame');
    expect(list.status).toBe(503);
    expect(list.text).not.toContain('hunter2');
  });

  it('503 when the stored payload is not a Hall of Fame report', async () => {
    const { get } = await setup([
      seedRow('hall_of_fame', SEPT, { junk: true }),
    ]);
    const res = await get(MONTH);
    expect(res.status).toBe(503);
  });

  it('503, not 500, when a stored host entry is malformed', async () => {
    const good = hofPayload().hosts[1];
    const malformed: unknown[][] = [
      [null],
      ['host'],
      [{ events: [] }],
      [{ host: null, events: [] }],
      [{ host: good.host }],
      [{ host: good.host, events: 'x' }],
      [{ host: good.host, events: [null] }],
      [good, { host: good.host, events: {} }],
    ];
    for (const hosts of malformed) {
      // eslint-disable-next-line no-await-in-loop -- one payload at a time, so a failure names it
      const { get } = await setup([
        seedRow('hall_of_fame', SEPT, { ...hofPayload(), hosts }),
      ]);
      // eslint-disable-next-line no-await-in-loop -- one payload at a time, so a failure names it
      const res = await get(MONTH);
      expect(res.status, JSON.stringify(hosts)).toBe(503);
      expect(res.text).toContain('cannot be loaded right now');
    }
  });

  it('never says incomplete', async () => {
    const { get } = await setup();
    for (const path of [
      MONTH,
      '/dashboard/hall-of-fame/2026-08',
      '/dashboard/hall-of-fame',
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one request at a time, so a failure names its path
      const res = await get(path);
      expect(res.text, path).not.toMatch(/incomplete/i);
    }
  });
});

describe('Hall of Fame months list', () => {
  const months = (n: number): SeedRow[] =>
    Array.from({ length: n }, (_, i) => {
      const period: Period = {
        year: 2026 - Math.floor((i + 3) / 12),
        month: 12 - ((i + 3) % 12),
      };
      return seedRow('hall_of_fame', period, null, {
        summary: { events: 4, hosts: 3, newHosts: 1 },
      });
    });

  it('lists months with links and summary numbers', async () => {
    const { get } = await setup([
      seedRow('hall_of_fame', SEPT, null, {
        summary: { events: 12, hosts: 7, newHosts: 2 },
      }),
      seedRow('hall_of_fame', { year: 2026, month: 8 }, null, {
        summary: { events: '<b>', hosts: null, newHosts: 1 },
      }),
    ]);
    const res = await get('/dashboard/hall-of-fame');
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/dashboard/hall-of-fame/2026-09"');
    expect(res.text).toContain('href="/dashboard/hall-of-fame/2026-08"');
    expect(res.text).toMatch(/<td[^>]*>\s*12\s*<\/td>/);
    expect(res.text).not.toContain('<b>');
    expect(res.text).not.toContain('&lt;b&gt;');
    expect(res.text).not.toMatch(/incomplete/i);
  });

  it('a stored month before the group began is listed unlinked, not a 500', async () => {
    const { get } = await setup([
      seedRow('hall_of_fame', SEPT, null, {
        summary: { events: 12, hosts: 7, newHosts: 2 },
      }),
      seedRow('hall_of_fame', { year: 2013, month: 3 }, null, {
        summary: { events: 1, hosts: 1, newHosts: 1 },
      }),
      seedRow('hall_of_fame', { year: 2013, month: 2 }, null, {
        summary: { events: 1, hosts: 1, newHosts: 1 },
      }),
    ]);
    const res = await get('/dashboard/hall-of-fame');
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/dashboard/hall-of-fame/2026-09"');
    expect(res.text).toContain('href="/dashboard/hall-of-fame/2013-03"');
    expect(res.text).not.toContain('2013-02');
    expect(res.text).toMatch(/<td[^>]*>\s*February 2013\s*<\/td>/);
    expect(res.text).not.toMatch(/<a[^>]*>\s*February 2013/);
  });

  it('months list pages with before and ignores junk', async () => {
    const { get, snapshots } = await setup();
    await get('/dashboard/hall-of-fame?before=2026-05');
    expect(snapshots.listSummaries).toHaveBeenLastCalledWith('hall_of_fame', {
      before: { year: 2026, month: 5 },
      limit: 50,
    });
    await get('/dashboard/hall-of-fame?before=2026-5');
    expect(snapshots.listSummaries).toHaveBeenLastCalledWith('hall_of_fame', {
      before: undefined,
      limit: 50,
    });
    await get('/dashboard/hall-of-fame?before=2026-05&before=2026-04');
    expect(snapshots.listSummaries).toHaveBeenLastCalledWith('hall_of_fame', {
      before: undefined,
      limit: 50,
    });
  });

  it('links older months only when a full page came back', async () => {
    const rows = months(51);
    const { get } = await setup(rows);
    const res = await get('/dashboard/hall-of-fame');
    const last = rows[49].meta.period;
    const key = `${last.year}-${String(last.month).padStart(2, '0')}`;
    expect(res.text).toContain(`href="/dashboard/hall-of-fame?before=${key}"`);
    const few = await (await setup(months(3))).get('/dashboard/hall-of-fame');
    expect(few.text).not.toContain('?before=');
  });

  it('says so when nothing is stored yet', async () => {
    const { get } = await setup([]);
    const res = await get('/dashboard/hall-of-fame');
    expect(res.status).toBe(200);
    expect(res.text).toContain('No Hall of Fame reports');
  });
});

describe('Hall of Fame mention copy text', () => {
  const ZWSP = '\u200b';
  const ANN = '111111111111111111';
  const BOB = '22222222222222222222';
  const member = (id: string, name: string): MemberRef => ({
    id,
    name,
    memberUrl: `https://www.meetup.com/members/${id}/`,
  });
  const ann = member('2001', 'Ann');
  const bob = member('2002', 'Bob');
  const everyone = member('2003', '@everyone');
  const dee = member('2004', 'Dee');
  const event = (
    id: string,
    title: string,
    hosts: MemberRef[],
  ): HallOfFameEvent => ({
    id,
    title,
    eventUrl: `https://www.meetup.com/1-5genasians/events/${id}/`,
    dateTime: '2026-09-04T02:00:00.000Z',
    maxTickets: 10,
    attendance: 7,
    eventHosts: hosts.map((m) => ({ member: m })),
  });
  const games = event('31', 'Board games', [ann, bob, everyone]);
  const pings = event('32', '<@&123> @here', [dee]);

  /** Ann (new) co-hosts with Bob and "@everyone"; Dee hosts a title full of pings. */
  function mentionPayload(): HallOfFamePayload {
    return {
      version: 1,
      reportType: 'hall_of_fame',
      period: '2026-09',
      asOf: '2026-10-01T07:00:00.000Z',
      summary: { events: 2, hosts: 4, newHosts: 1 },
      totalEvents: 2,
      hosts: [
        { host: ann, isNew: true, events: [games] },
        { host: bob, isNew: false, events: [games] },
        { host: everyone, isNew: false, events: [games] },
        { host: dee, isNew: false, events: [pings] },
      ],
    };
  }

  // Ann and Bob linked with valid ids; Dee's stored id is 4 digits; "@everyone" unlinked.
  const LINKS = { '2001': ANN, '2002': BOB, '2004': '1234' };

  const EXPECTED = [
    '**Hall of Fame — 2026 September**',
    '',
    `**#1: <@${ANN}> — 1 event** 🆕`,
    '    Board games (Sep 3)',
    `**#2: <@${BOB}> — 1 event**`,
    '    Board games (Sep 3)',
    `**#3: @${ZWSP}everyone — 1 event**`,
    '    Board games (Sep 3)',
    '**#4: Dee — 1 event**',
    `    <@${ZWSP}&123> @${ZWSP}here (Sep 3)`,
    '',
    `New hosts: <@${ANN}> (co-hosts: <@${BOB}>, @${ZWSP}everyone)`,
    '',
    '**Hosts: 4 · Events: 2**',
  ].join('\n');

  const textarea = (body: string, id: string) =>
    new RegExp(
      `<textarea id="${id}" class="copy" readonly>([\\s\\S]*?)</textarea>`,
    ).exec(body)?.[1];

  async function page(
    links: Partial<DashboardPageDeps> = {
      memberLinks: async () => fakeMemberLinks(LINKS),
    },
    payload = mentionPayload(),
  ) {
    const { get } = await setup(
      [seedRow('hall_of_fame', SEPT, payload)],
      links,
    );
    return get(MONTH);
  }

  const plainOf = (payload: HallOfFamePayload) =>
    neutralizeMentions(
      formatHallOfFamePost({
        periodLabel: '2026 September',
        hostStats: payload.hosts,
        totalEvents: payload.totalEvents,
        newHostIds: new Set(
          payload.hosts.filter((h) => h.isNew).map((h) => h.host.id),
        ),
      }),
    );

  it('mentions linked hosts and co-hosts, names everyone else, defuses Meetup text', async () => {
    const res = await page();
    expect(res.status).toBe(200);
    const raw = textarea(res.text, 'hof-post-mentions');
    expect(raw).toBeDefined();
    expect(unescape(raw ?? '')).toBe(EXPECTED);
  });

  it("keeps the bot's own mentions live and lets no other ping through", async () => {
    const res = await page();
    const text = unescape(textarea(res.text, 'hof-post-mentions') ?? '');
    expect(text).toContain(`<@${ANN}>`);
    expect(text).toContain(`<@${BOB}>`);
    expect(text).not.toContain(`<@${ZWSP}${ANN}>`);
    const live = [...text.matchAll(/<@[^\u200b]/g)].length;
    expect(live).toBe(4); // Ann twice, Bob twice
    expect(text).not.toMatch(/@everyone|@here|<@&|<@!/);
  });

  it('defuses typed @Name, <#channel> and </command> in both boxes; linked mentions stay live', async () => {
    const payload = mentionPayload();
    const moderator = member('2003', '@Moderator');
    const channel = member('2004', '#general-ish <#123>');
    const command = member('2005', '</ping:1>');
    payload.hosts[2].host = moderator;
    payload.hosts[3].host = channel;
    payload.hosts.push({
      host: command,
      isNew: false,
      events: [event('33', 'Karaoke', [command])],
    });
    const res = await page(undefined, payload);
    const mentions = unescape(textarea(res.text, 'hof-post-mentions') ?? '');
    const plain = unescape(textarea(res.text, 'hof-post') ?? '');
    for (const text of [mentions, plain]) {
      expect(text).toContain(`@${ZWSP}Moderator`);
      expect(text).toContain(`#general-ish <#${ZWSP}123>`);
      expect(text).toContain(`</${ZWSP}ping:1>`);
      expect(text).not.toMatch(/@Moderator|<#123|<\/ping/);
    }
    expect(mentions).toContain(`**#1: <@${ANN}> — 1 event**`);
    expect(mentions).toContain(`<@${BOB}>`);
    // The plain box has no live @ at all; the mention box only the bot's.
    expect(plain).not.toMatch(/@(?!\u200b)/);
    expect([...mentions.matchAll(/@(?!\u200b)/g)]).toHaveLength(4);
  });

  it('an invalid stored id appears by name, never as a mention', async () => {
    const res = await page();
    const text = unescape(textarea(res.text, 'hof-post-mentions') ?? '');
    expect(text).toContain('**#4: Dee — 1 event**');
    expect(text).not.toContain('<@1234>');
  });

  it('the textarea content is escaped text', async () => {
    const res = await page();
    expect(res.text).toContain(`&lt;@${ANN}&gt;`);
    expect(res.text).not.toContain(`<@${ANN}>`);
  });

  it('asks once for every distinct person in the text', async () => {
    const links = fakeMemberLinks(LINKS);
    await page({ memberLinks: async () => links });
    expect(links.discordIdsByMeetupIds).toHaveBeenCalledTimes(1);
    expect(links.discordIdsByMeetupIds.mock.calls[0][0]).toEqual([
      '2001',
      '2002',
      '2003',
      '2004',
    ]);
  });

  it('says how many people appear by name', async () => {
    const res = await page();
    expect(res.text).toContain(
      '2 of 4 people have no linked Discord account and appear by name.',
    );
  });

  it('no unlinked line when every person is linked', async () => {
    const res = await page({
      memberLinks: async () =>
        fakeMemberLinks({
          '2001': ANN,
          '2002': BOB,
          '2003': '333333333333333333',
          '2004': '444444444444444444',
        }),
    });
    expect(textarea(res.text, 'hof-post-mentions')).toBeDefined();
    expect(res.text).not.toContain('no linked Discord account');
  });

  it('the copy button names the mention textarea', async () => {
    const res = await page();
    expect(res.text).toContain(
      '<button type="button" data-copy="hof-post-mentions">Copy</button>',
    );
    expect(res.text).toContain('<h2>Ready to post (with mentions)</h2>');
    expect(res.text.indexOf('id="hof-post"')).toBeLessThan(
      res.text.indexOf('id="hof-post-mentions"'),
    );
  });

  it('the plain box is unchanged next to the mention box', async () => {
    const payload = mentionPayload();
    const res = await page(undefined, payload);
    const plain = unescape(textarea(res.text, 'hof-post') ?? '');
    expect(plain).toBe(plainOf(payload));
    expect(plain).toContain('**#1: Ann — 1 event** 🆕');
    expect(plain).not.toContain(ANN);
  });

  it('a stored host or title that is not a string is still a 200', async () => {
    const payload = mentionPayload();
    payload.hosts[2].host = { ...everyone, name: undefined };
    payload.hosts[3].events = [{ ...pings, title: 42 as never }];
    const res = await page(undefined, payload);
    expect(res.status).toBe(200);
    const text = unescape(textarea(res.text, 'hof-post-mentions') ?? '');
    expect(text).toContain('**#3: undefined — 1 event**');
    expect(text).toContain('    42 (Sep 3)');
  });

  const FALLBACK =
    'Mentions are unavailable right now; use the text above and add mentions by hand.';

  for (const [label, memberLinks] of [
    [
      'the repository cannot be opened',
      () => Promise.reject(new Error('password=hunter2')),
    ],
    [
      'the lookup rejects',
      async () => ({
        discordIdsByMeetupIds: () =>
          Promise.reject(new Error('password=hunter2')),
      }),
    ],
  ] as const) {
    it(`falls back to a fixed line when ${label}`, async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn');
      try {
        const payload = mentionPayload();
        const res = await page({ memberLinks }, payload);
        expect(res.status).toBe(200);
        expect(res.text).toContain(FALLBACK);
        expect(textarea(res.text, 'hof-post-mentions')).toBeUndefined();
        expect(res.text).not.toContain('data-copy="hof-post-mentions"');
        expect(unescape(textarea(res.text, 'hof-post') ?? '')).toBe(
          plainOf(payload),
        );
        expect(res.text).toContain('<h2>Hosts</h2>');
        expect(res.text).not.toContain('hunter2');
        expect(JSON.stringify(warn.mock.calls)).not.toContain('hunter2');
      } finally {
        warn.mockRestore();
      }
    });
  }

  it('falls back at the page deadline when the lookup never settles', async () => {
    const payload = mentionPayload();
    const { req, cookie } = await setup(
      [seedRow('hall_of_fame', SEPT, payload)],
      {
        memberLinks: async () => ({
          discordIdsByMeetupIds: () => new Promise<never>(() => undefined),
        }),
      },
    );
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const settled = Promise.resolve(req.get(MONTH).set('Cookie', cookie));
      for (let i = 0; i < 20; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- let the socket I/O run between clock steps
        await new Promise<void>((r) => {
          setImmediate(r);
        });
        // eslint-disable-next-line no-await-in-loop -- see above
        await vi.advanceTimersByTimeAsync(PAGE_LOAD_DEADLINE_MS);
      }
      const res = await settled;
      expect(res.status).toBe(200);
      expect(res.text).toContain(FALLBACK);
      expect(unescape(textarea(res.text, 'hof-post') ?? '')).toBe(
        plainOf(payload),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
