import { MeetupAnnounceEventContextCommands } from './meetup/announceEvent.js';
import { OnboardUserContextCommands } from './onboardUser.js';
import { WhoisUserContextCommands } from './whoisUser.js';

const ContextCommands = [
  OnboardUserContextCommands,
  MeetupAnnounceEventContextCommands,
  WhoisUserContextCommands,
];

export default ContextCommands;
