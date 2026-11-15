"""Draws PairShake's icon layers (Roomie/AppIcon.icon/Assets/*.svg, 1024 x 1024).

The idea: two drops about to merge, the way the matching screen draws you meeting your person. You (the
bigger drop, white) and them (the smaller, warm) are joined by a liquid neck: the same metaball connector
as goo() in server/web/index.html. Two layers, so each catches its own light: you in front, them and the
neck reaching out to you behind.

    python3 tools/icon_art.py
"""
import math, os

OUT = os.path.join(os.path.dirname(__file__), "..", "Roomie", "AppIcon.icon", "Assets")
R1, R2, GAP, ANGLE = 168, 116, 104, math.radians(0)         # sizes, space between, direction (level, them on the right)
V, HANDLE = 0.42, 2.4


def goo(c1, r1, c2, r2):
    d = math.dist(c1, c2)
    max_d = r1 + r2 * 3.2
    smooth = lambda a, b, x: (lambda k: k * k * (3 - 2 * k))(max(0, min(1, (x - a) / (b - a))))
    u1 = u2 = 0.0
    ac = math.atan2(c2[1] - c1[1], c2[0] - c1[0])
    spread = math.acos(max(-1, min(1, (r1 - r2) / d)))
    pinch = 1 - smooth(r1 + r2, max_d, d)
    vv = V * (.35 + .65 * pinch)
    a1, a2 = ac + u1 + (spread - u1) * vv, ac - u1 - (spread - u1) * vv
    a3 = ac + math.pi - u2 - (math.pi - u2 - spread) * vv
    a4 = ac - math.pi + u2 + (math.pi - u2 - spread) * vv
    P = lambda c, a, r: (c[0] + math.cos(a) * r, c[1] + math.sin(a) * r)
    p1, p2, p3, p4 = P(c1, a1, r1), P(c1, a2, r1), P(c2, a3, r2), P(c2, a4, r2)
    k = min(vv * HANDLE, math.dist(p1, p3) / (r1 + r2)) * min(1, d * 2 / (r1 + r2))
    h1, h2 = P(p1, a1 - math.pi / 2, r1 * k), P(p2, a2 + math.pi / 2, r1 * k)
    h3, h4 = P(p3, a3 + math.pi / 2, r2 * k), P(p4, a4 - math.pi / 2, r2 * k)
    f = lambda p: f"{p[0]:.1f} {p[1]:.1f}"
    return f"M{f(p1)} C{f(h1)} {f(h3)} {f(p3)} L{f(p4)} C{f(h4)} {f(h2)} {f(p2)} Z"


d = R1 + R2 + GAP
dx, dy = math.cos(ANGLE) * d, math.sin(ANGLE) * d
# centre the pair's bounding box on the canvas
x0, x1 = min(-R1, dx - R2), max(R1, dx + R2)
y0, y1 = min(-R1, dy - R2), max(R1, dy + R2)
cx, cy = 512 - (x0 + x1) / 2, 512 - (y0 + y1) / 2
c1, c2 = (cx, cy), (cx + dx, cy + dy)
print(f"glyph {x1 - x0:.0f} x {y1 - y0:.0f} px ({(x1 - x0) / 10.24:.0f}% of the width)")

front = f"""<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <circle cx="{c1[0]:.1f}" cy="{c1[1]:.1f}" r="{R1}" fill="#FFFFFF"/>
</svg>
"""
back = f"""<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="{c1[0]:.1f}" y1="{c1[1]:.1f}" x2="{c2[0]:.1f}" y2="{c2[1]:.1f}">
    <stop offset="0.45" stop-color="#FFE7D0"/><stop offset="0.85" stop-color="#FFB173"/></linearGradient></defs>
  <g fill="url(#g)">
    <circle cx="{c2[0]:.1f}" cy="{c2[1]:.1f}" r="{R2}"/>
    <path d="{goo(c1, R1, c2, R2)}"/>
  </g>
</svg>
"""
os.makedirs(OUT, exist_ok=True)
open(os.path.join(OUT, "front.svg"), "w").write(front)
open(os.path.join(OUT, "back.svg"), "w").write(back)
print("wrote", os.path.normpath(OUT))
