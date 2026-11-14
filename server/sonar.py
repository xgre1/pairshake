"""Sonar test server: serves web/sonar.html over HTTPS (browsers only allow the microphone on HTTPS)
and relays messages between the two phones in a room.

    python3 sonar.py            # https://<mac-ip>:8443/?room=test

Uses the self-signed certificate in certs/ (local network only; phones must accept the warning once).
"""
import json
import os
import ssl
import time

from aiohttp import WSMsgType, web

HERE = os.path.dirname(os.path.abspath(__file__))
rooms = {}        # room -> {"a": ws, "b": ws}
PROBE_LOG = os.path.join(HERE, "sonar_probe.jsonl")    # diagnostics the phones send (numbers only, no audio)


async def index(req):
    return web.FileResponse(os.path.join(HERE, "web", "sonar.html"), headers={"Cache-Control": "no-store"})


async def ws_handler(req):
    room = req.query.get("room", "test")
    R = rooms.setdefault(room, {})
    role = "a" if "a" not in R else "b" if "b" not in R else None
    if role is None:
        raise web.HTTPConflict(text="room full")
    other = "b" if role == "a" else "a"
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(req)
    R[role] = ws
    await ws.send_json({"t": "hello", "role": role, "peer": other in R})
    if other in R:
        await R[other].send_json({"t": "peer", "on": True})
    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            if '"probe"' in msg.data[:24]:
                try:
                    d = json.loads(msg.data)
                    d.update(ts=round(time.time(), 3), room=room, role=role)
                    with open(PROBE_LOG, "a") as f:
                        f.write(json.dumps(d) + "\n")
                except (ValueError, OSError):
                    pass
            elif other in R:
                await R[other].send_str(msg.data)
    finally:
        if R.get(role) is ws:
            del R[role]
            if other in R:
                await R[other].send_json({"t": "peer", "on": False})
    return ws


def main():
    ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    ctx.load_cert_chain(os.path.join(HERE, "certs", "cert.pem"), os.path.join(HERE, "certs", "key.pem"))
    app = web.Application()
    app.router.add_get("/", index)
    app.router.add_get("/ws", ws_handler)
    web.run_app(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8443)), ssl_context=ctx)


if __name__ == "__main__":
    main()
