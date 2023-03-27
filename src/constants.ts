export const SERVER_ROLES = {
  bots: '931394368949067796',
  guest_host: '912473798085836821',
  ladies_lounge: '935435362984161292',
  moderator: '912474048775221270',
  onboarding: '932906028725571594',
  organizer: '912474170594582568',
};
export type ServerRoles = keyof typeof SERVER_ROLES;

export const REWARD_ROLES: Record<
  'hosting' | 'attendance' | 'discord',
  Record<500 | 100 | 50 | 20 | 5 | 1, string>
> = {
  hosting: {
    500: '1089710397298331648',
    100: '1089710357360164894',
    50: '1089710295234134136',
    20: '1089710257607024780',
    5: '1089710221242421328',
    1: '1089710066380324974',
  },
  attendance: {
    500: '1089709985145036901',
    100: '1089709897807052874',
    50: '1089709848763043952',
    20: '1089709798632734740',
    5: '1089709738796789870',
    1: '1089709549302317076',
  },
  discord: {
    500: '1089710715134287923',
    100: '1089710681659555911',
    50: '1089710646335119450',
    20: '1089710611383996426',
    5: '1089710562834915381',
    1: '1089710477656981564',
  },
};
export type RewardRoles = keyof typeof REWARD_ROLES;
export type RewardRoleLevels = keyof (typeof REWARD_ROLES)[RewardRoles];

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
