/* The room: one Durable Object that is the whole of PairShake's server. Emma interviews each attendee, finds the
   one person in the room they should meet, and gives both of them an icebreaker mission instead of a DM.

   Everyone and every introduction is kept in D1 (the `users` and `missions` tables), loaded when the room
   starts and written through after each change, so it survives restarts and deploys. What only matters for a few
   seconds (a match being worked out, the agents' talks, who is waiting for a test match) is kept in memory.
   The rooms' WebSockets use hibernation: an open chat costs nothing while nobody types.

   The API is in docs/api.md. */
import { DurableObject } from "cloudflare:workers";
import * as M from "./matching.js";
import * as P from "./prompts.js";
import { ask, decide, QUICK, MAIN } from "./llm.js";
import { speak } from "./voice.js";
import * as Events from "./events.js";
import { readTraits, DIMENSIONS, vector } from "./traits.js";
import SEED_TRAITS from "./seed_traits.json";

const MAX_TURNS = 3;          // the chat is only there to get to an introduction: at most two questions after the opener
// Testing: Emma follows one fixed script, so every line is voiced once and then always comes from
// R2. The model still works out who someone is and who they should meet; only what she says out loud is fixed.
const SCRIPT = true;
const KNOWN = ["name", "building", "needs", "offers", "spot"];
const NEEDED = ["name", "building", "needs"];     // enough to introduce them; the rest is kept only if they say it
const NUDGES = ["Take your time.", "No rush, I'm listening.", "I'm here whenever you're ready."];   // the page's own lines
const FILLERS = ["Mm-hm.", "Okay.", "Right."];        // the page's sounds while Emma thinks
// New lines cost from the ElevenLabs allowance: at most this many a day for the whole room, and per address in
// ten minutes. A line voiced before costs nothing and is never limited here.
const VOICE_DAILY = 300;
const VOICE_PER_IP = 25;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PBKDF2_ITER = 100_000;

const SEED = P.SEED.map(s => ({ ...s, code: String(randint(1000, 9999)), seed: true }));
const SEED_BY_ID = Object.fromEntries(SEED.map(s => [s.id, s]));

function randint(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
const pick1 = a => a[Math.floor(Math.random() * a.length)];
const hexId = n => crypto.randomUUID().replace(/-/g, "").slice(0, n);
const now = () => Date.now() / 1000;
// a Luma event that is on right now: started, not ended (no end given: the 12 hours after it starts)
// the hackathon's own event: its room stays open through the finals on Monday (Luma says it ends Sunday 18:00);
// the app features it on top of the event list (app/web/index.html, FEATURED)
const FEATURED = { id: "evt-710BpFWsoXOJ5wi", end: "2026-11-16T20:00:00.000Z" };
const happening = e => { const t = Date.now(), a = Date.parse(e?.start || ""), b = Date.parse(e?.end || "") || a + 12 * 3600 * 1000; return t >= a && t <= b; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const str = v => (v == null ? "" : String(v)).trim();
const firstName = n => String(n || "").split(/\s+/)[0];
const isObj = v => v && typeof v === "object" && !Array.isArray(v);
// what someone can hide on the You page: off their card, and Emma never brings it up with anyone
const HIDEABLE = ["role", "building", "needs", "offers", "line", "hooks"];
const hideFrom = (p, hidden) => { const o = { ...p }; for (const k of hidden || []) if (k in o) o[k] = Array.isArray(o[k]) ? [] : ""; return o; };
const hooksOf = v => (Array.isArray(v) ? v : String(v ?? "").split(/[,\n]/)).map(str).filter(Boolean).slice(0, 3).map(h => h.slice(0, 80));
const json = (d, status = 200) => Response.json(d, { status, headers: { "cache-control": "no-store" } });
class HttpError extends Error { constructor(status, msg) { super(msg || String(status)); this.status = status; } }
const notFound = () => { throw new HttpError(404, "Not found."); };

function scriptReveal(p) { return `Meet ${firstName(p.name || "them")}. I think you two should talk.`; }

/** Like a semaphore, but whoever holds the lowest number goes first. The agents' talks queue here by rank: when
    many people match at once, everyone's first choices are talked to before anyone's fifth. */
class Turns {
  constructor(n) { this.free = n; this.waiting = []; this.seq = 0; }
  async take(rank) {
    if (this.free > 0) { this.free--; return; }
    await new Promise(resolve => {
      const w = { rank, seq: ++this.seq, resolve };
      const i = this.waiting.findIndex(x => x.rank > rank || (x.rank === rank && x.seq > w.seq));
      i < 0 ? this.waiting.push(w) : this.waiting.splice(i, 0, w);
    });
  }
  give() {
    const w = this.waiting.shift();
    if (w) w.resolve(); else this.free++;
  }
}

async function pwHash(pw, salt, iter = PBKDF2_ITER) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  const salty = Uint8Array.from(salt.match(/../g).map(h => parseInt(h, 16)));
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salty, iterations: iter }, key, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function sameHex(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  return x.length === y.length && crypto.subtle.timingSafeEqual(x, y);
}

export class PairShake extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.users = {};          // id -> {id, name, transcript[], profile{}, socials{}, code, color, match, inbox[]}
    this.missions = {};       // mission id -> {...}
    this.stats = { spoke: 0, intros: 0, met: 0 };
    this.written = new Map(); // "u:<id>", "m:<id>", "meta:stats" -> the JSON last written to D1
    this.pending = new Map(); // user id -> the match being worked out
    this.enriching = new Set(); // user ids whose persona and traits are being written
    this.networks = {};
    this.eventSeen = new Map(); // user id -> when they last had their Luma event's room open (memory only)         // network id -> {id, code, name, owner, created, members: [user ids]}  (D1: meta "networks")
    this.scans = new Map();   // user id -> {talks, total, sent, closed, muse}: one agent-to-agent talk per attendee
    this.claims = [];         // pairs just chosen whose introduction isn't made yet
    this.judged = {};         // pair -> what the judge said about the two (matching.js judge); kept until a profile changes
    this.gen = new Map();     // user id -> how many times their match was stopped (a match begun before a stop introduces nobody)
    this.profiles = new Map(); // user id -> {convo, me}: the profile written from that chat, so the same chat isn't read twice
    this.talkTasks = new Map();
    this.testWait = new Map();
    this.loginFails = new Map();
    this.rooms = new Map();   // mission id -> what a room keeps only in memory: {gps, replying}
    this.said = new Set();    // lines Emma came up with lately, which /speak may voice
    this.voicedBy = new Map();// address -> times it had a new line voiced, in the last ten minutes
    this.agentsTurns = new Turns(12);
    this.flushing = Promise.resolve();
    const loaded = ctx.blockConcurrencyWhile(() => this.load());
    ctx.waitUntil(loaded.then(() => this.backfillTraits()));     // once everyone is loaded: traits for whoever has none yet
    // the whole script, voiced (or found in R2) ahead of the first person, so the first seconds are instant
    const lines = [P.OPENER, P.THINKING, ...(SCRIPT ? [...Object.values(P.ASK), P.SCRIPT_BACK, ...Object.values(P.SCRIPT_MUSE), ...P.SCRIPT_FALLBACK] : []), ...NUDGES, ...FILLERS];
    ctx.waitUntil(Promise.all(lines.map(l => speak(env, l).catch(e => console.log("voice warm-up:", String(e))))));
  }

  // ---- the database (D1) ----------------------------------------------------------------------------------
  // D1 is where everyone and every introduction is kept (migrations/0001_init.sql). The room loads it all when it
  // starts and works in memory; each change is written through right after, one row per person and introduction.

  async load() {
    const [us, ms, meta] = await this.env.DB.batch([
      this.env.DB.prepare("SELECT id, data FROM users"),
      this.env.DB.prepare("SELECT id, data FROM missions"),
      this.env.DB.prepare("SELECT key, value FROM meta"),
    ]);
    for (const r of us.results) { this.users[r.id] = JSON.parse(r.data); this.written.set("u:" + r.id, r.data); }
    for (const r of ms.results) { this.missions[r.id] = JSON.parse(r.data); this.written.set("m:" + r.id, r.data); }
    for (const r of meta.results) if (r.key === "stats") { Object.assign(this.stats, JSON.parse(r.value)); this.written.set("meta:stats", r.value); }
    for (const r of meta.results) if (r.key === "networks") { this.networks = JSON.parse(r.value); this.written.set("meta:networks", r.value); }
    // once (15/11): everyone out of the old Luma events and out of the networks made from Luma events, to start clean
    if (!(await this.ctx.storage.get("cleanup:events-1"))) {
      let n = 0;
      for (const u of Object.values(this.users)) {
        if (u.event) { delete u.event; n++; }
        if (u.live && this.networks[u.live.network]?.luma) delete u.live;
        if (u.networks) u.networks = u.networks.filter(id => !this.networks[id]?.luma);
      }
      for (const [id, x] of Object.entries(this.networks)) if (x.luma) delete this.networks[id];
      console.log(`cleanup: ${n} people out of their events`);
      await this.ctx.storage.put("cleanup:events-1", Date.now());
      this.save();
    }
    // once (15/11): every introduction so far forgotten (the testing ones), so everyone can meet everyone again
    if (!(await this.ctx.storage.get("cleanup:missions-1"))) {
      console.log(`cleanup: ${Object.keys(this.missions).length} introductions forgotten`);
      this.missions = {};
      for (const u of Object.values(this.users)) { u.inbox = []; u.match = null; }
      await this.ctx.storage.put("cleanup:missions-1", Date.now());
      this.save();             // (missions no longer here are deleted from D1 as it saves)
    }
    if (us.results.length || ms.results.length) return;
    // an empty database: the room was kept in this object's own storage before D1; bring it over once
    const old = [];
    for (const [prefix, into] of [["u:", this.users], ["m:", this.missions]]) {
      for (const [k, v] of await this.ctx.storage.list({ prefix })) { into[k.slice(2)] = JSON.parse(v); old.push(k); }
    }
    const st = await this.ctx.storage.get("stats");
    if (st) { Object.assign(this.stats, JSON.parse(st)); old.push("stats"); }
    if (old.length) {
      console.log(`moving ${old.length} records from the object's storage to D1`);
      await this.flush();
      for (let i = 0; i < old.length; i += 128) await this.ctx.storage.delete(old.slice(i, i + 128));
    }
  }

  /** Writes what changed, right after the change (coalesced per tick, one write at a time, retried on failure). */
  save() {
    if (this.saving) return;
    this.saving = true;
    queueMicrotask(() => {
      this.saving = false;
      this.flushing = this.flushing.then(() => this.flush()).catch(e => {
        console.log("db error:", String(e));
        setTimeout(() => this.save(), 2000);
      });
      this.ctx.waitUntil(this.flushing);
    });
  }

  async flush() {
    const db = this.env.DB, t = now(), live = new Set(["meta:stats"]), done = [], dels = [], puts = [];
    const changed = (k, v) => {
      live.add(k);
      const s = JSON.stringify(v);
      if (this.written.get(k) === s) return null;
      done.push([k, s]);
      return s;
    };
    for (const [id, u] of Object.entries(this.users)) {
      const s = changed("u:" + id, u);
      if (s) puts.push({ k: "u:" + id, q: db.prepare(`INSERT INTO users (id, email, name, app, test, has_profile, created_at, updated_at, data)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8) ON CONFLICT(id) DO UPDATE SET email = ?2, name = ?3, app = ?4, test = ?5,
        has_profile = ?6, updated_at = ?7, data = ?8`).bind(id, u.email || null, u.name || null, u.app ? 1 : 0, u.test ? 1 : 0, u.profile ? 1 : 0, t, s) });
    }
    for (const [id, m] of Object.entries(this.missions)) {
      const s = changed("m:" + id, m);
      if (s) puts.push({ k: "m:" + id, q: db.prepare(`INSERT INTO missions (id, a, b, outcome, created_at, updated_at, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT(id) DO UPDATE SET a = ?2, b = ?3, outcome = ?4, updated_at = ?6, data = ?7`)
        .bind(id, m.a, m.b, m.outcome == null ? null : m.outcome ? 1 : 0, m.created || t, t, s) });
    }
    const s = changed("meta:stats", this.stats);
    if (s) puts.push({ k: "meta:stats", q: db.prepare("INSERT INTO meta (key, value) VALUES ('stats', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(s) });
    const n = changed("meta:networks", this.networks);
    if (n) puts.push({ k: "meta:networks", q: db.prepare("INSERT INTO meta (key, value) VALUES ('networks', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(n) });
    const gone = [...this.written.keys()].filter(k => !live.has(k) && !k.startsWith("meta:"));
    for (const k of gone) dels.push({ k, q: db.prepare(`DELETE FROM ${k[0] === "u" ? "users" : "missions"} WHERE id = ?1`).bind(k.slice(2)) });
    const all = [...dels, ...puts], failed = new Set();     // deletes first: a deleted account's email may be signed up again
    for (let i = 0; i < all.length; i += 100) {
      const chunk = all.slice(i, i + 100);
      try { await db.batch(chunk.map(x => x.q)); }
      catch {            // one bad row (too big, say) doesn't hold back the rest: each alone, and what fails is tried again later
        for (const x of chunk) try { await db.batch([x.q]); } catch (e) { failed.add(x.k); console.log("db error:", x.k, String(e).slice(0, 200)); }
      }
    }
    for (const [k, v] of done) if (!failed.has(k)) this.written.set(k, v);
    for (const k of gone) if (!failed.has(k)) this.written.delete(k);
    if (failed.size) throw new Error(`${failed.size} not written`);
  }

  // ---- people ---------------------------------------------------------------------------------------------
  /** Public card for anyone in the room, seed or real. What they hid is left out, except for themselves
      (`self`), who also get the list of what they hid. */
  person(pid, self = false) {
    const s = SEED_BY_ID[pid];
    if (s) {
      const o = {};
      for (const k of ["id", "name", "role", "color", "building", "needs", "offers", "spot", "line", "socials"]) o[k] = s[k];
      return { ...o, seed: true };
    }
    const u = this.users[pid];
    if (!u) return null;
    const p = u.profile || {};
    const card = {
      id: pid, name: u.name || p.name || "Someone", role: p.role || "", color: u.color, building: p.building || "",
      needs: p.needs || "", offers: p.offers || "", spot: p.spot || "", line: p.line || "", hooks: p.hooks || [],
      socials: u.socials || {}, photo: u.photo || "",
    };
    return self ? { ...card, hidden: u.hidden || [] } : hideFrom(card, u.hidden);
  }

  /** Someone's id is the key to their account, so what anyone else is sent carries a stand-in for it instead (the same
      one every time). `viewer` (whoever asked) sees their own. */
  outward(data, viewer) {
    const swap = v => typeof v === "string" ? (v !== viewer && Object.hasOwn(this.users, v) ? this.standIn(v) : v)
      : Array.isArray(v) ? v.map(swap) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)])) : v;
    return swap(data);
  }

  standIn(id) {
    const u = this.users[id];
    if (!u.pub) { u.pub = "p" + hexId(11); this.save(); }
    return u.pub;
  }

  /** Who an attendee can meet: the people live in the same network right now (one you created, joined by its code,
      or a Luma event, which is a network too), with a card, not paused and not test attendees. Outside a network
      there's nobody to meet. */
  candidates(exclude, app = false, seeds = true) {
    const me = this.users[exclude], net = me?.live?.network, n = net && this.networks[net];
    if (!n || n.expires <= now() || me.test) return [];
    return n.members.filter(id => id !== exclude && this.users[id]?.live?.network === net && this.users[id].profile &&
      !this.users[id].test && !this.users[id].paused).map(id => this.person(id));     // (paused in Settings: nobody meets them)
  }

  /** Why Find is closed for them now, or null when it's open: they have to be live in a network. */
  findClosed(u) {
    const n = u.live?.network && this.networks[u.live.network];
    return n && n.expires > now() ? null : "Join or create a network first.";
  }

  // ---- events (Luma) ------------------------------------------------------------------------------------------
  // Each Luma event is its own room: join one and Emma only introduces you to people who joined it too.

  /** Everyone who joined this event, newest first (test attendees left out). */
  inEvent(eid) {
    return Object.values(this.users).filter(u => u.event?.id === eid && !u.test).sort((a, b) => (b.event.at || 0) - (a.event.at || 0));
  }

  /** The events for a search, or near where they are, each with how many PairShake people joined it. Events
      people here joined come first. */
  async events(q) {
    const u = this.user(q.get("id"));
    const lat = parseFloat(q.get("lat")), lon = parseFloat(q.get("lon"));
    let list = [], error = null;
    // noluma: the app asked Luma itself (from the phone); here only the events kept here, and who joined what
    if (!q.get("noluma")) {
      try { list = await Events.find(q.get("q") || "", lat, lon); }
      catch (e) { console.log("luma error:", String(e)); error = "Luma isn't answering. Try again in a minute."; }
    }
    const here = {}, ours = new Map();
    for (const x of Object.values(this.users)) if (x.event?.id && !x.test) { here[x.event.id] = (here[x.event.id] || 0) + 1; ours.set(x.event.id, x.event); }
    // events Luma's search leaves out: the pinned ones, and any someone here joined (from its link), found by name
    const s = q.get("q") || "";
    if (!Events.isLink(s)) {
      const pinned = (await Promise.all(Events.PINNED.map(slug => Events.bySlug(slug).catch(() => null)))).filter(Boolean);
      const extra = [...pinned, ...ours.values()].filter(e => Events.live(e) && Events.named(e, s)).map(({ at, ...e }) => e);
      const seen = new Set(list.map(e => e.id));
      list = [...extra.filter(e => !seen.has(e.id) && seen.add(e.id)), ...list];
    }
    for (const n of Object.values(this.networks)) if (n.luma) here[n.luma] = n.members.length;   // (who joined it here: its network)
    list = list.filter(happening).map(e => ({ ...e, here: here[e.id] || 0 }));     // only what's on right now
    list.sort((a, b) => (b.here > 0) - (a.here > 0));
    return { events: list.slice(0, 40), mine: u?.event || null, error, here };
  }

  /** An event's page: who joined it (?event=<Luma id>, or the event they're in), and who has its room open now
      (the page asks every 8 s; kept in memory only, nothing written). Anyone can look before joining. */
  eventRoom(q) {
    const u = this.user(q.get("id")) || notFound();
    const eid = str(q.get("event")) || u.event?.id;
    if (!eid) return { event: null, people: [], count: 0, online: 0 };
    const joined = u.event?.id === eid;
    if (joined) this.eventSeen.set(u.id, now());
    const all = this.inEvent(eid), on = x => now() - (this.eventSeen.get(x.id) || 0) < 30;
    const people = all.filter(x => x.id !== u.id).sort((a, b) => on(b) - on(a)).slice(0, 100).map(x => ({ ...(x.profile ? this.person(x.id)
      : { id: x.id, name: x.name || "Someone", role: "", color: x.color, photo: x.photo || "" }), online: on(x), ready: !!x.profile && !x.paused }));   // (ready: someone Find can introduce)
    return { event: joined ? u.event : null, joined, people, count: all.length, online: people.filter(p => p.online).length };
  }

  /** Join an event (Luma's id and link, checked with Luma), or leave it ({leave: true}). */
  async joinEvent(d) {
    const u = this.user(d.id) || notFound();
    if (d.leave) { delete u.event; this.save(); return { event: null, people: [], count: 0 }; }
    const kept = Object.values(this.users).find(x => x.event?.id && x.event.id === d.event?.id)?.event;
    const ev = kept ? (({ at, ...e }) => e)(kept) : await Events.lookup(d.event);
    if (!ev) throw new HttpError(400, "Couldn't find that event on Luma.");
    if (u.event?.id !== ev.id) { u.event = { ...ev, at: now() }; this.save(); }
    return this.eventRoom(new URLSearchParams({ id: u.id }));
  }

  newUser(app) {
    const uid = hexId(10);
    this.users[uid] = {
      id: uid, name: null, transcript: [["emma", P.OPENER]], profile: null, socials: {}, code: String(randint(1000, 9999)),
      color: pick1(P.PALETTE), match: null, inbox: [], turns: 0, app,
    };
    return this.users[uid];
  }

  user(id) { return Object.hasOwn(this.users, String(id ?? "")) ? this.users[String(id)] : null; }

  convo(u) {
    const lines = u.transcript.map(([r, t]) => `${r === "emma" ? "Emma" : "Attendee"}: ${t}`);
    const mem = u.memory;
    if (mem) {        // someone who came back: what they told Emma last time stays true unless they change it
      const known = Object.fromEntries(["name", "role", "building", "needs", "offers"].map(k => [k, mem[k] || ""]));
      lines.unshift("(What Emma remembers from their last chat, still true unless they change it: " + JSON.stringify(known) + ")");
    }
    return lines.join("\n");
  }

  /** What Emma has worked out about this attendee so far in the chat (kept from turn to turn, so she never asks
      for something twice). Someone who came back starts with what she remembers, except where they are. */
  knownOf(u) {
    const k = Object.fromEntries(KNOWN.map(f => [f, ""]));
    const mem = u.memory || {};
    for (const f of KNOWN) if (f !== "spot") k[f] = String(mem[f] || "");
    for (const [f, v] of Object.entries(u.known || {})) if (f in k && v) k[f] = v;
    return k;
  }

  /** Everyone this person has already been introduced to, either way round. */
  met(uid) {
    const out = new Set();
    for (const m of Object.values(this.missions)) if (m.a === uid || m.b === uid) out.add(m.a === uid ? m.b : m.a);
    return out;
  }
  /** The people they both said yes to (went to find in person): never introduced to them again. */
  metInPerson(uid) {
    const out = new Set();
    for (const m of Object.values(this.missions)) if (m.outcome === true && (m.a === uid || m.b === uid)) out.add(m.a === uid ? m.b : m.a);
    return out;
  }

  /** What Emma says to someone who comes back: something of theirs, brought up by her. */
  async welcomeBack(u) {
    if (SCRIPT) return P.SCRIPT_BACK;
    const src = u.profile || u.memory || {};
    const mem = Object.fromEntries(["name", "role", "building", "needs", "offers"].map(k => [k, src[k] || ""]));
    const names = [...this.met(u.id)].map(pid => (this.person(pid) || {}).name).filter(Boolean);
    try {
      const out = await ask(this.env, M.fill(P.BACK, { memory: JSON.stringify(mem), met: names.join(", ") || "nobody yet" }), { timeout: 15 });
      const say = str(out.say);
      if (say) return say;
    } catch (e) {
      console.log("welcome back error:", String(e));
    }
    return M.fill(P.RETURN_OPENER, { first: firstName(u.name || "there") });
  }

  /** Written right after a match, so it is ready the moment they come back. */
  async prepareBack(u) {
    u.back = await this.welcomeBack(u);
    this.save();
  }

  // ---- talking to Emma ------------------------------------------------------------------------------------
  async start(d, app) {
    const u = this.user(d.id);
    if (u && u.profile) {      // back again: Emma remembers them and only asks what's changed
      u.memory = { ...u.profile };
      const say = u.back || await this.welcomeBack(u);
      delete u.back;
      Object.assign(u, { transcript: [["emma", say]], turns: 0, known: {}, asked: [] });
      this.said.add(say);
      this.scans.delete(u.id);
      this.pending.delete(u.id);
      this.save();
      return { id: u.id, say, code: u.code };
    }
    const n = this.newUser(app);
    this.save();
    return { id: n.id, say: P.OPENER, code: n.code };
  }

  async turn(d) {
    const u = this.user(d.id) || notFound();
    const text = str(d.text).slice(0, 2000);
    const last = u.transcript[u.transcript.length - 1];
    if (d.interrupted && last && last[0] === "emma") last[1] += " [the attendee cut Emma off here and started talking]";
    if (text) u.transcript.push(["you", text]);
    u.turns = (u.turns || 0) + 1;
    let out;
    if (u.turns >= MAX_TURNS) {
      out = { say: P.THINKING, done: true };
    } else {
      try {
        const prompt = M.fill(P.INTERVIEW, { convo: this.convo(u), known: JSON.stringify(this.knownOf(u)), returning: u.memory ? P.RETURNING : "" });
        out = await ask(this.env, prompt);
        // what Emma knows only grows: once she has what she needs she stops asking, whatever the model says
        const got = isObj(out.known) ? out.known : {};
        u.known = Object.fromEntries(Object.entries(this.knownOf(u)).map(([k, v]) => [k, str(got[k]) || v]));
        if (NEEDED.every(k => u.known[k])) {
          out.done = true;
        } else if (SCRIPT) {        // the script's question for the first thing still missing, each once
          const asked = (u.asked ||= []);
          const gap = NEEDED.filter(k => !u.known[k] && !asked.includes(k));
          if (gap.length) { out.say = P.ASK[gap[0]]; asked.push(gap[0]); } else out.done = true;
        }
      } catch (e) {
        console.log("interview error:", String(e));
        out = { say: pick1(P.SCRIPT_FALLBACK), done: false };   // (their answer is already written down)
      }
    }
    let say = str(out.say);
    // the quick model sometimes still opens like an assistant ("Ha, ...", "Nice, ...")
    say = say.replace(/^(?:(?:ha(?:ha)?|oh|nice|great|cool|love (?:it|that))[,!.]|so,?|okay,? so,?)\s+(?=\w)/i, "");
    say = (say.slice(0, 1).toUpperCase() + say.slice(1)) || P.THINKING;
    u.transcript.push(["emma", say]);
    if (out.done) {
      say = P.THINKING;
      u.transcript[u.transcript.length - 1] = ["emma", say];
      this.stopMatch(u);          // (finding starts only when they tap it, in their event)
    }
    this.said.add(say);
    this.save();
    return { say, done: !!out.done };
  }

  /** No talking: the attendee asked ChatGPT, which already knows them, to answer Emma's questions and pasted its
      answer here. It stands in for the voice chat, and the matching starts at once. */
  // ---- networks: a lobby for one event or group. Created with a name and a lifetime, joined by its QR code or
  // link. When it ends it is deleted and everyone is out. Who is in which network is kept on both sides
  // (network.members, user.networks); who is live in it right now is user.live = {network, since}.
  // Matching within a network is the matching's business: this.networks[id].members, and u.live.

  static LIFETIMES = [2, 6, 24, 72];      // hours a network can last

  /** Deletes the networks whose time is up, and takes everyone out of them. */
  purgeNetworks() {
    const t = now();
    for (const n of Object.values(this.networks)) {
      if (!n.expires) n.expires = (n.created || t) + 24 * 3600;       // (made before networks had a lifetime)
      if (n.expires > t) continue;
      for (const uid of n.members) {
        const u = this.users[uid]; if (!u) continue;
        u.networks = (u.networks || []).filter(x => x !== n.id);
        if (u.live?.network === n.id) delete u.live;
      }
      if (n.photo) this.env.VOICE.delete(`net/${n.id}.jpg`).catch(() => {});
      delete this.networks[n.id];
      this.save();
    }
  }

  networkCard(n, viewer) {
    const live = n.members.filter(id => this.users[id]?.live?.network === n.id).length;
    return { id: n.id, code: n.code, name: n.name, members: n.members.length, live, mine: n.owner === viewer,
             created: n.created, expires: n.expires, photo: n.photo ? `/network/photo/${n.id}?v=${n.photo}` : n.cover || "", luma: n.luma || "",
             you_live: this.users[viewer]?.live?.network === n.id };
  }

  async networkCreate(d) {
    this.purgeNetworks();
    const u = this.user(d.id) || notFound();
    const name = str(d.name).slice(0, 60);
    if (!name) throw new HttpError(400, "Give it a name.");
    const hours = PairShake.LIFETIMES.includes(Number(d.hours)) ? Number(d.hours) : 6;
    const ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";       // (no 0/O or 1/I to mistype)
    let code;
    do { code = Array.from(crypto.getRandomValues(new Uint8Array(6)), b => ABC[b % ABC.length]).join(""); }
    while (Object.values(this.networks).some(n => n.code === code));
    const id = hexId(8), t = now();
    const n = { id, code, name, owner: u.id, created: t, expires: t + hours * 3600, members: [u.id] };
    const photo = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(str(d.photo));      // the cover, if they chose one
    if (photo && photo[1].length < 700000) {
      const bytes = Uint8Array.from(atob(photo[1]), c => c.charCodeAt(0));
      await this.env.VOICE.put(`net/${id}.jpg`, bytes, { httpMetadata: { contentType: "image/jpeg" } });
      n.photo = Math.round(t);
    }
    this.networks[id] = n;
    u.networks = [...new Set([...(u.networks || []), id])];
    u.live = { network: id, since: t };          // the creator is live in it too
    this.save();
    return { network: this.networkCard(n, u.id) };
  }

  networkJoin(d) {
    this.purgeNetworks();
    const u = this.user(d.id) || notFound();
    const code = str(d.code).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(-6);
    const n = Object.values(this.networks).find(x => x.code === code);
    if (!n) throw new HttpError(404, "No network with that code, or it has ended.");
    if (!n.members.includes(u.id)) n.members.push(u.id);
    u.networks = [...new Set([...(u.networks || []), n.id])];
    u.live = { network: n.id, since: now() };    // joining puts you live: discoverable there right away
    this.save();
    return { network: this.networkCard(n, u.id) };
  }

  /** Join a Luma event that's on right now: it's a network like any other (made the first time someone joins it,
      named and pictured after the event, ending two hours after the event does), and you're live in it. */
  async networkLuma(d) {
    this.purgeNetworks();
    const u = this.user(d.id) || notFound();
    let ev = await Events.lookup(d.event);
    if (!ev) throw new HttpError(400, "Couldn't find that event on Luma.");
    if (ev.id === FEATURED.id) ev = { ...ev, end: FEATURED.end };
    if (!happening(ev)) throw new HttpError(409, `${ev.name} isn't on right now.`);
    let n = Object.values(this.networks).find(x => x.luma === ev.id);
    if (!n) {
      const ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      let code;
      do { code = Array.from(crypto.getRandomValues(new Uint8Array(6)), b => ABC[b % ABC.length]).join(""); }
      while (Object.values(this.networks).some(x => x.code === code));
      const t = now(), end = Date.parse(ev.end || "") / 1000 || t + 6 * 3600;
      n = { id: hexId(8), code, name: ev.name.slice(0, 60), owner: u.id, created: t, expires: end + 2 * 3600, members: [], luma: ev.id, cover: ev.cover || "" };
      this.networks[n.id] = n;
    }
    if (ev.id === FEATURED.id) n.expires = Math.max(n.expires, Date.parse(FEATURED.end) / 1000 + 2 * 3600);   // (made before it was featured)
    if (!n.members.includes(u.id)) n.members.push(u.id);
    u.networks = [...new Set([...(u.networks || []), n.id])];
    u.live = { network: n.id, since: now() };
    this.save();
    return { network: this.networkCard(n, u.id) };
  }

  /** One network as its live screen shows it: the card and who is in it (live first). */
  networkView(q) {
    this.purgeNetworks();
    const u = this.user(q.get("id")) || notFound();
    const n = this.networks[q.get("network")];
    if (!n || !n.members.includes(u.id)) throw new HttpError(404, "This network has ended.");
    const people = n.members.filter(id => id !== u.id && this.users[id]).map(id => {
      const p = this.person(id) || {};
      return { id, name: p.name, color: p.color, photo: p.photo || "", role: p.role || "", live: this.users[id].live?.network === n.id,
               ready: !!this.users[id].profile && !this.users[id].paused && !this.users[id].test };
    }).sort((a, b) => b.live - a.live);
    return { network: this.networkCard(n, u.id), people, ready: !!u.profile };
  }

  /** Live on or off in a network (discoverable or not), or leave it for good. */
  networkLive(d) {
    const u = this.user(d.id) || notFound();
    const n = this.networks[str(d.network)];
    if (!n || !n.members.includes(u.id)) throw new HttpError(404, "This network has ended.");
    if (d.leave) {
      n.members = n.members.filter(x => x !== u.id);
      u.networks = (u.networks || []).filter(x => x !== n.id);
      if (u.live?.network === n.id) delete u.live;
    } else if (d.on) u.live = { network: n.id, since: now() };
    else if (u.live?.network === n.id) delete u.live;
    this.save();
    return { network: d.leave ? null : this.networkCard(n, u.id) };
  }

  networksOf(q) {
    this.purgeNetworks();
    const u = this.user(q.get("id")) || notFound();
    return { networks: (u.networks || []).map(id => this.networks[id]).filter(Boolean).map(n => this.networkCard(n, u.id)) };
  }

  /** No AI of their own: our agent asks the profile's questions (prompts.js ONBOARD). The page keeps the chat
      and sends it whole each turn; when done, it gets the same PAIRSHAKE PROFILE text the AIs write, for /quick. */
  async onboard(d) {
    const u = this.user(d.id) || notFound();
    const turns = (Array.isArray(d.chat) ? d.chat : []).slice(-40)
      .map(c => `${c && c.from === "agent" ? "Agent" : "Person"}: ${str(c && c.text).slice(0, 1200)}`).join("\n");
    const mine = (Array.isArray(d.chat) ? d.chat : []).filter(c => c && c.from !== "agent").length;
    const wrapUp = d.finish || mine >= 14;      // they asked to stop, or it has gone on long enough
    const name = u.name ? `Their name (from how they signed in): ${u.name}\n\n` : "";
    let out;
    try {
      const chat = (turns || "(empty)") + (wrapUp ? "\n(Finish now: set done to true and write the profile from what they said.)" : "");
      out = await ask(this.env, M.fill(P.ONBOARD, { chat, name }), { timeout: 30 });
    } catch (e) {
      console.log("onboard error:", String(e).slice(0, 200));
      throw new HttpError(502, "Couldn't think of the next question. Try again.");
    }
    const done = !!out.done && str(out.profile).length > 80;
    return { say: str(out.say).slice(0, 600) || "Thanks, that's everything I need.", done, profile: done ? str(out.profile).slice(0, 6000) : "" };
  }

  /** What someone told us, as text for the persona and traits: their AI's write-up or their chat with Emma,
      else the profile they typed. */
  sourceText(u) {
    const chat = (u.transcript || []).some(([r]) => r !== "emma") ? this.convo(u) : "";
    return chat || JSON.stringify(u.profile || {});
  }

  /** Traits for everyone who has a profile but none yet (one person at a time, so the model isn't flooded). */
  async backfillTraits() {
    const todo = Object.values(this.users).filter(u => u.profile && !u.traits && !u.test).slice(0, 60);
    if (todo.length) console.log(`traits backfill: ${todo.length} people`);
    for (const u of todo) await this.writePersona(u, this.sourceText(u));
  }

  /** For matching: anyone's traits, demo attendees included. {v: {key: 0-1}, c: {key: 0-1}, type, summary,
      vector: [44 values in DIMENSIONS order], confidence: [44]}, or null while they're still being read. */
  traitsOf(pid) {
    const t = SEED_TRAITS[pid] || this.users[pid]?.traits;
    return t ? { ...t, ...vector(t) } : null;
  }

  /** The structured persona (prompts.js PERSONA) from what their AI wrote and how they signed in. */
  async writePersona(u, text) {
    if (this.enriching.has(u.id)) return;
    this.enriching.add(u.id);
    try { await this.enrich(u, text); } finally { this.enriching.delete(u.id); }
  }

  async enrich(u, text) {
    const signin = JSON.stringify({ name: u.name || "", via: u.linkedin ? "LinkedIn" : u.google ? "Google" : u.email ? "email" : "",
      email: u.linkedin?.email || u.google?.email || u.email || "" });
    try {
      const p = await ask(this.env, M.fill(P.PERSONA, { signin, text }), { model: MAIN, timeout: 40 });
      if (!isObj(p)) return;
      u.persona = { ...p, at: now() };
      const links = isObj(p.links) ? p.links : {};
      u.socials = u.socials || {};
      for (const k of ["x", "instagram", "linkedin", "github"]) {        // handles they hadn't set, from the write-up
        const h = str(links[k]).replace(/^https?:\/\/(www\.)?[^/]+\/(in\/)?/, "").replace(/[/@]/g, "").slice(0, 100);
        if (h && !u.socials[k]) u.socials[k] = h;
      }
      this.save();
    } catch (e) { console.log("persona error:", String(e).slice(0, 200)); }
    try {                         // then the 44 numbers (traits.js): what matching can work with
      u.traits = { ...(await readTraits(this.env, text, u.persona)), at: now() };
      this.save();
      console.log(`traits ${u.id}: ${u.traits.type}, ${u.traits.readings} readings`);
    } catch (e) { console.log("traits error:", String(e).slice(0, 200)); }
  }

  async quick(d, app) {
    const text = str(d.text).slice(0, 6000);
    if (text.length < 40) throw new HttpError(400, "That's too short. Paste your AI's whole answer.");
    const spot = str(d.spot).slice(0, 200);
    const u = this.user(d.id) || this.newUser(app);
    if (u.profile) u.memory = { ...u.profile };     // someone Emma knows: anything ChatGPT doesn't mention stays
    const transcript = [["emma", P.QUICK_ASK], ["you", P.QUICK_NOTE + text]];
    if (spot) transcript.push(["emma", "And where are you in the room?"], ["you", spot]);
    Object.assign(u, { transcript, turns: 0, known: {}, via: "chatgpt" });
    this.writePersona(u, text);   // the structured persona, in the background (the match doesn't wait for it)
    this.stopMatch(u);            // (finding starts only when they tap it, in their event)
    this.save();
    return { id: u.id, code: u.code, say: P.THINKING };
  }

  beginMatch(u) {
    const p = this.runMatch(u);
    p.catch(() => {});            // (whoever awaits it later sees the error)
    this.pending.set(u.id, p);
    this.startScan(u);
    return p;
  }

  /** Stop the match being worked out for them: it introduces nobody, and whom it had chosen is free again. */
  stopMatch(u) {
    this.gen.set(u.id, (this.gen.get(u.id) || 0) + 1);
    this.pending.delete(u.id);
    this.scans.delete(u.id);
    this.claims = this.claims.filter(c => c.a !== u.id);
  }

  // ---- matching -------------------------------------------------------------------------------------------
  async match(d) {
    const u = this.user(d.id) || notFound();
    u.socials = u.socials || {};        // handles sent here are added; an empty box doesn't erase one saved before
    for (const [k, v] of Object.entries(isObj(d.socials) ? d.socials : {})) if (str(v)) u.socials[k.slice(0, 20)] = str(v).replace(/^@+/, "").slice(0, 100);
    if (d.wait) return this.settle(u);
    const closed = this.findClosed(u);
    if (closed) throw new HttpError(403, closed);
    const gen = this.gen.get(u.id) || 0, stopped = () => (this.gen.get(u.id) || 0) !== gen;
    // a second /match while one is being worked out waits for the same one; a result is used once
    const take = async task => { try { return await task; } finally { if (this.pending.get(u.id) === task) this.pending.delete(u.id); } };
    const here = r => this.candidates(u.id, !!u.app).some(x => x.id === r.match_id);
    let r, room;
    try {
      [r, room] = await take(this.pending.get(u.id) || this.beginMatch(u));
      if (!stopped() && !here(r)) {      // the one chosen left, paused or deleted their account meanwhile: look again
        this.scans.delete(u.id);
        [r, room] = await take(this.beginMatch(u));
      }
    } catch (e) {
      if (stopped()) return json({ cancelled: true }, 409);
      console.log("match error:", String(e));
      if (/nobody else in the room/.test(String(e.message || e))) throw new HttpError(422, "Nobody new to meet here yet.");
      throw new HttpError(502, String(e.message || e));
    }
    if (stopped()) return json({ cancelled: true }, 409);    // they stopped looking meanwhile
    const them = this.person(r.match_id);
    if (!them || !here(r)) throw new HttpError(409, "They just left. Try again.");
    u.profile = r.me || u.profile || {};
    if (r.from) u.from = r.from; else delete u.from;
    u.name = u.profile.name || u.name;
    if (!u.traits) this.writePersona(u, this.sourceText(u));     // (after a voice chat; the pasted kind started already)
    this.claims = this.claims.filter(c => !(c.a === u.id && c.b === them.id));     // the introduction itself counts from here on
    // two people who found each other at the same moment share one introduction. One left unanswered from before
    // (its card gave ten seconds) is over: closed as a no, and a new one is made, so both phones show its card
    const pair = m => !m.test && ((m.a === u.id && m.b === them.id) || (m.a === them.id && m.b === u.id));
    for (const m of Object.values(this.missions)) if (m.outcome == null && pair(m) && now() - (m.created || 0) > 30) { m.outcome = false; this.broadcast(m.id, { t: "meet", yes: false }); }
    const open = Object.values(this.missions).find(m => m.outcome == null && pair(m));
    const mid = open ? open.id : hexId(8);
    if (!open) {
      this.missions[mid] = {
        id: mid, a: u.id, b: them.id, intro_a: r.intro_me || "", intro_b: r.intro_them || "",
        overlap: cleanOverlap(r.overlap || {}), created: now(), outcome: null,
      };
      this.agentTalk(mid).catch(e => console.log("talk error:", String(e)));    // agents talk while Emma reveals the match
      this.stats.intros++;
      if (this.users[them.id]) this.users[them.id].inbox.push(mid);            // a real person: their phone gets it too
    }
    u.match = mid;
    this.prepareBack(u).catch(e => console.log("back error:", String(e)));    // and her greeting for next time is written
    this.stats.spoke++;
    this.save();
    const say = SCRIPT ? scriptReveal(them) : r.say || "";
    this.said.add(say);
    return { say, me: this.person(u.id, true), mission: this.missionFor(mid, u.id) };
  }

  /** What Emma says while she looks (written as the search starts, ready when the page asks for it). */
  async prepareMuse(u, state) {
    try {
      const out = SCRIPT ? P.SCRIPT_MUSE : await ask(this.env, M.fill(P.MUSE, { about: this.convo(u) }));
      const lines = { start: str(out.start), looking: str(out.looking) };
      for (const k of ["start", "looking"]) if (lines[k]) this.said.add(lines[k]);     // voiced only if the page asks (sound on)
      state.muse = lines;
    } catch (e) {
      console.log("muse error:", String(e));
    }
  }

  /** The matching screen can start at once; the agents go out when runMatch has the profile (sendAgents). */
  startScan(u) {
    if (this.scans.has(u.id)) return;
    const state = { talks: [], total: 0, sent: 0, closed: false, muse: null };
    this.scans.set(u.id, state);
    this.prepareMuse(u, state);
  }

  /** The attendee's agent talks to the people most worth it (matching.shortlist), fewer when the room is busy
      matching. A talk still waiting for its turn when the match is made, or after 7 seconds, is dropped.
      Each talk is two agents, one model call each: the attendee's agent knows only its own person and the other's
      public card, and asks; the other person's agent knows its own person (whom they'd rather not meet, how many
      introductions they hold) and the attendee's public card, and answers yes or no for them. */
  sendAgents(state, u, me, R, room, only) {
    if (!state || state.sent) return state;      // (state: the run's own, so a run stopped meanwhile can't take a new one's)
    const busy = [...this.scans.values()].filter(st => st.sent && !st.closed).length;
    const who = only || M.shortlist(R, u.id, room.map(p => p.id), !busy ? 8 : busy < 5 ? 4 : 3);   // (only: the judge's choice and the next best)
    state.total = who.length;
    state.sent = now();
    const pub = p => JSON.stringify(Object.fromEntries(Object.entries(M.card(p)).filter(([k]) => k !== "id" && k !== "avoid")));
    // their agent's answer is shown to the attendee, so it knows nothing they hid (nor their AI's write-up then)
    const own = (p, self) => { const h = self ? null : this.users[p.id]?.hidden;
      return JSON.stringify(M.judgeCard({ ...hideFrom(p, h), persona: h?.length ? null : this.users[p.id]?.persona })); };
    const mine = own(me, true), myCard = pub(me), convo = this.convo(u);
    const one = async (rank, pid) => {
      const p = hideFrom(R.people[pid], this.users[pid]?.hidden);     // (what they hid: their agent doesn't say it either)
      try {
        await this.agentsTurns.take(rank);
        let q, a;
        try {
          if (state.closed || now() - state.sent > 7) throw new Error("no longer needed");
          q = await ask(this.env, M.fill(P.AGENT_ASK, { me: mine, convo, name: me.name || "the attendee", first: M.first(me),
            other_name: p.name, other_first: M.first(p), other: pub(p) }), { timeout: 15 });
          a = await ask(this.env, M.fill(P.AGENT_REPLY, { me: own(p), name: p.name, first: M.first(p), open: R.open[pid] || 0,
            other_name: me.name || "an attendee", other_first: M.first(me), other: myCard, ask: str(q.ask).slice(0, 300) }), { timeout: 15 });
        } finally {
          this.agentsTurns.give();
        }
        const person = this.person(pid);
        if (!person) throw new Error("no longer needed");      // (they deleted their account meanwhile)
        const no = a.meet === false;        // their agent declined for them
        state.talks.push({ person, ask: str(q.ask), reply: str(a.reply), fit: no ? Math.min(M.int(a.fit, 30), 15) : M.int(a.fit, 30), no });
      } catch (e) {
        if (e.message !== "no longer needed") console.log("scan error:", String(e));
        state.total--;
      }
    };
    who.forEach((pid, rank) => one(rank, pid));
    return state;
  }

  /** What the agents concluded. Waits for the ones still talking: 9 seconds when at least two are back by then,
      13 at most. The match is chosen from these, so it agrees with the screen. */
  async verdicts(state, t) {
    while (state.talks.length < state.total && now() < t + (state.talks.length >= 2 ? 9 : 13)) await sleep(250);
    return Object.fromEntries(state.talks.map(x => [x.person.id, x]));
  }

  /** A card plus what only matching may know: whom they'd rather not meet, and what they hid (it still helps
      pick who they meet, but nothing written for anyone else is made from it). */
  private(p) {
    const u = this.users[p.id], pr = u?.profile;
    if (!pr) return p;
    const o = { ...p };
    for (const k of u.hidden || []) if (pr[k]) o[k] = pr[k];
    return pr.avoid ? { ...o, avoid: pr.avoid } : o;
  }

  /** In a room (a Luma event or a network): write their card from what they told Emma and stop there. Nobody is
      introduced; they start finding from the room when they want ({wait: true} on /match). */
  async settle(u) {
    this.stopMatch(u);            // the match begun on the way here is dropped
    let me;
    const heard = M.hash(JSON.stringify(u.transcript || []));
    try { me = await M.profile(this.convo(u), prompt => ask(this.env, prompt, { timeout: 15 })); u.from = heard; }
    catch (e) {
      console.log("profile error:", String(e));
      delete u.from;
      me = Object.fromEntries(Object.entries(u.known || {}).filter(([, v]) => v).map(([k, v]) => [k, String(v)]));
    }
    if (u.memory) {
      const said = Object.fromEntries(Object.entries(me).filter(([, v]) => v && !(Array.isArray(v) && !v.length)));
      me = { ...u.memory, ...said };
    }
    delete me.id;
    u.profile = { ...(u.profile || {}), ...me };
    u.name = u.profile.name || u.name;
    u.memory = { ...u.profile };
    if (!u.traits) this.writePersona(u, this.sourceText(u));
    this.save();
    return { me: this.person(u.id) };
  }

  /** Who they meet (matching.js): their profile, the agents' verdicts, the pair, then the spark. */
  async runMatch(u) {
    const t0 = now(), gen = this.gen.get(u.id) || 0;
    const live = () => { if ((this.gen.get(u.id) || 0) !== gen) throw new Error("stopped"); };    // stopped meanwhile: nobody is chosen
    this.startScan(u);
    const state = this.scans.get(u.id);
    let p, s, talks = {}, t1 = t0, t2 = t0, me, room, judged = 0, byJudge = false, from = null;
    try {
      const app = !!u.app;
      // on the app: another app user if there is one; always someone new (unless they've met everyone: then someone
      // whose card timed out before, but never someone they both said yes to)
      const seen = this.met(u.id), together = this.metInPerson(u.id);
      const fresh = ps => ps.filter(x => !seen.has(x.id));
      room = (app && fresh(this.candidates(u.id, true, false))) || [];
      if (!room.length) room = fresh(this.candidates(u.id, app));
      if (!room.length) room = this.candidates(u.id, app).filter(x => !together.has(x.id));
      if (!room.length) throw new Error("nobody else in the room");
      const convo = this.convo(u), kept = this.profiles.get(u.id), heard = M.hash(JSON.stringify(u.transcript || []));
      if (u.profile && u.from === heard) { me = { ...u.profile }; from = heard; }   // nothing new said since their card was written: the card as it is now (with what they changed by hand)
      else if (kept && kept.convo === convo) { me = { ...kept.me }; from = heard; }     // looking again without a new chat: the same profile
      else {
        try {
          me = await M.profile(convo, prompt => ask(this.env, prompt, { timeout: 15 }));
          this.profiles.set(u.id, { convo, me: { ...me } });
          from = heard;
        } catch (e) {               // the chat already gave Emma the basics
          console.log("profile error:", String(e));
          me = Object.fromEntries(Object.entries(u.known || {}).filter(([, v]) => v).map(([k, v]) => [k, String(v)]));
        }
        live();
      }
      if (u.memory) {             // back again: what they didn't mention stays as it was
        const said = Object.fromEntries(Object.entries(me).filter(([, v]) => v && !(Array.isArray(v) && !v.length)));
        me = { ...u.memory, ...said };
      }
      me = { ...me, id: u.id };
      // an introduction to a demo attendee doesn't count as having met someone
      const past = Object.values(this.missions).map(m => ({
        a: m.a, b: m.b, outcome: m.outcome, created: m.created || 0, demo: !this.users[m.a] || !this.users[m.b],
      }));
      const R = new M.Room([...room.map(x => this.private(x)), me], past);
      t1 = now();
      // the judge reads the room for whoever it hasn't judged against them yet (one call, at most 5 s of waiting)
      const forJudge = x => ({ ...x, persona: this.users[x.id]?.persona });
      const rated = await M.rate(this.judged, forJudge(me), room.map(x => forJudge(this.private(x))),
        (input, questions) => decide(this.env, input, questions, { timeout: 4 }), 5);
      judged = Object.keys(rated.fits).length;
      live();
      // people matching at the same moment see each other's choices, so they don't all pick one person
      const claimed = () => {
        this.claims = this.claims.filter(c => now() - c.created < 90);
        for (const c of this.claims) if (c.a !== u.id) R.record(c.a, c.b);     // (not their own: a run of theirs that was stopped)
      };
      // someone whose agent said no for them isn't introduced: they are set aside, and the choice goes to the next of
      // the people the agents talked to whose agent said yes (only when none did, to the next best by the judge)
      const nos = () => Object.keys(talks).filter(i => talks[i].no);
      const willing = fits => Object.fromEntries(Object.entries(fits).filter(([i]) => !talks[i]?.no));
      const claim = () => { const c = this.users[p.b] ? { a: u.id, b: p.b, outcome: null, created: now() } : null; if (c) this.claims.push(c); return c; };
      // the judge decides when it answered for most of the room (a few old answers from an earlier room aren't enough)
      byJudge = judged >= Math.max(1, room.length / 2);
      if (byJudge) {              // the pair comes from the judge; the agents then talk to that person and the next two
        claimed();
        p = await M.pick(R, u.id, null, rated.fits, rated.recipes);
        const first = claim();
        const free = new Set(R.candidates(u.id));
        const order = M.talkTo(Object.fromEntries(Object.entries(rated.fits).filter(([i]) => free.has(i))), p.b);
        this.sendAgents(state, u, me, R, room, order);
        talks = await this.verdicts(state, now());
        t2 = now();
        live();
        if (talks[p.b]?.no) {
          for (const i of nos()) R.record(u.id, i, false);
          this.claims = this.claims.filter(c => c !== first);
          const b = M.saidYes(order, talks);
          p = b ? { ...p, b, recipe: rated.recipes[b] || R.links(u.id, b).recipe } : await M.pick(R, u.id, null, willing(rated.fits), rated.recipes);
          claim();
        }
      } else {                    // no answer from the judge: the agents' verdicts decide, as before
        this.sendAgents(state, u, me, R, room);
        talks = await this.verdicts(state, now());
        t2 = now();
        live();
        claimed();
        for (const i of nos()) R.record(u.id, i, false);
        p = await M.pick(R, u.id, null, willing(Object.fromEntries(Object.entries(talks).map(([i, t]) => [i, t.fit]))));
        claim();
      }
      state.closed = true;
      for (const x of [u.id, p.b]) R.people[x] = hideFrom(R.people[x], this.users[x]?.hidden);   // the intro is written from what's shown
      R.index();
      s = await M.spark(R, [u.id, p.b], p.recipe, prompt => ask(this.env, prompt, { model: MAIN }),
        u.hidden?.length ? null : talks[p.b],         // (their agent's question came from everything they said)
        [this.traitsOf(u.id), this.traitsOf(p.b)]);     // (traits only shape the tone of the introduction)
    } finally {
      state.closed = true;
    }
    console.log(`match ${u.id} -> ${p.b}: ${s.recipe}, ${p.mode}, by ${byJudge ? "judge" : p.by}, judged ${judged}/${room.length}, ${Object.keys(talks).length}/${state.total} talks, ${Object.values(talks).filter(t => t.no).length} said no, ` +
      `profile ${(t1 - t0).toFixed(1)} s, agents ${(t2 - t1).toFixed(1)} s, spark ${(now() - t2).toFixed(1)} s`);
    const sh = s.share;
    const note = pid => `${s.teases[pid]} Your mission together: ${s.mission}`;
    delete me.id;
    return [{
      me, from, match_id: p.b, intro_me: note(u.id), intro_them: note(p.b), say: s.say,
      overlap: { rare: sh.rare, you_only: sh.first_only, them_only: sh.second_only, give: sh.give, get: sh.get, ladder: s.ladder, mission: s.mission, recipe: s.recipe },
    }, room];
  }

  scan(q) {
    const u = this.user(q.get("id")) || notFound();
    this.startScan(u);
    const st = this.scans.get(u.id);
    return { talks: st.talks, total: st.total, muse: st.muse };
  }

  /** People > Forget everyone: every introduction they're in is deleted (for both sides), so anyone can be
      introduced to them again. For testing. */
  forget(d) {
    const u = this.user(d.id) || notFound();
    const gone = new Set(Object.values(this.missions).filter(m => m.a === u.id || m.b === u.id).map(m => m.id));
    for (const mid of gone) { this.broadcast(mid, { t: "meet", yes: false }); delete this.missions[mid]; }
    for (const x of Object.values(this.users)) if (x.inbox?.some(mid => gone.has(mid))) x.inbox = x.inbox.filter(mid => !gone.has(mid));
    if (gone.has(u.match)) u.match = null;
    this.save();
    return { forgotten: gone.size };
  }

  again(d) {
    const u = this.user(d.id);
    if (!u || !u.profile) notFound();
    const closed = this.findClosed(u);
    if (closed) throw new HttpError(403, closed);
    this.stopMatch(u);            // (a second tap starts over: the first one introduces nobody)
    this.beginMatch(u);
    return { ok: true };
  }

  cancel(d) {
    const u = this.user(d.id);
    if (u) this.stopMatch(u);
    return { ok: true };
  }

  me(q) {
    const u = this.user(q.get("id")) || notFound();
    const contacts = [];
    for (const [mid, m] of Object.entries(this.missions)) {
      if (m.a !== u.id && m.b !== u.id) continue;
      const mf = this.missionFor(mid, u.id);
      if (!mf.person) continue;
      const chat = m.chat || [];
      if (mf.person.seed && !chat.some(c => c.from === (m.a === u.id ? "a" : "b"))) continue;   // a demo attendee you never wrote to isn't someone you know
      contacts.push({ ...mf, you: m.a === u.id ? "a" : "b", chat: chat.slice(-30), at: Math.max(m.created || 0, ...chat.map(c => c.at || 0)) });
    }
    // one row per person: several introductions to the same person (older ones) show as the one you talked in, else the newest
    const best = new Map();
    for (const c of contacts) {
      const k = c.person.id, o = best.get(k);
      if (!o || (c.chat.length ? c.at : -1) > (o.chat.length ? o.at : -1) || (!c.chat.length && !o.chat.length && c.at > o.at)) best.set(k, c);
    }
    contacts.length = 0; contacts.push(...best.values());
    contacts.sort((x, y) => y.at - x.at);
    return { me: u.profile ? this.person(u.id, true) : null, socials: u.socials || {}, contacts, email: u.email || null, name: u.name,
             photo: u.photo || "", linkedin: !!u.linkedin, google: !!u.google, signed: !!(u.linkedin || u.google || u.email),
             via: u.linkedin ? "LinkedIn" : u.google ? "Google" : "", login: u.linkedin?.email || u.google?.email || u.email || "",
             paused: !!u.paused, event: u.event || null,
             traits: u.traits ? { v: u.traits.v, c: u.traits.c, type: u.traits.type, summary: u.traits.summary } : null,
             dims: u.traits ? DIMENSIONS : undefined };
  }

  missionFor(mid, viewer) {
    const m = this.missions[mid];
    const mine = m.a === viewer;
    return {
      id: mid, intro: mine ? m.intro_a : m.intro_b, overlap: overlapFor(m.overlap || cleanOverlap({}), mine),
      person: this.person(mine ? m.b : m.a), outcome: m.outcome ?? null,
      age: Math.max(0, now() - (m.created || now())),     // seconds since it was made (the card gives ten to say yes)
    };
  }

  inbox(q) {
    const u = this.user(q.get("id")) || notFound();
    return { missions: u.inbox.filter(mid => this.missions[mid]).map(mid => this.missionFor(mid, u.id)).filter(m => m.person) };   // (not from someone who deleted their account)
  }

  /** Two agents talk first. Generated once, kept on the mission. */
  async agentTalk(mid) {
    const m = this.missions[mid];
    if (m.talk) return m.talk;
    let t = this.talkTasks.get(mid);
    if (!t) {
      const card = p => JSON.stringify(Object.fromEntries(["name", "role", "building", "needs", "offers", "line"].map(k => [k, (p || {})[k] || ""])));
      t = ask(this.env, M.fill(P.AGENT_TALK, { a: card(this.person(m.a)), b: card(this.person(m.b)) }), { model: MAIN, timeout: 60 });
      this.talkTasks.set(mid, t);
    }
    let r;
    try {
      r = await t;
    } finally {
      this.talkTasks.delete(mid);
    }
    if (m.talk) return m.talk;
    const turns = (Array.isArray(r.turns) ? r.turns : []).slice(0, 10).filter(x => x && x.text)
      .map(x => ({ who: x.who === "b" ? "b" : "a", text: String(x.text).slice(0, 240) }));
    m.talk = { turns, fit: M.int(r.fit, 70), why_a: String(r.why_a ?? ""), why_b: String(r.why_b ?? ""), ask: String(r.ask ?? "") };
    if (m.talk.ask) (m.overlap ||= {}).agent_ask = m.talk.ask;     // the humans can open with what the agents found
    this.save();
    return m.talk;
  }

  async talk(q) {
    const m = this.missions[q.get("mid")] || notFound();
    let t;
    try {
      t = await this.agentTalk(m.id);
    } catch (e) {
      console.log("talk error:", String(e));
      throw new HttpError(502, String(e.message || e));
    }
    const me = q.get("id") === m.b ? "b" : "a";
    return { turns: t.turns, fit: t.fit, why: t["why_" + me], ask: t.ask, you: me, a: this.person(m.a), b: this.person(m.b) };
  }

  // ---- test match (the iPhone app's test button) ------------------------------------------------------------
  // Two phones that tap it are introduced to each other at once, each as a made-up attendee, so the room, meeting
  // and finding by Ultra Wideband can be tried. The first phone waits (it asks again every 2 s) for a second one.
  testUser(app) {
    const taken = new Set([...this.testWait.keys()].filter(w => this.users[w]).map(w => this.users[w].name));
    const free = P.TEST_PEOPLE.filter(t => !taken.has(t[0]));
    const [name, role, building, needs, offers] = pick1(free.length ? free : P.TEST_PEOPLE);
    const uid = hexId(10);
    this.users[uid] = {
      id: uid, name, transcript: [], socials: {}, code: String(randint(1000, 9999)), color: pick1(P.PALETTE), match: null,
      inbox: [], turns: 0, app, test: true,
      profile: { name, role, building, needs, offers, spot: "Holding the other test phone", line: `${firstName(name)} is testing PairShake.` },
    };
    return this.users[uid];
  }

  testMission(a, b) {
    const mid = hexId(8), pa = a.profile, pb = b.profile;
    this.missions[mid] = {
      id: mid, a: a.id, b: b.id, test: true, created: now(),
      outcome: true, decide: { a: true, b: true },        // both said yes already: straight to finding
      intro_a: `A test match: ${firstName(b.name)} is on the other phone. Say yes to meet, then follow the arrow.`,
      intro_b: `A test match: ${firstName(a.name)} is on the other phone. Say yes to meet, then follow the arrow.`,
      overlap: cleanOverlap({
        rare: [{ text: "You're both testing PairShake right now", opener: "Which phone are you on?" },
          { text: "Both your phones can find each other by Ultra Wideband", opener: "Ready to find each other?" }],
        you_only: [pa.building, pa.offers], them_only: [pb.building, pb.offers], give: pa.offers, get: pb.offers,
        ladder: ["What are you building?", "What's the hardest part so far?", "What would make tonight a win?"],
      }),
    };
    a.match = b.match = mid;
    b.inbox.push(mid);
    return mid;
  }

  testMatch(d, app) {
    let u = this.user(d.id);
    if (!u || !u.test) u = this.testUser(app);
    const t = now();
    if (d.cancel) { this.testWait.delete(u.id); this.save(); return { me: this.person(u.id) }; }
    let mid = u.test_mid;                    // the other phone came while we waited and matched us
    delete u.test_mid;
    if (!mid) {
      for (const [w, at] of this.testWait) if (t - at > 8 || !this.users[w]) this.testWait.delete(w);   // that phone left
      const otherId = [...this.testWait.keys()].find(w => w !== u.id && !!this.users[w].app === !!app);
      if (otherId) {
        const other = this.users[otherId];
        this.testWait.delete(otherId);
        mid = this.testMission(u, other);
        other.test_mid = mid;
      }
    }
    if (!mid) { this.testWait.set(u.id, t); this.save(); return { waiting: true, me: this.person(u.id) }; }
    this.testWait.delete(u.id);
    this.save();
    const m = this.missions[mid], them = m.a === u.id ? m.b : m.a;
    return { say: `Test match with ${firstName(this.users[them].name)}.`, me: this.person(u.id), mission: this.missionFor(mid, u.id) };
  }

  // ---- accounts: an email and a password that lead back to the same person on any device ----------------------
  // Passwords are kept only as salted PBKDF2-SHA256 hashes.
  byEmail(email) { return Object.values(this.users).find(u => u.email === email) || null; }

  async account(d, app) {
    const action = d.action;
    const email = str(d.email).toLowerCase().slice(0, 200);
    const pw = String(d.password ?? "").slice(0, 200);
    const no = (msg, code = 400) => json({ error: msg }, code);
    if (action === "signup") {
      if (!EMAIL_RE.test(email)) return no("That email doesn't look right.");
      if (pw.length < 6) return no("Use at least 6 characters for the password.");
      if (this.byEmail(email)) return no("There's already an account with that email. Sign in instead.", 409);
      const u = this.user(d.id) || this.newUser(app);
      if (u.email) return no(`This device is already signed in as ${u.email}.`, 409);
      const salt = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
      u.email = email;
      u.pw = { alg: "pbkdf2-sha256", iter: PBKDF2_ITER, salt, hash: await pwHash(pw, salt) };
      this.save();
      return json({ id: u.id, email });
    }
    if (action === "login") {
      const [n, last] = this.loginFails.get(email) || [0, 0];
      if (n >= 5 && now() - last < 60) return no("Too many tries. Wait a minute and try again.", 429);
      const u = this.byEmail(email);
      const ok = u && u.pw?.alg === "pbkdf2-sha256" && sameHex(u.pw.hash, await pwHash(pw, u.pw.salt, u.pw.iter));
      if (!ok) { this.loginFails.set(email, [n + 1, now()]); return no("Wrong email or password.", 401); }
      this.loginFails.delete(email);
      return json({ id: u.id, email });
    }
    if (action === "delete") {               // the user record goes; their introductions stay, without them
      const id = String(d.id ?? "");
      if (this.user(id)) {
        delete this.users[id];
        for (const t of [this.scans, this.pending, this.testWait]) t.delete(id);
        this.save();
      }
      return json({ ok: true });
    }
    return no("Unknown action.");
  }

  /** Signed in with LinkedIn or Google (auth.js has already checked who they are): the same person every time,
      on any device. A first sign-in on a device that already has someone becomes that someone. */
  login(d, app) {
    const provider = ["linkedin", "google"].includes(d.provider) ? d.provider : null;
    const sub = str(d.sub).slice(0, 100);
    if (!provider || !sub) throw new HttpError(400, "Who signed in?");
    let u = Object.values(this.users).find(x => x[provider]?.sub === sub);
    if (!u) {
      const here = this.user(d.id);
      u = here && !here[provider] ? here : this.newUser(app);
    }
    u[provider] = { sub, email: str(d.email).slice(0, 200), picture: str(d.picture).slice(0, 1000), at: now() };
    if (u[provider].picture && (!u.photo || provider === "linkedin")) u.photo = u[provider].picture;   // LinkedIn's photo wins
    const name = str(d.name).slice(0, 80);
    if (name && (!u.name || !u.profile)) { u.name = name; if (u.profile) u.profile.name = name; }
    this.save();
    return { id: u.id, name: u.name };
  }

  /** Settings: your name and where people can follow you; and what Emma remembers, edited by hand. */
  profile(d) {
    const u = this.user(d.id) || notFound();
    if (Array.isArray(d.hidden)) {          // the You page: what stays off their card
      const h = HIDEABLE.filter(k => d.hidden.includes(k)), pr = u.profile || {};
      const left = HIDEABLE.some(k => !h.includes(k) && (Array.isArray(pr[k]) ? pr[k].length : pr[k]));   // all off = nothing to match on: ignored
      if (left) { if (h.length) u.hidden = h; else delete u.hidden; }
    }
    if (typeof d.paused === "boolean") { if (d.paused) u.paused = true; else delete u.paused; }   // Settings > Pause introductions
    if (isObj(d.socials)) {
      u.socials = {};
      for (const [k, v] of Object.entries(d.socials)) if (["x", "instagram", "linkedin", "github"].includes(k) && str(v)) u.socials[k] = str(v).replace(/^@+/, "").slice(0, 100);
    }
    if (isObj(d.about) && !u.profile) {      // written by hand on the You page, without talking to Emma first
      const p = {};
      for (const k of ["needs", "building", "offers", "role", "line", "spot"]) if (str(d.about[k])) p[k] = str(d.about[k]).slice(0, 400);
      if (!(p.needs || p.building || p.offers || p.role)) throw new HttpError(400, "Say what you're working on or looking for.");
      u.profile = { name: str(d.name).slice(0, 80) || u.name || "", hooks: [], ...p };
      u.via = "form";
      this.writePersona(u, this.sourceText(u));
    }
    if (isObj(d.about) && u.profile) {       // what Emma remembers, fixed by hand
      for (const k of ["needs", "building", "offers", "role", "line", "spot"]) if (k in d.about) u.profile[k] = str(d.about[k]).slice(0, 400);
      if ("hooks" in d.about) u.profile.hooks = hooksOf(d.about.hooks);
      delete u.back;                         // her welcome-back line was about the old one
    }
    const name = str(d.name).slice(0, 80);
    if (name) { u.name = name; if (u.profile) u.profile.name = name; }
    if (isObj(d.about) && u.profile) u.memory = { ...u.profile };    // the next match starts from what's written here
    this.save();
    return { me: u.profile ? this.person(u.id, true) : null, socials: u.socials, name: u.name, email: u.email || null, paused: !!u.paused };
  }

  /** Settings > Send feedback: kept on the person (it travels with the export) and printed to the logs. */
  feedback(d) {
    const u = this.user(d.id) || notFound();
    const text = str(d.text).slice(0, 2000);
    if (!text) throw new HttpError(400, "Write something first.");
    u.feedback = [...(u.feedback || []).slice(-49), { at: now(), text, version: str(d.version).slice(0, 40) }];
    console.log(`feedback from ${u.id} (${u.name || "?"}): ${text}`);
    this.save();
    return { ok: true };
  }

  // ---- the room: see what you share, chat, then each decides whether to meet ----------------------------------
  // Seed people are played by Emma: she chats and decides for them.
  roomFor(mid) {
    if (!this.rooms.has(mid)) this.rooms.set(mid, { gps: {}, replying: false, hold: {} });
    const m = this.missions[mid];
    m.chat ||= [];
    m.decide ||= {};
    return { m, R: this.rooms.get(mid), bot: SEED_BY_ID[m.b] || null };
  }

  sockets(mid, role) {
    return this.ctx.getWebSockets(role ? `${mid}:${role}` : mid).filter(ws => ws.readyState === WebSocket.OPEN);
  }

  broadcast(mid, msg, skip) {
    const s = JSON.stringify(msg);
    for (const ws of this.sockets(mid)) {
      if (skip && ws.deserializeAttachment()?.role === skip) continue;
      try { ws.send(s); } catch {}
    }
  }

  snapshot(mid, role) {
    const { m, bot } = this.roomFor(mid);
    const { R } = this.roomFor(mid);
    return { t: "state", you: role, chat: m.chat, decided: role in m.decide, meet: m.outcome ?? null, online: this.sockets(mid, other(role)).length > 0 || !!bot,
             hold: !!R.hold[other(role)], found: !!m.found };
  }

  decide(mid, role, yes) {
    const { m } = this.roomFor(mid);
    if (role in m.decide) return;
    m.decide[role] = !!yes;
    if (!yes || Object.keys(m.decide).length === 2) {
      m.outcome = Object.keys(m.decide).length === 2 && Object.values(m.decide).every(Boolean);
      if (m.outcome) this.stats.met++;
      this.broadcast(mid, { t: "meet", yes: m.outcome });
    }
    this.save();
  }

  openSocket(q) {
    const mid = q.get("mission"), uid = q.get("id");
    const m = this.missions[mid];
    if (!m || (uid !== m.a && uid !== m.b)) notFound();
    const role = m.a === uid ? "a" : "b";
    for (const old of this.sockets(mid, role)) try { old.close(1000, "opened again"); } catch {}
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [mid, `${mid}:${role}`]);
    server.serializeAttachment({ mid, role });
    const { R } = this.roomFor(mid);
    server.send(JSON.stringify(this.snapshot(mid, role)));
    const o = other(role);
    if (m.ni?.[o]) server.send(JSON.stringify({ t: "ni", token: m.ni[o] }));   // the other phone's token, if sent before
    if (R.gps[o] && m.outcome === true) server.send(JSON.stringify(R.gps[o]));  // the other person's last known location (only once both said yes)
    this.broadcast(mid, { t: "presence", online: true }, role);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, data) {
    const at = ws.deserializeAttachment();
    if (!at || typeof data !== "string" || !this.missions[at.mid]) return;
    const { mid, role } = at;
    let d;
    try { d = JSON.parse(data); } catch { return; }
    const { m, R, bot } = this.roomFor(mid);
    if (d.t === "chat") {
      const text = str(d.text).slice(0, 500);
      if (!text) return;
      m.chat.push({ from: role, text, at: now() });
      this.save();
      this.broadcast(mid, { t: "chat", from: role, text }, role);
      if (bot) this.botReply(mid);
    } else if (d.t === "found") {      // they found each other (within 2 m, or I found them): both phones hear it at once
      if (m.outcome !== true) return;
      if (!m.found) { m.found = now(); this.save(); }
      this.broadcast(mid, { t: "found" });
    } else if (d.t === "ni") {         // Nearby Interaction token: relayed so the two iPhones can find each other
      if (m.found) return;             // (found: no more radio or location for this introduction)
      const token = String(d.token ?? "").slice(0, 4000);
      (m.ni ||= {})[role] = token;
      this.save();
      this.broadcast(mid, { t: "ni", token }, role);
    } else if (d.t === "gps") {        // web finding: share each person's filtered location with the other
      if (m.outcome !== true || m.found) return;  // only once both said yes, and not after they found each other
      const lat = parseFloat(d.lat), lon = parseFloat(d.lon), acc = d.acc == null ? 30 : parseFloat(d.acc);
      if (![lat, lon, acc].every(Number.isFinite)) return;
      R.gps[role] = { t: "gps", lat, lon, acc };
      this.broadcast(mid, R.gps[role], role);
    } else if (d.t === "hold") {       // the two keys: each holds their button, the bar fills only while both do
      R.hold[role] = !!d.on;
      this.broadcast(mid, { t: "hold", on: R.hold[role] }, role);
    } else if (d.t === "decide") {
      const yes = !!d.yes;
      if (bot && yes) sleep(2500).then(() => this.decide(mid, "b", true));
      this.decide(mid, role, yes);
    }
  }

  async webSocketClose(ws, code, reason) {
    const at = ws.deserializeAttachment();
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, reason); } catch {}
    if (!at) return;
    if (!this.sockets(at.mid, at.role).some(x => x !== ws)) {
      const R = this.rooms.get(at.mid);
      if (R?.hold?.[at.role]) { R.hold[at.role] = false; this.broadcast(at.mid, { t: "hold", on: false }); }   // gone: let go
      this.broadcast(at.mid, { t: "presence", online: false });
    }
  }

  async webSocketError(ws) { await this.webSocketClose(ws, 1011, "error"); }

  async suggest(d) {
    const m = this.missions[d.mission];
    if (!m || (d.id !== m.a && d.id !== m.b)) notFound();
    const role = m.a === d.id ? "a" : "b";
    const { m: mm } = this.roomFor(m.id);
    const me = this.person(d.id) || {}, them = this.person(m[other(role)]) || {};
    const names = { [role]: me.name || "Me", [other(role)]: them.name || "Them" };
    const chat = mm.chat.slice(-10).map(c => `${names[c.from]}: ${c.text}`).join("\n");
    const brief = p => JSON.stringify(Object.fromEntries(["name", "building", "needs", "offers"].map(k => [k, p[k] ?? null])));
    try {
      const out = await ask(this.env, M.fill(P.SUGGEST, { me: brief(me), them: brief(them), chat: chat || "(nothing yet)" }));
      return { ideas: (Array.isArray(out.ideas) ? out.ideas : []).map(String).slice(0, 2) };
    } catch (e) {
      console.log("suggest error:", String(e));
      return { ideas: [] };
    }
  }

  /** Emma playing a seed person in the chat. */
  async botReply(mid) {
    const { m, R, bot: b } = this.roomFor(mid);
    if (R.replying) return;
    R.replying = true;
    try {
      await sleep(1000);
      this.broadcast(mid, { t: "typing" });
      const them = this.person(m.a) || {};
      const chat = m.chat.slice(-12).map(c => `${c.from === "b" ? b.name : them.name || "Them"}: ${c.text}`).join("\n");
      const shared = (m.overlap?.rare || []).map(x => x.text || "").join("; ");
      const out = await ask(this.env, M.fill(P.CHATBOT, {
        name: b.name, role: b.role, building: b.building, needs: b.needs, offers: b.offers, shared, chat,
        them: JSON.stringify(Object.fromEntries(["name", "building", "needs", "offers"].map(k => [k, them[k] ?? null]))),
      }));
      const text = str(out.text);
      if (text) {
        m.chat.push({ from: "b", text, at: now() });
        this.save();
        this.broadcast(mid, { t: "chat", from: "b", text });
      }
    } catch (e) {
      console.log("chat error:", String(e));
    } finally {
      R.replying = false;
    }
  }

  // ---- voice ----------------------------------------------------------------------------------------------
  /** Only lines Emma could really say are voiced: her script, what she came up with lately, and the page's own
      lines about someone in the room. Anything else would spend the voice allowance on whatever anyone sends. */
  mayVoice(text) {
    if (this.said.has(text) || NUDGES.includes(text) || FILLERS.includes(text)) return true;
    if ([P.OPENER, P.THINKING, P.SCRIPT_BACK, ...Object.values(P.ASK), ...Object.values(P.SCRIPT_MUSE), ...P.SCRIPT_FALLBACK].includes(text)) return true;
    if (Object.values(this.users).some(u => u.back === text)) return true;
    const people = [...SEED, ...Object.values(this.users).filter(u => u.profile).map(u => this.person(u.id))];
    const firsts = new Set(people.map(p => firstName(p.name)));
    let g;
    if ((g = text.match(/^(?:Ooh\. (\S+) might be it\.|Psst\. I just introduced you to (\S+)\.|Meet (\S+)\. I think you two should talk\.)$/))) {
      return firsts.has(g[1] || g[2] || g[3]);
    }
    if ((g = text.match(/^You both said yes\. (\S+) is ?(.*)$/s))) return people.some(p => firstName(p.name) === g[1] && (p.spot || "") === g[2]);
    return false;
  }

  /** Whether one more new line may be voiced for this address: the room's daily allowance, then the address's. */
  async voiceBudget(ip) {
    const t = Date.now(), recent = (this.voicedBy.get(ip) || []).filter(x => t - x < 600_000);
    if (recent.length >= VOICE_PER_IP) { console.log("voice: per-address limit", ip); return false; }
    const day = "voice:" + new Date().toISOString().slice(0, 10);
    const used = (await this.ctx.storage.get(day)) || 0;
    if (used >= VOICE_DAILY) { console.log("voice: daily allowance used up"); return false; }
    await this.ctx.storage.put(day, used + 1);
    recent.push(t);
    this.voicedBy.set(ip, recent);
    if (this.voicedBy.size > 5000) this.voicedBy.clear();
    return true;
  }

  async speakLine(d, ip) {
    const text = str(d.text).slice(0, 600);
    if (!text) throw new HttpError(400, "Nothing to say.");
    if (!this.mayVoice(text)) throw new HttpError(403, "Emma doesn't say that.");
    const a = await speak(this.env, text, () => this.voiceBudget(ip));
    if (!a) throw new HttpError(429, "Emma's voice is resting. Her words are still on the screen.");
    return new Response(a.body, { headers: { "content-type": a.type, "cache-control": "no-store" } });
  }

  // ---- backups ----------------------------------------------------------------------------------------------
  exportAll() { return { users: this.users, missions: this.missions, stats: this.stats }; }

  importAll(d) {
    if (!isObj(d.users) || !isObj(d.missions)) throw new HttpError(400, "Expected {users, missions, stats}.");
    this.users = d.users;
    this.missions = d.missions;
    this.stats = { spoke: 0, intros: 0, met: 0, ...(isObj(d.stats) ? d.stats : {}) };
    this.pending.clear();
    this.scans.clear();
    this.save();
    return { users: Object.keys(this.users).length, missions: Object.keys(this.missions).length };
  }

  // ---- HTTP -------------------------------------------------------------------------------------------------
  async fetch(req) {
    const url = new URL(req.url), q = url.searchParams, path = url.pathname;
    const app = /PairShakeApp|RoomieApp/.test(req.headers.get("user-agent") || "");     // the iPhone app (WKWebView)
    try {
      if (req.method === "GET") {
        const you = q.get("id"), mine = data => json(this.outward(data, you));     // (other people's ids swapped for their stand-ins)
        switch (path) {
          case "/ws": return this.openSocket(q);
          case "/scan": return mine(this.scan(q));
          case "/me": return mine(this.me(q));
          case "/networks": return json(this.networksOf(q));
          case "/network": return mine(this.networkView(q));
          case "/events": return json(await this.events(q));
          case "/event": return mine(this.eventRoom(q));
          case "/inbox": return mine(this.inbox(q));
          case "/talk": return mine(await this.talk(q));
          case "/room": return json({ stats: this.stats, people: Object.values(this.users).filter(u => u.profile && !u.test).length, intros: Object.keys(this.missions).length });
          case "/admin/export": return json(this.exportAll());
        }
      } else if (req.method === "POST") {
        let d = {};
        try { d = await req.json(); } catch {}
        if (!isObj(d)) d = {};
        const mine = data => json(this.outward(data, d.id));
        switch (path) {
          case "/start": return json(await this.start(d, app));
          case "/turn": return json(await this.turn(d));
          case "/quick": return json(await this.quick(d, app));
          case "/onboard": return json(await this.onboard(d));
          case "/network/create": return json(await this.networkCreate(d));
          case "/network/live": return json(this.networkLive(d));
          case "/network/join": return json(this.networkJoin(d));
          case "/network/luma": return json(await this.networkLuma(d));
          case "/match": { const r = await this.match(d); return r instanceof Response ? r : mine(r); }
          case "/match/cancel": return json(this.cancel(d));
          case "/again": return json(this.again(d));
          case "/forget": return json(this.forget(d));
          case "/test/match": return json(this.testMatch(d, app));
          case "/account": return await this.account(d, app);
          case "/internal/login": return json(this.login(d, app));          // only from auth.js: index.js never forwards /internal
          case "/profile": return mine(this.profile(d));
          case "/event": return mine(await this.joinEvent(d));
          case "/feedback": return json(this.feedback(d));
          case "/suggest": return json(await this.suggest(d));
          case "/speak": return await this.speakLine(d, req.headers.get("cf-connecting-ip") || "?");
          case "/admin/import": return json(this.importAll(d));
        }
      }
      return json({ error: "Not found." }, 404);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.log("error", path, e && e.stack || String(e));
      return json({ error: "Something went wrong. Try again." }, 500);
    }
  }
}

function other(role) { return role === "a" ? "b" : "a"; }

function cleanOverlap(o) {
  const rare = (Array.isArray(o.rare) ? o.rare : []).filter(isObj).map(x => ({ text: String(x.text ?? ""), opener: String(x.opener ?? "") })).slice(0, 3);
  const strs = v => (Array.isArray(v) ? v : []).map(String).slice(0, 3);
  return {
    rare, you_only: strs(o.you_only), them_only: strs(o.them_only), give: String(o.give ?? ""), get: String(o.get ?? ""),
    ladder: strs(o.ladder), mission: String(o.mission ?? ""), recipe: String(o.recipe ?? ""),
  };
}

/** The overlap seen from one side: the match sees give/get and the two sides swapped. */
function overlapFor(o, mine) {
  return mine ? o : { ...o, you_only: o.them_only, them_only: o.you_only, give: o.get, get: o.give };
}
