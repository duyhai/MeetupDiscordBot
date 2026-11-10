# Event changes screenshots

Rendered through the real dashboard router from fake fixture data (no real
events or members; `tst/web/routes/eventChanges.screenshots.test.ts` with
`SCREENSHOT_OUT` set writes the pages), in headless Chrome at device scale 1,
1600 px tall. "Desktop" is 1280 px wide; "phone" is 360 px. Light and dark
are the dashboard's own theme setting.

- `event-changes-desktop-light.png` / `-dark.png`: the Event changes list with
  the Snapshot-now card, the filter bar and one row per change kind.
- `event-changes-phone-light.png` / `-dark.png`: the same list as stacked cards.
- `event-history-desktop-light.png` / `-dark.png`: one event's history: the
  latest snapshot card, its changes and its snapshots.
- `event-history-phone-light.png` / `-dark.png`: the same on a phone.
