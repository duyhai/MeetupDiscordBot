import {
  MeetupIdConflictError,
  MemberRepository,
} from '../repositories/types.js';

/** The member store reads and the one write the website link needs. */
export type WebLinkStore = Pick<
  MemberRepository,
  'findByMeetupId' | 'findByDiscordId' | 'linkUnlessLinkedElsewhere'
>;

export type WebLinkOutcome =
  /** Saved now. */
  | { kind: 'linked' }
  /** This Meetup account was already linked to this Discord account. */
  | { kind: 'already' }
  /** The Meetup account is linked to a different Discord account. */
  | { kind: 'meetup-taken'; otherDiscordId: string | undefined }
  /** The Discord account is linked to a different Meetup account. */
  | { kind: 'discord-taken'; otherMeetupId: string | undefined };

/**
 * Links a signed-in host's Meetup account to the Discord account they just
 * proved they own (Discord's sign-in). The same duplicate rules as Verify
 * in the server, except that a Discord account already linked to another
 * Meetup account is refused rather than moved: nothing on the website
 * confirms the switch on the Discord side. A row left by a manual onboard
 * (no Meetup id) is upgraded. No server roles: that stays with Verify.
 * Throws when the store cannot answer.
 */
export async function linkDiscordFromWeb(
  store: WebLinkStore,
  link: { meetupId: string; meetupName: string; discordUserId: string },
): Promise<WebLinkOutcome> {
  const byMeetup = await store.findByMeetupId(link.meetupId);
  if (byMeetup) {
    return byMeetup.discordUserId === link.discordUserId
      ? { kind: 'already' }
      : { kind: 'meetup-taken', otherDiscordId: byMeetup.discordUserId };
  }
  const byDiscord = await store.findByDiscordId(link.discordUserId);
  if (byDiscord?.meetupId && byDiscord.meetupId !== link.meetupId) {
    return { kind: 'discord-taken', otherMeetupId: byDiscord.meetupId };
  }
  let saved: Awaited<ReturnType<WebLinkStore['linkUnlessLinkedElsewhere']>>;
  try {
    saved = await store.linkUnlessLinkedElsewhere({
      discordUserId: link.discordUserId,
      meetupId: link.meetupId,
      meetupName: link.meetupName,
      meetupMemberUrl: `https://www.meetup.com/members/${link.meetupId}/`,
      onboardMethod: 'web_link',
      onboardedBy: null,
    });
  } catch (error: unknown) {
    // A concurrent link of the same Meetup account won the unique key.
    if (error instanceof MeetupIdConflictError) {
      return { kind: 'meetup-taken', otherDiscordId: undefined };
    }
    throw error;
  }
  // Verify linked this Discord account elsewhere after the check above.
  if (saved === undefined) {
    return { kind: 'discord-taken', otherMeetupId: undefined };
  }
  return { kind: 'linked' };
}
