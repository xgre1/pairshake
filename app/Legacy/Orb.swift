import SwiftUI

extension Color {
    init(hex: String) {
        let h = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        let v = UInt64(h, radix: 16) ?? 0xB9A7FF
        self.init(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }
    // Emma's palette: the colours of her orb.
    static let iris = Color(hex: "#6E6BF2")
    static let lilac = Color(hex: "#B9A7FF")
    static let sky = Color(hex: "#8FD3FF")
    static let blush = Color(hex: "#FFB8CF")
    static let glow = Color(hex: "#F4F0FF")
}

/// Emma: a living mesh of her four colours. It breathes when idle, swells with her voice,
/// leans sky-blue while listening and churns faster while thinking.
struct Orb: View {
    var mode: Flow.Mode = .idle
    var level: CGFloat = 0
    var size: CGFloat = 200

    private var speed: Double {
        switch mode {
        case .thinking: return 2.6
        case .speaking: return 1.4
        case .listening: return 1.0
        case .idle: return 0.6
        }
    }

    private var palette: [Color] {
        switch mode {
        case .listening: return [.sky, .lilac, .sky, .iris, .glow, .sky, .lilac, .sky, .blush]
        default: return [.lilac, .iris, .sky, .blush, .glow, .lilac, .sky, .lilac, .blush]
        }
    }

    static func points(_ t: Double) -> [SIMD2<Float>] {
        func w(_ x: Double, _ amp: Double) -> Float { Float(0.5 + x * amp) }
        return [
            SIMD2(0, 0), SIMD2(w(sin(t * 0.8), 0.2), 0), SIMD2(1, 0),
            SIMD2(0, w(cos(t * 0.9), 0.2)), SIMD2(w(sin(t * 1.1), 0.22), w(cos(t * 1.3), 0.22)), SIMD2(1, w(sin(t * 0.7), 0.2)),
            SIMD2(0, 1), SIMD2(w(cos(t * 0.6), 0.2), 1), SIMD2(1, 1),
        ]
    }

    var body: some View {
        TimelineView(.animation) { tl in
            let t = tl.date.timeIntervalSinceReferenceDate * speed
            MeshGradient(width: 3, height: 3, points: Self.points(t), colors: palette, smoothsColors: true)
            .clipShape(Circle())
            .overlay(Circle().strokeBorder(.white.opacity(0.35), lineWidth: 0.5))
            .scaleEffect(1 + 0.02 * sin(t * 1.6 / speed) + level * 0.2)
            .shadow(color: Color.iris.opacity(0.28), radius: size * 0.16, y: size * 0.08)
        }
        .frame(width: size, height: size)
        .animation(.easeOut(duration: 0.12), value: level)
        .animation(.easeInOut(duration: 0.6), value: mode)
    }
}

/// Two people's colours meeting: the backdrop of every introduction.
struct PairMesh: View {
    let a: Color
    let b: Color

    private var colors: [Color] {
        [a, a.mix(with: .white, by: 0.3), b,
         a.mix(with: .white, by: 0.15), .glow, b.mix(with: .white, by: 0.15),
         a, b.mix(with: .white, by: 0.3), b]
    }

    private func points(_ t: Double) -> [SIMD2<Float>] {
        let cx = Float(0.5 + sin(t) * 0.18), cy = Float(0.5 + cos(t * 1.2) * 0.12), bx = Float(0.5 + cos(t * 0.8) * 0.15)
        return [SIMD2(0, 0), SIMD2(0.5, 0), SIMD2(1, 0),
                SIMD2(0, 0.5), SIMD2(cx, cy), SIMD2(1, 0.5),
                SIMD2(0, 1), SIMD2(bx, 1), SIMD2(1, 1)]
    }
    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30)) { tl in
            let t = tl.date.timeIntervalSinceReferenceDate * 0.35
            MeshGradient(width: 3, height: 3, points: points(t), colors: colors, smoothsColors: true)
        }
    }
}

struct Avatar: View {
    let person: Person
    var size: CGFloat = 56
    var body: some View {
        ZStack {
            Circle().fill(Color(hex: person.color).gradient)
            Text(person.initials)
                .font(.system(size: size * 0.36, weight: .semibold, design: .serif))
                .foregroundStyle(.black.opacity(0.75))
        }
        .frame(width: size, height: size)
    }
}
