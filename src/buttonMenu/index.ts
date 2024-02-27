import { MeetupSyncAccountCommands } from './meetup/syncAccount';
import { MeetupSyncAccountCommandsV2 } from './meetup/syncAccountV2';
import { MessageModsCommands } from './messageMods';

const Commands = [
  MeetupSyncAccountCommands,
  MeetupSyncAccountCommandsV2,
  MessageModsCommands,
];

export default Commands;
