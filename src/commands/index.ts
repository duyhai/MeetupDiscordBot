import { MeetupCreateEventCommands } from './meetup/createEvent.js';
import { MeetupGetEventStatsCommands } from './meetup/getEventStats.js';
import { MeetupNoShowCommands } from './meetup/getNoShow.js';
import { MeetupGetTokenCommands } from './meetup/getToken.js';
import { MeetupGetUnannouncedEventsCommands } from './meetup/getUnannouncedEvents.js';
import { MeetupListSuspensionsCommands } from './meetup/listSuspensions.js';
import { MeetupRecordSuspensionCommands } from './meetup/recordSuspension.js';
import { MeetupTestGqlCommands } from './meetup/testGQL.js';
import { UnlinkAccountCommands } from './meetup/unlinkAccount.js';
import { MeetupVoidSuspensionCommands } from './meetup/voidSuspension.js';
import { MeetupWhoisCommands } from './meetup/whoisAccount.js';
import { SendMessageCommands } from './sendMessage.js';

const Commands = [
  MeetupCreateEventCommands,
  MeetupGetEventStatsCommands,
  MeetupListSuspensionsCommands,
  MeetupGetTokenCommands,
  MeetupGetUnannouncedEventsCommands,
  MeetupNoShowCommands,
  MeetupRecordSuspensionCommands,
  SendMessageCommands,
  MeetupTestGqlCommands,
  UnlinkAccountCommands,
  MeetupVoidSuspensionCommands,
  MeetupWhoisCommands,
];

export default Commands;
