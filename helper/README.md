# Folio helper

Fetches a YouTube video's real caption timings for the web app.

## Why it exists

Folio needs the video's own caption timings. Without them the model has to
guess where it is in the video, and it cannot — asked to timestamp a 42-minute
video it compressed the whole thing into the first 20 minutes and placed a
scene from 38:49 at 0:30, a median error of **563 seconds**. Handed the real
timings to copy, the same model lands within **16 seconds**.

## Why it has to run on your machine

Nothing else can fetch them:

- A browser tab cannot read `youtube.com` (not CORS-readable), and the embedded
  player refuses to serve its own track (`is_servable: false`).
- A cloud function is answered with *"Sign in to confirm you're not a bot"* —
  measured on Vercel, even through yt-dlp, because it comes from a datacenter
  address. Cookies would work and would mean putting a Google session on a
  server, which is not worth the account.
- Your Mac can, because it is an ordinary residential connection.

Browsers treat `127.0.0.1` as a secure context, so the https page is allowed to
call it.

## Run it

```
node helper/folio-helper.js
```

Needs `yt-dlp` on the machine (`brew install yt-dlp`). Listens on loopback
only, port 8787. Handles no credentials and stores nothing but a caption cache
in the system temp directory.

To start it automatically at login:

```
cp helper/com.folio.helper.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.folio.helper.plist
```

## Without it

Folio still works. It says so, and falls back to asking the model for
timestamps — which is fast and cheap and gets them badly wrong on anything
long. The import button also stays available for pasting a transcript by hand.
