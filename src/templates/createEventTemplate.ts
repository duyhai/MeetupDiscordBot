import { CreateEventInput } from '../lib/client/meetup/types.js';

/**
 * Body of every guest-host event. It used to be copied from a Meetup draft
 * event (313217466) at approval time; that event was deleted on 2026-10-25,
 * so the text now lives here. The approve handler prepends the request's
 * "💡 Host Tip" line when there is one.
 */
export const GUEST_HOST_EVENT_DESCRIPTION = `TODO: recovered description pending`;

export const createEventTemplate: CreateEventInput = {
  title: 'Organizer Event Template',
  description: GUEST_HOST_EVENT_DESCRIPTION,
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
    chat: false,
    comments: true,
  },
  isCopy: true,
};
