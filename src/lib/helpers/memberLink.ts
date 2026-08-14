import {
  ButtonInteraction,
  CommandInteraction,
  MessageContextMenuCommandInteraction,
  UserContextMenuCommandInteraction,
} from 'discord.js';
import { Logger } from 'tslog';

import { linkStr } from '../../util/discord.js';
import { ApplicationMemberRepository } from '../../util/memberRepository.js';
import { logActivity, logAlert } from './discordLogger.js';

const logger = new Logger({ name: 'memberLink' });

const strings = {
  duplicateAccount:
    'This Meetup account is already linked to another Discord account — please contact the mods.',
};

export class DuplicateMeetupAccountError extends Error {}

export interface MeetupLinkInfo {
  meetupId: string;
  meetupMemberUrl: string;
  meetupName: string;
}

/**
 * Records a successful Meetup link in the members table.
 * - Blocks (throws DuplicateMeetupAccountError) when the Meetup account is
 *   already linked to a different Discord user.
 * - Alerts (but allows) when this Discord user switches Meetup accounts.
 * - Repository failures never block onboarding: they alert instead.
 */
export async function recordMeetupLink(
  interaction: ButtonInteraction | CommandInteraction,
  info: MeetupLinkInfo,
  method: 'self_onboard' | 'sync_v2'
): Promise<void> {
  const { client, user } = interaction;
  const meetupLink = linkStr(info.meetupName, info.meetupMemberUrl);
  try {
    const repo = await ApplicationMemberRepository();

    const claimedBy = await repo.findByMeetupId(info.meetupId);
    if (claimedBy && claimedBy.discordUserId !== user.id) {
      await logAlert(client, {
        title: 'Duplicate Meetup link blocked',
        description: `${user.toString()} tried to link ${meetupLink}, already linked to <@${
          claimedBy.discordUserId
        }>.`,
        fields: [{ name: 'Meetup ID', value: info.meetupId }],
      });
      throw new DuplicateMeetupAccountError(strings.duplicateAccount);
    }

    const existing = await repo.findByDiscordId(user.id);
    if (existing?.meetupId && existing.meetupId !== info.meetupId) {
      await logAlert(client, {
        title: 'Meetup account changed',
        description: `${user.toString()} switched their linked Meetup account.`,
        fields: [
          { name: 'Old Meetup ID', value: existing.meetupId, inline: true },
          { name: 'New Meetup ID', value: info.meetupId, inline: true },
        ],
      });
    }

    await repo.upsert({
      discordUserId: user.id,
      meetupId: info.meetupId,
      meetupName: info.meetupName,
      meetupMemberUrl: info.meetupMemberUrl,
      onboardMethod: method,
      onboardedBy: null,
    });

    await logActivity(client, {
      title: 'Meetup account linked',
      description: `${user.toString()} (${user.username}) ↔ ${meetupLink}`,
      fields: [
        { name: 'Meetup ID', value: info.meetupId, inline: true },
        { name: 'Method', value: method, inline: true },
      ],
    });
  } catch (error) {
    if (error instanceof DuplicateMeetupAccountError) {
      throw error;
    }
    logger.error(`Failed to record Meetup link: ${String(error)}`);
    await logAlert(client, {
      title: 'Database write failed during onboarding',
      description: `Could not record Meetup link for ${user.toString()}: ${String(
        error
      )}`,
    });
  }
}

/**
 * Records a manual (mod-driven) onboard as a meetup_id=NULL row. The manual
 * flow is deprecated; every use is also alerted. Never throws, and never
 * downgrades an existing linked row.
 */
export async function recordManualOnboard(
  interaction:
    | CommandInteraction
    | MessageContextMenuCommandInteraction
    | UserContextMenuCommandInteraction,
  targetUserId: string
): Promise<void> {
  const { client, user: mod } = interaction;
  try {
    const repo = await ApplicationMemberRepository();

    const existing = await repo.findByDiscordId(targetUserId);
    if (!existing?.meetupId) {
      await repo.upsert({
        discordUserId: targetUserId,
        meetupId: null,
        meetupName: null,
        meetupMemberUrl: null,
        onboardMethod: 'manual',
        onboardedBy: mod.id,
      });
    }

    const message =
      `${mod.toString()} manually onboarded <@${targetUserId}>. ` +
      `They have no Meetup account on record and should go through automated verification.`;
    await logAlert(client, {
      title: 'Manual onboard used (deprecated flow)',
      description: message,
    });
  } catch (error) {
    logger.error(`Failed to record manual onboard: ${String(error)}`);
  }
}
