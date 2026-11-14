"""Sonar test server: serves web/sonar.html over HTTPS (browsers only allow the microphone on HTTPS),
relays messages between the two phones in a room, and keeps many pairs in one hall from talking over
each other.

    python3 sonar.py            # https://<mac-ip>:8443/?room=test

Many pairs in one hall (every room is assumed to share the same air):
- Each room gets a code. The code picks one of two beep bands and one of three note pairs, so pairs on
  different bands can beep at the same time without hearing each other.
- Pairs on the same band take turns: a phone asks ("want"), the server says when ("turn"), the phone
  reports back ("done"). A short gap after each turn makes sure the last pair's beeps are over before the
  next pair's listening window opens.

Uses the self-signed certificate in certs/ (local network only; phones must accept the warning once).
"""
import asyncio
import json
import os
import ssl
import time

from aiohttp import WSMsgType, web

HERE = os.path.dirname(os.path.abspath(__file__))
rooms = {}        # room -> {"a": ws, "b": ws}
codes = {}        # room -> code (which beep band and note pair it uses), while anyone is in it
BANDS = 2         # beep bands: code % 2
GAP = 0.3         # seconds of quiet between one pair's turn and the next on the same band
TURN_MAX = 2.6    # a turn is taken back after this long if "done" never arrives
waiting = {b: [] for b in range(BANDS)}       # rooms queued for a turn, per band
holder = {b: None for b in range(BANDS)}      # (room, since) holding the band
free_at = {b: 0.0 for b in range(BANDS)}      # when the band may be handed out again
PROBE_LOG = os.path.join(HERE, "sonar_probe.jsonl")    # diagnostics the phones send (numbers only, no audio)


async def index(req):
    return web.FileResponse(os.path.join(HERE, "web", "sonar.html"), headers={"Cache-Control": "no-store"})


def code_for(room):
    if room not in codes:
        used = set(codes.values())
        codes[room] = next(i for i in range(len(used) + 1) if i not in used)
    return codes[room]


def band_of(room):
    return codes.get(room, 0) % BANDS


async def pump(band):
    """Hand the band to the next waiting room, if it's free."""
    now = time.monotonic()
    h = holder[band]
    if h and now - h[1] > TURN_MAX:           # never said "done": take it back
        holder[band] = None
        free_at[band] = now + GAP
    if holder[band] or now < free_at[band]:
        return
    while waiting[band]:
        room = waiting[band].pop(0)
        R = rooms.get(room, {})
        if "a" in R and "b" in R:              # the initiator is always phone a
            holder[band] = (room, now)
            try:
                await R["a"].send_json({"t": "turn"})
            except Exception:
                holder[band] = None
                continue
            return


def release(room):
    b = band_of(room)
    if holder[b] and holder[b][0] == room:
        holder[b] = None
        free_at[b] = time.monotonic() + GAP
    if room in waiting[b]:
        waiting[b].remove(room)


async def scheduler():
    while True:
        await asyncio.sleep(0.05)
        for b in range(BANDS):
            await pump(b)


async def ws_handler(req):
    room = req.query.get("room", "test")
    R = rooms.setdefault(room, {})
    role = "a" if "a" not in R else "b" if "b" not in R else None
    if role is None:
        raise web.HTTPConflict(text="room full")
    other = "b" if role == "a" else "a"
    # 5 s heartbeat: a phone that drops off (sleep, network change) is noticed fast, otherwise its dead
    # socket keeps the seat and the phone's reconnect is refused as "room full" for up to ~40 s
    ws = web.WebSocketResponse(heartbeat=5)
    await ws.prepare(req)
    R[role] = ws
    await ws.send_json({"t": "hello", "role": role, "peer": other in R, "code": code_for(room)})
    if other in R:
        await R[other].send_json({"t": "peer", "on": True})
    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            head = msg.data[:24]
            if '"probe"' in head:
                try:
                    d = json.loads(msg.data)
                    d.update(ts=round(time.time(), 3), room=room, role=role, code=codes.get(room))
                    with open(PROBE_LOG, "a") as f:
                        f.write(json.dumps(d) + "\n")
                except (ValueError, OSError):
                    pass
            elif '"want"' in head:
                b = band_of(room)
                if room not in waiting[b] and not (holder[b] and holder[b][0] == room):
                    waiting[b].append(room)
                await pump(b)
            elif '"done"' in head:
                release(room)
                await pump(band_of(room))
            elif other in R:
                await R[other].send_str(msg.data)
    finally:
        if R.get(role) is ws:
            del R[role]
            release(room)
            if other in R:
                await R[other].send_json({"t": "peer", "on": False})
            else:
                rooms.pop(room, None)
                codes.pop(room, None)
    return ws


async def on_start(app):
    app["scheduler"] = asyncio.ensure_future(scheduler())


def main():
    ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    ctx.load_cert_chain(os.path.join(HERE, "certs", "cert.pem"), os.path.join(HERE, "certs", "key.pem"))
    app = web.Application()
    app.router.add_get("/", index)
    app.router.add_get("/ws", ws_handler)
    app.on_startup.append(on_start)
    web.run_app(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8443)), ssl_context=ctx)


if __name__ == "__main__":
    main()
