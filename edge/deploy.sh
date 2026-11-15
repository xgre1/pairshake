#!/bin/sh
# Copy the hands' heavy models from server/web/hands, note the ETag server.py (aiohttp) gives each, deploy.
set -e
cd "$(dirname "$0")"
mkdir -p public/hands
python3 - <<'PY'
import json, os, shutil
src, out = "../server/web/hands", {}
for f in ("hand_r.glb", "hand_l.glb", "hand_r_lo.glb", "handkit_wasm_bg.wasm", "ring.bin"):
    p = os.path.join(src, f)
    st = os.stat(p)
    shutil.copyfile(p, os.path.join("public/hands", f))
    out["/hands/" + f] = '"%x-%x"' % (st.st_mtime_ns, st.st_size)
json.dump(out, open("src/etags.json", "w"), indent=1)
PY
npx --no-install wrangler deploy
