import { MeetupAnnounceEventContextCommands } from './meetup/announceEvent';
import { OnboardUserContextCommands } from './onboardUser';

const EventHandlers = [
  OnboardUserContextCommands,
  MeetupAnnounceEventContextCommands,
];

export default EventHandlers;
