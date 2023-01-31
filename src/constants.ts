export const MODERATOR_ROLE_ID = '912474048775221270';
export const LADIES_LOUNGE_ROLE_ID = '935435362984161292';
export const ONBOARDING_ROLE_ID = '932906028725571594';
export const BOTS_ROLE_ID = '931394368949067796';

export const DISCUSSION_CATEGORY_ID = '912463814287585321';
export const INTEREST_CATEGORY_ID = '912461362733645884';
export const DISCUSSION_JOIN_CHANNEL_ID = '935080178181373992';
export const INTEREST_JOIN_CHANNEL_ID = '935074582325506068';
export const BOT_COMMANDS_CHANNEL_ID = '915035889174990899';
export const LGBTQ_CHANNEL_ID = '935434313183404062';

export const INTEREST_JOIN_MESSAGE_ID = '935078311351177256';
export const DISCUSSION_JOIN_MESSAGE_ID = '935080771536953394';

export type MeetupScope =
  | 'ageless'
  | 'basic'
  | 'event_management'
  | 'group_edit'
  | 'group_content_edit'
  | 'group_join'
  | 'messaging'
  | 'profile_edit'
  | 'reporting'
  | 'rsvp';

export const BASIC_MEETUP_AUTH_SCOPES: MeetupScope[] = ['basic'];
export const ELEVATED_MEETUP_AUTH_SCOPES: MeetupScope[] = [
  'basic',
  'event_management',
];

export const DISCORD_BOT_URL = 'https://meetup-discord-bot.herokuapp.com';
export const DISCORD_BOT_MEETUP_OAUTH_URL = `${DISCORD_BOT_URL}/connect/meetup`;
export const DISCORD_BOT_MEETUP_OAUTH_OVERRIDE_URL = (
  tokenId?: string,
  scopes?: MeetupScope[]
) => {
  const url = new URL(DISCORD_BOT_MEETUP_OAUTH_URL);
  if (tokenId) {
    url.searchParams.append('callback', `/persistToken/${tokenId}`);
  }
  if (scopes) {
    url.searchParams.append('scope', scopes.join(' '));
  }
  return url.toString();
};
