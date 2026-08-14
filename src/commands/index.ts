import { MeetupCreateEventCommands } from './meetup/createEvent.js';
import { MeetupGetBadgesCommands } from './meetup/getBadges.js';
import { MeetupGetEventStatsCommands } from './meetup/getEventStats.js';
import { MeetupNoShowCommands } from './meetup/getNoShow.js';
import { MeetupGetTokenCommands } from './meetup/getToken.js';
import { MeetupGetUnannouncedEventsCommands } from './meetup/getUnannouncedEvents.js';
import { MeetupGetUserRolesCommands } from './meetup/getUserRoles.js';
import { MeetupSelfOnboardCommands } from './meetup/selfOnboard.js';
import { MeetupTestGqlCommands } from './meetup/testGQL.js';
import { UnlinkAccountCommands } from './meetup/unlinkAccount.js';
import { MeetupWhoisCommands } from './meetup/whoisAccount.js';
import { OnboardUserCommands } from './onboardUser.js';
import { SendMessageCommands } from './sendMessage.js';

const Commands = [
  MeetupCreateEventCommands,
  MeetupSelfOnboardCommands,
  MeetupGetBadgesCommands,
  MeetupGetEventStatsCommands,
  MeetupGetTokenCommands,
  MeetupGetUserRolesCommands,
  MeetupGetUnannouncedEventsCommands,
  OnboardUserCommands,
  MeetupNoShowCommands,
  SendMessageCommands,
  MeetupTestGqlCommands,
  UnlinkAccountCommands,
  MeetupWhoisCommands,
];

export default Commands;
