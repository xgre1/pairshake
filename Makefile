# Everyday commands. `make help` lists them.
EMMA ?= $(HOME)/Desktop/emma
PY   ?= $(EMMA)/.venv/bin/python

.PHONY: help server edge backup app sonar

help:            ## list the commands
	@grep -E '^[a-z]+:.*## ' $(MAKEFILE_LIST) | sed -E 's/:.*## /\t/'

server:          ## the old Mac server on http://localhost:8780, for local tools only (production is edge/)
	cd server && $(PY) -u server.py

edge:            ## deploy PairShake to Cloudflare (roomie.binjto.workers.dev)
	edge/deploy.sh

backup:          ## save the whole room from Cloudflare to backups/room-<date>.json
	@mkdir -p backups && curl -sf https://roomie.binjto.workers.dev/admin/export \
	  -H "authorization: Bearer $$(sed -n 's/^ROOMIE_ADMIN_TOKEN=//p' server/.env)" \
	  -o backups/room-$$(date +%Y%m%d-%H%M%S).json && ls -t backups | head -1

app:             ## regenerate the Xcode project from app/project.yml
	cd app && xcodegen

sonar:           ## the sound-ranging experiment on https://<mac-ip>:8443
	cd server && $(PY) -u sonar.py
