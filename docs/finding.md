# Finding each other

When both people say yes, PairShake shows an arrow and a distance until they meet. How it does that depends on what the two phones can do.

| Both on | Distance | Direction |
| --- | --- | --- |
| The iPhone app (iPhone 11 or later, not SE or 16e) | Ultra Wideband, then Bluetooth when out of range | Ultra Wideband, then GPS when far apart |
| A seed attendee (no phone) | a made-up position nearby | GPS, compass and gyroscope |

## In the app: Ultra Wideband

`app/PairShake/Finder.swift` runs a Nearby Interaction session with the other phone.

- **Token exchange.** Each phone's discovery token travels two ways at once: through the room's WebSocket (`ni` messages) and directly over Bluetooth, through a service only the two phones know (derived from the introduction's id). Bad Wi-Fi can't stop them from finding each other.
- **Distance.** The median of the last three readings, so one bounce off a wall can't make the number jump. Readings arrive about 50 times a second.
- **Direction.** Plain Ultra Wideband gives a direction instantly and in the dark, but only for someone roughly in front of the phone and not too far away. Camera-assisted Ultra Wideband (ARKit plus the radio) sees further and to the side, but only once the phone has been moved around in enough light. So the app starts plain, switches to camera assistance after 5 seconds without a direction, and goes back to plain after 15 seconds if the camera can't work it out either.
- **Pinned to the room.** Each direction is turned into a compass-free world direction with the gyroscope, so the arrow stays right while you turn, and an old direction stays useful for 45 seconds after the radio loses sight of them.
- **Hints.** While no direction comes, the page says what helps: hold the phone up and turn, move it from side to side, tilt it, walk a few steps, or find more light.
- **GPS as a stand-in.** With no radio direction and the two of you at least 8 metres apart (and further than GPS's own error), the arrow follows the GPS direction and says so. Up close GPS is too rough to point with.
- **Bluetooth.** Out of Ultra Wideband range, the signal strength of the Bluetooth link gives a rough distance.
- **Recovery.** Sessions that stall, get suspended or end are restarted on their own, and tokens are offered again until ranging starts.

The page draws the reading: `PairShakeApp.onFix({d, a, mode, coach})` arrives about 15 times a second; while one is less than 3 seconds old it wins over GPS.

## In the page: GPS, compass, gyroscope

In `app/web/index.html` (`Find`):

- **Position.** Each GPS fix is blended with the last estimate by how accurate it claims to be (a small Kalman filter). A single fix far outside the expected error is held back until a second one agrees.
- **Pointing.** The gyroscope gives smooth, fast turning; the compass only slowly corrects its drift, and a sudden compass jump (a laptop, a steel beam) is ignored unless it lasts 2.5 seconds. While you walk, your direction of travel corrects it too.
- Both phones share their filtered position over the room's WebSocket.

## When finding runs, and when it stops

Every sensor finding uses (Ultra Wideband, the camera that assists it, Bluetooth, motion, GPS) is on only while all of these are true:

- the "You both said yes" screen or the finding screen is on screen,
- the two of you haven't found each other yet,
- the app is in front (in the background the app turns everything off itself, and starts again when you come back),
- it hasn't been 15 minutes; then it pauses until you tap Keep looking.

Closing either screen turns everything off at once (`{t: "find", stop: true}` to the app, and the GPS watch is cleared). The page also forgets both positions.

## Have you found each other?

- **Ultra Wideband within 1.5 metres for 2 seconds** decides it by itself (it holds while the distance stays under 2 metres, so one reading can't break it). Both phones hear `found` at the same moment and stop.
- **Bluetooth (under about 1.2 metres) or GPS (closer than its own error, at least 6 metres)** is too rough to decide: the Found button at the top of the finding screen lights up and pulses, and you tap it.
- **The Found button is always there**, for a demo attendee or when the radios can't tell.
- **"Not with them yet? Keep looking"** undoes it for two minutes, for a tap by mistake or two people walking past each other.

Once found, the room never relays a location or a radio token again.

## After you find each other

1. **You found them.** Your faces come together, and the screen says that location, camera and radio are off. Then the two-minute mission Emma wrote for the two of you, and a question to start with: light, then real, then deep.
2. **How was it?** Stay in touch, good to meet, or not really my person. Only Emma sees the answer (it is never sent to the other person); it is kept on the introduction for her next match.
3. **Stay in touch** shows their handles with Follow. Then Find someone new, or go home.

In the room, the button at the top follows the same steps: Meet?, then Find them, then How was it?. Under People, someone you found shows Met, someone who only said yes shows Said yes.

## What testing taught us

- **Camera assistance on its own fails at night.** With it always on, one phone received 55 Ultra Wideband readings a second at 1.5 metres and not one direction: the camera never had enough light. That is why plain Ultra Wideband comes first.
- **GPS can't point across a room.** Its error is several metres, so the arrow only moved after walking that far. GPS direction is used only when people are well apart.
- **Diagnostics.** The app writes `Documents/web.log` on the phone: page load times, errors, and every 5 seconds how many Ultra Wideband readings arrived and how many had a direction. See [running.md](running.md) for how to read it.

## Sound ranging experiment

The sound-ranging experiment (`sonar.py`, `sonar.html`, `probe_report.py`) moved out with the web version, to `~/Desktop/pairshake-web`.
