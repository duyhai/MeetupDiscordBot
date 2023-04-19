// import { CreateChannel } from './createChannel';
// import { DeleteChannel } from './deleteChannel';
import { MeetupCreateEventCommands } from './meetup/createEvent';
import { MeetupGetBadgesCommands } from './meetup/getBadges';
import { MeetupGetEventStatsCommands } from './meetup/getEventStats';
import { MeetupNoShowCommands } from './meetup/getNoShow';
import { MeetupGetUserRolesCommands } from './meetup/getUserRoles';
import { MeetupSelfOnboardCommands } from './meetup/selfOnboard';
import { OnboardUserCommands } from './onboardUser';

const Commands = [
  MeetupCreateEventCommands,
  MeetupSelfOnboardCommands,
  MeetupGetBadgesCommands,
  MeetupGetEventStatsCommands,
  MeetupGetUserRolesCommands,
  OnboardUserCommands,
  MeetupNoShowCommands,
  // CreateChannel,
  // DeleteChannel,
];

export default Commands;
