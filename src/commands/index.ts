import { CreateChannel } from './createChannel';
import { DeleteChannel } from './deleteChannel';
import { MeetupGetEventStatsCommands } from './meetup/getEventStats';
import { MeetupSelfOnboardCommands } from './meetup/selfOnboard';
import { OnboardUserCommands } from './onboardUser';

const Commands = [
  MeetupSelfOnboardCommands,
  MeetupGetEventStatsCommands,
  OnboardUserCommands,
  CreateChannel,
  DeleteChannel,
];

export default Commands;
