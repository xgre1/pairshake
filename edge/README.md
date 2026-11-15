# edge

PairShake's backend for the iPhone app, all on Cloudflare: **https://pairshake.binjto.workers.dev**.

```sh
./deploy.sh      # copy the app's page from ../app/web and deploy (or `make edge`)
```

| File | What it is |
| --- | --- |
| `src/index.js` | The Worker. Serves the app's page from static assets (to the app only; a browser gets a short note), checks the hands' models against the app's bundled copies by ETag, runs Emma's ears (`/hear`, Whisper on Workers AI), answers `/speak` straight from R2 when the line was voiced before, and sends everything else to the room. |
| `src/room.js` | The room: one Durable Object working with every person, introduction and chat (kept in D1), the interview, matching, accounts and the rooms' WebSockets (with hibernation). API: [docs/api.md](../docs/api.md). |
| `src/matching.js` | Who meets whom, and the spark. |
| `src/llm.js` | Gemini: flash-lite for the chat and the quick jobs, flash for the spark and the agents' talk. |
| `src/voice.js` | Emma's voice (ElevenLabs, kept in R2 for good; Workers AI's voice if ElevenLabs is down) and ears. |
| `src/prompts.js` | Emma's scripted lines, the interview, agent and chat prompts, and the demo attendees (the matching prompts are in `matching.js`). |
| `migrations/` | The D1 schema: `users`, `missions`, `meta`. Apply a new one with `npx wrangler d1 migrations apply pairshake --remote`. |
| `wrangler.jsonc` | Bindings: `ROOM` (Durable Object), `DB` (D1 database `pairshake`), `VOICE` (R2 bucket `pairshake-voice`), `AI`, `LIMIT` (rate limit), `ASSETS`. |

## Secrets

Set once with `npx wrangler secret put <NAME>`; they are never in the repository.

| Name | What |
| --- | --- |
| `GEMINI_API_KEY` | The model. A local copy is in `.dev.vars` (ignored by git). |
| `ELEVENLABS_API_KEY` | Emma's voice. |
| `ADMIN_TOKEN` | For `/admin/export` and `/admin/import`. A local copy is in `.dev.vars`. |

## Backups

```sh
make backup      # saves the whole room to backups/room-<date>.json
```

To restore one, or to move data in: `curl -X POST https://pairshake.binjto.workers.dev/admin/import -H "authorization: Bearer $TOKEN" --data-binary @room.json` (it replaces everything).

## Looking at the data

```sh
npx wrangler d1 execute pairshake --remote --command "SELECT id, name, email, app, created_at FROM users ORDER BY created_at DESC LIMIT 20"
```

Or Storage & Databases → D1 → pairshake in the Cloudflare dashboard. Change data through the app or `/admin/import`, not by hand: the room keeps it in memory and would write its own copy back.

## Logs

`npx wrangler tail pairshake`, or Workers → pairshake → Logs in the Cloudflare dashboard.

## Limits to know

- The free Workers plan allows 10 ms of CPU per request. PairShake's requests mostly wait on the model, which doesn't count, but a very full room may need the $5 paid plan.
- Workers AI (the ears) has a free daily allowance of 10,000 neurons, about 200 minutes of speech.
- `/speak` only voices lines Emma really says, so nobody can spend the ElevenLabs allowance on their own text.
- Calls that cost money (`/hear`, `/speak`, the model) are limited to 300 a minute per address and path. A venue's Wi-Fi is usually one address, so this is generous on purpose.
