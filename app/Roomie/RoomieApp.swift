import SwiftUI

/// PairShake for the people on stage: the same web app the audience uses, as an iPhone app,
/// with finding done by the phone's radios instead of GPS.
@main
struct RoomieApp: App {
    var body: some Scene {
        WindowGroup {
            WebShellView()
                .ignoresSafeArea()
                .background(Color(.systemBackground))
        }
    }
}
