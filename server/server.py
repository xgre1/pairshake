"""Roomie server: Emma interviews each attendee by voice, finds the one person in the room they
should meet, and gives both of them an icebreaker mission instead of a DM.

Runs on the Mac with Emma's Python environment and speaks in Emma's voice (ElevenLabs, with the
local Kokoro voice as fallback) by importing Emma's own engine/tts.py.

    ~/Desktop/emma/.venv/bin/python server.py          # listens on 0.0.0.0:8780

The iPhone app talks to it over plain HTTP on the local network.
"""
import asyncio
import hashlib
import json
import os
import random
import re
import sys
import time
import uuid

from aiohttp import WSMsgType, web

HERE = os.path.dirname(os.path.abspath(__file__))
EMMA = os.path.expanduser("~/Desktop/emma")
sys.path.insert(0, EMMA)
from engine.tts import Voice  # noqa: E402

PORT = int(os.environ.get("PORT", 8780))
MODEL = os.environ.get("ROOMIE_MODEL", "haiku")
MAX_TURNS = 5
STATE_FILE = os.path.join(HERE, "room.json")

OPENER = ("Hi, I'm Emma. I know pretty much everyone in this room, and I'd love to introduce you to someone. "
          "First, what's your name, and what are you building?")
TOPICS = ["(2) what they need most right now", "(3) what they could help someone else with",
          "(4) where they are in the room and how to spot them"]
THINKING = ("Lovely. I think I know someone. While I check, add your handles so they can follow you.")

# ---------------------------------------------------------------------------------------------
# Fictional attendees so the room is never empty. Real attendees are added as they finish.
SEED = [
    {"id": "s1", "name": "Eleni Markou", "role": "Product designer, ex-fintech", "color": "#FFB86B",
     "building": "A language tutor that notices when you're lost and changes the exercise.",
     "needs": "A backend engineer who has shipped agents.",
     "offers": "Interface design, Figma, making a demo look finished in one night.",
     "spot": "Row 5 by the window, yellow raincoat.",
     "line": "Spent four years designing banking apps and wants to never see a form again.",
     "socials": {"x": "eleni_designs", "instagram": "eleni.makes", "linkedin": "elenimarkou"}},
    {"id": "s2", "name": "Tom Becker", "role": "Voice infrastructure engineer", "color": "#8AA8FF",
     "building": "Sub-300ms voice agents that can be interrupted mid-sentence.",
     "needs": "A designer and a real use case with real users.",
     "offers": "Streaming speech, turn-taking, websockets, latency tuning.",
     "spot": "Front row, left side, grey hoodie, two laptops.",
     "line": "Measures everything in milliseconds, including lunch.",
     "socials": {"x": "tbecker_rt", "github": "tbeck", "linkedin": "tombecker"}},
    {"id": "s3", "name": "Nikos Alexiou", "role": "Medical student who builds at weekends", "color": "#7CF2C4",
     "building": "An agent that writes the hospital discharge letter while the doctor talks to the patient.",
     "needs": "Someone strong on frontend, and help with small models.",
     "offers": "Knows exactly how clinics work and can get ten doctors to test it.",
     "spot": "Row 8, near the coffee, green scarf.",
     "line": "Has watched doctors lose two hours a day to paperwork.",
     "socials": {"x": "nikos_md", "instagram": "nikos.alexiou", "linkedin": "nalexiou"}},
    {"id": "s4", "name": "Priya Raman", "role": "ML engineer, small models", "color": "#F78FB3",
     "building": "Agents that run on a 3B model on a laptop, no cloud.",
     "needs": "Real users and help telling the story on stage.",
     "offers": "Fine-tuning, evals, making small models do big-model jobs.",
     "spot": "Row 3, seat by the pillar, black cap.",
     "line": "Thinks most startups are paying for model size they don't need.",
     "socials": {"x": "priya_tiny", "github": "praman", "linkedin": "priyaraman"}},
    {"id": "s5", "name": "Dimitra Kosta", "role": "Founder of a language school in Athens", "color": "#C3A6FF",
     "building": "Speaking practice for 400 students who are too shy to talk in class.",
     "needs": "Anyone who can build a voice agent. She has zero engineers.",
     "offers": "400 real students to test with tomorrow, and Greek market know-how.",
     "spot": "Row 6, aisle seat, red glasses.",
     "line": "Has the users and the problem, just not the code.",
     "socials": {"instagram": "dimitra.k.school", "linkedin": "dimitrakosta"}},
    {"id": "s6", "name": "Sam Okafor", "role": "Full-stack, ships fast", "color": "#FFD36B",
     "building": "Nothing yet. Wants to join the best idea in the room.",
     "needs": "A good idea and a designer.",
     "offers": "React, Swift, backend, deploys. A working URL by tonight.",
     "spot": "Row 4, far right, orange sneakers.",
     "line": "Won two hackathons by joining someone else's idea.",
     "socials": {"x": "samships", "github": "sokafor", "linkedin": "samokafor"}},
    {"id": "s7", "name": "Lena Vogt", "role": "Angel investor, pre-seed AI", "color": "#6BDCFF",
     "building": "Looking for teams whose agent does a real job end to end.",
     "needs": "To see agents doing work, not slides.",
     "offers": "Pitch feedback and intros to European seed funds.",
     "spot": "Front row, centre, white blazer.",
     "line": "Will ask you to show the agent, not the deck.",
     "socials": {"x": "lenavogt", "linkedin": "lenavogt"}},
    {"id": "s8", "name": "Yusuf Demir", "role": "Robotics and sensors", "color": "#B5F27C",
     "building": "A robot arm that sorts recycling by listening to what you say about it.",
     "needs": "Speech recognition and a nicer interface.",
     "offers": "Hardware, sensors, a robot arm he brought with him.",
     "spot": "Row 7, the one with the robot arm on the table.",
     "line": "Brought a robot arm. Nobody has asked about it yet.",
     "socials": {"x": "yusuf_bots", "github": "ydemir", "instagram": "yusuf.builds"}},
    {"id": "s9", "name": "Maria Papadaki", "role": "Growth marketer", "color": "#FF8A6B",
     "building": "Helping one team here go viral by Monday.",
     "needs": "A team with a demo worth filming.",
     "offers": "Distribution: 10k followers, short-form video, launch copy.",
     "spot": "Row 5, middle, filming everything on her phone.",
     "line": "Can get your demo in front of ten thousand people by Monday.",
     "socials": {"x": "mariagrows", "instagram": "maria.papadaki", "linkedin": "mpapadaki"}},
    {"id": "s10", "name": "Chen Wei", "role": "Audio ML researcher", "color": "#9EF0FF",
     "building": "Speech models that understand elderly speakers.",
     "needs": "A designer and people to test with.",
     "offers": "Speech recognition, voice cloning, audio models.",
     "spot": "Row 3, first seat, big headphones.",
     "line": "Says speech is the only interface his grandmother uses.",
     "socials": {"x": "chenwei_audio", "github": "cwei", "linkedin": "chenwei"}},
]
for s in SEED:
    s["code"] = f"{random.randint(1000, 9999)}"
    s["seed"] = True

PALETTE = ["#7CF2C4", "#8AA8FF", "#FFB86B", "#F78FB3", "#C3A6FF", "#FFD36B", "#6BDCFF", "#B5F27C"]

# ---------------------------------------------------------------------------------------------
# Room state: users (people who talked to Emma) and missions between two people.
users = {}        # id -> {id, name, transcript[], profile{}, socials{}, code, color, match, inbox[]}
missions = {}     # mission id -> {...}
stats = {"spoke": 0, "intros": 0, "met": 0}


def save():
    try:
        with open(STATE_FILE, "w") as f:
            json.dump({"users": users, "missions": missions, "stats": stats}, f)
    except OSError:
        pass


def load():
    try:
        with open(STATE_FILE) as f:
            d = json.load(f)
        users.update(d.get("users", {}))
        missions.update(d.get("missions", {}))
        stats.update(d.get("stats", {}))
    except (OSError, ValueError):
        pass


def person(pid):
    """Public card for anyone in the room, seed or real."""
    s = next((p for p in SEED if p["id"] == pid), None)
    if s:
        return {**{k: s[k] for k in ("id", "name", "role", "color", "building", "needs", "offers", "spot",
                                     "line", "socials")}, "seed": True}
    u = users.get(pid)
    if not u:
        return None
    p = u.get("profile", {})
    return {"id": pid, "name": u.get("name") or p.get("name") or "Someone", "role": p.get("role", ""),
            "color": u["color"], "building": p.get("building", ""), "needs": p.get("needs", ""),
            "offers": p.get("offers", ""), "spot": p.get("spot", ""), "line": p.get("line", ""),
            "socials": u.get("socials", {})}


def candidates(exclude):
    out = [person(s["id"]) for s in SEED]
    out += [person(uid) for uid, u in users.items() if uid != exclude and u.get("profile")]
    return out


# ---------------------------------------------------------------------------------------------
# Language model: one-shot `claude -p` calls on the subscription (no tools, no MCP, no CLAUDE.md).

async def ask_llm(prompt, timeout=40):
    env = dict(os.environ, CLAUDE_CODE_DISABLE_CLAUDE_MDS="1")
    for k in ("ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"):
        env.pop(k, None)
    proc = await asyncio.create_subprocess_exec(
        "claude", "-p", "--model", MODEL, "--strict-mcp-config", "--tools", "", "--output-format", "text",
        prompt, cwd=HERE, env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise RuntimeError("model timed out")
    text = out.decode()
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise RuntimeError(f"no JSON from model: {text[:200]!r} {err.decode()[:200]!r}")
    return json.loads(m.group(0))


def convo(u):
    return "\n".join(f"{'Emma' if r == 'emma' else 'Attendee'}: {t}" for r, t in u["transcript"])


INTERVIEW = """You are Emma, the matchmaker of the Gen AI Summit Hackathon in Athens: warm, perceptive, a little
playful, like a friend who knows everyone in the room and loves setting people up. You are getting to
know one attendee BY VOICE so you can introduce them to the one person here they should meet.

You need four things: (1) their name and what they're building, (2) what they need most right now,
(3) what they could help someone else with in ten minutes, (4) where they are in the room and
something to spot them by (clothes, a laptop sticker, anything).

Rules for what you say next:
- This is spoken aloud. One short reaction (a few words, specific to what they said, never generic
  praise) then exactly ONE question. Under 25 words total. No lists, no emojis, no stage directions.
- Ask about the FIRST topic in this list that they have not already answered: {todo}
  Never ask about a later topic before an earlier one. If an answer was too vague to use, ask one
  sharper follow-up on that same topic instead.
- If they cut you off, don't repeat what you were saying: just respond to them.
- When all four are answered, set done to true and say only a short handover line like "Perfect. Give
  me a second, I'm looking around the room."

Conversation so far:
{convo}

Reply with JSON only: {{"say": "...", "done": true|false}}"""

MATCH = """You are Emma, the matchmaker of the Gen AI Summit Hackathon in Athens (36 hours, teams of 1-5,
build an agent that does real work). Below is your voice chat with one attendee, then everyone else in the room.

Chat:
{convo}

People in the room (JSON):
{room}

Do three things.
1. Write the attendee's profile from the chat, in short plain sentences.
2. Pick the ONE person they should meet. Prefer complementary needs (one needs what the other offers,
   ideally both ways) over similar topics. Be concrete.
3. Map their OVERLAP, the thing that gets two strangers talking. Research says RARE shared traits bond
   people far more than common ones (Alves 2018), so skip the obvious ("you both like AI", "you're both at
   the hackathon"); find specific, surprising things they share: a past, a frustration, a way of working,
   a user they care about, a taste. Also what each could give the other. Then write a ladder of three
   questions they could ask each other, from light to real to deep (escalating self-disclosure, Aron 1997),
   tied to their actual lives and projects, never generic icebreakers.

Reply with JSON only:
{{"me": {{"name": "...", "role": "3-6 words", "building": "...", "needs": "...", "offers": "...",
         "spot": "...", "line": "one memorable sentence about them, third person"}},
  "match_id": "id from the room list",
  "intro_me": "Emma's matchmaker note to the attendee about the match: 2-3 warm, specific sentences on why these two should meet. Second person.",
  "intro_them": "the same note written to the match about the attendee. Second person.",
  "overlap": {{"rare": [{{"text": "a rare thing they share, under 9 words", "opener": "how the attendee could open with it, a question, under 18 words"}}, ...2 or 3],
               "you_only": ["2 short tags (2-4 words) true of the attendee but not the match"],
               "them_only": ["2 short tags (2-4 words) true of the match but not the attendee"],
               "give": "what the attendee can give the match, under 10 words",
               "get": "what the match can give the attendee, under 10 words",
               "ladder": ["light question", "real question", "deep question"]}},
  "say": "what Emma says aloud when revealing the match, like a matchmaker: their name and one reason. Never say where they are. Under 30 words, no lists."}}"""


AGENT_TALK = """Two personal agents are meeting on behalf of their people at the Gen AI Summit Hackathon in
Athens, before the humans ever speak. Each agent knows only its own person and protects their time: it is
polite but honest, asks sharp questions, and says plainly if the fit is weak. They talk like quick,
friendly colleagues, not like a sales pitch.

Agent A represents:
{a}

Agent B represents:
{b}

Write their conversation: 6 to 8 short turns, alternating, A first. Each turn under 28 words, spoken
plainly, always about the real overlap or gap between the two people (needs vs offers). At least one
turn must be a pointed question and one must be an honest concern. No greetings beyond the first turn.

Reply with JSON only:
{{"turns": [{{"who": "a", "text": "..."}}, {{"who": "b", "text": "..."}}],
  "fit": 0-100 integer, how good the match really is,
  "why_a": "one sentence to person A: what they get from meeting B, second person",
  "why_b": "one sentence to person B: what they get from meeting A, second person",
  "ask": "the one concrete question the two humans should start with, under 20 words"}}"""


# ---------------------------------------------------------------------------------------------
# Voice

voice = None
audio_cache = {}


async def speak_wav(text):
    key = hashlib.sha1(text.encode()).hexdigest()
    if key not in audio_cache:
        res = await asyncio.wrap_future(voice.submit(text))
        audio_cache[key] = res["wav"]
    return audio_cache[key]


# ---------------------------------------------------------------------------------------------
# HTTP

async def h_start(req):
    uid = uuid.uuid4().hex[:10]
    users[uid] = {"id": uid, "name": None, "transcript": [("emma", OPENER)], "profile": None,
                  "socials": {}, "code": f"{random.randint(1000, 9999)}",
                  "color": random.choice(PALETTE), "match": None, "inbox": [], "turns": 0}
    save()
    return web.json_response({"id": uid, "say": OPENER, "code": users[uid]["code"]})


async def h_turn(req):
    d = await req.json()
    u = users.get(d.get("id"))
    if not u:
        raise web.HTTPNotFound()
    text = (d.get("text") or "").strip()
    if d.get("interrupted") and u["transcript"] and u["transcript"][-1][0] == "emma":
        r, t = u["transcript"][-1]
        u["transcript"][-1] = (r, t + " [the attendee cut Emma off here and started talking]")
    if text:
        u["transcript"].append(("you", text))
    u["turns"] += 1
    if u["turns"] >= MAX_TURNS:
        out = {"say": THINKING, "done": True}
    else:
        try:
            todo = "; ".join(TOPICS)
            out = await ask_llm(INTERVIEW.format(convo=convo(u), todo=todo))
        except Exception as e:
            print("interview error:", e, flush=True)
            out = {"say": "Sorry, say that once more?", "done": False}
    say = str(out.get("say", "")).strip() or THINKING
    u["transcript"].append(("emma", say))
    if out.get("done"):
        say = THINKING
        u["transcript"][-1] = ("emma", say)
        pending[u["id"]] = asyncio.ensure_future(run_match(u))     # think while Emma talks
        start_scan(u)
    save()
    return web.json_response({"say": say, "done": bool(out.get("done"))})


async def h_match(req):
    d = await req.json()
    u = users.get(d.get("id"))
    if not u:
        raise web.HTTPNotFound()
    u["socials"] = {k: v.strip().lstrip("@") for k, v in (d.get("socials") or {}).items() if v and v.strip()}
    task = pending.pop(u["id"], None) or asyncio.ensure_future(run_match(u))
    try:
        r, room = await task
    except Exception as e:
        print("match error:", e, flush=True)
        return web.json_response({"error": str(e)}, status=502)
    u["profile"] = r.get("me") or {}
    u["name"] = u["profile"].get("name") or u.get("name")
    them = person(r.get("match_id")) or room[0]
    mid = uuid.uuid4().hex[:8]
    missions[mid] = {"id": mid, "a": u["id"], "b": them["id"], "intro_a": r.get("intro_me", ""),
                     "intro_b": r.get("intro_them", ""), "overlap": clean_overlap(r.get("overlap") or {}),
                     "created": time.time(), "outcome": None}
    u["match"] = mid
    asyncio.ensure_future(agent_talk(mid))          # agents start talking while Emma reveals the match
    stats["spoke"] += 1
    stats["intros"] += 1
    if them["id"] in users:            # a real person: their phone gets the introduction too
        users[them["id"]]["inbox"].append(mid)
    else:                              # a seed person: Emma plays them in the chat
        prepare_bot(mid)
    save()
    return web.json_response({"say": r.get("say", ""), "me": person(u["id"]), "mission": mission_for(mid, u["id"])})


pending = {}      # user id -> running match task
scans = {}        # user id -> {"talks": [...], "total": n}: one agent-to-agent talk per attendee

SCAN = """At the Gen AI Summit Hackathon in Athens every attendee has an AI agent that represents them.
Agent A represents the attendee below and is talking to agent B, who represents {name}, to decide whether
the two humans should meet.

Attendee's chat with Emma:
{convo}

{name} (JSON): {other}

Write their exchange: agent A asks or pitches, specific to {first} (under 14 words); agent B replies
honestly about fit (under 14 words, may say no). Then a fit score 0-100. Be discerning: most people are
weak fits; only a clear two-way fit scores above 75.

Reply with JSON only: {{"ask": "...", "reply": "...", "fit": 0}}"""


def start_scan(u):
    if u["id"] in scans:
        return
    room = candidates(u["id"])[:14]
    state = {"talks": [], "total": len(room)}
    scans[u["id"]] = state

    async def one(p):
        other = json.dumps({k: p[k] for k in ("role", "building", "needs", "offers")}, ensure_ascii=False)
        try:
            out = await ask_llm(SCAN.format(convo=convo(u), name=p["name"], first=p["name"].split()[0], other=other))
            state["talks"].append({"person": p, "ask": str(out.get("ask", "")), "reply": str(out.get("reply", "")),
                                   "fit": max(0, min(100, _int(out.get("fit"), 30)))})
        except Exception as e:
            print("scan error:", e, flush=True)
            state["total"] -= 1

    for p in room:
        asyncio.ensure_future(one(p))


async def h_scan(req):
    """Your agent's conversations with everyone else's agents, as they finish (polled by the app)."""
    u = users.get(req.query.get("id"))
    if not u:
        raise web.HTTPNotFound()
    start_scan(u)
    st = scans[u["id"]]
    return web.json_response({"talks": st["talks"], "total": st["total"]})


def _int(v, default):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


async def run_match(u):
    room = candidates(u["id"])
    room_json = json.dumps([{k: p[k] for k in ("id", "name", "role", "building", "needs", "offers")}
                            for p in room], ensure_ascii=False)
    return await ask_llm(MATCH.format(convo=convo(u), room=room_json), timeout=60), room


def clean_overlap(o):
    rare = [{"text": str(x.get("text", "")), "opener": str(x.get("opener", ""))}
            for x in (o.get("rare") or []) if isinstance(x, dict)][:3]
    strs = lambda v: [str(x) for x in (v or [])][:3]
    return {"rare": rare, "you_only": strs(o.get("you_only")), "them_only": strs(o.get("them_only")),
            "give": str(o.get("give", "")), "get": str(o.get("get", "")), "ladder": strs(o.get("ladder"))}


def overlap_for(o, mine):
    """The overlap seen from one side: the match sees give/get and the two sides swapped."""
    if mine:
        return o
    return {**o, "you_only": o["them_only"], "them_only": o["you_only"], "give": o["get"], "get": o["give"]}


def mission_for(mid, viewer):
    m = missions[mid]
    mine = m["a"] == viewer
    other = m["b"] if mine else m["a"]
    return {"id": mid, "intro": m["intro_a"] if mine else m["intro_b"], "overlap": overlap_for(m["overlap"], mine),
            "person": person(other), "outcome": m.get("outcome")}


def card(p):
    return json.dumps({k: p.get(k, "") for k in ("name", "role", "building", "needs", "offers", "line")},
                      ensure_ascii=False)


async def agent_talk(mid):
    """Two agents talk first. Generated once, cached on the mission."""
    m = missions[mid]
    if m.get("talk"):
        return m["talk"]
    t = m.get("talk_task")
    if not t:
        t = m["talk_task"] = asyncio.ensure_future(
            ask_llm(AGENT_TALK.format(a=card(person(m["a"])), b=card(person(m["b"]))), timeout=60))
    try:
        r = await t
    except Exception:
        m.pop("talk_task", None)
        raise
    turns = [{"who": "b" if x.get("who") == "b" else "a", "text": str(x.get("text", ""))[:240]}
             for x in (r.get("turns") or [])[:10] if x.get("text")]
    m["talk"] = {"turns": turns, "fit": max(0, min(100, _int(r.get("fit"), 70))),
                 "why_a": str(r.get("why_a", "")), "why_b": str(r.get("why_b", "")), "ask": str(r.get("ask", ""))}
    if m["talk"]["ask"]:
        m.setdefault("overlap", {})["agent_ask"] = m["talk"]["ask"]   # the humans can open with what the agents found
    m.pop("talk_task", None)
    save()
    return m["talk"]


async def h_talk(req):
    mid = req.query.get("mid")
    m = missions.get(mid)
    if not m:
        raise web.HTTPNotFound()
    viewer = req.query.get("id")
    try:
        t = await agent_talk(mid)
    except Exception as e:
        print("talk error:", e, flush=True)
        return web.json_response({"error": str(e)}, status=502)
    me = "b" if viewer == m["b"] else "a"
    return web.json_response({"turns": t["turns"], "fit": t["fit"], "why": t["why_" + me], "ask": t["ask"],
                              "you": me, "a": person(m["a"]), "b": person(m["b"])})


async def h_inbox(req):
    u = users.get(req.query.get("id"))
    if not u:
        raise web.HTTPNotFound()
    items = [mission_for(mid, u["id"]) for mid in u["inbox"]]
    return web.json_response({"missions": items})


# ---------------------------------------------------------------------------------------------
# The room: see what you share, chat (with Emma suggesting follow-up questions), then each decides
# whether to meet. Seed people are played by Emma: she chats and decides for them.

rooms = {}        # mission id -> room


def other(role):
    return "b" if role == "a" else "a"


def room_for(mid):
    if mid not in rooms:
        m = missions[mid]
        seed = next((p for p in SEED if p["id"] == m["b"]), None)
        rooms[mid] = {"chat": [], "decide": {}, "conns": {}, "bot": seed, "meet": None}
    return rooms[mid]


async def broadcast(R, msg, skip=None):
    for role, ws in list(R["conns"].items()):
        if role == skip:
            continue
        try:
            await ws.send_json(msg)
        except Exception:
            R["conns"].pop(role, None)


def snapshot(R, role):
    return {"t": "state", "you": role, "chat": R["chat"], "decided": role in R["decide"], "meet": R["meet"],
            "online": other(role) in R["conns"] or bool(R["bot"])}


async def decide(mid, role, yes):
    R = rooms[mid]
    if role in R["decide"]:
        return
    R["decide"][role] = bool(yes)
    if not yes or len(R["decide"]) == 2:
        R["meet"] = all(R["decide"].values()) and len(R["decide"]) == 2
        if R["meet"]:
            stats["met"] += 1
            save()
        await broadcast(R, {"t": "meet", "yes": R["meet"]})


async def h_ws(req):
    mid, uid = req.query.get("mission"), req.query.get("id")
    m = missions.get(mid)
    if not m or uid not in (m["a"], m["b"]):
        raise web.HTTPNotFound()
    role = "a" if m["a"] == uid else "b"
    R = room_for(mid)
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(req)
    R["conns"][role] = ws
    await ws.send_json(snapshot(R, role))
    await broadcast(R, {"t": "presence", "online": True}, skip=role)
    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            d = json.loads(msg.data)
            t = d.get("t")
            if t == "chat":
                text = str(d.get("text", "")).strip()[:500]
                if text:
                    R["chat"].append({"from": role, "text": text})
                    await broadcast(R, {"t": "chat", "from": role, "text": text}, skip=role)
                    if R["bot"]:
                        asyncio.ensure_future(bot_reply(mid))
            elif t == "ni":            # Nearby Interaction token: relayed so the two iPhones can find each other
                await broadcast(R, {"t": "ni", "token": str(d.get("token", ""))[:4000]}, skip=role)
            elif t == "decide":
                yes = bool(d.get("yes"))
                if R["bot"] and yes:
                    async def bot_yes():
                        await asyncio.sleep(2.5)
                        await decide(mid, "b", True)
                    asyncio.ensure_future(bot_yes())
                await decide(mid, role, yes)
    finally:
        if R["conns"].get(role) is ws:
            R["conns"].pop(role, None)
            await broadcast(R, {"t": "presence", "online": False})
    return ws


# ---- follow-up questions (people who ask follow-ups are liked more: Huang et al. 2017) -------

SUGGEST = """You coach someone texting a person they were just introduced to at a hackathon.
About the person you coach: {me}
About the other person: {them}

Chat so far (latest last):
{chat}

Suggest 2 short follow-up questions the person could send next. They must pick up something specific
the other person just said (a follow-up, not a new topic), show curiosity, and be under 12 words each.
Plain, casual, no emojis. JSON only: {{"ideas": ["...", "..."]}}"""


async def h_suggest(req):
    d = await req.json()
    m = missions.get(d.get("mission"))
    if not m or d.get("id") not in (m["a"], m["b"]):
        raise web.HTTPNotFound()
    role = "a" if m["a"] == d["id"] else "b"
    R = room_for(m["id"])
    me, them = person(d["id"]) or {}, person(m[other(role)]) or {}
    names = {role: me.get("name", "Me"), other(role): them.get("name", "Them")}
    chat = "\n".join(f"{names[c['from']]}: {c['text']}" for c in R["chat"][-10:])
    pick = lambda p: json.dumps({k: p.get(k) for k in ("name", "building", "needs", "offers")}, ensure_ascii=False)
    try:
        out = await ask_llm(SUGGEST.format(me=pick(me), them=pick(them), chat=chat or "(nothing yet)"))
        ideas = [str(x) for x in (out.get("ideas") or [])][:2]
    except Exception as e:
        print("suggest error:", e, flush=True)
        ideas = []
    return web.json_response({"ideas": ideas})


# ---- Emma playing a seed person ---------------------------------------------------------------

CHATBOT = """You are {name} ({role}) at the Gen AI Summit Hackathon in Athens, texting someone Emma the
matchmaker just introduced you to.
About you: building {building} Needs: {needs} Good at: {offers}
About them: {them}
What you two share: {shared}

Chat so far:
{chat}

Write your next text message. Casual, warm, specific to what they said. Answer their question and,
about half the time, ask one back. Under 25 words, no emojis, no hashtags. JSON only: {{"text": "..."}}"""


def prepare_bot(mid):
    room_for(mid)


async def bot_reply(mid):
    R = rooms[mid]
    m = missions[mid]
    b = R["bot"]
    if R.get("replying"):
        return
    R["replying"] = True
    try:
        await asyncio.sleep(1.0)
        await broadcast(R, {"t": "typing"})
        them = person(m["a"]) or {}
        chat = "\n".join(f"{b['name'] if c['from'] == 'b' else them.get('name', 'Them')}: {c['text']}" for c in R["chat"][-12:])
        shared = "; ".join(x.get("text", "") for x in m["overlap"].get("rare", []))
        out = await ask_llm(CHATBOT.format(name=b["name"], role=b["role"], building=b["building"], needs=b["needs"],
                                           offers=b["offers"], shared=shared,
                                           them=json.dumps({k: them.get(k) for k in ("name", "building", "needs", "offers")}),
                                           chat=chat))
        text = str(out.get("text", "")).strip()
        if text:
            R["chat"].append({"from": "b", "text": text})
            await broadcast(R, {"t": "chat", "from": "b", "text": text})
    except Exception as e:
        print("chat error:", e, flush=True)
    finally:
        R["replying"] = False


async def h_speak(req):
    d = await req.json()
    text = (d.get("text") or "").strip()[:600]
    if not text:
        raise web.HTTPBadRequest()
    wav = await speak_wav(text)
    return web.Response(body=wav, content_type="audio/wav")


async def h_room(req):
    return web.json_response({"stats": stats, "people": len(SEED) + sum(1 for u in users.values() if u.get("profile")),
                              "intros": len(missions)})


async def on_start(app):
    global voice
    print("loading Emma's voice…", flush=True)
    voice = await asyncio.to_thread(Voice)
    print(f"voice ready ({voice.engine}, {voice.load_ms:.0f} ms)", flush=True)
    for line in (OPENER, THINKING):                 # pre-render so the first seconds are instant
        await speak_wav(line)


def main():
    load()
    app = web.Application()
    app.router.add_post("/start", h_start)
    app.router.add_post("/turn", h_turn)
    app.router.add_post("/match", h_match)
    app.router.add_get("/inbox", h_inbox)
    app.router.add_get("/talk", h_talk)
    app.router.add_get("/ws", h_ws)
    app.router.add_get("/scan", h_scan)
    app.router.add_post("/suggest", h_suggest)
    app.router.add_post("/speak", h_speak)
    app.router.add_get("/room", h_room)
    web_index = os.path.join(HERE, "web", "index.html")      # the web app: same flow, phone and computer layouts
    app.router.add_get("/", lambda req: web.FileResponse(web_index, headers={"Cache-Control": "no-store"}))
    app.on_startup.append(on_start)
    web.run_app(app, host="0.0.0.0", port=PORT)


if __name__ == "__main__":
    main()
