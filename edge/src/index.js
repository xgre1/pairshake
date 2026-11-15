/* Roomie on Cloudflare: https://roomie.binjto.workers.dev. Nothing runs on the Mac.

   - The web app (index.html and Emma's hands) is static and served from Cloudflare's edge.
   - Emma's ears (/hear) run here, on Workers AI. Her voice (/speak) comes straight from R2 when the line was
     ever voiced before; a new line goes to the room, which checks that Emma really says it.
   - Everything else (the API and the rooms' WebSockets) goes to the one Durable Object that is the room
     (room.js), so every attendee sees the same people, matches and chats. */
import { Roomie } from "./room.js";
import { hear, voiceKey } from "./voice.js";

export { Roomie };

const API = new Set(["/start", "/turn", "/quick", "/match", "/match/cancel", "/again", "/test/match", "/account", "/profile",
  "/inbox", "/talk", "/ws", "/scan", "/me", "/suggest", "/room"]);
// what costs money per call (the model, the voice, the ears): limited per address, generously (a venue's Wi-Fi is one address)
const COSTLY = new Set(["/hear", "/speak", "/start", "/turn", "/quick", "/again", "/suggest", "/account"]);
const MAX_HEAR = 16000 * 2 * 90;      // 90 s of 16 kHz int16

const room = env => env.ROOM.get(env.ROOM.idFromName("room"));
const json = (d, status = 200) => Response.json(d, { status, headers: { "cache-control": "no-store" } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url), path = url.pathname;
    try {
      if (COSTLY.has(path) && env.LIMIT) {
        const { success } = await env.LIMIT.limit({ key: `${req.headers.get("cf-connecting-ip") || "?"}:${path}` });
        if (!success) return json({ error: "Slow down a little and try again." }, 429);
      }
      if (path === "/hear" && req.method === "POST") return await ears(req, env);
      if (path === "/speak" && req.method === "POST") return await voice(req, env);
      if (path.startsWith("/admin/")) {
        const token = (req.headers.get("authorization") || "").replace(/^Bearer /, "");
        if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return json({ error: "Not allowed." }, 403);
        return room(env).fetch(req);
      }
      if (path === "/health") return json({ ok: true });
      if (API.has(path)) return room(env).fetch(req);
      const r = await env.ASSETS.fetch(req);
      if (path === "/" || path === "/index.html") {      // the app itself is never cached: a deploy shows at once
        const out = new Response(r.body, r);
        out.headers.set("cache-control", "no-store");
        return out;
      }
      return r;
    } catch (e) {
      console.log("edge error", path, e && e.stack || String(e));
      return json({ error: "Something went wrong. Try again." }, 500);
    }
  },
};

/** 16 kHz mono int16 PCM in, the words out. An empty body says whether the ears are there (they are). */
async function ears(req, env) {
  const pcm = await req.arrayBuffer();
  if (pcm.byteLength < 3200) return json({ text: "" });        // under 0.1 s: nothing said
  if (pcm.byteLength > MAX_HEAR + 2) return json({ error: "Too long." }, 413);
  try {
    return json({ text: await hear(env, pcm.slice(0, pcm.byteLength & ~1)) });
  } catch (e) {
    console.log("hear error:", String(e));
    return json({ error: "Couldn't hear that." }, 502);       // the page then uses the browser's own recogniser
  }
}

async function voice(req, env) {
  const body = await req.text();
  let text = "";
  try { text = String(JSON.parse(body).text ?? "").trim().slice(0, 600); } catch {}
  if (!text) return json({ error: "Nothing to say." }, 400);
  const hit = await env.VOICE.get(await voiceKey(text));
  if (hit) return new Response(hit.body, { headers: { "content-type": "audio/wav", "cache-control": "public, max-age=31536000, immutable" } });
  return room(env).fetch(new Request(req.url, { method: "POST", headers: req.headers, body }));
}
