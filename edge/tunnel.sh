#!/bin/sh
# Connects the Mac (server.py on :8780) to Cloudflare through the named tunnel "roomie".
# The token lives in ~/.cloudflared/roomie.token (not in the repo). HTTP/2 instead of QUIC: steadier on venue Wi-Fi.
exec cloudflared tunnel --no-autoupdate --protocol http2 run --token "$(cat ~/.cloudflared/roomie.token)"
