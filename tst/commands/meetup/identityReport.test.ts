/* eslint-disable @typescript-eslint/unbound-method */
import { CommandInteraction } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  IdentityReportCommands,
  buildReportAttachment,
  tooLargeMessage,
} from '../../../src/commands/meetup/identityReport.js';
import {
  estimateReportBytes,
  estimateReportBytesFromCounts,
} from '../../../src/lib/helpers/identityReport.js';
import { IdentityChangeRecord } from '../../../src/lib/repositories/identityTypes.js';

const repo = vi.hoisted(() => ({
  listChangesBetween: vi.fn(),
  measureChangesBetween: vi.fn(),
}));

vi.mock('../../../src/util/identityRepository.js', () => ({
  ApplicationIdentityRepository: vi.fn(async () => repo),
}));

// The wrapper and the role gate are unit-tested elsewhere; run them straight
// through so this test is only about how the handler delivers the file.
// withDiscordFileAttachment stays REAL: its tmpfile shape is what the delivery
// call receives, and faking it would hide a malformed payload.
vi.mock('../../../src/util/discord.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/util/discord.js')>();
  return {
    ...actual,
    discordCommandWrapper: vi.fn(async (_interaction, fn: () => unknown) => {
      await fn();
    }),
    requireModOrOrganizer: vi.fn().mockResolvedValue(undefined),
  };
});

const change = (
  over: Partial<IdentityChangeRecord> = {},
): IdentityChangeRecord => ({
  id: '1',
  discordUserId: 'u1',
  field: 'user_avatar',
  oldValue: 'aaa',
  newValue: 'bbb',
  oldThumb: Buffer.from([1, 2, 3]),
  newThumb: Buffer.from([4, 5, 6]),
  detectedAt: new Date('2026-08-16T14:02:00Z'),
  source: 'event',
  ...over,
});

describe('buildReportAttachment', () => {
  it('returns html and a dated filename for a normal range', () => {
    const result = buildReportAttachment([change()], 7);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fileName).toMatch(
      /^identity-report-\d{4}-\d{2}-\d{2}\.html$/,
    );
    expect(result.html).toContain('<!doctype html>');
  });

  it('refuses a range too large for Discord to accept', () => {
    const huge = Array.from({ length: 400 }, (_, i) =>
      change({ id: String(i), newThumb: Buffer.alloc(300_000) }),
    );

    const result = buildReportAttachment(huge, 365);

    // Producing a file Discord rejects wastes the whole generation pass and
    // gives the organizer nothing but a confusing upload error.
    expect(result.ok).toBe(false);
    // `=== true` (not truthy `result.ok`): no strictNullChecks in this
    // project, so a plain truthy check doesn't narrow the union down to the
    // `reason` variant reliably — literal equality does.
    if (result.ok === true) return;
    expect(result.reason).toContain('narrower');
  });

  it('still builds a report when there are no changes', () => {
    const result = buildReportAttachment([], 7);

    expect(result.ok).toBe(true);
  });
});

/**
 * Handler-level, not helper-level. buildReportAttachment was unit-tested from
 * day one, yet the command still shipped delivering the attachment through
 * editReply -- which edits the very progress reply discordCommandWrapper
 * deletes on success, so the organizer watched the file appear and vanish.
 * Only a test at the call site can see that.
 */
describe('identityReportHandler delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repo.listChangesBetween.mockResolvedValue([change()]);
    repo.measureChangesBetween.mockResolvedValue({
      changeCount: 1,
      thumbBytes: 6,
    });
  });

  const fakeInteraction = () =>
    ({
      user: { id: 'u-mod', username: 'mod' },
      editReply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
    }) as unknown as CommandInteraction;

  const run = async (days?: number) => {
    const interaction = fakeInteraction();
    await new IdentityReportCommands().identityReportHandler(days, interaction);
    return interaction;
  };

  it('delivers the attachment with followUp, never editReply', async () => {
    const interaction = await run(7);

    expect(vi.mocked(interaction.followUp)).toHaveBeenCalledTimes(1);
    // editReply would target the message the wrapper deletes on success.
    expect(vi.mocked(interaction.editReply)).not.toHaveBeenCalled();
  });

  it('attaches the html file to that followUp, ephemerally', async () => {
    const interaction = await run(7);

    const [payload] = vi.mocked(interaction.followUp).mock
      .calls[0] as unknown as [
      { content: string; ephemeral: boolean; files: { name: string }[] },
    ];
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0].name).toMatch(/\.html$/);
    // The report names members; a non-ephemeral reply would publish it.
    expect(payload.ephemeral).toBe(true);
    expect(payload.content).toContain('1 change');
  });
});

/**
 * The old guard measured the rows AFTER loading them, so the range that would
 * OOM the dyno was already resident by the time it fired. These pin the order.
 */
describe('identityReportHandler size guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repo.listChangesBetween.mockResolvedValue([change()]);
    repo.measureChangesBetween.mockResolvedValue({
      changeCount: 1,
      thumbBytes: 6,
    });
  });

  const fakeInteraction = () =>
    ({
      user: { id: 'u-mod', username: 'mod' },
      editReply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
    }) as unknown as CommandInteraction;

  const run = (days?: number) =>
    new IdentityReportCommands().identityReportHandler(days, fakeInteraction());

  it('measures the range before fetching any rows', async () => {
    await run(7);

    expect(repo.measureChangesBetween.mock.invocationCallOrder[0]).toBeLessThan(
      repo.listChangesBetween.mock.invocationCallOrder[0],
    );
  });

  it('refuses an oversized range without ever loading the thumbnails', async () => {
    repo.measureChangesBetween.mockResolvedValue({
      changeCount: 20_000,
      thumbBytes: 80 * 1024 * 1024,
    });

    await expect(run(90)).rejects.toThrow(/narrower window/);
    // The whole point: nothing was pulled into the dyno before refusing.
    expect(repo.listChangesBetween).not.toHaveBeenCalled();
  });

  it('names a concrete narrower window in the refusal', () => {
    // ~107 MB projected over 90 days against a ~10 MB budget -> single digits.
    const message = tooLargeMessage(107 * 1024 * 1024, 90);

    expect(message).toMatch(/about 8 days should fit/);
  });

  it('builds the report when the range fits', async () => {
    await expect(run(7)).resolves.not.toThrow();
    expect(repo.listChangesBetween).toHaveBeenCalledTimes(1);
  });
});

describe('estimateReportBytesFromCounts', () => {
  it('matches the in-memory estimate for the same rows', () => {
    const rows = [change(), change({ id: '2' })];
    const thumbBytes = rows.reduce(
      (total, row) =>
        total + (row.oldThumb?.length ?? 0) + (row.newThumb?.length ?? 0),
      0,
    );

    // The pre-fetch guard and the post-fetch backstop must agree, or a range
    // could pass one and be refused by the other after all the work.
    expect(estimateReportBytesFromCounts(rows.length, thumbBytes)).toBe(
      estimateReportBytes(rows),
    );
  });

  it('counts base64 inflation, not just the raw bytes', () => {
    // 3 MB of thumbnails is ~4 MB once base64-encoded into the document.
    expect(estimateReportBytesFromCounts(0, 3_000_000)).toBeGreaterThan(
      3_900_000,
    );
  });
});
