import { CreateEventInput } from '../lib/client/meetup/types.js';

/**
 * Body of every guest-host event. It used to be copied from a Meetup draft
 * event (313217466) at approval time; that event was deleted on 2026-10-25,
 * so the text now lives here. The EVENT RULES / LEARN MORE block is verbatim
 * from the guest-host events created since (16 of 32 carried it unchanged);
 * hosts rewrite the top of every event, so the template's original opening
 * could not be recovered and EVENT DETAILS is a placeholder for the host.
 * The approve handler prepends the request's "💡 Host Tip" line when there
 * is one.
 */
export const GUEST_HOST_EVENT_DESCRIPTION = [
  '**EVENT DETAILS**',
  '',
  'Host: replace this with what the event is, where to meet, and anything attendees should bring.',
  '',
  '**EVENT RULES**',
  '',
  '* Read our Community Rules: [https://bit.ly/15genasians-rules](https://bit.ly/15genasians-rules)',
  '* **Cancellations within 48 hours will be marked as a No Show. Two no shows will result in a suspension from the group.** ' +
    'For more details on our Attendance & No-Show Policy go to [https://bit.ly/15genasians-noshow](https://bit.ly/15genasians-noshow)',
  '',
  '**LEARN MORE ABOUT 1.5 GEN ASIANS**',
  '',
  '* Find out more: [https://bit.ly/15genasians-wiki](https://bit.ly/15genasians-wiki)',
  '* Learn how to become a Guest Host: [https://bit.ly/15genasians-host](https://bit.ly/15genasians-host)',
  '* Join the Discord: [http://discord.gg/15genasian](http://discord.gg/15genasian)',
].join('\n');

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
