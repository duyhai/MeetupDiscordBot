const successIcon =
  // eslint-disable-next-line max-len
  '<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>';
const failIcon =
  // eslint-disable-next-line max-len
  '<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>';

export const getAuthLandingPage = (
  status: 'success' | 'error',
  message: string
) => {
  const isSuccess = status === 'success';
  const title = isSuccess ? 'Success!' : 'Something went wrong';
  const color = isSuccess ? '#5865F2' : '#ED4245'; // Discord Blurple or Red
  const icon = isSuccess ? successIcon : failIcon;
  const deepLink = 'discord://';
  const webLink = 'https://discord.com/channels/@me';

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
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">
            ${icon}
        </div>
        <h1>${title}</h1>
        <p>${message}</p>
        <a href="${webLink}" class="btn" onclick="setTimeout(function(){ window.location = '${deepLink}'; }, 25);">Back to Discord</a>
    </div>
    <script>
        window.onload = function() {
            if ("${status}" === "success") {
                // Try deep link immediately
                window.location.href = "${deepLink}";
                
                // Fallback to web link if deep link fails (though browser handling varies)
                setTimeout(function() {
                     window.location.href = "${webLink}";
                }, 1500);
            }
        }
    </script>
</body>
</html>
  `;
};
