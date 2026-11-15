#!/bin/sh
# Copy the app's page and Emma's hands from app/web (not the hands' authoring tools), note each model's ETag
# (mtime in nanoseconds and size, in hex: the same the app's build step writes into its bundle), then deploy.
set -e
cd "$(dirname "$0")"
rm -rf public
mkdir -p public
cp ../app/web/index.html public/
rsync -a --exclude tools ../app/web/hands/ public/hands/
etag() {
  t=$(stat -f %Fm "$1"); s=${t%.*}; f=$(printf '%-9s' "${t#*.}" | tr ' ' 0)
  printf '"\\"%x-%x\\""' $((s * 1000000000 + 10#$f)) "$(stat -f %z "$1")"
}
{
  printf '{\n'
  sep=""
  for f in hand_r.glb hand_l.glb hand_r_lo.glb handkit_wasm_bg.wasm ring.bin; do
    printf '%s "/hands/%s": %s' "$sep" "$f" "$(etag ../app/web/hands/$f)"
    sep=",
"
  done
  printf '\n}\n'
} > src/etags.json
npx --no-install wrangler deploy
