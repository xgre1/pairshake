#!/bin/sh
# wrangler for this project, with this project's own Cloudflare token instead of the machine's `wrangler login`
# (so a laptop logged in to another Cloudflare account still deploys PairShake to the right one).
#
#   edge/wrangler.sh whoami | deploy | tail pairshake | secret put NAME | ...
#
# The token lives in .env.cloudflare at the repository root (ignored by git):
#   CLOUDFLARE_API_TOKEN=...      Workers Scripts:Edit, Workers R2:Edit, Account Settings:Read (+ Workers AI, D1 if used)
#   CLOUDFLARE_ACCOUNT_ID=...     the account that owns pairshake.binjto.workers.dev
# Without that file, wrangler falls back to whatever login the machine has.
set -e
cd "$(dirname "$0")"
ENV_FILE=../.env.cloudflare
if [ -f "$ENV_FILE" ]; then
  set -a
  . "$ENV_FILE"
  set +a
fi
if command -v wrangler >/dev/null 2>&1; then
  exec wrangler "$@"
fi
exec npx --yes wrangler@4 "$@"
