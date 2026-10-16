import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MeetupGetEventStatsCommands } from '../../../src/commands/meetup/getEventStats.js';
import { ApplicationCache } from '../../../src/util/cache.js';
import { WORLD_2026 } from '../../fixtures/meetup/world2026.js';
import { installMeetupResponder } from '../../fixtures/meetup/graphqlResponder.js';
import { FakeCache } from '../../web/fakeCache.js';
import { GoldenEvent, fakeInteraction, transcript } from './goldenHarness.js';

const USER_TOKEN = 'golden-user-token';

const recorder = vi.hoisted(() => {
  const events: unknown[] = [];
  return {
    events: events as GoldenEvent[],
    reset() {
      events.length = 0;
    },
  };
});

vi.mock('../../../src/util/discord.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/util/discord.js')>();
  return {
    ...actual, // keeps linkStr real
    discordCommandWrapper: vi.fn(
      async (_interaction: unknown, fn: () => Promise<void>) => {
        await fn();
      },
    ),
    requireModOrOrganizer: vi.fn().mockResolvedValue(undefined),
    logModerationAction: vi.fn(
      async (_interaction: unknown, entry: unknown) => {
        recorder.events.push({ kind: 'moderationLog', entry });
      },
    ),
    withDiscordFileAttachment: vi.fn(
      async (
        fileName: string,
        data: string,
        handler: (args: unknown) => Promise<void>,
      ) => {
        recorder.events.push({
          kind: 'attachment',
          fileName,
          data: String(data),
        });
        await handler({
          files: [{ attachment: 'golden.tmp', name: fileName }],
        });
      },
    ),
  };
});
vi.mock('../../../src/util/meetup.js', async () => {
  const { GqlMeetupClient } =
    await import('../../../src/lib/client/meetup/gqlClient.js');
  return {
    withMeetupClient: vi.fn(
      async (_interaction: unknown, fn: (client: unknown) => Promise<void>) =>
        fn(new GqlMeetupClient('golden-user-token')),
    ),
  };
});
// Every test gets a fresh FakeCache: the real singleton outlives a test and
// its keys ignore the token, so one test's answers would feed the next.
vi.mock('../../../src/util/cache.js', () => ({ ApplicationCache: vi.fn() }));

let responder: ReturnType<typeof installMeetupResponder>;

beforeEach(() => {
  recorder.reset();
  vi.mocked(ApplicationCache).mockResolvedValue(new FakeCache() as never);
  responder = installMeetupResponder(WORLD_2026, { maxPageSize: 2 });
});

afterEach(() => {
  // Cleanup first, so a failed expectation below cannot leak fake timers or
  // interceptors into the next test.
  nock.cleanAll();
  vi.useRealTimers();
  expect(responder.unhandled()).toEqual([]);
  // A handler error would reach the code as a GraphQL error; a later
  // try/catch or allSettled must not be able to hide one.
  expect(responder.failures()).toEqual([]);
  expect(responder.calls.length).toBeGreaterThan(0);
  responder.calls.forEach((call) => {
    expect(call.authorization).toBe(`Bearer ${USER_TOKEN}`);
  });
});

// Only Date is faked: undici and nock need the real timers.
function freezeAt(iso: string) {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(iso) });
}

const commands = new MeetupGetEventStatsCommands();

function hostStats(
  year: number,
  month: number,
  showDates?: boolean,
  includeLinks?: boolean,
) {
  return commands.meetupGetHostEventStatsHandler(
    year,
    month,
    showDates,
    includeLinks,
    fakeInteraction(recorder),
  );
}

function attachment() {
  const found = recorder.events.find((e) => e.kind === 'attachment');
  if (found?.kind !== 'attachment') {
    throw new Error('no attachment recorded');
  }
  return found;
}

function followUpContents() {
  const contents: (string | undefined)[] = [];
  recorder.events.forEach((e) => {
    if (e.kind === 'followUp') {
      contents.push(e.args.content);
    }
  });
  return contents;
}

function logEntry() {
  const found = recorder.events.find((e) => e.kind === 'moderationLog');
  if (found?.kind !== 'moderationLog') {
    throw new Error('no moderation log recorded');
  }
  return found.entry as {
    title: string;
    description: string;
    fields: { name: string; value: string }[];
  };
}

describe('/meetup_get_host_event_stats goldens', () => {
  it('host stats, September 2026, with links and dates', async () => {
    freezeAt('2026-10-05T17:00:00Z');

    await hostStats(2026, 9);

    const file = attachment();
    expect(file.fileName).toBe('**Hosting stats for 2026 September**.txt');
    expect(file.data).toContain(
      '**#1: 3 [Ava Host](https://www.meetup.com/members/101/) ID: 101**',
    );
    expect(file.data).toContain('ID: 104** 🆕');
    expect(file.data).toContain('[Board Game Night (4/20)](');
    expect(file.data).toContain('**Total: 4**');
    expect(file.data).toContain('New hosts: Dee New (co-hosts: Ben Host)');
    expect(file.data).toContain('Board Game Night ×2 (Sep 3, Sep 17)');
    expect(file.data).toContain('**Hosts: 3 · Events: 4**');
    expect(file.data).not.toContain('Picnic');
    expect(file.data).not.toContain('Open House');
    expect(file.data).not.toContain('October Kickoff');
    expect(followUpContents()).toEqual([
      'Check the results in the attachment!',
    ]);
    expect(logEntry().fields).toEqual([
      { name: 'Events', value: '4', inline: true },
      { name: 'Hosts', value: '3', inline: true },
    ]);
    await expect(transcript(recorder)).toMatchFileSnapshot(
      './__goldens__/hostStats-2026-09.golden.txt',
    );
  });

  it('host stats, September 2026, without links or dates', async () => {
    freezeAt('2026-10-05T17:00:00Z');

    await hostStats(2026, 9, false, false);

    const file = attachment();
    expect(file.data).toContain('**#1: 3 Ava Host ID: 101**');
    expect(file.data).not.toContain('](');
    await expect(transcript(recorder)).toMatchFileSnapshot(
      './__goldens__/hostStats-2026-09-plain.golden.txt',
    );
  });

  it('host stats, March 2026, across the start of daylight saving time', async () => {
    freezeAt('2026-04-05T17:00:00Z');

    await hostStats(2026, 3);

    const file = attachment();
    expect(file.data).toContain('First of March Brunch');
    expect(file.data).toContain('End of March Trivia');
    expect(file.data).not.toContain('Leap Night Karaoke');
    expect(file.data).not.toContain('April Fools Run');
    expect(file.data).toMatch(/\*\*#1: 2 .*Cy Host.* ID: 103\*\* 🆕/);
    await expect(transcript(recorder)).toMatchFileSnapshot(
      './__goldens__/hostStats-2026-03.golden.txt',
    );
  });

  it('host stats, November 2026, across the end of daylight saving time', async () => {
    freezeAt('2026-12-03T17:00:00Z');

    await hostStats(2026, 11);

    const file = attachment();
    expect(file.data).toContain('Day of the Dead Walk');
    expect(file.data).toContain('Last Night of November');
    expect(file.data).not.toContain('Halloween Late Show');
    expect(file.data).not.toContain('December Kickoff');
    expect(file.data).not.toContain('🆕');
    await expect(transcript(recorder)).toMatchFileSnapshot(
      './__goldens__/hostStats-2026-11.golden.txt',
    );
  });

  it('host stats, July 2026 has no events', async () => {
    freezeAt('2026-08-05T17:00:00Z');

    await hostStats(2026, 7);

    expect(attachment().data).toContain('**Total: 0**');
    expect(logEntry().fields).toEqual([
      { name: 'Events', value: '0', inline: true },
      { name: 'Hosts', value: '0', inline: true },
    ]);
    await expect(transcript(recorder)).toMatchFileSnapshot(
      './__goldens__/hostStats-2026-07.golden.txt',
    );
  });

  it('host stats, whole year 2026', async () => {
    freezeAt('2026-12-15T17:00:00Z');

    await hostStats(2026, 0);

    expect(attachment().fileName).toBe('**Hosting stats for 2026**.txt');
    expect(logEntry().description.endsWith('for 2026 (whole year).')).toBe(
      true,
    );
    await expect(transcript(recorder)).toMatchFileSnapshot(
      './__goldens__/hostStats-2026.golden.txt',
    );
  });
});

describe('/meetup_get_noshow_event_stats goldens', () => {
  it('no-show stats, September 2026', async () => {
    freezeAt('2026-10-05T17:00:00Z');

    await commands.meetupGetNoShowEventStatsHandler(
      2026,
      9,
      true,
      true,
      fakeInteraction(recorder),
    );

    expect(attachment().data).toContain('**Total: 8**');
    expect(logEntry().fields).toEqual([
      { name: 'No-shows', value: '8', inline: true },
      { name: 'Members', value: '7', inline: true },
    ]);
    await expect(transcript(recorder)).toMatchFileSnapshot(
      './__goldens__/noShowStats-2026-09.golden.txt',
    );
  });
});
