/**
 * Wrapped from the group snapshot: a member's sources and every attendee
 * list read from Postgres, so a build makes no Meetup call. The token path
 * (build.ts) stays the fallback for a member the snapshot cannot serve:
 * before the first full pull, a member with nothing stored (joined after the
 * last run, or invisible to the organizer view), or a member whose own token
 * counted clearly more past RSVPs than the snapshot holds (flagged in
 * wrapped_snapshot_flags, so that sticks).
 *
 * Privacy is unchanged: other people's Meetup ids reach only the companion
 * and cohort rankings, exactly where the token path's attendee lists go;
 * naming is companions.ts's linked-and-present walk.
 */
import { Logger } from 'tslog';

import Configuration from '../../configuration.js';
import { ApplicationCache } from '../../util/cache.js';
import { GqlMeetupClient } from '../client/meetup/gqlClient.js';
import { getUsableMeetupTokens } from '../helpers/meetupTokens.js';
import { SnapshotReader } from '../repositories/postgresSnapshotRepository.js';
import {
  AttendeeReader,
  BuildDeps,
  BuildResult,
  WrappedSources,
  buildWrappedYear,
} from '../wrapped/build.js';

const logger = new Logger({ name: 'snapshotWrapped' });

/** Past RSVPs Meetup may count beyond the snapshot: events since the last run. */
export const SNAPSHOT_COUNT_SLACK = 2;

export interface SnapshotWrapped {
  /**
   * The member's sources from the snapshot, or undefined for the token
   * path. `selfPastCount` (the member's own token, when stored) is the
   * cross-check; undefined or failing, it is skipped. Never throws.
   */
  sources(
    linkedMeetupId: string,
    selfPastCount?: () => Promise<number | undefined>,
  ): Promise<WrappedSources | undefined>;
  attendees: AttendeeReader;
  /** When the latest snapshot run finished; undefined before any. Never throws. */
  updatedAt(): Promise<Date | undefined>;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}

export function snapshotWrapped(reader: SnapshotReader): SnapshotWrapped {
  return {
    sources: async (linkedMeetupId, selfPastCount) => {
      try {
        if (
          !(await reader.isReady()) ||
          (await reader.isFlagged(linkedMeetupId))
        ) {
          return undefined;
        }
        const [events, hosted] = await Promise.all([
          reader.memberEvents(linkedMeetupId),
          reader.hostedEvents(linkedMeetupId),
        ]);
        if (events.length === 0 && hosted.length === 0) {
          return undefined;
        }
        if (selfPastCount) {
          let counted: number | undefined;
          try {
            counted = await selfPastCount();
          } catch (error) {
            logger.warn(`Snapshot cross-check skipped: ${errorName(error)}`);
          }
          if (
            counted !== undefined &&
            counted > events.length + SNAPSHOT_COUNT_SLACK
          ) {
            logger.info(
              `Snapshot holds ${events.length} past RSVPs for Meetup member ${linkedMeetupId}, ` +
                `their token counts ${counted}: flagged, the token path from now on`,
            );
            // Durable, so the backfill does not overwrite the token build
            // with the undercounted snapshot (it rebuilds their snapshot
            // years on the token path instead).
            await reader
              .flagUndercounted(linkedMeetupId, events.length, counted)
              .catch((error: unknown) => {
                logger.warn(
                  `Snapshot undercount flag not written: ${errorName(error)}`,
                );
              });
            return undefined;
          }
        }
        return { events, hosted };
      } catch (error) {
        logger.warn(
          `Snapshot unreadable, using the token path: ${errorName(error)}`,
        );
        return undefined;
      }
    },
    attendees: async (events) => ({
      byEvent: await reader.attendeesOf(events.map((event) => event.id)),
      // The snapshot holds every page of every list.
      partial: new Set<string>(),
    }),
    updatedAt: async () => {
      try {
        return await reader.updatedAt();
      } catch (error) {
        logger.warn(`Snapshot age unreadable: ${errorName(error)}`);
        return undefined;
      }
    },
  };
}

export type SnapshotBuildDeps = Pick<
  BuildDeps,
  'claimBuild' | 'findByMeetupId' | 'isPresent' | 'now' | 'log' | 'onProgress'
> & { attendees: AttendeeReader };

/**
 * The on-demand build from the snapshot: the hourly slot as buildWrapped
 * takes it, then the same year build. No token, so no account check and no
 * "not in the group".
 */
export async function buildWrappedFromSnapshot(
  deps: SnapshotBuildDeps,
  linkedMeetupId: string,
  year: number,
  sources: WrappedSources,
): Promise<BuildResult> {
  if (deps.claimBuild && !deps.claimBuild()) {
    return { kind: 'rate-limited' };
  }
  return {
    kind: 'built',
    wrapped: await buildWrappedYear(deps, linkedMeetupId, year, sources),
  };
}

/** The member's stored token's count of their past yes/attended RSVPs; undefined without one. */
export async function storedTokenSelfCount(
  discordUserId: string,
): Promise<number | undefined> {
  const tokens = await getUsableMeetupTokens(
    await ApplicationCache(),
    discordUserId,
  );
  if (!tokens) {
    return undefined;
  }
  return new GqlMeetupClient(tokens.accessToken).getSelfPastRsvpCount(
    Configuration.meetup.groupId,
  );
}
