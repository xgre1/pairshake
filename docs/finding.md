# Finding each other

When both people say yes, PairShake shows an arrow and a distance until they meet. How it does that depends on what the two phones can do.

| Both on | Distance | Direction |
| --- | --- | --- |
| The iPhone app (iPhone 11 or later, not SE or 16e) | Ultra Wideband, then Bluetooth when out of range | Ultra Wideband, then GPS when far apart |
| A seed attendee (no phone) | a made-up position nearby | GPS, compass and gyroscope |

## In the app: Ultra Wideband

`app/Roomie/Finder.swift` runs a Nearby Interaction session with the other phone.

- **Token exchange.** Each phone's discovery token travels two ways at once: through the room's WebSocket (`ni` messages) and directly over Bluetooth, through a service only the two phones know (derived from the introduction's id). Bad Wi-Fi can't stop them from finding each other.
- **Distance.** The median of the last three readings, so one bounce off a wall can't make the number jump. Readings arrive about 50 times a second.
- **Direction.** Plain Ultra Wideband gives a direction instantly and in the dark, but only for someone roughly in front of the phone and not too far away. Camera-assisted Ultra Wideband (ARKit plus the radio) sees further and to the side, but only once the phone has been moved around in enough light. So the app starts plain, switches to camera assistance after 5 seconds without a direction, and goes back to plain after 15 seconds if the camera can't work it out either.
- **Pinned to the room.** Each direction is turned into a compass-free world direction with the gyroscope, so the arrow stays right while you turn, and an old direction stays useful for 45 seconds after the radio loses sight of them.
- **Hints.** While no direction comes, the page says what helps: hold the phone up and turn, move it from side to side, tilt it, walk a few steps, or find more light.
- **GPS as a stand-in.** With no radio direction and the two of you at least 8 metres apart (and further than GPS's own error), the arrow follows the GPS direction and says so. Up close GPS is too rough to point with.
- **Bluetooth.** Out of Ultra Wideband range, the signal strength of the Bluetooth link gives a rough distance.
- **Recovery.** Sessions that stall, get suspended or end are restarted on their own, and tokens are offered again until ranging starts.

The page draws the reading: `RoomieApp.onFix({d, a, mode, coach})` arrives about 15 times a second; while one is less than 3 seconds old it wins over GPS.

## In the page: GPS, compass, gyroscope

In `app/web/index.html` (`Find`):

- **Position.** Each GPS fix is blended with the last estimate by how accurate it claims to be (a small Kalman filter). A single fix far outside the expected error is held back until a second one agrees.
- **Pointing.** The gyroscope gives smooth, fast turning; the compass only slowly corrects its drift, and a sudden compass jump (a laptop, a steel beam) is ignored unless it lasts 2.5 seconds. While you walk, your direction of travel corrects it too.
- Both phones share their filtered position over the room's WebSocket.

## What testing taught us

- **Camera assistance on its own fails at night.** With it always on, one phone received 55 Ultra Wideband readings a second at 1.5 metres and not one direction: the camera never had enough light. That is why plain Ultra Wideband comes first.
- **GPS can't point across a room.** Its error is several metres, so the arrow only moved after walking that far. GPS direction is used only when people are well apart.
- **Diagnostics.** The app writes `Documents/web.log` on the phone: page load times, errors, and every 5 seconds how many Ultra Wideband readings arrived and how many had a direction. See [running.md](running.md) for how to read it.

## Sound ranging experiment

The sound-ranging experiment (`sonar.py`, `sonar.html`, `probe_report.py`) moved out with the web version, to `~/Desktop/pairshake-web`.
