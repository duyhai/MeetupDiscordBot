import { CreateEventInput } from '../lib/client/meetup/types';

export const createEventTemplate: CreateEventInput = {
  title: 'Organizer Event Template',
  description: '',
  startDateTime: '2023-04-20T19:00',
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
  publishStatus: 'PUBLISHED',
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
