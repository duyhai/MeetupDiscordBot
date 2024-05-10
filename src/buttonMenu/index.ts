import { AANHPIFlagsCommands } from './AANHPIFlags';
import { MeetupSyncAccountCommands } from './meetup/syncAccount';
import { MeetupSyncAccountCommandsV2 } from './meetup/syncAccountV2';
import { MessageModsCommands } from './messageMods';

const Commands = [
  AANHPIFlagsCommands,
  MeetupSyncAccountCommands,
  MeetupSyncAccountCommandsV2,
  MessageModsCommands,
];

export default Commands;
