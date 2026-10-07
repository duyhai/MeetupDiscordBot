import { MeetupAnnounceEventContextCommands } from './meetup/announceEvent.js';
import { OnboardUserContextCommands } from './onboardUser.js';
import { WhoisUserContextCommands } from './whoisUser.js';
import { WhereHaveWeMetContextCommands } from './whereHaveWeMet.js';

const ContextCommands = [
  OnboardUserContextCommands,
  MeetupAnnounceEventContextCommands,
  WhoisUserContextCommands,
  WhereHaveWeMetContextCommands,
];

export default ContextCommands;
