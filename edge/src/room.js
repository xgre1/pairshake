/* The room: one Durable Object that is the whole of PairShake's server. Emma interviews each attendee, finds the
   one person in the room they should meet, and gives both of them an icebreaker mission instead of a DM.

   Everyone and every introduction is kept in D1 (the `users` and `missions` tables), loaded when the room
   starts and written through after each change, so it survives restarts and deploys. What only matters for a few
   seconds (a match being worked out, the agents' talks, who is waiting for a test match) is kept in memory.
   The rooms' WebSockets use hibernation: an open chat costs nothing while nobody types.

   A port of the first, Python server; the API is the same (docs/api.md). */
import { DurableObject } from "cloudflare:workers";
import * as M from "./matching.js";
import * as P from "./prompts.js";
import { ask, QUICK, MAIN } from "./llm.js";
import { speak } from "./voice.js";

const MAX_TURNS = 3;          // the chat is only there to get to an introduction: at most two questions after the opener
// Testing (on for now): Emma follows one fixed script, so every line is voiced once and then always comes from
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
const sleep = ms => new Promise(r => setTimeout(r, ms));
const str = v => (v == null ? "" : String(v)).trim();
const firstName = n => String(n || "").split(/\s+/)[0];
const isObj = v => v && typeof v === "object" && !Array.isArray(v);
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
    this.scans = new Map();   // user id -> {talks, total, sent, closed, muse}: one agent-to-agent talk per attendee
    this.claims = [];         // pairs just chosen whose introduction isn't made yet
    this.talkTasks = new Map();
    this.testWait = new Map();
    this.loginFails = new Map();
    this.rooms = new Map();   // mission id -> what a room keeps only in memory: {gps, replying}
    this.said = new Set();    // lines Emma came up with lately: the only new lines /speak will voice
    this.voicedBy = new Map();// address -> times it had a new line voiced, in the last ten minutes
    this.agentsTurns = new Turns(12);
    this.flushing = Promise.resolve();
    ctx.blockConcurrencyWhile(() => this.load());
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
      if (s) puts.push(db.prepare(`INSERT INTO users (id, email, name, app, test, has_profile, created_at, updated_at, data)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8) ON CONFLICT(id) DO UPDATE SET email = ?2, name = ?3, app = ?4, test = ?5,
        has_profile = ?6, updated_at = ?7, data = ?8`).bind(id, u.email || null, u.name || null, u.app ? 1 : 0, u.test ? 1 : 0, u.profile ? 1 : 0, t, s));
    }
    for (const [id, m] of Object.entries(this.missions)) {
      const s = changed("m:" + id, m);
      if (s) puts.push(db.prepare(`INSERT INTO missions (id, a, b, outcome, created_at, updated_at, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT(id) DO UPDATE SET a = ?2, b = ?3, outcome = ?4, updated_at = ?6, data = ?7`)
        .bind(id, m.a, m.b, m.outcome == null ? null : m.outcome ? 1 : 0, m.created || t, t, s));
    }
    const s = changed("meta:stats", this.stats);
    if (s) puts.push(db.prepare("INSERT INTO meta (key, value) VALUES ('stats', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(s));
    const gone = [...this.written.keys()].filter(k => !live.has(k));
    for (const k of gone) dels.push(db.prepare(`DELETE FROM ${k[0] === "u" ? "users" : "missions"} WHERE id = ?1`).bind(k.slice(2)));
    const all = [...dels, ...puts];             // deletes first: a deleted account's email may be signed up again
    for (let i = 0; i < all.length; i += 100) await db.batch(all.slice(i, i + 100));
    for (const [k, v] of done) this.written.set(k, v);
    for (const k of gone) this.written.delete(k);
  }

  // ---- people ---------------------------------------------------------------------------------------------
  /** Public card for anyone in the room, seed or real. */
  person(pid) {
    const s = SEED_BY_ID[pid];
    if (s) {
      const o = {};
      for (const k of ["id", "name", "role", "color", "building", "needs", "offers", "spot", "line", "socials"]) o[k] = s[k];
      return { ...o, seed: true };
    }
    const u = this.users[pid];
    if (!u) return null;
    const p = u.profile || {};
    return {
      id: pid, name: u.name || p.name || "Someone", role: p.role || "", color: u.color, building: p.building || "",
      needs: p.needs || "", offers: p.offers || "", spot: p.spot || "", line: p.line || "", hooks: p.hooks || [],
      socials: u.socials || {}, photo: u.photo || "",
    };
  }

  /** Who an attendee can meet. The iPhone app and the web page are separate rooms (so phones can find each
      other by Ultra Wideband); Emma's demo attendees are in both. */
  candidates(exclude, app = false, seeds = true) {
    const out = seeds ? SEED.map(s => this.person(s.id)) : [];
    for (const [uid, u] of Object.entries(this.users)) {
      if (uid !== exclude && u.profile && !!u.app === app && !u.test) out.push(this.person(uid));
    }
    return out;
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
      this.beginMatch(u);         // think while Emma talks
    }
    this.said.add(say);
    this.save();
    return { say, done: !!out.done };
  }

  /** No talking: the attendee asked ChatGPT, which already knows them, to answer Emma's questions and pasted its
      answer here. It stands in for the voice chat, and the matching starts at once. */
  async quick(d, app) {
    const text = str(d.text).slice(0, 6000);
    if (text.length < 40) throw new HttpError(400, "That's too short. Paste ChatGPT's whole answer.");
    const spot = str(d.spot).slice(0, 200);
    const u = this.user(d.id) || this.newUser(app);
    if (u.profile) u.memory = { ...u.profile };     // someone Emma knows: anything ChatGPT doesn't mention stays
    const transcript = [["emma", P.QUICK_ASK], ["you", P.QUICK_NOTE + text]];
    if (spot) transcript.push(["emma", "And where are you in the room?"], ["you", spot]);
    Object.assign(u, { transcript, turns: 0, known: {}, via: "chatgpt" });
    delete u.cancelled;
    this.scans.delete(u.id);
    this.beginMatch(u);           // think while they add their handles
    this.save();
    return { id: u.id, code: u.code, say: P.THINKING };
  }

  beginMatch(u) {
    const p = this.runMatch(u);
    p.catch(() => {});            // (whoever awaits it later sees the error)
    this.pending.set(u.id, p);
    this.startScan(u);
  }

  // ---- matching -------------------------------------------------------------------------------------------
  async match(d) {
    const u = this.user(d.id) || notFound();
    u.socials = {};
    for (const [k, v] of Object.entries(isObj(d.socials) ? d.socials : {})) if (str(v)) u.socials[k.slice(0, 20)] = str(v).replace(/^@+/, "").slice(0, 100);
    delete u.cancelled;
    const task = this.pending.get(u.id) || this.runMatch(u);
    this.pending.delete(u.id);
    let r, room;
    try {
      [r, room] = await task;
    } catch (e) {
      console.log("match error:", String(e));
      throw new HttpError(502, String(e.message || e));
    }
    if (u.cancelled) { delete u.cancelled; return json({ cancelled: true }, 409); }    // they stopped looking meanwhile
    u.profile = r.me || u.profile || {};
    u.name = u.profile.name || u.name;
    const them = this.person(r.match_id) || room[0];
    const mid = hexId(8);
    this.missions[mid] = {
      id: mid, a: u.id, b: them.id, intro_a: r.intro_me || "", intro_b: r.intro_them || "",
      overlap: cleanOverlap(r.overlap || {}), created: now(), outcome: null,
    };
    u.match = mid;
    this.agentTalk(mid).catch(e => console.log("talk error:", String(e)));    // agents talk while Emma reveals the match
    this.prepareBack(u).catch(e => console.log("back error:", String(e)));    // and her greeting for next time is written
    this.stats.spoke++;
    this.stats.intros++;
    if (this.users[them.id]) this.users[them.id].inbox.push(mid);            // a real person: their phone gets it too
    this.save();
    const say = SCRIPT ? scriptReveal(them) : r.say || "";
    this.said.add(say);
    return { say, me: this.person(u.id), mission: this.missionFor(mid, u.id) };
  }

  /** What Emma says while she looks (written as the search starts, voiced before the page asks for it). */
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
      matching. A talk still waiting for its turn when the match is made, or after 7 seconds, is dropped. */
  sendAgents(u, me, R, room) {
    const state = this.scans.get(u.id);
    if (state.sent) return state;
    const busy = [...this.scans.values()].filter(st => st.sent && !st.closed).length;
    const who = M.shortlist(R, u.id, room.map(p => p.id), !busy ? 8 : busy < 5 ? 4 : 3);
    state.total = who.length;
    state.sent = now();
    const mine = JSON.stringify(M.card(me));
    const one = async (rank, pid) => {
      const p = R.people[pid];
      const other = {};
      for (const k of ["role", "building", "needs", "offers", "hooks", "avoid"]) if (p[k] && !(Array.isArray(p[k]) && !p[k].length)) other[k] = p[k];
      try {
        await this.agentsTurns.take(rank);
        let out;
        try {
          if (state.closed || now() - state.sent > 7) throw new Error("no longer needed");
          out = await ask(this.env, M.fill(P.SCAN, { me: mine, convo: this.convo(u), name: p.name, first: firstName(p.name), other: JSON.stringify(other) }), { timeout: 30 });
        } finally {
          this.agentsTurns.give();
        }
        state.talks.push({ person: this.person(pid), ask: String(out.ask ?? ""), reply: String(out.reply ?? ""), fit: M.int(out.fit, 30) });
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

  /** A card plus what only matching may know: whom they'd rather not meet. */
  private(p) {
    const avoid = this.users[p.id]?.profile?.avoid;
    return avoid ? { ...p, avoid } : p;
  }

  /** Who they meet (matching.js): their profile, the agents' verdicts, the pair, then the spark. */
  async runMatch(u) {
    const t0 = now();
    this.startScan(u);
    const state = this.scans.get(u.id);
    let p, s, talks = {}, t1 = t0, t2 = t0, me, room;
    try {
      const app = !!u.app;
      // on the app: another app user if there is one; always someone new (unless they've met everyone)
      const seen = this.met(u.id);
      const fresh = ps => ps.filter(x => !seen.has(x.id));
      room = (app && fresh(this.candidates(u.id, true, false))) || [];
      if (!room.length) room = fresh(this.candidates(u.id, app));
      if (!room.length) room = this.candidates(u.id, app);
      if (!room.length) throw new Error("nobody else in the room");
      try {
        me = await M.profile(this.convo(u), prompt => ask(this.env, prompt, { timeout: 15 }));
      } catch (e) {               // the chat already gave Emma the basics
        console.log("profile error:", String(e));
        me = Object.fromEntries(Object.entries(u.known || {}).filter(([, v]) => v).map(([k, v]) => [k, String(v)]));
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
      this.sendAgents(u, me, R, room);
      talks = await this.verdicts(state, t1);
      t2 = now();
      // people matching at the same moment see each other's choices, so they don't all pick one person
      this.claims = this.claims.filter(c => t2 - c.created < 90);
      for (const c of this.claims) R.record(c.a, c.b);
      p = await M.pick(R, u.id, null, Object.fromEntries(Object.entries(talks).map(([i, t]) => [i, t.fit])));
      state.closed = true;
      if (this.users[p.b]) this.claims.push({ a: u.id, b: p.b, outcome: null, created: now() });
      s = await M.spark(R, [u.id, p.b], p.recipe, prompt => ask(this.env, prompt, { model: MAIN }), talks[p.b]);
    } finally {
      state.closed = true;
    }
    console.log(`match ${u.id} -> ${p.b}: ${s.recipe}, ${p.mode}, by ${p.by}, ${Object.keys(talks).length}/${state.total} talks, ` +
      `profile ${(t1 - t0).toFixed(1)} s, agents ${(t2 - t1).toFixed(1)} s, spark ${(now() - t2).toFixed(1)} s`);
    const sh = s.share;
    const note = pid => `${s.teases[pid]} Your mission together: ${s.mission}`;
    delete me.id;
    return [{
      me, match_id: p.b, intro_me: note(u.id), intro_them: note(p.b), say: s.say,
      overlap: { rare: sh.rare, you_only: sh.first_only, them_only: sh.second_only, give: sh.give, get: sh.get, ladder: s.ladder, mission: s.mission, recipe: s.recipe },
    }, room];
  }

  scan(q) {
    const u = this.user(q.get("id")) || notFound();
    this.startScan(u);
    const st = this.scans.get(u.id);
    return { talks: st.talks, total: st.total, muse: st.muse };
  }

  again(d) {
    const u = this.user(d.id);
    if (!u || !u.profile) notFound();
    this.scans.delete(u.id);
    this.beginMatch(u);
    return { ok: true };
  }

  cancel(d) {
    const u = this.user(d.id);
    if (u) { u.cancelled = true; this.scans.delete(u.id); }
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
      contacts.push({ ...mf, you: m.a === u.id ? "a" : "b", chat: chat.slice(-30), at: Math.max(m.created || 0, ...chat.map(c => c.at || 0)) });
    }
    contacts.sort((x, y) => y.at - x.at);
    return { me: u.profile ? this.person(u.id) : null, socials: u.socials || {}, contacts, email: u.email || null, name: u.name,
             photo: u.photo || "", linkedin: !!u.linkedin, google: !!u.google, signed: !!(u.linkedin || u.google || u.email) };
  }

  missionFor(mid, viewer) {
    const m = this.missions[mid];
    const mine = m.a === viewer;
    return {
      id: mid, intro: mine ? m.intro_a : m.intro_b, overlap: overlapFor(m.overlap || cleanOverlap({}), mine),
      person: this.person(mine ? m.b : m.a), outcome: m.outcome ?? null,
    };
  }

  inbox(q) {
    const u = this.user(q.get("id")) || notFound();
    return { missions: u.inbox.filter(mid => this.missions[mid]).map(mid => this.missionFor(mid, u.id)) };
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
    let mid = u.test_mid;                    // the other phone tapped first and matched us
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
    if (action === "delete") {               // everything about this person goes
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
    if (isObj(d.socials)) {
      u.socials = {};
      for (const [k, v] of Object.entries(d.socials)) if (["x", "instagram", "linkedin", "github"].includes(k) && str(v)) u.socials[k] = str(v).replace(/^@+/, "").slice(0, 100);
    }
    if (isObj(d.about) && u.profile) {       // what Emma remembers, fixed by hand
      for (const k of ["needs", "building", "offers", "role", "line", "spot"]) if (k in d.about) u.profile[k] = str(d.about[k]).slice(0, 400);
      delete u.back;                         // her welcome-back line was about the old one
    }
    const name = str(d.name).slice(0, 80);
    if (name) { u.name = name; if (u.profile) u.profile.name = name; }
    this.save();
    return { me: u.profile ? this.person(u.id) : null, socials: u.socials, name: u.name, email: u.email || null };
  }

  // ---- the room: see what you share, chat, then each decides whether to meet ----------------------------------
  // Seed people are played by Emma: she chats and decides for them.
  roomFor(mid) {
    if (!this.rooms.has(mid)) this.rooms.set(mid, { gps: {}, replying: false });
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
    return { t: "state", you: role, chat: m.chat, decided: role in m.decide, meet: m.outcome ?? null, online: this.sockets(mid, other(role)).length > 0 || !!bot };
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
    if (R.gps[o]) server.send(JSON.stringify(R.gps[o]));                       // the other person's last known location
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
    } else if (d.t === "ni") {         // Nearby Interaction token: relayed so the two iPhones can find each other
      const token = String(d.token ?? "").slice(0, 4000);
      (m.ni ||= {})[role] = token;
      this.save();
      this.broadcast(mid, { t: "ni", token }, role);
    } else if (d.t === "gps") {        // web finding: share each person's filtered location with the other
      const lat = parseFloat(d.lat), lon = parseFloat(d.lon), acc = d.acc == null ? 30 : parseFloat(d.acc);
      if (![lat, lon, acc].every(Number.isFinite)) return;
      R.gps[role] = { t: "gps", lat, lon, acc };
      this.broadcast(mid, R.gps[role], role);
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
    if (!this.sockets(at.mid, at.role).some(x => x !== ws)) this.broadcast(at.mid, { t: "presence", online: false });
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
    const app = (req.headers.get("user-agent") || "").includes("RoomieApp");     // the iPhone app (WKWebView)
    try {
      if (req.method === "GET") {
        switch (path) {
          case "/ws": return this.openSocket(q);
          case "/scan": return json(this.scan(q));
          case "/me": return json(this.me(q));
          case "/inbox": return json(this.inbox(q));
          case "/talk": return json(await this.talk(q));
          case "/room": return json({ stats: this.stats, people: SEED.length + Object.values(this.users).filter(u => u.profile).length, intros: Object.keys(this.missions).length });
          case "/admin/export": return json(this.exportAll());
        }
      } else if (req.method === "POST") {
        let d = {};
        try { d = await req.json(); } catch {}
        if (!isObj(d)) d = {};
        switch (path) {
          case "/start": return json(await this.start(d, app));
          case "/turn": return json(await this.turn(d));
          case "/quick": return json(await this.quick(d, app));
          case "/match": { const r = await this.match(d); return r instanceof Response ? r : json(r); }
          case "/match/cancel": return json(this.cancel(d));
          case "/again": return json(this.again(d));
          case "/test/match": return json(this.testMatch(d, app));
          case "/account": return await this.account(d, app);
          case "/internal/login": return json(this.login(d, app));          // only from auth.js: index.js never forwards /internal
          case "/profile": return json(this.profile(d));
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
