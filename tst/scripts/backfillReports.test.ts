/* eslint-disable @typescript-eslint/unbound-method -- vi.mocked on module mocks */
import { readFileSync } from 'node:fs';

import { Client, Routes } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  main,
  parseBackfillArgs,
  restPoster,
} from '../../scripts/backfillReports.js';
import { RedisCache } from '../../src/lib/cache/redisCache.js';
import {
  BACKFILL_DEFAULT_DELAY_MS,
  BACKFILL_LEASE_WAIT_MS,
  BackfillRefusedError,
  BackfillResult,
  runBackfill,
} from '../../src/lib/reports/backfill.js';
import { organizerMonthReports } from '../../src/lib/reports/buildJob.js';
import { PostgresReportSnapshotRepository } from '../../src/lib/repositories/postgresReportSnapshotRepository.js';
import { PostgresSuspensionRepository } from '../../src/lib/repositories/postgresSuspensionRepository.js';

vi.mock('discord.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('discord.js')>()),
  Client: vi.fn(() => {
    throw new Error('gateway');
  }),
}));
vi.mock('../../src/lib/reports/backfill.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../src/lib/reports/backfill.js')
  >()),
  runBackfill: vi.fn(),
}));
vi.mock('../../src/lib/reports/buildJob.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../src/lib/reports/buildJob.js')
  >()),
  organizerMonthReports: vi.fn(() => 'organizer-read'),
}));
vi.mock('../../src/lib/cache/redisCache.js', () => ({
  RedisCache: { instance: vi.fn(() => Promise.resolve('redis')) },
}));
vi.mock(
  '../../src/lib/repositories/postgresReportSnapshotRepository.js',
  () => ({ PostgresReportSnapshotRepository: { instance: vi.fn() } }),
);
vi.mock('../../src/lib/repositories/postgresSuspensionRepository.js', () => ({
  PostgresSuspensionRepository: { instance: vi.fn() },
}));

const FULL_ENV = {
  DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x',
  REDISCLOUD_URL: 'redis://127.0.0.1:1',
  DISCORD_API_KEY: 'not-a-real-token',
};

const result = (over: Partial<BackfillResult> = {}): BackfillResult => ({
  months: 1,
  built: [],
  skipped: [],
  failed: [],
  allDeparted: [],
  noNoShows: 0,
  ...over,
});

beforeEach(() => {
  vi.mocked(runBackfill).mockReset();
  vi.mocked(PostgresReportSnapshotRepository.instance).mockReset();
  vi.mocked(PostgresSuspensionRepository.instance).mockReset();
  vi.mocked(PostgresReportSnapshotRepository.instance).mockResolvedValue(
    'snapshots' as never,
  );
  vi.mocked(PostgresSuspensionRepository.instance).mockResolvedValue(
    'suspensions' as never,
  );
});

describe('parseBackfillArgs', () => {
  it('parses the valid set', () => {
    expect(parseBackfillArgs([])).toEqual({
      force: false,
      delayMs: BACKFILL_DEFAULT_DELAY_MS,
      allowAllDeparted: false,
    });
    expect(
      parseBackfillArgs([
        '--',
        '--from',
        '2013-03',
        '--force',
        '--delay-ms',
        '0',
        '--allow-all-departed',
      ]),
    ).toEqual({
      force: true,
      from: { year: 2013, month: 3 },
      delayMs: 0,
      allowAllDeparted: true,
    });
    expect(parseBackfillArgs(['--delay-ms', '60000'])).toMatchObject({
      delayMs: 60000,
    });
  });

  it('rejects bad values without echoing them', () => {
    for (const argv of [
      ['--from', '2026-1'],
      ['--from', '../x'],
      ['--from'],
      ['--from', '2013-02'], // before the group began
      ['--delay-ms', '-1'],
      ['--delay-ms', '60001'],
      ['--delay-ms', '1.5'],
      ['--delay-ms'],
      ['--bogus'],
    ]) {
      const parsed = parseBackfillArgs(argv);
      expect(parsed).toHaveProperty('error');
      const { error } = parsed as { error: string };
      expect(error).not.toContain('../x');
      expect(error).not.toContain('bogus');
    }
  });
});

describe('restPoster', () => {
  it('posts embeds over REST with no mentions', async () => {
    const post = vi.fn((_route: string, _options: unknown) =>
      Promise.resolve({}),
    );
    const ok = await restPoster({ post })({
      title: 'Report backfill started',
      description: '163 months',
    });
    expect(ok).toBe(true);
    const [route, options] = post.mock.calls[0];
    expect(route).toBe(Routes.channelMessages('1537755631602237473'));
    const { body } = options as {
      body: {
        content?: string;
        allowed_mentions: unknown;
        embeds: { title: string; description: string }[];
      };
    };
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.content).toBeUndefined();
    expect(body.embeds).toHaveLength(1);
    expect(body.embeds[0].title).toBe('Report backfill started');
    expect(JSON.stringify(body.embeds)).not.toContain('<@');
  });

  it('a failed post returns false and does not throw', async () => {
    const post = vi.fn(() => Promise.reject(new Error('429 body')));
    expect(await restPoster({ post })({ title: 't' })).toBe(false);
  });
});

describe('main', () => {
  it('sets PG_POOL_MAX=1 when unset and keeps an explicit value', async () => {
    const env: NodeJS.ProcessEnv = {};
    expect(await main([], env)).toBe(1); // no DATABASE_URL: before any pool
    expect(env.PG_POOL_MAX).toBe('1');
    const explicit: NodeJS.ProcessEnv = { PG_POOL_MAX: '2' };
    expect(await main([], explicit)).toBe(1);
    expect(explicit.PG_POOL_MAX).toBe('2');
    expect(PostgresReportSnapshotRepository.instance).not.toHaveBeenCalled();
  });

  it('refuses without REDISCLOUD_URL or DISCORD_API_KEY', async () => {
    expect(await main([], { ...FULL_ENV, REDISCLOUD_URL: undefined })).toBe(1);
    expect(await main([], { ...FULL_ENV, DISCORD_API_KEY: undefined })).toBe(1);
    expect(PostgresReportSnapshotRepository.instance).not.toHaveBeenCalled();
    expect(runBackfill).not.toHaveBeenCalled();
  });

  it('bad arguments exit 1 before anything else', async () => {
    const env: NodeJS.ProcessEnv = { ...FULL_ENV };
    expect(await main(['--bogus'], env)).toBe(1);
    expect(runBackfill).not.toHaveBeenCalled();
  });

  it('wires the build to Redis, the organizer read and the flags', async () => {
    vi.mocked(runBackfill).mockResolvedValue(result());
    const env: NodeJS.ProcessEnv = { ...FULL_ENV };
    expect(await main(['--from', '2020-01', '--allow-all-departed'], env)).toBe(
      0,
    );
    const [deps, options] = vi.mocked(runBackfill).mock.calls[0];
    expect(options).toEqual({
      force: false,
      from: { year: 2020, month: 1 },
      delayMs: BACKFILL_DEFAULT_DELAY_MS,
      leaseWaitMs: BACKFILL_LEASE_WAIT_MS,
      allowAllDeparted: true,
    });
    // Redis itself, never the in-memory fallback.
    expect(await deps.cache()).toBe('redis');
    expect(RedisCache.instance).toHaveBeenCalled();
    expect(deps.build.snapshots).toBe('snapshots');
    expect(deps.build.fetchMonthReports).toBe('organizer-read');
    // No Discord client: the organizer helper then posts nothing.
    expect(organizerMonthReports).toHaveBeenCalledWith(
      undefined,
      'suspensions',
    );
    expect(deps.newLeaseValue()).not.toBe(deps.newLeaseValue());
  });

  it('maps the outcome to an exit code', async () => {
    const env = () => ({ ...FULL_ENV }) as NodeJS.ProcessEnv;
    vi.mocked(runBackfill).mockResolvedValueOnce(
      result({ stopped: 'quiet-window' }),
    );
    expect(await main([], env())).toBe(3);
    vi.mocked(runBackfill).mockResolvedValueOnce(
      result({
        failed: [
          {
            period: { year: 2026, month: 1 },
            reason: 'x',
            allDepartedRefusal: false,
          },
        ],
      }),
    );
    expect(await main([], env())).toBe(1);
    vi.mocked(runBackfill).mockRejectedValueOnce(
      new BackfillRefusedError('quiet-window'),
    );
    expect(await main([], env())).toBe(2);
    vi.mocked(runBackfill).mockRejectedValueOnce(new Error('pg down'));
    await expect(main([], env())).rejects.toThrow('pg down');
  });

  it('never logs in to the gateway', async () => {
    vi.mocked(runBackfill).mockResolvedValue(result());
    expect(await main(['--bogus'], { ...FULL_ENV })).toBe(1);
    expect(await main([], { ...FULL_ENV })).toBe(0);
    expect(Client).not.toHaveBeenCalled();
    for (const file of [
      'scripts/backfillReports.ts',
      'src/lib/reports/backfill.ts',
    ]) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toContain('new Client(');
      expect(source).not.toContain('.login(');
    }
  });
});
