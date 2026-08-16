import { MeetupCreateEventCommands } from './meetup/createEvent.js';
import { MeetupGetEventStatsCommands } from './meetup/getEventStats.js';
import { MeetupNoShowCommands } from './meetup/getNoShow.js';
import { MeetupGetTokenCommands } from './meetup/getToken.js';
import { MeetupGetUnannouncedEventsCommands } from './meetup/getUnannouncedEvents.js';
import { MeetupTestGqlCommands } from './meetup/testGQL.js';
import { UnlinkAccountCommands } from './meetup/unlinkAccount.js';
import { MeetupWhoisCommands } from './meetup/whoisAccount.js';
import { SendMessageCommands } from './sendMessage.js';

const Commands = [
  MeetupCreateEventCommands,
  MeetupGetEventStatsCommands,
  MeetupGetTokenCommands,
  MeetupGetUnannouncedEventsCommands,
  MeetupNoShowCommands,
  SendMessageCommands,
  MeetupTestGqlCommands,
  UnlinkAccountCommands,
  MeetupWhoisCommands,
];

export default Commands;
