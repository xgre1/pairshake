# Running Roomie

## What you need

- A Mac with Emma's engine and its Python environment in `~/Desktop/emma` (it provides the voice, the speech recogniser, and `aiohttp`).
- The `claude` command line tool, signed in. The server calls it for every decision.
- `cloudflared` (`brew install cloudflared`), and for the Worker, `wrangler` signed in to the Cloudflare account.
- For the iPhone app: Xcode and XcodeGen (`brew install xcodegen`).

## 1. The server

```sh
make server                 # same as: cd server && ~/Desktop/emma/.venv/bin/python -u server.py
```

It listens on port 8780 and serves the web app at `/`. Use Emma's environment: the system Python lacks the audio libraries her engine needs and the server stops at start-up. State is saved to `server/room.json`, so restarting is safe.

Environment variables: `PORT` (default 8780), `ROOMIE_MODEL` (default `haiku`).

## 2. The tunnel

```sh
make tunnel                 # edge/tunnel.sh
```

This connects the Mac to Cloudflare through the named tunnel `roomie`, over HTTP/2 (steadier on venue Wi-Fi than QUIC). The token is read from `~/.cloudflared/roomie.token`, which is not in the repository. Keep it running alongside the server. If the Mac restarts, start both again.

## 3. The Worker

Only needed when `edge/` changes or the hands' models change on the server:

```sh
make edge                   # edge/deploy.sh: copies the models, notes their ETags, deploys
```

The Worker reaches the Mac through the Workers VPC service `roomie-origin`, which points at `127.0.0.1:8780` through the tunnel. (It points at `127.0.0.1` rather than `localhost`: `localhost` resolved to IPv6 first, where the server doesn't listen.)

Public address: **https://roomie.binjto.workers.dev**. Share this with the audience.

## 4. The iPhone app

```sh
make app                    # cd app && xcodegen
open app/Roomie.xcodeproj
```

Pick your team in Signing & Capabilities if it differs, choose a connected iPhone, and run. Or from the command line:

```sh
xcodebuild -project app/Roomie.xcodeproj -scheme Roomie -destination 'id=<device udid>' -allowProvisioningUpdates build
xcrun devicectl device install app --device <device id> <DerivedData>/Build/Products/Debug-iphoneos/Roomie.app
```

First time on a phone:

1. Connect it by cable and tap **Trust** on the phone.
2. Turn on **Settings → Privacy & Security → Developer Mode** and restart when asked.
3. After installing, open **Settings → General → VPN & Device Management**, tap the developer certificate and **Trust** it.
4. Open Roomie and allow the microphone, Bluetooth, Nearby Interaction, camera and location.

After that, phones on the same Wi-Fi as the Mac can be updated without a cable. With a free Apple developer account the app stops opening after 7 days; install it again.

Only native changes need a reinstall. The page, Emma and matching come from the server, so closing and reopening the app is enough.

## Testing finding between two phones

1. Open Roomie on two iPhones with the app.
2. On both, tap **Test: find another phone** on the first page.
3. The phones are introduced to each other as made-up attendees who have both said yes, and go straight to the finding screen.

To read a phone's diagnostics afterwards:

```sh
xcrun devicectl device copy from --device <device id> --domain-type appDataContainer \
  --domain-identifier com.jtobin.roomie --source Documents/web.log --destination web.log
```

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| The app says "Connecting to Roomie…" | The server or the tunnel is down. Start both. The app retries every 2 seconds. Shake the phone to change the server address. |
| The Worker answers "Roomie's server isn't reachable" | Same: `make server` and `make tunnel`. |
| The server stops with `No module named 'soundfile'` | It was started with the system Python. Use `make server`. |
| On the web in Safari, a top bar sits halfway down after typing | An iOS 26 WebKit bug (the page isn't panned back after the keyboard closes, WebKit bug 297779). The app avoids it by shrinking the page above the keyboard; the web page nudges the scroll after the keyboard closes. |
| The arrow doesn't turn | See [finding.md](finding.md). Hold the phone up and follow the hint on screen. |
| A `trycloudflare.com` link stopped working | Quick tunnels are for testing and can disappear at any time. Use the Worker address. |
