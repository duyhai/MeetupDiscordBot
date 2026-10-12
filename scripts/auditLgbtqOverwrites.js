// READ-ONLY audit of the private LGBTQ channel's per-user permission
// overwrites. Reports how many belong to someone who should not have one:
//   - members who currently hold the Onboarding role (not verified), and
//   - users who are no longer in the server.
// It only sends GET requests; removing an overwrite is a separate, manual
// decision.
//
// Run against production (needs the owner's go-ahead):
//   heroku run --no-tty -a meetup-discord-bot -- node - < scripts/auditLgbtqOverwrites.js
//
// Membership of this channel is sensitive, so the default output is counts
// only. To also list the flagged user ids (for a private cleanup, never for
// a PR, an issue, or a public channel), set AUDIT_SHOW_IDS=1:
//   heroku run --no-tty -a meetup-discord-bot -e AUDIT_SHOW_IDS=1 -- node - < scripts/auditLgbtqOverwrites.js
//
// Plain CommonJS-compatible JS with no imports, because it is piped to
// `node -` on a dyno rather than run through tsx. The ids below mirror
// GUILD_ID, LGBTQ_CHANNEL_ID and SERVER_ROLES.onboarding in src/constants.ts.

const API = 'https://discord.com/api/v10';
const GUILD_ID = '912461362289061939';
const LGBTQ_CHANNEL_ID = '935434313183404062';
const ONBOARDING_ROLE_ID = '932906028725571594';
const MEMBER_OVERWRITE = 1; // 0 is a role overwrite
const VIEW_CHANNEL = 1n << 10n;
const UNKNOWN_MEMBER = 10007;
const UNKNOWN_USER = 10013;
const MAX_ATTEMPTS = 5;

/** GET only: this script must never change anything. */
async function get(path, attempt = 1) {
  const response = await fetch(`${API}${path}`, {
    method: 'GET',
    headers: { Authorization: `Bot ${process.env.DISCORD_API_KEY}` },
  });
  if (response.status === 429 && attempt < MAX_ATTEMPTS) {
    const { retry_after: retryAfter } = await response.json();
    await new Promise((resolve) => {
      setTimeout(resolve, (Number(retryAfter) || 1) * 1000 + 100);
    });
    return get(path, attempt + 1);
  }
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function main() {
  if (!process.env.DISCORD_API_KEY) {
    throw new Error('DISCORD_API_KEY is not set');
  }
  const showIds = process.env.AUDIT_SHOW_IDS === '1';

  const channel = await get(`/channels/${LGBTQ_CHANNEL_ID}`);
  if (channel.status !== 200) {
    throw new Error(`Could not read the channel: HTTP ${channel.status}`);
  }
  if (channel.body.guild_id !== GUILD_ID) {
    throw new Error('Channel is not in the expected guild');
  }

  const memberOverwrites = channel.body.permission_overwrites.filter(
    (overwrite) => overwrite.type === MEMBER_OVERWRITE,
  );
  // Only an allow of ViewChannel lets someone in; a per-user deny (or an
  // overwrite for some other permission) is not what this audit is about.
  const allowed = memberOverwrites.filter(
    (overwrite) => (BigInt(overwrite.allow) & VIEW_CHANNEL) !== 0n,
  );

  const onboarding = [];
  const leftGuild = [];
  const unknown = [];
  let ok = 0;
  for (const overwrite of allowed) {
    // Sequential on purpose: one bucket, and no rush.

    const member = await get(`/guilds/${GUILD_ID}/members/${overwrite.id}`);
    if (member.status === 200) {
      if (member.body.roles.includes(ONBOARDING_ROLE_ID)) {
        onboarding.push(overwrite.id);
      } else {
        ok += 1;
      }
    } else if (
      member.status === 404 &&
      (member.body.code === UNKNOWN_MEMBER || member.body.code === UNKNOWN_USER)
    ) {
      leftGuild.push(overwrite.id);
    } else {
      // Never guess: an unreadable member is reported, not counted as gone.
      unknown.push(overwrite.id);
    }
  }

  console.log('LGBTQ channel per-user overwrite audit (read-only)');
  console.log(
    `Per-user overwrites, total:          ${memberOverwrites.length}`,
  );
  console.log(`  of which allow ViewChannel:        ${allowed.length}`);
  console.log(`Verified members (expected):         ${ok}`);
  console.log(`Holding the Onboarding role:         ${onboarding.length}`);
  console.log(`No longer in the server:             ${leftGuild.length}`);
  console.log(`Could not be checked:                ${unknown.length}`);
  if (showIds) {
    console.log('\nSENSITIVE - do not paste below this line anywhere public.');
    console.log(`Onboarding: ${onboarding.join(' ') || '(none)'}`);
    console.log(`Left server: ${leftGuild.join(' ') || '(none)'}`);
    console.log(`Unchecked: ${unknown.join(' ') || '(none)'}`);
  } else {
    console.log('\nUser ids withheld. Set AUDIT_SHOW_IDS=1 to list them.');
  }
}

main().catch((error) => {
  console.error(`Audit failed: ${error.message}`);
  process.exitCode = 1;
});
