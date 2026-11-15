import Foundation

/// A finished introduction for previews and stage rehearsals (launch with -demoIntro or -demoGame).
extension Flow {
    func loadSample(openGame: Bool) {
        let json = #"""
        {"say": "", "me": {"id": "me", "name": "Kai Laine", "role": "iOS and Swift builder", "color": "#8FD3FF",
          "building": "An agent that reads any menu and tells you what to order.", "needs": "Travellers to test it, and a designer.",
          "offers": "iOS and Swift.", "spot": "Back left, green beanie.", "line": "", "socials": {}},
         "mission": {"id": "demo", "outcome": null,
          "intro": "Eleni is the designer you asked for. She can make a demo look finished in one night, which is exactly what a phone-first menu agent needs. And she's been hunting for someone who has actually shipped an agent. That's you.",
          "overlap": {"rare": [{"text": "Both left finance for a product bet.", "opener": "Did leaving the bank feel like relief, or a gamble you're still testing?"},
                               {"text": "Both build for people lost in another language.", "opener": "When someone's lost in a menu, what's the first sign your agent should catch?"}],
                      "you_only": ["Swift and iOS builder", "Travel menu reader"], "them_only": ["Figma and interface design", "Tutor for lost learners"],
                      "give": "iOS help to ship her tutor", "get": "A design that looks finished tonight",
                      "ladder": ["What's the strangest dish you've had to guess your way through?", "What does your tutor show someone the moment they're lost?", "What did leaving your old job cost you that you still think about?"]},
          "person": {"id": "s1", "name": "Eleni Markou", "role": "Product designer, ex-fintech", "color": "#FFB86B",
           "building": "A language tutor that notices when you're lost and changes the exercise.",
           "needs": "A backend engineer who has shipped agents.", "offers": "Interface design, Figma, making a demo look finished in one night.",
           "spot": "Row 5 by the window, yellow raincoat.", "line": "",
           "socials": {"x": "eleni_designs", "instagram": "eleni.makes", "linkedin": "elenimarkou"}}}}
        """#
        guard let r = try? JSONDecoder().decode(MatchResp.self, from: Data(json.utf8)) else { return }
        result = r
        stage = .match
        if openGame { openMission = r.mission }
    }
}

import SwiftUI

/// Launch with -demoFind (or -demoFindAligned) to look at the finding screen without two phones.
struct FindPreviewHost: View {
    @StateObject private var finder = Finder()
    let aligned: Bool
    var body: some View {
        FindView(person: Person(id: "s1", name: "Eleni Markou", role: "", color: "#FFB86B", building: "", needs: "",
                                offers: "", spot: "Row 5 by the window, yellow raincoat.", line: "", socials: [:], seed: true),
                 finder: finder) {}
            .onAppear {
                finder.distance = 8.4
                finder.angle = aligned ? 0.05 : -0.9
            }
    }
}
