/* PairShake's backend, for the iPhone app: https://pairshake.binjto.workers.dev.

   - The app's page (app/web: index.html and Emma's hands) is static and served from Cloudflare's edge, only to
     the app. The hands' models are checked against the copy in the app's bundle (ETag), so it rarely downloads them.
   - Emma's ears (/hear) run here, on Workers AI. Her voice (/speak) comes straight from R2 when the line was
     ever voiced before; a new line goes to the room, which checks that Emma really says it.
   - Everything else (the API and the rooms' WebSockets) goes to the one Durable Object that is the room
     (room.js), so every attendee sees the same people, matches and chats. */
import { PairShake } from "./room.js";
import { hear, voiceKey } from "./voice.js";
import ETAGS from "./etags.json";
import * as Auth from "./auth.js";

export { PairShake };

const API = new Set(["/start", "/turn", "/quick", "/onboard", "/network/create", "/network/join", "/networks", "/match", "/match/cancel", "/again", "/test/match", "/account", "/profile", "/feedback",
  "/inbox", "/talk", "/ws", "/scan", "/me", "/suggest", "/room", "/events", "/event"]);
// what costs money per call (the model, the voice, the ears): limited per address, generously (a venue's Wi-Fi is one address)
const COSTLY = new Set(["/events", "/hear", "/speak", "/start", "/turn", "/quick", "/onboard", "/again", "/suggest", "/account", "/feedback"]);
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
      { const j = path.match(/^\/join\/([A-Za-z0-9]{4,12})$/); if (j) return joinPage(j[1].toUpperCase()); }
      {                                   // Sign in with LinkedIn or Google (auth.js)
        const m = path.match(/^\/auth\/(linkedin|google)(\/callback)?$/);
        if (m) return m[2] ? await Auth.callback(m[1], req, env, room(env)) : await Auth.start(m[1], req, env);
      }
      if (path === "/events" && !url.searchParams.has("lat") && req.cf?.latitude) {     // nearby: where Cloudflare thinks they are
        url.searchParams.set("lat", req.cf.latitude); url.searchParams.set("lon", req.cf.longitude);
        return room(env).fetch(new Request(url, req));
      }
      if (API.has(path)) return room(env).fetch(req);
      if (path === "/" || path === "/index.html") {
        if (!/PairShakeApp|RoomieApp/.test(req.headers.get("user-agent") || "")   /* (builds from before the rename say RoomieApp) */) return appOnly();
        const r = await env.ASSETS.fetch(req);
        const out = new Response(r.body, r);
        out.headers.set("cache-control", "no-store");      // never cached: a deploy shows at once
        return out;
      }
      const tag = req.method === "GET" && ETAGS[path];
      if (tag) {                                           // a model the app may already have in its bundle
        const headers = { etag: tag, "cache-control": "no-cache" };
        if (req.headers.get("if-none-match") === tag) return new Response(null, { status: 304, headers });
        const r = await env.ASSETS.fetch(new Request(url.origin + path));
        const out = new Response(r.body, r);
        for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
        return out;
      }
      return env.ASSETS.fetch(req);
    } catch (e) {
      console.log("edge error", path, e && e.stack || String(e));
      return json({ error: "Something went wrong. Try again." }, 500);
    }
  },
};

/** A network's share link, opened by the phone's camera or a browser: straight into the app with the code. */
function joinPage(code) {
  const app = `pairshake://join/${code}`;
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Join on PairShake</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;font:17px -apple-system,system-ui,sans-serif;background:#000;color:#fff;text-align:center">
<div style="padding:24px"><h1 style="font-size:30px;margin:0 0 10px">You're invited</h1><p style="margin:0 0 28px;opacity:.6">Join this network on PairShake. Code ${code}</p>
<a href="${app}" style="display:inline-block;padding:16px 32px;border-radius:999px;background:#fff;color:#000;font-weight:600;text-decoration:none">Open in PairShake</a></div>
<script>location.href = ${JSON.stringify(app)};</script>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

/** PairShake lives in the iPhone app; a browser gets a short note instead of the page. */
function appOnly() {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PairShake</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;font:17px -apple-system,system-ui,sans-serif;background:#000;color:#fff;text-align:center">
<div><h1 style="font-size:28px;margin:0 0 8px">PairShake</h1><p style="margin:0;opacity:.6">PairShake is an iPhone app.</p></div>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

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
