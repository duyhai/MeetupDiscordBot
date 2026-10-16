/* eslint-disable @typescript-eslint/unbound-method -- vi.mocked on a static mock factory */
import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MeetupNoShowReportCommands } from '../../../src/commands/meetup/noShowReport.js';
import { PostgresSuspensionRepository } from '../../../src/lib/repositories/postgresSuspensionRepository.js';
import { ApplicationCache } from '../../../src/util/cache.js';
import { fakeSuspensionRepository } from '../../fixtures/meetup/fakeSuspensions.js';
import {
  SUSPENSIONS_2026,
  WORLD_2026,
} from '../../fixtures/meetup/world2026.js';
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
vi.mock(
  '../../../src/lib/repositories/postgresSuspensionRepository.js',
  () => ({
    PostgresSuspensionRepository: { instance: vi.fn() },
  }),
);

let responder: ReturnType<typeof installMeetupResponder>;

beforeEach(() => {
  recorder.reset();
  vi.mocked(ApplicationCache).mockResolvedValue(new FakeCache() as never);
  vi.mocked(PostgresSuspensionRepository.instance).mockResolvedValue(
    fakeSuspensionRepository(SUSPENSIONS_2026) as never,
  );
  responder = installMeetupResponder(WORLD_2026, { maxPageSize: 2 });
});

afterEach(() => {
  expect(responder.unhandled()).toEqual([]);
  expect(responder.calls.length).toBeGreaterThan(0);
  responder.calls.forEach((call) => {
    expect(call.authorization).toBe(`Bearer ${USER_TOKEN}`);
  });
  nock.cleanAll();
  vi.useRealTimers();
});

// Only Date is faked: undici and nock need the real timers.
function freezeAt(iso: string) {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(iso) });
}

const commands = new MeetupNoShowReportCommands();

function report(year: number, month: number) {
  return commands.runNoShowReportHandler(
    year,
    month,
    fakeInteraction(recorder),
  );
}

function attachments() {
  const found: { fileName: string; data: string }[] = [];
  recorder.events.forEach((e) => {
    if (e.kind === 'attachment') {
      found.push({ fileName: e.fileName, data: e.data });
    }
  });
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
    fields?: { name: string; value: string }[];
  };
}

describe('/meetup_run_noshow_report goldens', () => {
  it('no-show report, September 2026', async () => {
    freezeAt('2026-10-05T17:00:00Z');

    await report(2026, 9);

    const [text, csv] = attachments();
    expect(attachments().map((a) => a.fileName)).toEqual([
      'No Show report 2026-9.txt',
      'suggested_suspensions_2026-9.csv',
    ]);
    expect(followUpContents()).toEqual([
      'Report ready — hand this to Melissa. She sends warnings and applies ' +
        'suspensions; record outcomes with /meetup_record_suspension.',
      'Suggested suspensions as an editable CSV. Delete the rows Melissa ' +
        'didn’t act on, fill in `suspended_at` with the day she applied each ' +
        'one, then upload it via /meetup_record_suspension.',
    ]);
    expect(text.data).toContain('__Warnings (1 no-show): 2__');
    expect(text.data).toContain('__Suspension candidates (2+ no-shows): 3__');
    expect(text.data).toContain('**ACT NOW**');
    expect(text.data).toContain('prior suspensions: 1 → recommended: 60 days');
    expect(text.data).toContain('2 upcoming RSVPs may involve payment');
    expect(text.data).toContain('— 💵 $15 event fee');
    expect(text.data).toContain('— 💵 description mentions payment');
    expect(text.data).toContain('suspended 2026-09-20');
    expect(text.data).toContain(
      'no upcoming RSVPs in the group — suspend at any time',
    );
    expect(text.data).not.toContain('Jo Park');
    expect(csv.data.split('\n')[0]).toBe(
      'member_id,member_name,duration_days,suspended_at,notes',
    );
    expect(csv.data).toMatch(/^"201","Dana Lee","30","",/m);
    expect(csv.data).toMatch(/^"202","Eli Park","60","",/m);
    expect(csv.data).toMatch(/^"205","Hana Kim","30","",/m);
    expect(logEntry().fields).toEqual([
      { name: 'Warnings', value: '2', inline: true },
      { name: 'Suspension candidates', value: '3', inline: true },
      { name: 'No action needed', value: '1', inline: true },
      { name: 'No longer in the group', value: '1', inline: true },
    ]);
    await expect(transcript(recorder)).toMatchFileSnapshot(
      './__goldens__/noShowReport-2026-09.golden.txt',
    );
  });

  it('no-show report, August 2026 has no no-shows', async () => {
    freezeAt('2026-09-05T17:00:00Z');

    await report(2026, 8);

    expect(attachments()).toEqual([]);
    expect(followUpContents()).toEqual(['No no-shows recorded for 2026-8. 🎉']);
    expect(logEntry().description).toContain(
      'ran the 2026-8 report: no no-shows.',
    );
    await expect(transcript(recorder)).toMatchFileSnapshot(
      './__goldens__/noShowReport-2026-08.golden.txt',
    );
  });

  it('no-show report, November 2026, across the end of daylight saving time', async () => {
    freezeAt('2026-12-03T17:00:00Z');

    await report(2026, 11);

    const [text] = attachments();
    expect(text.data).toContain('Kai Ito');
    expect(text.data).toContain('December Kickoff');
    expect(text.data).toContain('Fall Back Fondue');
    expect(text.data).toContain('Last Night of November');
    expect(text.data).not.toContain('Halloween Late Show');
    await expect(transcript(recorder)).toMatchFileSnapshot(
      './__goldens__/noShowReport-2026-11.golden.txt',
    );
  });
});
