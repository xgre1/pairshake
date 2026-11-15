<p align="center">
  <img src="docs/logo.svg" width="96" alt="PairShake">
</p>

<h1 align="center">PairShake</h1>

<p align="center">
  A host for a crowded room.<br>
  Built at the Gen AI Summit Hackathon, Athens, 14–15 November 2026.
</p>

<br>

**Who it's for:** anyone at an event, a conference or a co-working space who came to meet people.

**The problem:** a room full of strangers. You don't know who is worth talking to, it's awkward to walk up to someone, and the person you needed was there all along and you never met.

**What PairShake does:** your AI agent talks to everyone else's agents in the room and finds the one person you should meet right now. You both get a card, you both say yes, and your phones point you to each other across the room.

<p align="center">
  <img src="docs/screens.png" width="100%" alt="Three screens of the app">
</p>

## How it works

1. **Introduce yourself with the AI you already use.** One tap copies a question and opens ChatGPT, Claude or Gemini, which already know you. Paste its answer back, and PairShake has your profile: what you're building, what you need, what you can offer. No AI of your own? Answer a few questions instead.
2. **Join a room.** Create a network and share its QR code or link, scan someone else's, or pick the Luma event you're at. Events that haven't started yet show in the search but can't be joined until they start.
3. **Agents talk.** Inside a network your agent starts by itself. It asks the other attendees' agents whether the two of you should meet, while a ring of hands on screen shakes each agent's hand in turn (a thumbs-up for a yes).
4. **Someone for you.** When it finds someone, you get a card with no name and no face: someone here right now you should meet. You have ten seconds to tap Let's go. If they tap it too, you go straight to finding each other.
5. **Find each other.** An arrow and a distance lead you to them: Ultra Wideband between the two iPhones, Bluetooth and GPS when it can't reach. Within 2 m (or when one of you taps I found them), both phones know at once, and only then do you see who it is.

Someone you have already met is never introduced to you again.

## Matching

Nobody can predict which two strangers will click ([Joel, Eastwick & Finkel 2017](https://www.psychologicalscience.org/news/releases/romantic-matches-are-hard-to-predict.html)), and a rare thing in common bonds people more than a common one ([Alves 2018](https://scinapse.io/papers/2802513993)). So PairShake doesn't look for a perfect match. It looks for a good reason to start talking.

- **A judge reads the room.** Gemini Decision 1 answers three closed questions about you and each other person: would a five-minute talk be worth your time, would it be worth theirs, and what is the best reason to talk (one needs what the other offers, something rare in common, the same frustration, a friendly disagreement, or none). The answers are kept per pair and asked again only when a profile changes.
- **Code picks the pair, the model writes the words.** A pair scores high only when there is a reason to talk and both sides find it worth their time. The judge's answers (or, without them, the agents' verdicts) count for 80%, the two profiles for 20%.
- **Two agents per talk.** Your agent knows you and only the other person's public card, and asks. Their agent knows them and only your public card, and answers for them, yes or no. If the best person's agent says no, the next best is asked.
- **You decide what others see.** Any part of your card can be hidden. Hidden parts still help pick who you meet, but nothing written for anyone else is made from them. At least one part has to stay visible.
- **Fair to the room.** People with no introduction yet go first, and nobody is introduced to the same person twice.
- **Always an answer.** If the judge doesn't answer, up to eight agents' verdicts decide. If the model fails, the code still pairs people and writes a plain introduction.

The code is in [`edge/src/matching.js`](edge/src/matching.js).

## Built with

- **Gemini** (Flash and Flash-Lite, and Decision 1 for the judge): profiles, the agents' talks, matching, the introduction.
- **ElevenLabs**: Emma's voice. **Workers AI (Whisper)**: her ears.
- **Cloudflare**: a Worker, a Durable Object for the room, D1 for the data, R2 for every line Emma has said.
- **iPhone app** (Swift): the page full screen, plus Ultra Wideband (Nearby Interaction), Bluetooth and GPS for finding each other.
- **three.js**: Emma's 3D hands and the handshake ring.

## Architecture

```mermaid
flowchart LR
  A["iPhone app"] --> W["Cloudflare Worker"]
  W --> R["Durable Object: room<br/>people, networks, matching, chats"]
  R --> D[("D1")]
  R --> G["Gemini"]
  R --> V["ElevenLabs"]
  W --> H["Workers AI: Whisper"]
  A --> L["Luma (events)"]
  A <-. "Ultra Wideband, Bluetooth" .-> B["the other iPhone"]
```

| Path | What it is |
| --- | --- |
| [`edge/`](edge/) | The backend, all on Cloudflare: profiles, networks and events, matching, accounts, voice. It also serves the app's page. |
| [`app/`](app/) | The iPhone app: its page (`app/web/`) full screen, with finding by Ultra Wideband and Bluetooth. |
| [`docs/`](docs/) | Architecture, API, finding, and how to run everything. |
| [`prototypes/`](prototypes/) | An early standalone demo of the matching screen. |

## Try it on your iPhone

PairShake is an iPhone app. You don't need to set up any server: the app talks to our live backend on Cloudflare (`https://pairshake.binjto.workers.dev`). You only build the app and install it on your phone.

**What you need**

- A Mac with [Xcode](https://apps.apple.com/app/xcode/id497799835) 16 or later (free on the Mac App Store).
- [Homebrew](https://brew.sh) and XcodeGen: `brew install xcodegen`.
- An iPhone with iOS 18 or later, and a cable to connect it to the Mac. Finding by Ultra Wideband needs an iPhone 11 or newer; older ones use Bluetooth and GPS.
- An Apple ID. A free one is enough (the app then stops opening after 7 days; install it again).

**1. Download the code**

```sh
git clone https://github.com/xgre1/pairshake.git
cd pairshake
```

(Or on GitHub: Code → Download ZIP, then unzip it and `cd` into the folder.)

**2. Turn on Developer Mode on the iPhone**

1. Connect the iPhone to the Mac with the cable. On the iPhone, tap **Trust** and enter your passcode.
2. Open Xcode once (it may ask to install extra components: let it).
3. On the iPhone: **Settings → Privacy & Security → Developer Mode**, turn it on and tap **Restart**.
4. After the restart, unlock the iPhone and tap **Turn On** when it asks again.

(If Developer Mode isn't in the list, open Xcode with the iPhone connected and it will appear.)

**3. Sign in to Xcode with your Apple ID**

Xcode → **Settings → Accounts → +** → Apple Account, and sign in.

**4. Make the app yours**

The app's ID is taken by our team, so give it your own. In `app/project.yml`, change:

```yaml
    DEVELOPMENT_TEAM: ZZYK46YQNL                       # delete this line (you pick your team in Xcode)
        PRODUCT_BUNDLE_IDENTIFIER: com.jtobin.pairshake    # -> e.g. com.yourname.pairshake
```

Then generate the Xcode project and open it:

```sh
make app                       # runs xcodegen in app/
open app/PairShake.xcodeproj
```

**5. Install it on the iPhone**

1. In Xcode, click **PairShake** in the left sidebar → the **PairShake** target → **Signing & Capabilities**, and choose your Apple ID under **Team** (it shows as "Your Name (Personal Team)").
2. At the top of the window, pick your iPhone as the device.
3. Press **Run** (▶ or ⌘R). The first build takes a few minutes.

**6. Trust the app on the iPhone (first time only)**

The first time, the iPhone won't open it ("Untrusted Developer"). Go to **Settings → General → VPN & Device Management**, tap your Apple ID under Developer App, then **Trust**. Open PairShake again.

**7. Use it**

Sign in with LinkedIn or Google, and allow the microphone, Bluetooth, Nearby Interaction, camera and location when it asks (finding the other person needs them). Then introduce yourself with your AI, and create a network or join one.

To see a match you need at least two people in the same network, so two iPhones: install it on a second phone the same way, create a network on one and scan its QR code with the other. The test tools (the hammer on the first page) can also pair two test phones directly.

## Run your own backend (optional)

Only if you want your own server instead of ours. You need a Cloudflare account and Node.js.

```sh
npx wrangler login
cd edge
npx wrangler d1 create pairshake              # copy the database_id it prints
npx wrangler r2 bucket create pairshake-voice
```

In `edge/wrangler.jsonc`, put your own `account_id` and the new `database_id`. Then create the tables and add the keys:

```sh
npx wrangler d1 migrations apply pairshake --remote
npx wrangler secret put GEMINI_API_KEY         # Google AI Studio
npx wrangler secret put ELEVENLABS_API_KEY     # Emma's voice
npx wrangler secret put ADMIN_TOKEN            # any long random string (for backups)
npx wrangler secret put LINKEDIN_CLIENT_ID     # sign-in: a LinkedIn app and a Google OAuth client,
npx wrangler secret put LINKEDIN_CLIENT_SECRET #   each with the redirect URL
npx wrangler secret put GOOGLE_CLIENT_ID       #   https://<your worker>/auth/linkedin/callback
npx wrangler secret put GOOGLE_CLIENT_SECRET   #   and .../auth/google/callback
cd .. && make edge                             # copies app/web into the Worker and deploys
```

Then point the app at it: in `app/PairShake/Server.swift`, set `fallback` to your Worker's address, and install the app again (step 5 above).

`make help` lists every command. Logs, backups, installing on several phones and troubleshooting are in [docs/running.md](docs/running.md).

## Documentation

- [Architecture](docs/architecture.md): the parts, how a request travels, what is stored.
- [API](docs/api.md): every HTTP endpoint and WebSocket message.
- [Finding each other](docs/finding.md): Ultra Wideband, Bluetooth and GPS, and what was learned testing them.
- [Running PairShake](docs/running.md): deploying, logs, backups, phones, and troubleshooting.
