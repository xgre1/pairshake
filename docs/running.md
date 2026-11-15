# Running PairShake

## What you need

- `wrangler`, signed in to the Cloudflare account (`npx wrangler login`). Nothing else has to run anywhere: PairShake lives entirely on Cloudflare.
- For the iPhone app: Xcode and XcodeGen (`brew install xcodegen`).

## 1. Deploying

```sh
make edge                   # edge/deploy.sh: copies app/web into edge/public and deploys
```

Address: **https://pairshake.binjto.workers.dev**, for the app only (a browser sees a note that PairShake is an iPhone app). The page is never cached, so after a deploy the app shows it the next time it opens; data is kept across deploys.

The keys are Worker secrets (see [edge/README.md](../edge/README.md)). They only need setting again if they change.

## 2. Watching it

```sh
npx wrangler tail pairshake    # live logs: every match, model error and voice fallback
make backup                 # the whole room, saved to backups/
curl https://pairshake.binjto.workers.dev/room      # numbers for the room
```

## 3. The iPhone app

```sh
make app                    # cd app && xcodegen
open app/PairShake.xcodeproj
```

Pick your team in Signing & Capabilities if it differs, choose a connected iPhone, and run. Or from the command line:

```sh
xcodebuild -project app/PairShake.xcodeproj -scheme PairShake -destination 'id=<device udid>' -allowProvisioningUpdates build
xcrun devicectl device install app --device <device id> <DerivedData>/Build/Products/Debug-iphoneos/PairShake.app
```

First time on a phone:

1. Connect it by cable and tap **Trust** on the phone.
2. Turn on **Settings → Privacy & Security → Developer Mode** and restart when asked.
3. After installing, open **Settings → General → VPN & Device Management**, tap the developer certificate and **Trust** it.
4. Open PairShake and allow the microphone, Bluetooth, Nearby Interaction, camera and location.

After that, phones on the same Wi-Fi as the Mac can be updated without a cable. With a free Apple developer account the app stops opening after 7 days; install it again.

Only native changes need a reinstall. The page, Emma and matching come from Cloudflare, so closing and reopening the app is enough.

## Testing finding between two phones

1. Open PairShake on two iPhones with the app.
2. On both, tap **Test: find another phone** on the first page.
3. The phones are introduced to each other as made-up attendees who have both said yes, and go straight to the finding screen.

To read a phone's diagnostics afterwards:

```sh
xcrun devicectl device copy from --device <device id> --domain-type appDataContainer \
  --domain-identifier com.jtobin.pairshake --source Documents/web.log --destination web.log
```

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| The app says "Connecting to PairShake…" | The phone is offline, or a server address typed in by hand no longer answers. The app retries every 2 seconds. Shake the phone to change the server address. |
| Emma's lines come out in a different voice | ElevenLabs failed (allowance used up, or down), so Workers AI's voice stands in. `wrangler tail` shows why. |
| Matches come back plain ("I want you to meet …") | The model failed; the code still paired people. Check `wrangler tail` for `gemini 4xx/5xx`. |
| On the web in Safari, a top bar sits halfway down after typing | An iOS 26 WebKit bug (the page isn't panned back after the keyboard closes, WebKit bug 297779). The app avoids it by shrinking the page above the keyboard; the web page nudges the scroll after the keyboard closes. |
| The arrow doesn't turn | See [finding.md](finding.md). Hold the phone up and follow the hint on screen. |
| A `trycloudflare.com` link stopped working | Quick tunnels are for testing and can disappear at any time. Use the Worker address. |
