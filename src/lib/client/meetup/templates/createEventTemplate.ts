// Too lazy to query the event from Meetup. Just hardcode for now

import { CreateEventInput } from '../types';

export const createEventTemplate: CreateEventInput = {
  title: 'Organizer Event Template',
  description:
    'MEETING SPOT:\n\nEVENT DETAILS:\n\nGUEST INFORMATION:\nX Guests are allowed OR\nNo guests are allowed for this event.\n\nWHAT TO BRING: (if applicable)\n(lunch for hike, etc.)\n\nWEATHER PERMITTING INFORMATION: (if applicable)\n\nPAYMENT INFORMATION: (if applicable)\n\n***EVENT RULES***\nWe have a max limit on attendees because it gives hosts the predictability needed to plan high quality events.\n\nPlease RSVP only if you have every intent of attending. Do not hold a spot and block other members from being able to attend. Our hosts are volunteers trying to ensure events are enjoyable. Late cancellations and low turnout negatively impact events for attendees and other members lose the opportunity to attend.\n\nTherefore, we try to strictly enforce our no-show / late cancellation policy. Last minute drops will be tracked as no shows. RSVP lists will be closed 1-2 days out to prevent last minute drops and for tracking.\n\nRemember, 2 no-shows will result in removal from the group. If something comes up last minute, reach out to the host before the event. If you have questions, please let us know.\n\nFull RSVP cancellation policy here:\n\nhttp://www.meetup.com/1-5GenAsians/pages/RSVP_Cancellation_Policy/\n\n***GUEST HOST OPPORTUNITIES***\nWe welcome members to host events! See the "Official Guide to Suggested Events" under the "Upcoming Events" section.\n\n**JOIN DISCORD TO CONNECT WITH MEMBERS**\nDid you have fun talking to fellow group members? Hop on our Discord server to hang out with us online: https://discord.gg/3QqrjcWh6v',
  startDateTime: new Date('2023-04-20T19:00'),
  duration: 'PT2H',
  question: '',
  featuredPhotoId: 503707686,
  eventHosts: [182828976],
  rsvpSettings: {
    rsvpOpenDuration: 'PT0S',
    rsvpCloseDuration: 'P2D',
    rsvpLimit: 12,
    guestLimit: 1,
  },
  publishStatus: 'DRAFT',
  // covidPrecautions: {},
  groupUrlname: '1-5genasians',
  selfRsvp: false,
  topics: [16345, 19419, 25070, 83759, 121143],
  fundraising: {
    enabled: false,
  },
  communicationSettings: {
    chat: true,
    comments: false,
  },
  isCopy: true,
};
