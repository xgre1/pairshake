#!/bin/sh
# Copy the web app from server/web (the page and Emma's hands, not the sonar experiment), then deploy.
set -e
cd "$(dirname "$0")"
rm -rf public
mkdir -p public
cp ../server/web/index.html public/
cp -R ../server/web/hands public/hands
npx --no-install wrangler deploy
