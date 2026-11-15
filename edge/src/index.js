import ETAGS from "./etags.json";

/* PairShake's front door on Cloudflare.
   - The hands' heavy models (~7 MB) are deployed to Cloudflare's edge with this Worker, so phones get them
     from the nearest data centre instead of through the tunnel to the Mac. Each request still asks the Mac,
     with a tiny If-None-Match request, whether its copy changed (a re-baked model wins at once); if the Mac
     can't be reached, the edge copy is used.
   - Everything else (the page, Emma's voice and ears, the API, the room's WebSocket) goes to server.py on the
     Mac through the named tunnel. */
const ORIGIN = "http://localhost:8780";

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const target = ORIGIN + url.pathname + url.search;
    const tag = req.method === "GET" && ETAGS[url.pathname];
    if (tag) return model(req, env, url, target, tag);
    try {
      return await env.ORIGIN.fetch(new Request(target, req));
    } catch (e) {
      return new Response("PairShake's server isn't reachable right now.", { status: 502 });
    }
  },
};

async function model(req, env, url, target, deployed) {
  let current = deployed, fresh = null;
  try {
    const r = await env.ORIGIN.fetch(target, { headers: { "if-none-match": deployed } });
    if (r.status === 200) { fresh = r; current = r.headers.get("etag") || deployed; }
  } catch {}                                            // the Mac is away: the edge copy still works
  const headers = { etag: current, "cache-control": "no-cache" };
  if (req.headers.get("if-none-match") === current) return new Response(null, { status: 304, headers });
  const src = fresh || await env.ASSETS.fetch(new Request(url.origin + url.pathname));
  const out = new Response(src.body, src);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}
