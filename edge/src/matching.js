/* Roomie matching: who meets whom, and what gets the two of them talking.

   A match is a pair plus a spark. The pair is chosen here in code: who is free, who has met whom, who has
   had no introduction yet. How strongly two people pull comes from their agents' talks when there are any
   (the scan, the same talks the matching screen shows), else from the model rating a shortlist, else from
   the cards alone. The model then writes the spark. If the model fails, the code still pairs people and
   writes a plain spark, so there is always a match.

     const room = new Room(people, missions)        // people: profile objects, missions: [{a, b, outcome, created, demo}]
     const who = shortlist(room, myId, ids, k)      // whom my agent should talk to: the k most worth it
     const p = await pick(room, myId, llm, fits)    // fits: {id: 0-100} from the agents' talks
     const s = await spark(room, [a, b], recipe, llm, talk)

   `llm` is any `async (prompt) => object`. A port of server/matching.py. */

export const RECIPES = {
  useful: "one of them needs what the other can give",
  twin: "they share something rare that few people in the room have",
  pain: "they have the same frustration and can complain about it together",
  clash: "they would disagree, in a friendly way, about something low-stakes",
  wildcard: "no obvious link: they get a small mission to find out what they share",
};
const TINY = 5;          // up to this many candidates: everyone meets everyone in turn
const BIG = 40;          // above this the model only sees a shortlist, and some matches are wildcards
const SHORT = 8;         // shortlist size
const MAX_OPEN = 2;      // open introductions one person can hold at a time
const WILD = 0.25;       // share of wildcard matches in a big room
const SCAN = 8;          // how many people one attendee's agent talks to
const STRONG = 60;       // an agents' verdict this high is never passed over for a wildcard
const UNWANTED = 8;      // taken off a pair's card score when one said they'd rather not meet people like the other
const OPEN_FOR = 1200;   // seconds an unanswered introduction keeps someone busy; after that they count as free

const STOP = new Set(`a an and the of to in on at for with from by is are was be been it its this that these those i me my
we our you your they them their he she his her as or but not no so if than then too very just also can could will
would should has have had do does did who what when where how why which there here all any some one two more most
into about over out up down off need needs want wants looking look help helps make makes making made build builds
building built get gets got give gives use uses using work works working someone anyone people person thing things
good great real really right now yet still every each other others own way lot much many new first agent agents ai
hackathon athens`.split(/\s+/));

/** Random numbers; seeded (for tests) or not. */
export function makeRng(seed) {
  let s = seed == null ? null : seed >>> 0;
  const random = s == null ? Math.random : () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    random,
    choice: a => a[Math.floor(random() * a.length)],
    sample(a, k) {
      const c = [...a];
      for (let i = c.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [c[i], c[j]] = [c[j], c[i]]; }
      return c.slice(0, k);
    },
  };
}

/** Sort by a key that returns an array, compared item by item (like Python's tuple keys). */
export function sortBy(a, key) {
  const keyed = a.map(x => [key(x), x]);
  keyed.sort((p, q) => {
    for (let i = 0; i < p[0].length; i++) if (p[0][i] !== q[0][i]) return p[0][i] < q[0][i] ? -1 : 1;
    return 0;
  });
  return keyed.map(k => k[1]);
}
const maxBy = (a, key) => sortBy(a, x => key(x).map(v => -v))[0];
const minBy = (a, key) => sortBy(a, key)[0];

const pair = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function stem(w) {
  for (const suf of ["ers", "er", "ing", "ed", "s"]) if (w.endsWith(suf) && w.length - suf.length >= 4) return w.slice(0, -suf.length);
  return w;
}

function toks(...texts) {
  const out = new Set();
  for (let t of texts) {
    if (Array.isArray(t)) t = t.map(String).join(" ");
    for (const w of String(t || "").toLowerCase().match(/[a-z][a-z0-9+#-]{2,}/g) || []) if (!STOP.has(w)) out.add(stem(w));
  }
  return out;
}
const inter = (a, b) => [...a].filter(x => b.has(x));

export const first = p => String(p.name || "them").split(/\s+/)[0];

export function card(p) {
  const out = {};
  for (const k of ["id", "name", "role", "building", "needs", "offers", "hooks", "avoid"]) {
    const v = p[k];
    if (v && !(Array.isArray(v) && !v.length)) out[k] = v;
  }
  return out;
}

export function int(v, d) {
  const n = Math.trunc(parseFloat(v));
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : d;
}

export class Room {
  constructor(people, missions = [], rng) {
    this.people = {};
    this.rng = rng || makeRng();
    this.met = new Set();         // pair(a, b) for every introduction made
    this.open = {};               // id -> introductions not answered yet
    this.intros = {};             // id -> introductions ever
    for (const p of people) this.people[p.id] = p;
    this.index();
    const now = Date.now() / 1000;
    for (const m of missions) {
      if (m.demo) { this.met.add(pair(m.a, m.b)); continue; }    // met a demo attendee: not again, but it isn't an introduction
      this.record(m.a, m.b, m.outcome == null && now - (m.created ?? now) < OPEN_FOR);
    }
  }

  index() {
    this.ix = {};
    this.df = {};
    for (const [pid, p] of Object.entries(this.people)) {
      const e = { about: toks(p.role, p.building, p.line, p.hooks), needs: toks(p.needs), offers: toks(p.offers), avoid: toks(p.avoid) };
      this.ix[pid] = e;
      for (const t of new Set([...e.about, ...e.needs, ...e.offers])) this.df[t] = (this.df[t] || 0) + 1;
    }
  }

  /** Rare words weigh more: a thing two people share and nobody else has is worth the most. */
  idf(t) { return Math.log(1 + Object.keys(this.people).length / Math.max(1, this.df[t] || 1)); }

  record(a, b, open = true) {
    this.met.add(pair(a, b));
    for (const x of [a, b]) {
      this.intros[x] = (this.intros[x] || 0) + 1;
      if (open) this.open[x] = (this.open[x] || 0) + 1;
    }
  }

  /** Someone new who is free; else someone new; else anyone. Empty only when the room is empty. */
  candidates(me) {
    const others = Object.keys(this.people).filter(i => i !== me);
    const fresh = others.filter(i => !this.met.has(pair(me, i)));
    const free = fresh.filter(i => (this.open[i] || 0) < MAX_OPEN);
    return free.length ? free : fresh.length ? fresh : others;
  }

  links(a, b) {
    const A = this.ix[a], B = this.ix[b];
    const w = ts => ts.reduce((s, t) => s + this.idf(t), 0);
    const get = inter(A.needs, B.offers), give = inter(B.needs, A.offers);
    const useful = (w(get) + w(give)) * (get.length && give.length ? 1.5 : 1);
    const shared = inter(A.about, B.about);
    const twin = w(shared);
    const recipe = useful && useful >= twin ? "useful" : twin ? "twin" : "wildcard";
    // one of them said they'd rather not meet people like the other
    const unwanted = inter(A.avoid, B.about).length > 0 || inter(B.avoid, A.about).length > 0;
    return {
      score: useful + 0.8 * twin - (unwanted ? UNWANTED : 0), unwanted, recipe, get: get.sort(), give: give.sort(),
      shared: sortBy(shared, t => [-this.idf(t)]).slice(0, 4),
    };
  }

  /** People with no introduction yet come first; busy people and demo attendees come last. */
  fair(pid) {
    const p = this.people[pid];
    return (this.intros[pid] ? 0 : 12) - 15 * (this.open[pid] || 0) - (p.seed ? 20 : 0);
  }
}

/** Whom `me`'s agent should talk to: the `k` most worth it among `ids` (default: everyone they could meet), by
    their cards and the same fairness as pick(). When there are more than `k`, the last two are drawn from further
    down so it never closes up. */
export function shortlist(room, me, ids, k = SCAN) {
  const rng = room.rng;
  ids = (ids || room.candidates(me)).filter(i => i !== me && room.people[i]);
  const rank = sortBy(ids, c => [-(room.links(me, c).score + room.fair(c) / 4), rng.random()]);
  if (rank.length <= k || k < 4) return rank.slice(0, k);
  return [...rank.slice(0, k - 2), ...rng.sample(rank.slice(k - 2), 2)];
}

const RATE = `You are Emma, the matchmaker at a hackathon. Your job is not to find the most similar person. It is to
find the pairing most likely to make two strangers walk over and have a conversation they enjoy.

The attendee:
{me}

People they could meet:
{pool}

Ways two people can be worth introducing:
{recipes}

Choose the {k} people who would make the best conversation with the attendee. For each, name the way
(one of: {names}) and how strong the pull is, 0-100. A rare shared detail or a real two-way need beats a
generic shared topic. Use "wildcard" only when nothing else fits. If the attendee's card says whom to
"avoid", leave those people out.

Reply with JSON only: {"picks": [{"id": "...", "recipe": "...", "pull": 0}]}`;

const SPARK = `You are Emma, the matchmaker at the Gen AI Summit Hackathon in Athens, introducing {n} strangers.
Talk like a friend who is plotting something, never like a system: no scores, no percentages, no "match",
no "compatible", no praise words (amazing, great, perfect, love). Plain spoken English with contractions.

{people}

Why these people ({recipe}): {why}
Hints from their cards (use only if they are real and interesting): {hints}
{talk}`;

// The spark is written in two halves at the same time: one call for all of it took twice as long.
const SPARK_WORDS = `
Write:
- "recipe": keep "{recipe}", or switch to one of {names} if it clearly fits better.
- "teases": for each person, one line Emma says to THEM about the other(s). Give half the story: the
  other person's first name and one specific thing to ask them about, and leave the reason for them to
  find out. Under 22 words. Second person.
- "mission": one small thing they do together in two minutes, concrete and a little playful, tied to
  who they are. Under 20 words.
- "say": what Emma says aloud to the first person when revealing it, the way a friend points someone
  out at a party: the other's first name and what they do, what they're building in a few concrete
  words, and why the two of you should talk (what you get, what you give). Two or three short spoken
  sentences, 25 to 45 words, no lists. Don't use the first person's name. Never say where anyone is
  ("over there", a row, a seat).

Reply with JSON only:
{"recipe": "...", "teases": {{ids}}, "mission": "...", "say": "..."}`;

const SPARK_SCREEN = `
Write:
- "ladder": three questions they could ask each other, light, then real, then deep, about their
  actual lives and projects, never generic icebreakers.
- "share": for the screen the first two see once they start talking. "rare": two or three specific
  things they have in common that few others in the room would (under 9 words each; skip the obvious,
  like "you both like AI"), each with an "opener", a question the first person could send to start on
  it (under 18 words). "first_only" and "second_only": two short tags (2-4 words) true of one and not
  the other. "give": what the first can give the second, "get": what the second can give the first
  (under 10 words each).

Reply with JSON only:
{"ladder": ["...", "...", "..."],
 "share": {"rare": [{"text": "...", "opener": "..."}], "first_only": ["..."], "second_only": ["..."],
           "give": "...", "get": "..."}}`;

export const PROFILE = `Below is what one hackathon attendee told Emma: a voice chat (speech recognition, so some words
come out garbled; take the obvious meaning), or a write-up about them that they pasted in. If it starts
with what Emma remembers from last time, keep all of that unless they changed it. Write their profile in
short plain sentences, in English whatever language they spoke, only from what is there. Leave a field ""
if they didn't say it, except "offers": if they didn't say what they can help with, write what their work
plainly shows (an iOS developer can help with iOS apps), and nothing beyond that.

{convo}

"hooks" are the odd, specific, human details that would make a stranger curious (a past job, a hobby,
a strong opinion, something they brought with them). Up to three, each under 10 words, never generic,
and none at all if nothing like that came up.
"avoid" is who would waste their time, only if they said so.

Reply with JSON only: {"name": "...", "role": "3-6 words", "building": "...", "needs": "...",
"offers": "...", "spot": "...", "line": "one memorable sentence about them, third person",
"hooks": ["..."], "avoid": "..."}`;

/** Fills {name} placeholders; anything else in braces (the JSON examples) is left alone. */
export function fill(t, kw) {
  return t.replace(/\{(\w+)\}/g, (m, k) => (k in kw ? String(kw[k]) : m));
}

const str = v => (v == null ? "" : String(v)).trim();

export async function profile(convo, llm) {
  const p = await llm(fill(PROFILE, { convo }));
  const out = {};
  for (const k of ["name", "role", "building", "needs", "offers", "spot", "line", "avoid"]) out[k] = str(p[k]);
  out.hooks = (Array.isArray(p.hooks) ? p.hooks : []).map(str).filter(Boolean).slice(0, 3);
  return out;
}

/** Who `me` should meet next: {a, b, recipe, mode, by}; null only when nobody else is in the room. `fits` is
    what the agents concluded, {id: 0-100}; with it the model isn't asked to rate again. */
export async function pick(room, me, llm, fits) {
  const cands = room.candidates(me);
  if (!cands.length) return null;
  const rng = room.rng, n = cands.length;
  const links = Object.fromEntries(cands.map(c => [c, room.links(me, c)]));
  fits = Object.fromEntries(Object.entries(fits || {}).filter(([c]) => c in links).map(([c, v]) => [c, int(v, 50)]));
  const hasFits = Object.keys(fits).length > 0;
  let by = hasFits ? "agents" : "cards";
  const cards = Object.fromEntries(cands.map(c => [c, Math.max(0, Math.min(100, 20 + 8 * links[c].score)) - (links[c].unwanted ? 40 : 0)]));
  // the agents' verdict where they talked, steadied by the cards (one verdict is one opinion: a few points either
  // way shouldn't decide it); else the cards, a little lower when others were looked at closely
  let pulls = Object.fromEntries(cands.map(c => [c, [
    c in fits ? 0.8 * fits[c] + 0.2 * cards[c] : cards[c] - (hasFits ? 10 : 0),
    (fits[c] || 0) >= STRONG && links[c].recipe === "wildcard" ? "useful" : links[c].recipe,
  ]]));
  if (n <= TINY) {                                  // a few people: go round, least-introduced first
    const b = minBy(cands, c => [room.intros[c] || 0, -pulls[c][0], rng.random()]);
    return { a: me, b, recipe: pulls[b][1], mode: "tiny", by };
  }
  const strong = hasFits && Math.max(...Object.values(fits)) >= STRONG;
  if (n > BIG && !strong && rng.random() < WILD) {  // a big room: now and then, someone unexpected
    const quiet = sortBy(cands, c => [room.intros[c] || 0, rng.random()]).slice(0, Math.max(4, Math.floor(n / 4)));
    return { a: me, b: rng.choice(quiet), recipe: "wildcard", mode: "wildcard", by: "chance" };
  }
  let pool = cands;
  const mode = n <= BIG ? "room" : "big";
  if (llm && !hasFits) {
    if (n > BIG) {                                  // the best by profile, plus two the profile would never suggest
      const ranked = sortBy(cands, c => [-links[c].score]);
      pool = [...ranked.slice(0, SHORT - 2), ...rng.sample(ranked.slice(SHORT - 2), 2)];
    }
    try {
      const r = await llm(fill(RATE, {
        me: JSON.stringify(card(room.people[me])),
        pool: JSON.stringify(pool.map(c => card(room.people[c]))),
        recipes: Object.entries(RECIPES).map(([k, v]) => `- ${k}: ${v}`).join("\n"),
        names: Object.keys(RECIPES).join(", "), k: Math.min(5, pool.length),
      }));
      const rated = {};
      for (const x of Array.isArray(r.picks) ? r.picks : []) {
        const c = x && String(x.id);
        if (!x || typeof x !== "object" || !pool.includes(c)) continue;    // ids the model made up are dropped
        rated[c] = [int(x.pull, 50), x.recipe in RECIPES ? x.recipe : links[c].recipe];
      }
      if (Object.keys(rated).length) { pulls = rated; pool = Object.keys(rated); by = "model"; }
    } catch (e) {
      console.log("rate error:", String(e));
    }
  }
  const b = maxBy(pool, c => [pulls[c][0] + room.fair(c), rng.random()]);
  return { a: me, b, recipe: pulls[b][1], mode, by: b in fits ? "agents" : by };
}

/** The spark when the model is unavailable: still a name, something to ask, and a mission. */
export function plainSpark(people, recipe) {
  const teases = {};
  for (const p of people) {
    const o = people.find(x => x !== p);
    const ask = (o.hooks && o.hooks.length ? o.hooks : [o.building || "what they're building"])[0];
    teases[p.id] = `Go find ${first(o)} and ask about this: ${ask}`;
  }
  const ladder = ["What are you building this weekend?", "What part of it are you stuck on?",
    "What made you care about this problem in the first place?"];
  return {
    recipe, teases, ladder,
    mission: "Two minutes: find three things you share that nobody else in the room does.",
    say: people.slice(1).map(p => `I want you to meet ${first(p)}.` + (p.role ? ` ${p.role}.` : "")).join(" "),
    share: { rare: [{ text: "Something you two share. Find it.", opener: ladder[0] }], first_only: [], second_only: [], give: "", get: "" },
  };
}

/** What gets them talking. `talk` is the agents' exchange about the first two, {ask, reply}. */
export async function spark(room, ids, recipe, llm, talk) {
  const people = ids.map(i => room.people[i]);
  const out = plainSpark(people, recipe);
  if (!llm) return out;
  const ln = room.links(ids[0], ids[1]);
  const hints = { "shared words": ln.shared, [`${first(people[0])} could get`]: ln.get, [`${first(people[0])} could give`]: ln.give };
  const kw = {
    n: people.length, recipe, why: RECIPES[recipe], names: Object.keys(RECIPES).join(", "),
    people: people.map(p => JSON.stringify(card(p))).join("\n"), hints: JSON.stringify(hints),
    talk: talk && talk.ask ? `Their agents already talked. ${first(people[0])}'s asked: "${talk.ask}" ${first(people[1])}'s answered: "${talk.reply || ""}"\n` : "",
    ids: ids.map(i => `"${i}": "..."`).join(", "),
  };
  const half = async prompt => {                    // a half that fails keeps its plain version
    try {
      const r = await llm(fill(SPARK + prompt, kw));
      return r && typeof r === "object" ? r : {};
    } catch (e) {
      console.log("spark error:", String(e));
      return {};
    }
  };
  const r = Object.assign({}, ...(await Promise.all([half(SPARK_WORDS), half(SPARK_SCREEN)])));
  const teases = r.teases && typeof r.teases === "object" ? r.teases : {};
  for (const i of ids) if (str(teases[i])) out.teases[i] = str(teases[i]);    // a missing line keeps the plain one
  if (r.recipe in RECIPES) out.recipe = r.recipe;
  for (const k of ["mission", "say"]) if (str(r[k])) out[k] = str(r[k]);
  const ladder = (Array.isArray(r.ladder) ? r.ladder : []).map(str).filter(Boolean).slice(0, 3);
  if (ladder.length === 3) out.ladder = ladder;
  const sh = r.share && typeof r.share === "object" ? r.share : {};
  const rare = (Array.isArray(sh.rare) ? sh.rare : []).filter(x => x && typeof x === "object" && str(x.text))
    .map(x => ({ text: str(x.text), opener: str(x.opener) })).slice(0, 3);
  if (rare.length) {
    const tags = v => (Array.isArray(v) ? v : []).map(str).filter(Boolean).slice(0, 2);
    out.share = { rare, first_only: tags(sh.first_only), second_only: tags(sh.second_only), give: str(sh.give), get: str(sh.get) };
  }
  return out;
}
