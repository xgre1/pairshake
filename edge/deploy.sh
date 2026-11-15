#!/bin/sh
# Copy the app's page and Emma's hands from app/web (not the hands' authoring tools), note each model's ETag
# (mtime-size, the same the app's build step writes into its bundle), then deploy.
set -e
cd "$(dirname "$0")"
rm -rf public
mkdir -p public
cp ../app/web/index.html public/
rsync -a --exclude tools ../app/web/hands/ public/hands/
python3 - <<'PY'
import json, os
src, out = "../app/web/hands", {}
for f in ("hand_r.glb", "hand_l.glb", "hand_r_lo.glb", "handkit_wasm_bg.wasm", "ring.bin"):
    st = os.stat(os.path.join(src, f))
    out["/hands/" + f] = '"%x-%x"' % (st.st_mtime_ns, st.st_size)
json.dump(out, open("src/etags.json", "w"), indent=1)
PY
npx --no-install wrangler deploy
