/* Matching: who meets whom, and what gets the two of them talking.

   A match is a pair plus a spark. The pair is chosen here in code: who is free, who has met whom, who has
   had no introduction yet. How strongly two people pull comes from the judge's stored answers about the
   pair (judge, rate: below), else from their agents' talks, else from the cards alone. The model then writes
   the spark. If the model fails, the code still pairs people and writes a plain spark, so there is always a
   match.

     const room = new Room(people, missions)        // people: profile objects, missions: [{a, b, outcome, created, demo}]
     const who = shortlist(room, myId, ids, k)      // whom my agent should talk to: the k most worth it
     const p = await pick(room, myId, llm, fits, recipes)   // fits: {id: 0-100} from the judge or the agents' talks
     const s = await spark(room, [a, b], recipe, llm, talk, traits)   // traits: each one's traits (room.js traitsOf), for the tone

   `llm` is any `async (prompt) => object`. */

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

/** Random numbers, optionally seeded so a run can be repeated. */
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
{talk}{tone}`;

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
    what the judge or the agents concluded, {id: 0-100}; with it the model isn't asked to rate again. `recipes`,
    {id: recipe}, is the kind of pair the judge saw for each person. */
export async function pick(room, me, llm, fits, recipes) {
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
    recipes?.[c] in RECIPES ? recipes[c] : (fits[c] || 0) >= STRONG && links[c].recipe === "wildcard" ? "useful" : links[c].recipe,
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

/* The tone: three traits (docs/traits.md) shape how Emma words the spark, never who meets whom. A trait counts only
   when it was read with confidence of at least SURE; the line says how to write, never what anyone is like. */
const TONE = ["playfulness", "directness", "openness_to_strangers"];
const SURE = 0.4;          // confidence a trait needs before it shapes the tone
const HIGH = 0.65;         // a trait value this high or higher counts as high
const LOW = 0.35;          // this low or lower counts as low

/** The tone traits read well enough: {key: 0-1}. `t` is room.js traitsOf(), {v: {key: 0-1}, c: {key: 0-1}}, or null. */
function toneTraits(t) {
  const out = {};
  for (const k of TONE) {
    const v = Number(t?.v?.[k]), c = Number(t?.c?.[k]);
    if (Number.isFinite(v) && Number.isFinite(c) && c >= SURE) out[k] = v;
  }
  return out;
}

/** One short line for the spark prompt on how to word it, from the people's traits (one per person, null while not
    read yet): all playful, a more playful mission; all hesitant with strangers, an easier first question; anyone
    direct, direct questions. "" when no trait is known well enough. */
export function tone(traits) {
  const ts = (Array.isArray(traits) ? traits : []).map(toneTraits);
  const all = (k, f) => ts.length > 1 && ts.every(t => k in t && f(t[k]));
  const any = (k, f) => ts.some(t => k in t && f(t[k]));
  const hi = v => v >= HIGH, lo = v => v <= LOW;
  const say = [];
  if (all("playfulness", hi)) say.push("make the mission more playful than usual");
  if (all("openness_to_strangers", lo)) say.push("make the first question easy to answer and the mission low-pressure");
  if (any("directness", hi)) say.push("make the questions direct, no small talk");
  return say.length ? `Tone: ${say.join("; ")}.\n` : "";
}

/** What gets them talking. `talk` is the agents' exchange about the first two, {ask, reply}. `traits`, one per person
    in the order of `ids` (room.js traitsOf), only adds a line on tone to the prompt. */
export async function spark(room, ids, recipe, llm, talk, traits) {
  const people = ids.map(i => room.people[i]);
  const out = plainSpark(people, recipe);
  if (!llm) return out;
  const ln = room.links(ids[0], ids[1]);
  const hints = { "shared words": ln.shared, [`${first(people[0])} could get`]: ln.get, [`${first(people[0])} could give`]: ln.give };
  const kw = {
    n: people.length, recipe, why: RECIPES[recipe], names: Object.keys(RECIPES).join(", "),
    people: people.map(p => JSON.stringify(card(p))).join("\n"), hints: JSON.stringify(hints),
    talk: talk && talk.ask ? `Their agents already talked. ${first(people[0])}'s asked: "${talk.ask}" ${first(people[1])}'s answered: "${talk.reply || ""}"\n` : "",
    tone: tone(traits),
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

/* The judge: Gemini Decision 1 reads the whole room once for each person whose profile is new or changed, and for
   every other person answers three closed questions: is the talk worth the first one's time, is it worth the other's,
   and which kind of reason to talk fits (one of the recipes, or none). The answers are kept per pair, so the match
   itself is code over stored answers, and the same pair isn't judged again until one of the two profiles changes.

     const todo = toJudge(cache, me, people)                 // who needs judging against `me`
     Object.assign(cache, await judge(me, todo, decide))     // decide: (input, questions) => answers
     const { fits, recipes } = fitsFrom(cache, me.id, ids)   // fits: {id: 0-100}, recipes: {id: recipe}
     const p = await pick(room, me.id, null, fits, recipes)

   People can carry their `persona` (room.js) for the judge to read. */

export const KINDS = {
  useful: RECIPES.useful, twin: RECIPES.twin, pain: RECIPES.pain, clash: RECIPES.clash,
  none: "there is no real reason for these two to talk",
};
const PER_CALL = 333;    // three questions a person, at most 1,000 questions in one call

const filled = v => v != null && v !== "" && !(Array.isArray(v) && !v.length);

/** What the judge reads about a person: their card, plus the parts of their persona that matter for an introduction. */
export function judgeCard(p) {
  const out = card(p);
  delete out.id;
  const ps = p.persona;
  if (ps && typeof ps === "object") {
    const w = ps.work || {}, g = ps.goals || {}, pe = ps.personality || {};
    const more = { headline: ps.headline, project: w.current_project, skills: w.skills, looking_for: g.looking_for,
      can_offer: ps.offers, rare: ps.rare, talks_about: ps.talk_about, avoid_people: pe.avoid };
    for (const [k, v] of Object.entries(more)) if (filled(v)) out[k] = Array.isArray(v) ? v.slice(0, 6).map(x => String(x).slice(0, 200)) : String(v).slice(0, 300);
  }
  return out;
}

/** A short fingerprint of what the judge reads about someone: when it changes, their pairs are judged again. */
export function sig(p) {
  const s = JSON.stringify(judgeCard(p));
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}

/** The people in `people` whose pair with `me` has no answer yet, or an answer from an older profile of either. */
export function toJudge(cache, me, people) {
  const mine = sig(me);
  return people.filter(o => {
    if (o.id === me.id) return false;
    const e = cache[pair(me.id, o.id)];
    return !e || e.s?.[me.id] !== mine || e.s?.[o.id] !== sig(o);
  });
}

export function judgeInput(me, group) {
  return `At a hackathon, a matchmaker is choosing whom to introduce to one attendee. The aim is not a perfect match but a\n` +
    `good reason for two strangers to walk over and start talking.\n\nThe attendee, ${me.name || "them"}:\n${JSON.stringify(judgeCard(me))}\n\n` +
    `The other people in the room:\n` + group.map((o, i) => `#${i} ${o.name || "someone"}: ${JSON.stringify(judgeCard(o))}`).join("\n");
}

export function judgeQuestions(me, group) {
  const a = first(me), q = {};
  group.forEach((o, i) => {
    const b = `#${i} (${o.name || "someone"})`;
    q[`a${i}`] = { type: "noul", instructions: `Would a five-minute talk with ${b} be worth ${a}'s time, given what ${a} is working on and looking for? No if ${a} said they would rather not meet people like them.` };
    q[`b${i}`] = { type: "noul", instructions: `Would ${b} find a five-minute talk with ${a} worth their time, given what they are working on and looking for? No if they said they would rather not meet people like ${a}.` };
    q[`k${i}`] = { type: "choice", instructions: `What is the best reason for ${a} and ${b} to talk?`, criteria: { ...KINDS } };
  });
  return q;
}

/** The judge's answers about `me` and each of `people`, as cache entries by pair. A call that fails leaves its people
    out (they keep any older answer, or fall back to the cards); it never throws. */
export async function judge(me, people, decide) {
  const others = people.filter(o => o.id !== me.id);
  const groups = [];
  for (let i = 0; i < others.length; i += PER_CALL) groups.push(others.slice(i, i + PER_CALL));
  const out = {}, mine = sig(me), at = Date.now() / 1000;
  const results = await Promise.allSettled(groups.map(g => decide(judgeInput(me, g), judgeQuestions(me, g))));
  results.forEach((r, gi) => {
    if (r.status !== "fulfilled") { console.log("judge error:", String(r.reason).slice(0, 200)); return; }
    const ans = r.value && typeof r.value === "object" ? r.value : {};
    groups[gi].forEach((o, i) => {
      const a = Number(ans[`a${i}`]?.noul), b = Number(ans[`b${i}`]?.noul), k = ans[`k${i}`]?.probabilities;
      if (!Number.isFinite(a) || !Number.isFinite(b) || !k || typeof k !== "object") return;
      const kinds = {};
      for (const name of Object.keys(KINDS)) kinds[name] = Number.isFinite(Number(k[name])) ? Number(k[name]) : 0;
      out[pair(me.id, o.id)] = { s: { [me.id]: mine, [o.id]: sig(o) }, p: { [me.id]: a, [o.id]: b }, kinds, at };
    });
  });
  return out;
}

/** What the stored answers say about `me` and each of `ids`: a pull of 0-100 (a reason to talk, worth it to both)
    and the kind of pair. People with no answer are left out, so pick() falls back to the cards for them. */
export function fitsFrom(cache, me, ids) {
  const fits = {}, recipes = {};
  for (const id of ids) {
    const e = cache[pair(me, id)];
    const a = e?.p?.[me], b = e?.p?.[id];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const reason = 1 - (e.kinds?.none || 0);
    fits[id] = Math.round(100 * Math.max(0, reason) * Math.sqrt(Math.max(0, a) * Math.max(0, b)));
    const best = Object.entries(e.kinds || {}).filter(([k]) => k !== "none").sort((x, y) => y[1] - x[1])[0];
    if (best && best[1] > 0) recipes[id] = best[0];
  }
  return { fits, recipes };
}

/** The judge's view of `me` against `others`, for a live match: whoever isn't judged yet is judged now, but the
    match waits at most `wait` seconds for it. Answers that arrive later are still kept for the next match. */
export async function rate(cache, me, others, decide, wait = 5) {
  const todo = decide ? toJudge(cache, me, others) : [];
  if (todo.length) {
    const done = judge(me, todo, decide).then(r => { Object.assign(cache, r); });
    let timer;
    await Promise.race([done, new Promise(r => { timer = setTimeout(r, wait * 1000); })]);
    clearTimeout(timer);
  }
  return { ...fitsFrom(cache, me.id, others.map(o => o.id)), asked: todo.length };
}

/** Whom the attendee's agent talks to once the judge has spoken: the chosen person, then the next best. */
export function talkTo(fits, chosen, k = 3) {
  const rest = Object.keys(fits).filter(c => c !== chosen).sort((x, y) => fits[y] - fits[x]);
  return [chosen, ...rest].slice(0, k);
}

/** After the chosen person's agent said no: the first of the people talked to, in order, whose agent said yes. */
export function saidYes(order, talks) {
  return order.find(i => talks[i] && !talks[i].no) || null;
}
