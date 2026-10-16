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
import { GoldenEvent, fakeInteraction } from './goldenHarness.js';

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

const commands = new MeetupNoShowReportCommands();

function report(year: number, month: number) {
  return commands.runNoShowReportHandler(
    year,
    month,
    fakeInteraction(recorder),
  );
}

function attachmentNames() {
  const names: string[] = [];
  recorder.events.forEach((e) => {
    if (e.kind === 'attachment') {
      names.push(e.fileName);
    }
  });
  return names;
}

// Not a golden: the same world and harness, asserting which Meetup calls the
// command makes. The host flag is for stored snapshots only.
describe('/meetup_run_noshow_report Meetup calls', () => {
  it('makes no host-count calls', async () => {
    freezeAt('2026-10-05T17:00:00Z');

    await report(2026, 9);

    expect(attachmentNames()).toEqual([
      'No Show report 2026-9.txt',
      'suggested_suspensions_2026-9.csv',
    ]);
    expect(
      responder.calls.filter((call) => call.name === 'getGroupEventsCount'),
    ).toEqual([]);
  });
});
