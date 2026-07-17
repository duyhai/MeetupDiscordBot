import { AANHPIFlagsCommands } from './AANHPIFlags.js';
import { MeetupSyncAccountCommands } from './meetup/syncAccount.js';
import { MeetupSyncAccountCommandsV2 } from './meetup/syncAccountV2.js';
import { MessageModsCommands } from './messageMods.js';

const Commands = [
  AANHPIFlagsCommands,
  MeetupSyncAccountCommands,
  MeetupSyncAccountCommandsV2,
  MessageModsCommands,
];

export default Commands;
