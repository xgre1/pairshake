# Finding each other

When both people say yes, PairShake shows an arrow and a distance until they meet. How it does that depends on what the two phones can do.

| Both on | Distance | Direction |
| --- | --- | --- |
| The iPhone app (iPhone 11 or later, not SE or 16e) | Ultra Wideband, then Bluetooth when out of range | Ultra Wideband, then GPS when far apart |
| A seed attendee (no phone) | a made-up position nearby | GPS, compass and gyroscope |

## In the app: Ultra Wideband

`app/PairShake/Finder.swift` runs a Nearby Interaction session with the other phone.

- **Token exchange.** Each phone's discovery token travels two ways at once: through the room's WebSocket (`ni` messages) and directly over Bluetooth, through a service only the two phones know (derived from the introduction's id). Bad Wi-Fi can't stop them from finding each other.
- **Distance.** The median of the last five readings (a tenth of a second), so one bounce off a wall can't make the number jump. Readings arrive about 50 times a second. A gap of up to 6 seconds keeps the last Ultra Wideband distance instead of switching to Bluetooth's much rougher guess.
- **Direction, like Find My's Precision Finding.** Camera assistance is on for the whole search. The app runs its own ARKit world tracking and hands it to Nearby Interaction, which places the other person in the room (`worldTransform(for:)`). The arrow is drawn from where the phone is now to that spot, about 30 times a second, so it stays right while you turn and while you walk, even when they're behind you. It never switches camera assistance off and on: that restarts the session and throws away what it has worked out.
- **The camera's first frame.** Nearby Interaction refuses an ARSession that hasn't delivered a frame yet (`NIERROR_INVALID_AR_SESSION_DESCRIPTION`), so the first run waits for one. If it still refuses twice, Nearby Interaction runs its own camera session instead (direction then pinned with the gyroscope, and no camera picture).
- **The screen.** While the finding screen is open the app draws that same camera, blurred, behind the transparent page (`findView` message; each reading says `cam: true`). No direction yet: soft dots drift round the middle and the page says what helps. A direction: the dots fold away and the arrow sharpens out of a blur, turning on a spring every frame, with the distance eased the same way. Pointing at them (inside 12°, out past 20°) floods the screen with their colour from the arrow outwards.
- **Why the camera.** iPhone 15 Pro and 16 Pro (the U2 chip) give no direction at all without it (`supportsDirectionMeasurement` is false); with it they give one only after the phone has been moved around for a few seconds in enough light. Older iPhones give a 3D direction either way.
- **Steady arrow.** Each reading moves the spot a little (about a quarter of a second of smoothing). A reading far from it counts only if the next ones agree for 0.7 seconds, so one reflection can't swing the arrow. When the live distance stops matching the spot for 1.5 seconds (they walked off), the spot is dropped and found again.
- **No world tracking.** On a phone without camera assistance, or while ARKit is still starting, each direction is pinned to the room with the gyroscope instead: right while you turn, not while you walk, so it is kept for 15 seconds only.
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

## What testing taught us

- **Camera assistance needs light.** With it always on, one phone received 55 Ultra Wideband readings a second at 1.5 metres and not one direction at night: the camera never had enough light. Plain Ultra Wideband was tried first for a while, but on iPhone 15 Pro and 16 Pro it gives no direction at all, and switching between the two kept restarting the session (direction lost, distance falling back to Bluetooth and jumping). In the dark the page asks for more light, as Precision Finding does.
- **GPS can't point across a room.** Its error is several metres, so the arrow only moved after walking that far. GPS direction is used only when people are well apart.
- **Diagnostics.** The app writes `Documents/web.log` on the phone: page load times, errors, the phone's Nearby Interaction abilities when finding starts, and every 5 seconds how many Ultra Wideband readings arrived, how many placed the person / had a 3D direction / had only a horizontal angle, the arrow, the camera's tracking state, and how `horizontalAngle` compares with NI's placement (its sign isn't documented). See [running.md](running.md) for how to read it.

## Sound ranging experiment

The sound-ranging experiment (`sonar.py`, `sonar.html`, `probe_report.py`) moved out with the web version, to `~/Desktop/pairshake-web`.
