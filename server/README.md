# server

The PairShake server and the web app it serves.

```sh
~/Desktop/emma/.venv/bin/python -u server.py      # or `make server` from the repository root
```

| File | What it is |
| --- | --- |
| `server.py` | aiohttp server on port 8780: Emma's interview, agent-to-agent matching, rooms over WebSocket, accounts. Imports Emma's voice and speech recognition from `~/Desktop/emma/engine`. |
| `matching.py` | Who meets whom, and what gets them talking: fairness, the agents' verdicts, the spark. `test_matching.py` checks its rules (`python3 test_matching.py`, or `--live` for a run with the model). |
| `llm.py` | Gemini when `GEMINI_API_KEY` is set (environment or `server/.env`), else `claude -p`. |
| `web/index.html` | The whole web app: one page, no build step. |
| `web/hands/` | Emma's 3D hands: `hands.js` (scene and gesture planner hookup), `planner.js` (text to gestures), `worker.js` (Handkit solver off the main thread), `ring.js` and `ring.bin` (the matching screen's ring of hands), the hand models, and `tools/bake_ring.mjs`, which bakes `ring.bin`. |
| `sonar.py`, `web/sonar*.html`, `probe_report.py` | A separate experiment: measuring distance with sound between two browsers, and scoring how accurate it was. See [docs/finding.md](../docs/finding.md). |
| `requirements.txt` | What the server needs beyond Emma's engine. |

Runtime files that stay out of git: `room.json` (everything the server knows; safe to keep across restarts), `*.log`, `*.jsonl`, and `certs/` (the self-signed key for the sonar page).

API: [docs/api.md](../docs/api.md). How it fits with the rest: [docs/architecture.md](../docs/architecture.md).
