import { CreateChannel } from './createChannel';
import { DeleteChannel } from './deleteChannel';
import { Ping } from './ping';
import { OnboardUserCommands } from './user/onboard';

const Commands = [OnboardUserCommands, CreateChannel, DeleteChannel, Ping];

export default Commands;
