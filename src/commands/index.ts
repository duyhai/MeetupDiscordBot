import { CreateChannel } from './createChannel';
import { DeleteChannel } from './deleteChannel';
import { OnboardUserCommands } from './user/onboard';

const Commands = [OnboardUserCommands, CreateChannel, DeleteChannel];

export default Commands;
