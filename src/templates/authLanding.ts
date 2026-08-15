import {
  GET_VERIFIED_CHANNEL_ID,
  GUILD_ID,
  WELCOME_CHANNEL_ID,
} from '../constants.js';

const successIcon =
  // eslint-disable-next-line @stylistic/max-len
  '<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>';
const failIcon =
  // eslint-disable-next-line @stylistic/max-len
  '<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>';

// All current callers pass constants, but escape defensively so a future
// caller that threads through user-controlled text can't reintroduce XSS.
const escapeHtml = (input: string): string =>
  input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Client-side hand-off: send the browser to the Discord app, and only fall
 * back to the web app if nothing took over. Without the cancellation the
 * fallback fires unconditionally, so a desktop user who lands in the app also
 * gets Discord opened in their browser a moment later.
 *
 * Backgrounding is the signal that the app claimed the link: the OS hands
 * focus to Discord, so this tab is hidden/blurred before the timer fires.
 */
export const buildHandoffScript = (deepLink: string, webLink: string) => `
var meetupBotHandoff = (function () {
  var handedOff = false;
  var fallbackTimer;
  function handedOffToApp() {
    handedOff = true;
    if (fallbackTimer) { clearTimeout(fallbackTimer); }
  }
  window.addEventListener('blur', handedOffToApp);
  window.addEventListener('pagehide', handedOffToApp);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { handedOffToApp(); }
  });
  window.location.href = '${deepLink}';
  fallbackTimer = setTimeout(function () {
    if (!handedOff) { window.location.href = '${webLink}'; }
  }, 2000);
  return true;
})();
`;

export const getAuthLandingPage = (
  status: 'success' | 'error',
  message: string,
) => {
  const isSuccess = status === 'success';
  const title = isSuccess ? 'Success!' : 'Something went wrong';
  const color = isSuccess ? '#5865F2' : '#ED4245'; // Discord Blurple or Red
  const icon = isSuccess ? successIcon : failIcon;
  const targetChannelId = isSuccess
    ? WELCOME_CHANNEL_ID
    : GET_VERIFIED_CHANNEL_ID;
  const deepLink = `discord://-/channels/${GUILD_ID}/${targetChannelId}`;
  const webLink = `https://discord.com/channels/${GUILD_ID}/${targetChannelId}`;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Meetup Bot Auth</title>
    <style>
        body {
            background-color: #36393f;
            color: #dcddde;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
        }
        .container {
            background-color: #2f3136;
            padding: 40px;
            border-radius: 8px;
            box-shadow: 0 4px 15px rgba(0,0,0,0.2);
            text-align: center;
            max-width: 400px;
            width: 100%;
        }
        .icon {
            color: ${color};
            margin-bottom: 20px;
        }
        h1 {
            margin: 0 0 10px;
            color: #fff;
        }
        p {
            margin-bottom: 30px;
            line-height: 1.5;
        }
        .btn {
            display: inline-block;
            background-color: #5865F2;
            color: white;
            padding: 12px 24px;
            text-decoration: none;
            border-radius: 4px;
            font-weight: 600;
            transition: background-color 0.2s;
        }
        .btn:hover {
            background-color: #4752c4;
        }
        .secondary {
            margin: 20px 0 0;
            font-size: 0.85em;
            color: #a3a6aa;
        }
        .secondary a {
            color: #a3a6aa;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">
            ${icon}
        </div>
        <h1>${title}</h1>
        <p>${escapeHtml(message)}</p>
        <a href="${deepLink}" class="btn">Back to Discord</a>
        <p class="secondary">or <a href="${webLink}">open Discord in your browser</a></p>
    </div>
    ${
      isSuccess
        ? `<script>${buildHandoffScript(deepLink, webLink)}</script>`
        : ''
    }
</body>
</html>
  `;
};
