export const HOST_TIPS = [
    // Planning & Setup
    'Start Small - For your first events, pick a familiar activity and avoid large or pre-paid events.',
    'Lead Time Matters - Suggest events at least a week in advance to give members time to plan.',
    'Privacy First - Keep exact locations out of event titles (public). Only members can see the address in the description.',
    "Waitlist Integrity - Don't give in to requests to increase the attendee limit or skip the waitlist.",
    'RSVP Rules - Only people on the "Going" list can attend. Attending without RSVP has consequences.',
    'Tag It - Keep the [Guest Host] tag in your event title, unless an Organizer is co-hosting.',
    "Paid Events = Your Risk - Make sure you're comfortable assuming all financial risks. The group does not cover losses.",
    'Transparent Costs - Be upfront about all costs in the description (e.g., if you are rounding up to cover potential no-shows).',
    'Backup Plans - Always have a "Plan B" (e.g., an indoor option for rain) and communicate it early.',
    'Cross-Posting - If non-members will be in attendance, disclose it in the description so attendees know.',
    'Help newbies attend events - Consider holding some attendee spots for members who have attended fewer than 5 events with our group.',
    // During the Event
    'Be Early - Never be late to your own event. Arrive early to scout the spot and welcome the first arrivals.',
    'The "First Face" - You are often the first person a new member meets. Be warm and welcoming!',
    'Break the Ice - Lead introductions or icebreaker activities to help people mingle.',
    'No Cliques - Avoid sticking only to people you know. Engage everyone, especially shy and new members!',
    'Nametags Help - If possible, bring nametags. They make introductions much smoother.',
    'Connect the Dots - Actively introduce people with shared interests (e.g., "Oh, you both like hiking!").',
    'Be Agile - Things can go wrong (tables not ready, weather changes). Stay calm, adapt quickly, and communicate clearly to the group.',
    'De-escalate - If someone is being rude or inappropriate, try to de-escalate if you feel safe, then report them to Organizers later.',
    'Safety First - Prioritize the safety and comfort of your attendees over politeness.',
    'Check In - Keep an eye on the group dynamics. If someone looks left out, draw them into the conversation.',
    // Post-Event & Admin
    'Mark No-Shows - Enforce the attendance policy. Marking no-shows helps keep the community accountable.',
    'Feedback Loop - Ask attendees to rate the event on Meetup. It helps you improve and lets the community know what works.',
    'Report Issues - Let Organizers know about any problematic behavior. You are the eyes and ears on the ground.',
    'Share Success - Tell the Organizers how it went! They love hearing success stories and learning from your experiences.',
    'Track Payments - For paid events, use a spreadsheet or manually move paid attendees off the Waitlist to track who has paid.',
    'Recruit Hosts - We are always looking for new hosts! Encourage them and share the Guide to Hosting.',
    // General Best Practices
    "Avoid Cancellations - Try to find a replacement host if you can't make it. Cancellation should be a last resort.",
    'Cancel Correctly - If you must cancel, do it at least a week out, update the title to "CANCELED," and post a comment. Never just "delete" the event.',
    'Don\'t Burn Out - You are a volunteer. It is okay to take breaks or ask for a co-host to split the workload.',
    'No Commercial Gain - Never use events for personal profit or to promote a business. This is a community space.',
    'Review the Wiki - Policies evolve. Occasionally skim the **Guide to Hosting** to stay sharp on the latest best practices.',
];

export const getRandomTip = () => {
    const randomIndex = Math.floor(Math.random() * HOST_TIPS.length);
    return HOST_TIPS[randomIndex];
};
