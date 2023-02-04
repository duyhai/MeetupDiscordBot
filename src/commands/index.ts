import { CreateChannel } from './createChannel';
import { DeleteChannel } from './deleteChannel';
import { MeetupSelfOnboardCommands } from './meetup/selfOnboard';
import { OnboardUserCommands } from './onboardUser';

const Commands = [
  MeetupSelfOnboardCommands,
  OnboardUserCommands,
  CreateChannel,
  DeleteChannel,
];

export default Commands;
