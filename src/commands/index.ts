import { MeetupCreateEventCommands } from './meetup/createEvent';
import { MeetupGetBadgesCommands } from './meetup/getBadges';
import { MeetupGetEventStatsCommands } from './meetup/getEventStats';
import { MeetupNoShowCommands } from './meetup/getNoShow';
import { MeetupGetUnannouncedEventsCommands } from './meetup/getUnannouncedEvents';
import { MeetupGetUserRolesCommands } from './meetup/getUserRoles';
import { MeetupSelfOnboardCommands } from './meetup/selfOnboard';
import { MeetupTestGqlCommands } from './meetup/testGQL';
import { OnboardUserCommands } from './onboardUser';
import { SendMessageCommands } from './sendMessage';

const Commands = [
  MeetupCreateEventCommands,
  MeetupSelfOnboardCommands,
  MeetupGetBadgesCommands,
  MeetupGetEventStatsCommands,
  MeetupGetUserRolesCommands,
  MeetupGetUnannouncedEventsCommands,
  OnboardUserCommands,
  MeetupNoShowCommands,
  SendMessageCommands,
  MeetupTestGqlCommands,
];

export default Commands;
