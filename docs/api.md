# API

All endpoints are served by Cloudflare at `https://pairshake.binjto.workers.dev` (`edge/`). Bodies are JSON unless noted. A user is identified by the `id` the server hands out; there is no other session token.

## Talking to Emma

| Method | Path | Body or query | Returns |
| --- | --- | --- | --- |
| POST | `/start` | `{id?}` | `{id, say, code}`. A new attendee, or a returning one Emma greets with what she remembers. |
| POST | `/turn` | `{id, text, interrupted?}` | `{say, done}`. Emma's next line; `done` means she has heard enough and matching has begun. |
| POST | `/quick` | `{id?, text, spot?}` | `{id, code, say}`. Skips the voice chat: `text` is a description of the attendee (for example from ChatGPT). |
| POST | `/hear` | raw 16 kHz mono int16 PCM | `{text}`. Whisper's transcript (Workers AI). An empty body answers 200 if speech recognition is available. |
| POST | `/speak` | `{text}` | `audio/wav` in Emma's voice (`audio/mpeg` while ElevenLabs is down). 403 for text Emma doesn't say. |

## Matching

| Method | Path | Body or query | Returns |
| --- | --- | --- | --- |
| GET | `/scan` | `?id` | `{talks: [{person, ask, reply, fit, no}], total, muse}` (`muse`: Emma's `{start, looking}` lines). Your agent's conversations so far; `no` is true when the other person's agent declined for them. |
| POST | `/match` | `{id, socials}` | `{say, me, mission}`. The introduction. 409 `{cancelled: true}` if the search was stopped meanwhile. |
| POST | `/match/cancel` | `{id}` | `{ok}`. Drops the match being worked out; nobody is introduced. |
| POST | `/again` | `{id}` | `{ok}`. Look for someone new using what Emma already knows. |
| POST | `/test/match` | `{id?, cancel?}` | `{waiting, me}` until a second phone asks, then `{say, me, mission}`. Two phones are introduced as made-up attendees who have both already said yes. The iPhone app's test button. |
| GET | `/inbox` | `?id` | `{missions}`. Introductions where someone else was matched with you. |

A `mission` is `{id, intro, overlap, person, outcome}`. `overlap` holds `rare` (things few people share, each with an `opener`), `you_only`, `them_only`, `give`, `get`, and `ladder` (three questions from light to deep). A `person` is `{id, name, role, color, building, needs, offers, spot, line, socials, seed?}`.

## After the introduction

| Method | Path | Body or query | Returns |
| --- | --- | --- | --- |
| GET | `/talk` | `?mid&id` | The two agents' opening exchange: `{turns, fit, why, ask, ...}`. |
| POST | `/suggest` | `{id, mission}` | `{ideas}`. Follow-up questions for the chat. |
| GET | `/me` | `?id` | `{me, socials, contacts, email, name}`. What Emma remembers and everyone you've met. |
| GET | `/room` | | `{stats, people, intros}`. Numbers for the room. |

## Events (Luma)

Each Luma event is its own room: someone who joined an event is only matched with people who joined it too (people in no event only with each other). The demo attendees are in every room.

| Method | Path | Body or query | Returns |
| --- | --- | --- | --- |
| GET | `/events` | `?q&id&lat&lon` | `{events, mine, error}`. Luma's events for `q` (a search word, or a Luma link), or near `lat,lon` when `q` is empty (where Cloudflare places the caller when not given). Each event is `{id, name, start, end, tz, city, cover, url, guests, here}`; `here` counts PairShake people who joined it. |
| GET | `/event` | `?id` | `{event, people, count}`. The event they joined and who else is in it. |
| POST | `/event` | `{id, event}` or `{id, leave: true}` | `{event, people, count}`. Joins the event (checked with Luma; 400 if Luma doesn't know it) or leaves it. |

## Account and profile

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| POST | `/account` | `{action: "signup", email, password, id?}` | `{id, email}`. Adds an email and password to this device's user (or a new one). 409 if the email is taken. |
| POST | `/account` | `{action: "login", email, password}` | `{id, email}`. 401 on a wrong password, 429 after five failures in a minute. |
| POST | `/account` | `{action: "delete", id}` | `{ok}`. Removes the user. |
| POST | `/profile` | `{id, name?, socials?, about?}` | `{me, socials, name, email}`. |

Errors come back as `{error}` with a sentence that can be shown to the person. 429 means too many calls from one address in a minute.

## Admin

`GET /admin/export` and `POST /admin/import` (the whole room as `{users, missions, stats}`), with `authorization: Bearer <ADMIN_TOKEN>`.

## The room's WebSocket

`GET /ws?mission=<id>&id=<user id>` opens the room for one introduction. Each side is `a` or `b`.

From the server:

| `t` | Fields | Meaning |
| --- | --- | --- |
| `state` | `you, chat, decided, meet, online` | Sent on connect. `meet` is `true` or `false` once both have decided, or one said no. |
| `chat` | `from, text` | A message from the other side. |
| `typing` | | The other side (or Emma playing a seed person) is typing. |
| `presence` | `online` | The other person joined or left. |
| `meet` | `yes` | Both decided, or one said no. |
| `ni` | `token` | The other iPhone's Nearby Interaction token (base64), for Ultra Wideband. |
| `gps` | `lat, lon, acc` | The other person's filtered position, for finding by GPS. |

From the page: `{t: "chat", text}`, `{t: "decide", yes}`, `{t: "ni", token}`, `{t: "gps", lat, lon, acc}`.
