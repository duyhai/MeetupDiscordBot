import { CreateChannel } from './createChannel';
import { DeleteChannel } from './deleteChannel';
import { AuthUserCommands } from './meetup/auth';
import { OnboardUserCommands } from './user/onboard';

const Commands = [
  AuthUserCommands,
  OnboardUserCommands,
  CreateChannel,
  DeleteChannel,
];

export default Commands;
