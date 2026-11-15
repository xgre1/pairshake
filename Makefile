# Everyday commands. `make help` lists them.

.PHONY: help edge backup app

help:            ## list the commands
	@grep -E '^[a-z]+:.*## ' $(MAKEFILE_LIST) | sed -E 's/:.*## /\t/'

edge:            ## deploy PairShake to Cloudflare (roomie.binjto.workers.dev)
	edge/deploy.sh

backup:          ## save the whole room from Cloudflare to backups/room-<date>.json
	@mkdir -p backups && curl -sf https://roomie.binjto.workers.dev/admin/export \
	  -H "authorization: Bearer $$(sed -n 's/^ADMIN_TOKEN=//p' edge/.dev.vars)" \
	  -o backups/room-$$(date +%Y%m%d-%H%M%S).json && ls -t backups | head -1

app:             ## regenerate the Xcode project from app/project.yml
	cd app && xcodegen
