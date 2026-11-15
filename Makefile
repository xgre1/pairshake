# Everyday commands. `make help` lists them.
EMMA ?= $(HOME)/Desktop/emma
PY   ?= $(EMMA)/.venv/bin/python

.PHONY: help server tunnel edge app sonar

help:            ## list the commands
	@grep -E '^[a-z]+:.*## ' $(MAKEFILE_LIST) | sed -E 's/:.*## /\t/'

server:          ## run Roomie on http://localhost:8780 (with Emma's Python environment)
	cd server && $(PY) -u server.py

tunnel:          ## connect the Mac to Cloudflare (named tunnel "roomie")
	edge/tunnel.sh

edge:            ## deploy the Cloudflare Worker (roomie.binjto.workers.dev)
	edge/deploy.sh

app:             ## regenerate the Xcode project from app/project.yml
	cd app && xcodegen

sonar:           ## the sound-ranging experiment on https://<mac-ip>:8443
	cd server && $(PY) -u sonar.py
