"""PairShake matching: who meets whom, and what gets the two of them talking.

A match is a pair plus a spark. The pair is chosen here in code: who is free, who has met whom, who has
had no introduction yet. How strongly two people pull comes from their agents' talks when there are any
(the server's scan, the same talks the matching screen shows), else from the model rating a shortlist,
else from the cards alone. The model then writes the spark. If the model fails, the code still pairs
people and writes a plain spark, so there is always a match.

    room = Room(people, missions)                 # people: profile dicts, missions: [{"a","b","outcome","created","demo"}]
    who = shortlist(room, my_id, ids, k)          # whom my agent should talk to: the k most worth it
    m = await match_one(room, my_id, llm, fits)   # someone just finished talking to Emma; fits: {id: 0-100}
    ms = await match_round(room, llm)             # everyone at once (a round); an odd one out joins a trio

`llm` is any `async def llm(prompt) -> dict` (the server's ask_llm). Standard library only.
"""
import asyncio
import json
import math
import random
import re
import time

RECIPES = {
    "useful": "one of them needs what the other can give",
    "twin": "they share something rare that few people in the room have",
    "pain": "they have the same frustration and can complain about it together",
    "clash": "they would disagree, in a friendly way, about something low-stakes",
    "wildcard": "no obvious link: they get a small mission to find out what they share",
}
TINY = 5          # up to this many candidates: everyone meets everyone in turn
BIG = 40          # above this the model only sees a shortlist, and some matches are wildcards
SHORT = 8         # shortlist size
MAX_OPEN = 2      # open introductions one person can hold at a time
WILD = 0.25       # share of wildcard matches in a big room
SCAN = 8          # how many people one attendee's agent talks to
STRONG = 60       # an agents' verdict this high is never passed over for a wildcard
UNWANTED = 8      # taken off a pair's card score when one said they'd rather not meet people like the other
OPEN_FOR = 1200   # seconds an unanswered introduction keeps someone busy; after that they count as free

STOP = set("""a an and the of to in on at for with from by is are was be been it its this that these those i me my
we our you your they them their he she his her as or but not no so if than then too very just also can could will
would should has have had do does did who what when where how why which there here all any some one two more most
into about over out up down off need needs want wants looking look help helps make makes making made build builds
building built get gets got give gives use uses using work works working someone anyone people person thing things
good great real really right now yet still every each other others own way lot much many new first agent agents ai
hackathon athens""".split())


def stem(w):
    for suf in ("ers", "er", "ing", "ed", "s"):
        if w.endswith(suf) and len(w) - len(suf) >= 4:
            return w[: -len(suf)]
    return w


def toks(*texts):
    out = set()
    for t in texts:
        if isinstance(t, (list, tuple)):
            t = " ".join(str(x) for x in t)
        for w in re.findall(r"[a-z][a-z0-9+#-]{2,}", str(t or "").lower()):
            if w not in STOP:
                out.add(stem(w))
    return out


def first(p):
    return (p.get("name") or "them").split()[0]


def card(p):
    return {k: p.get(k) for k in ("id", "name", "role", "building", "needs", "offers", "hooks", "avoid") if p.get(k)}


class Room:
    def __init__(self, people, missions=(), rng=None):
        self.people = {}
        self.rng = rng or random.Random()
        self.met = set()          # frozenset({a, b}) for every introduction made
        self.open = {}            # id -> introductions not answered yet
        self.intros = {}          # id -> introductions ever
        self.ix = {}
        self.df = {}
        for p in people:
            self.add(p, index=False)
        self._index()
        now = time.time()
        for m in missions:
            if m.get("demo"):                  # met a demo attendee: not again, but it doesn't count as an introduction
                self.met.add(frozenset((m["a"], m["b"])))
                continue
            self.record(m["a"], m["b"], open_=m.get("outcome") is None and now - m.get("created", now) < OPEN_FOR)

    def add(self, p, index=True):
        self.people[p["id"]] = p
        if index:
            self._index()

    def _index(self):
        self.ix, self.df = {}, {}
        for pid, p in self.people.items():
            e = {"about": toks(p.get("role"), p.get("building"), p.get("line"), p.get("hooks")),
                 "needs": toks(p.get("needs")), "offers": toks(p.get("offers")), "avoid": toks(p.get("avoid"))}
            self.ix[pid] = e
            for t in e["about"] | e["needs"] | e["offers"]:
                self.df[t] = self.df.get(t, 0) + 1

    def idf(self, t):
        """Rare words weigh more: a thing two people share and nobody else has is worth the most."""
        return math.log(1 + len(self.people) / max(1, self.df.get(t, 1)))

    def record(self, a, b, open_=True):
        self.met.add(frozenset((a, b)))
        for x in (a, b):
            self.intros[x] = self.intros.get(x, 0) + 1
            if open_:
                self.open[x] = self.open.get(x, 0) + 1

    def close(self, a, b):
        for x in (a, b):
            self.open[x] = max(0, self.open.get(x, 0) - 1)

    def candidates(self, me):
        """Someone new who is free; else someone new; else anyone. Empty only when the room is empty."""
        others = [i for i in self.people if i != me]
        new = [i for i in others if frozenset((me, i)) not in self.met]
        free = [i for i in new if self.open.get(i, 0) < MAX_OPEN]
        return free or new or others

    def links(self, a, b):
        A, B = self.ix[a], self.ix[b]
        w = lambda ts: sum(self.idf(t) for t in ts)
        get, give = A["needs"] & B["offers"], B["needs"] & A["offers"]
        useful = (w(get) + w(give)) * (1.5 if get and give else 1)
        shared = A["about"] & B["about"]
        twin = w(shared)
        recipe = "useful" if useful and useful >= twin else "twin" if twin else "wildcard"
        # one of them said they'd rather not meet people like the other
        unwanted = bool(A["avoid"] & B["about"] or B["avoid"] & A["about"])
        return {"score": useful + .8 * twin - (UNWANTED if unwanted else 0), "unwanted": unwanted, "recipe": recipe, "get": sorted(get), "give": sorted(give),
                "shared": sorted(shared, key=lambda t: -self.idf(t))[:4]}

    def fair(self, pid):
        """People with no introduction yet come first; busy people and demo attendees come last."""
        p = self.people[pid]
        return (12 if not self.intros.get(pid) else 0) - 15 * self.open.get(pid, 0) - (20 if p.get("seed") else 0)


def shortlist(room, me, ids=None, k=SCAN):
    """Whom `me`'s agent should talk to: the `k` most worth it among `ids` (default: everyone they could
    meet), by their cards and the same fairness as pick() (nobody-yet first, busy and demo people last).
    When there are more than `k`, the last two are drawn from further down so it never closes up."""
    rng = room.rng
    ids = [i for i in (ids or room.candidates(me)) if i != me]
    rank = sorted(ids, key=lambda c: (-(room.links(me, c)["score"] + room.fair(c) / 4), rng.random()))
    if len(rank) <= k or k < 4:
        return rank[:k]
    return rank[: k - 2] + rng.sample(rank[k - 2:], 2)


RATE = """You are Emma, the matchmaker at a hackathon. Your job is not to find the most similar person. It is to
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

Reply with JSON only: {{"picks": [{{"id": "...", "recipe": "...", "pull": 0}}]}}"""

SPARK = """You are Emma, the matchmaker at the Gen AI Summit Hackathon in Athens, introducing {n} strangers.
Talk like a friend who is plotting something, never like a system: no scores, no percentages, no "match",
no "compatible", no praise words (amazing, great, perfect, love). Plain spoken English with contractions.

{people}

Why these people ({recipe}): {why}
Hints from their cards (use only if they are real and interesting): {hints}
{talk}"""

# The spark is written in two halves at the same time: one call for all of it took twice as long.
SPARK_WORDS = """
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
{{"recipe": "...", "teases": {{{ids}}}, "mission": "...", "say": "..."}}"""

SPARK_SCREEN = """
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
{{"ladder": ["...", "...", "..."],
  "share": {{"rare": [{{"text": "...", "opener": "..."}}], "first_only": ["..."], "second_only": ["..."],
            "give": "...", "get": "..."}}}}"""

PROFILE = """Below is what one hackathon attendee told Emma: a voice chat (speech recognition, so some words
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

Reply with JSON only: {{"name": "...", "role": "3-6 words", "building": "...", "needs": "...",
"offers": "...", "spot": "...", "line": "one memorable sentence about them, third person",
"hooks": ["..."], "avoid": "..."}}"""


async def profile(convo, llm):
    p = await llm(PROFILE.format(convo=convo))
    out = {k: str(p.get(k, "")).strip() for k in ("name", "role", "building", "needs", "offers", "spot", "line", "avoid")}
    out["hooks"] = [str(h).strip() for h in (p.get("hooks") or []) if str(h).strip()][:3]
    return out


def _int(v, default):
    try:
        return max(0, min(100, int(float(v))))
    except (TypeError, ValueError):
        return default


async def pick(room, me, llm=None, fits=None):
    """Who `me` should meet next: {"a", "b", "recipe", "mode", "by"}; None only when nobody else is in the
    room. `fits` is what the agents concluded, {id: 0-100}; with it the model isn't asked to rate again."""
    cands = room.candidates(me)
    if not cands:
        return None
    rng, n = room.rng, len(cands)
    links = {c: room.links(me, c) for c in cands}
    fits = {c: _int(v, 50) for c, v in (fits or {}).items() if c in links}
    by = "agents" if fits else "cards"
    cards = {c: max(0, min(100, 20 + 8 * links[c]["score"])) - (40 if links[c]["unwanted"] else 0) for c in cands}
    # the agents' verdict where they talked, steadied by the cards (one verdict is one opinion: a few points
    # either way shouldn't decide it); else the cards, a little lower when others were looked at closely
    pulls = {c: (.8 * fits[c] + .2 * cards[c] if c in fits else cards[c] - (10 if fits else 0),
                 "useful" if fits.get(c, 0) >= STRONG and links[c]["recipe"] == "wildcard" else links[c]["recipe"])
             for c in cands}
    if n <= TINY:                                   # a few people: go round, least-introduced first
        b = min(cands, key=lambda c: (room.intros.get(c, 0), -pulls[c][0], rng.random()))
        return {"a": me, "b": b, "recipe": pulls[b][1], "mode": "tiny", "by": by}
    strong = fits and max(fits.values()) >= STRONG
    if n > BIG and not strong and rng.random() < WILD:      # a big room: now and then, someone unexpected
        quiet = sorted(cands, key=lambda c: (room.intros.get(c, 0), rng.random()))[: max(4, n // 4)]
        return {"a": me, "b": rng.choice(quiet), "recipe": "wildcard", "mode": "wildcard", "by": "chance"}
    pool = cands
    mode = "room" if n <= BIG else "big"
    if llm and not fits:
        if n > BIG:                                 # the best by profile, plus two the profile would never suggest
            ranked = sorted(cands, key=lambda c: -links[c]["score"])
            pool = ranked[: SHORT - 2] + rng.sample(ranked[SHORT - 2:], 2)
        try:
            r = await llm(RATE.format(
                me=json.dumps(card(room.people[me]), ensure_ascii=False),
                pool=json.dumps([card(room.people[c]) for c in pool], ensure_ascii=False),
                recipes="\n".join(f"- {k}: {v}" for k, v in RECIPES.items()),
                names=", ".join(RECIPES), k=min(5, len(pool))))
            rated = {str(x.get("id")): (_int(x.get("pull"), 50), x.get("recipe")) for x in (r.get("picks") or [])
                     if isinstance(x, dict)}
            rated = {c: (pull, rec if rec in RECIPES else links[c]["recipe"])
                     for c, (pull, rec) in rated.items() if c in pool}       # ids the model made up are dropped
            if rated:
                pulls, pool, by = rated, list(rated), "model"
        except Exception as e:
            print("rate error:", e, flush=True)
    b = max(pool, key=lambda c: (pulls[c][0] + room.fair(c), rng.random()))
    return {"a": me, "b": b, "recipe": pulls[b][1], "mode": mode, "by": "agents" if b in fits else by}


def plain_spark(people, recipe):
    """The spark when the model is unavailable: still a name, something to ask, and a mission."""
    teases = {}
    for p in people:
        o = next(x for x in people if x is not p)
        ask = (o.get("hooks") or [o.get("building") or "what they're building"])[0]
        teases[p["id"]] = f"Go find {first(o)} and ask about this: {ask}"
    ladder = ["What are you building this weekend?", "What part of it are you stuck on?",
              "What made you care about this problem in the first place?"]
    return {"recipe": recipe, "teases": teases,
            "mission": "Two minutes: find three things you share that nobody else in the room does.",
            "ladder": ladder,
            "say": " ".join(f"I want you to meet {first(p)}." + (f" {p['role']}." if p.get("role") else "")
                            for p in people[1:]),
            "share": {"rare": [{"text": "Something you two share. Find it.", "opener": ladder[0]}],
                      "first_only": [], "second_only": [], "give": "", "get": ""}}


async def spark(room, ids, recipe, llm=None, talk=None):
    """What gets them talking. `talk` is the agents' exchange about the first two, {"ask", "reply"}."""
    people = [room.people[i] for i in ids]
    out = plain_spark(people, recipe)
    if not llm:
        return out
    ln = room.links(ids[0], ids[1])
    hints = {"shared words": ln["shared"], f"{first(people[0])} could get": ln["get"],
             f"{first(people[0])} could give": ln["give"]}
    kw = dict(n=len(people), recipe=recipe, why=RECIPES[recipe], names=", ".join(RECIPES),
              people="\n".join(json.dumps(card(p), ensure_ascii=False) for p in people),
              hints=json.dumps(hints, ensure_ascii=False),
              talk=(f"Their agents already talked. {first(people[0])}'s asked: \"{talk.get('ask', '')}\" "
                    f"{first(people[1])}'s answered: \"{talk.get('reply', '')}\"\n" if talk and talk.get("ask") else ""),
              ids=", ".join(f'"{i}": "..."' for i in ids))

    async def half(prompt):                          # a half that fails keeps its plain version
        try:
            r = await llm((SPARK + prompt).format(**kw))
            return r if isinstance(r, dict) else {}
        except Exception as e:
            print("spark error:", e, flush=True)
            return {}

    r = {}
    for part in await asyncio.gather(half(SPARK_WORDS), half(SPARK_SCREEN)):
        r.update(part)
    teases = r.get("teases") if isinstance(r.get("teases"), dict) else {}
    for i in ids:                                    # a missing line keeps the plain one
        if str(teases.get(i, "")).strip():
            out["teases"][i] = str(teases[i]).strip()
    if r.get("recipe") in RECIPES:
        out["recipe"] = r["recipe"]
    for k in ("mission", "say"):
        if str(r.get(k, "")).strip():
            out[k] = str(r[k]).strip()
    ladder = [str(q).strip() for q in (r.get("ladder") or []) if str(q).strip()][:3]
    if len(ladder) == 3:
        out["ladder"] = ladder
    sh = r.get("share") if isinstance(r.get("share"), dict) else {}
    rare = [{"text": str(x.get("text", "")).strip(), "opener": str(x.get("opener", "")).strip()}
            for x in (sh.get("rare") or []) if isinstance(x, dict) and str(x.get("text", "")).strip()][:3]
    if rare:
        tags = lambda v: [str(x).strip() for x in (v or []) if str(x).strip()][:2]
        out["share"] = {"rare": rare, "first_only": tags(sh.get("first_only")),
                        "second_only": tags(sh.get("second_only")),
                        "give": str(sh.get("give", "")).strip(), "get": str(sh.get("get", "")).strip()}
    return out


async def match_one(room, me, llm=None, fits=None):
    p = await pick(room, me, llm, fits)
    if not p:
        return None
    s = await spark(room, [p["a"], p["b"]], p["recipe"], llm)
    room.record(p["a"], p["b"])
    return {"ids": [p["a"], p["b"]], "mode": p["mode"], "by": p["by"], **s}


async def match_round(room, llm=None):
    """Everyone in the room gets someone at the same moment. With an odd number, one pair becomes a trio."""
    rng = room.rng
    free = sorted(room.people, key=lambda i: (room.intros.get(i, 0), rng.random()))
    big = len(free) > BIG
    groups = []
    while len(free) >= 2:
        a = free.pop(0)
        pool = [b for b in free if frozenset((a, b)) not in room.met] or free
        if big and rng.random() < WILD:
            b, recipe, mode = rng.choice(pool), "wildcard", "wildcard"
        else:
            b = max(pool, key=lambda c: (room.links(a, c)["score"] + room.fair(c) / 10, rng.random()))
            recipe, mode = room.links(a, b)["recipe"], "round"
        free.remove(b)
        groups.append({"ids": [a, b], "recipe": recipe, "mode": mode})
    if free and groups:
        c = free.pop()
        g = max(groups, key=lambda g: sum(room.links(c, x)["score"] for x in g["ids"]))
        g["ids"].append(c)
        g["mode"] = "trio"
    sparks = await asyncio.gather(*(spark(room, g["ids"], g["recipe"], llm) for g in groups))
    out = []
    for g, s in zip(groups, sparks):
        ids = g["ids"]
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                room.record(ids[i], ids[j])
        out.append({"ids": ids, "mode": g["mode"], **s})
    return out
