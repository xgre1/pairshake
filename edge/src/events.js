/* Events from Luma (lu.ma), for "Choose your event": the events near you, a search, or a pasted Luma link.
   Luma's own public discover endpoints (the ones its website uses), no key needed. Each answer is kept for five
   minutes per isolate, so a room full of people searching costs Luma a handful of calls. */

const LUMA = "https://api.lu.ma";
const TTL = 5 * 60 * 1000;
const cache = new Map();        // url -> {at, data}
const known = new Map();        // event id -> the event, as last found
// Events Luma's own search never shows (a host can keep a public event off Luma's discover pages, as the Gen AI
// Summit Hackathon is). Always found here by name, and listed near the top while they're on. Add a link's slug to pin one.
export const PINNED = ["x1wxi5sn"];

async function luma(path) {
  const url = LUMA + path, hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  let r;
  try { r = await fetch(url, { headers: { accept: "application/json", "user-agent": "PairShake/1.0" }, signal: AbortSignal.timeout(8000) }); }
  catch (e) { if (hit) return hit.data; throw e; }
  if (!r.ok) {
    if (hit && (r.status === 429 || r.status >= 500)) return hit.data;     // turned away (or down): the last answer will do
    throw Object.assign(new Error(`luma ${r.status}`), { status: r.status });
  }
  const data = await r.json();
  if (cache.size > 300) cache.clear();
  cache.set(url, { at: Date.now(), data });
  return data;
}

const s = (v, n = 200) => (v == null ? "" : String(v)).trim().slice(0, n);

/** One event, as the app shows and stores it. */
export function clean(ev, extra = {}) {
  if (!ev || !ev.api_id) return null;
  const geo = ev.geo_address_info || {};
  return {
    id: s(ev.api_id, 40), name: s(ev.name, 160), start: s(ev.start_at, 40), end: s(ev.end_at, 40), tz: s(ev.timezone, 60),
    city: s(geo.city || geo.city_state || (ev.location_type === "online" ? "Online" : ""), 80),
    cover: /^https:\/\/images\.lumacdn\.com\//.test(ev.cover_url || "") ? s(ev.cover_url, 300) : "",
    url: s(ev.url, 80).replace(/[^\w-]/g, ""), guests: Number(extra.guest_count) || 0,
  };
}

/** A Luma link pasted into the search box, alone or with text around it ("lu.ma/abc123", "luma.com/abc123"), else null. */
function slugOf(q) {
  const m = q.match(/(?:^|[^\w.\/])(?:https?:\/\/)?(?:www\.)?(?:lu\.ma|luma\.com)\/(?:event\/)?([\w-]{3,80})(?![\w-])/i);
  return m ? m[1] : null;
}

/** One event by its link's slug (cached), or null. */
export async function bySlug(slug) {
  const d = await luma(`/url?url=${encodeURIComponent(slug)}`).catch(() => null);
  const ev = d && d.kind === "event" && clean(d.data?.event, d.data);
  if (ev) remember(ev);
  return ev || null;
}

/** Still on, or ended in the last few hours. */
export const live = e => !e.end || Date.parse(e.end) > Date.now() - 6 * 3600 * 1000;

/** Whether a search could mean this event: any of its words (2+ letters) in the name or city, spaces ignored
    ("genai" finds "Gen AI"). Loose on purpose: it only runs over the handful of events kept here. Empty matches all. */
export function named(e, q) {
  const fold = x => String(x || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const hay = fold(`${e.name} ${e.city}`).replace(/[^\p{L}\p{N}]+/gu, "");
  const words = fold(q).split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 2);
  return !words.length || words.some(w => hay.includes(w));
}

/** Whether a search is a pasted Luma link (then only that event is shown). */
export const isLink = q => !!slugOf(s(q, 120));

/** Events for a search (or, with none, the ones coming up near lat/lon), in Luma's order; ended ones are left out. */
export async function find(q, lat, lon) {
  q = s(q, 120);
  const slug = slugOf(q);
  if (slug) {
    const d = await luma(`/url?url=${encodeURIComponent(slug)}`).catch(() => null);
    const ev = d && d.kind === "event" && clean(d.data?.event, d.data);
    if (ev) { remember(ev); return [ev]; }
  }
  const p = new URLSearchParams({ pagination_limit: "50" });
  if (q) p.set("query", q);
  if (Number.isFinite(lat) && Number.isFinite(lon)) { p.set("latitude", lat.toFixed(3)); p.set("longitude", lon.toFixed(3)); }
  const d = await luma(`/discover/get-paginated-events?${p}`);
  const cutoff = Date.now() - 6 * 3600 * 1000;      // still on, or ended in the last few hours
  const seen = new Set();
  const out = (d.entries || [])
    .map(e => clean(e.event, e))
    .filter(e => e && !seen.has(e.id) && seen.add(e.id) && (!e.end || Date.parse(e.end) > cutoff));
  out.forEach(remember);
  return out;
}

function remember(ev) { if (known.size > 5000) known.clear(); known.set(ev.id, ev); }

/** The event someone chose, as Luma has it: from a recent search, else looked up again by its link. Null if Luma
    doesn't know it (a made-up id). If Luma can't be reached, what the app sent is kept, cleaned. */
export async function lookup(sent) {
  const id = s(sent?.id, 40), slug = s(sent?.url, 80).replace(/[^\w-]/g, "");
  if (!/^evt-[\w]{4,36}$/.test(id)) return null;
  if (known.has(id)) return known.get(id);
  if (!slug) return null;
  let d;
  try { d = await luma(`/url?url=${encodeURIComponent(slug)}`); }
  catch (e) {
    if (e.status >= 400 && e.status < 500 && e.status !== 429 || !s(sent.name)) return null;   // Luma says there's no such event
    return clean({ ...sent, api_id: id, start_at: sent.start, end_at: sent.end, cover_url: sent.cover, geo_address_info: { city: sent.city } });
  }
  const ev = d && d.kind === "event" && clean(d.data?.event, d.data);
  if (!ev || ev.id !== id) return null;
  remember(ev);
  return ev;
}
