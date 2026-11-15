#!/bin/sh
# Copy the app's page and Emma's hands from app/web (not the hands' authoring tools) and the front (_worker.js)
# into dist, then deploy to Cloudflare Pages (https://pairshake.pages.dev).
set -e
cd "$(dirname "$0")"
rm -rf dist
mkdir -p dist
cp ../app/web/index.html _worker.js dist/
rsync -a --exclude tools ../app/web/hands/ dist/hands/
# this project's own Cloudflare token when ../.env.cloudflare exists (as edge/wrangler.sh), else the machine's login
if [ -f ../.env.cloudflare ]; then set -a; . ../.env.cloudflare; set +a; fi
export CLOUDFLARE_ACCOUNT_ID=${CLOUDFLARE_ACCOUNT_ID:-662aad26c7f15dc72bb81dfbd929e7d4}
W="npx --yes wrangler@4"; command -v wrangler >/dev/null 2>&1 && W=wrangler
$W pages project list | grep -q " pairshake " || $W pages project create pairshake --production-branch main
$W pages deploy --project-name pairshake --branch main --commit-dirty=true
