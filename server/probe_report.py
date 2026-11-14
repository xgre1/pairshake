"""How accurate was the finder test page? Reads the probes the phones logged (sonar_probe.jsonl).

    python3 probe_report.py                 # latest version, room "test"
    python3 probe_report.py --version mix13 --room test --since 20:00

Distance: every probe where the tester typed the real distance is compared with what the screen showed.
Direction: every "I'm facing them now" tap stores how far off the arrow was at that moment.
Distance is split by what measured it (sound, walking, GPS); direction by what drove the arrow (sound sweep,
walking, GPS), so improvements show up as numbers.
"""
import argparse
import json
import os
import re
import statistics
import time
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))


def pct(values, p):
    v = sorted(values)
    return v[min(len(v) - 1, int(p * len(v)))]


def shown_metres(text):
    m = re.match(r"[≈~]?\s*([\d.]+)\s*(k?m)", text or "")
    if not m:
        return None
    return float(m.group(1)) * (1000 if m.group(2) == "km" else 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", default=os.path.join(HERE, "sonar_probe.jsonl"))
    ap.add_argument("--version")
    ap.add_argument("--room", default="test")
    ap.add_argument("--since", help="HH:MM today")
    a = ap.parse_args()

    rows = []
    with open(a.file) as f:
        for line in f:
            try:
                rows.append(json.loads(line))
            except ValueError:
                pass
    rows = [r for r in rows if r.get("room") == a.room and "shown" in r]
    if a.since:
        h, m = map(int, a.since.split(":"))
        t0 = time.mktime(time.localtime()[:3] + (h, m, 0, 0, 0, -1))
        rows = [r for r in rows if r["ts"] >= t0]
    if not rows:
        print("No probes with the new fields yet. Test with version mix13 or later.")
        return
    version = a.version or rows[-1]["v"]
    rows = [r for r in rows if r["v"] == version]
    print(f"version {version} · room {a.room} · {len(rows)} probes · phones {sorted({r['role'] for r in rows})}")

    dist = defaultdict(list)
    for r in rows:
        truth, shown = r.get("truth"), shown_metres((r.get("shown") or {}).get("dist"))
        if truth and shown is not None:
            dist[(r.get("shown") or {}).get("distSrc") or "?"].append(abs(shown - truth))
    print("\nDistance error (screen vs the real distance typed in)")
    if not dist:
        print("  none: type the real distance under Testing tools while testing")
    for mode, e in sorted(dist.items()):
        print(f"  {mode:10s} n={len(e):4d}  median {statistics.median(e):.2f} m   90% within {pct(e, .9):.2f} m")

    facing = defaultdict(list)
    for r in rows:
        if r["kind"] == "facing":
            facing[r.get("mode")].append(r.get("arrowErr"))
    print("\nDirection error (arrow angle when 'I'm facing them now' was tapped)")
    if not facing:
        print("  none: point the phone at the other person and tap 'I'm facing them now'")
    for mode, e in sorted(facing.items()):
        got = [abs(x) for x in e if x is not None]
        miss = len(e) - len(got)
        if got:
            print(f"  {mode:10s} n={len(got):4d}  median {statistics.median(got):.0f}°   90% within {pct(got, .9):.0f}°"
                  + (f"   ({miss} taps with no arrow)" if miss else ""))
        else:
            print(f"  {mode:10s} {miss} taps, no arrow shown")

    modes = defaultdict(int)
    for r in rows:
        if r["kind"] == "tick":
            modes[r.get("mode")] += 1
    total = sum(modes.values()) or 1
    print("\nWhat drove the arrow (share of time): " + ", ".join(f"{m} {100 * n // total}%" for m, n in sorted(modes.items(), key=lambda x: -x[1])))
    silent = sum(1 for r in rows if r["kind"] == "mic-silent")
    if silent:
        print(f"Warning: a microphone went silent {silent} times (another tab or app holding the mic).")


if __name__ == "__main__":
    main()
