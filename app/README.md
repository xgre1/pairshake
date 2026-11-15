# app

The Roomie iPhone app, used by the people on stage. It shows the same web app as the audience, full screen, and adds what a browser can't do: finding the other person with Ultra Wideband and Bluetooth, haptics, and Core Location.

```sh
xcodegen                     # regenerate Roomie.xcodeproj from project.yml
open Roomie.xcodeproj
```

| File | What it is |
| --- | --- |
| `project.yml` | XcodeGen project: iOS 18, iPhone only, portrait, permissions. A build step copies the hands' models from `../server/web/hands` into the app with their server ETags. |
| `Roomie/RoomieApp.swift` | App entry point. |
| `Roomie/WebShell.swift` | The WKWebView and the `window.RoomieApp` bridge: GPS from Core Location, haptics, permissions, keyboard handling, retrying when the server is away, and the diagnostics log. |
| `Roomie/LocalServer.swift` | A server on `localhost:47213` inside the app. It serves the page (localhost counts as secure, so the microphone works), ships the models and three.js, and passes everything else, including the room's WebSocket, to Roomie. |
| `Roomie/Server.swift` | Which Roomie server to use, and the sheet for changing it (shake the phone). |
| `Roomie/Finder.swift` | Ultra Wideband (Nearby Interaction), the Bluetooth link between the two phones, and the gyroscope. |
| `Vendor/` | three.js 0.170.0 (MIT), bundled so the first launch needs no CDN. |
| `Legacy/` | The first, fully native SwiftUI version. Kept for reference, not compiled. |

Installing on phones, testing finding, and reading the log: [docs/running.md](../docs/running.md). How finding works: [docs/finding.md](../docs/finding.md).
