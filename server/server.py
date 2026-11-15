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

import llm
import matching as M

HERE = os.path.dirname(os.path.abspath(__file__))
EMMA = os.path.expanduser("~/Desktop/emma")
sys.path.insert(0, EMMA)
from engine.tts import Voice  # noqa: E402

PORT = int(os.environ.get("PORT", 8780))
MAX_TURNS = 6
STATE_FILE = os.path.join(HERE, "room.json")

OPENER = ("Hi, I'm Emma. I know pretty much everyone in this room, and I'd love to introduce you to someone. "
          "First, what's your name, and what are you building?")
TOPICS = ["(2) what they need most right now", "(3) what they could help someone else with",
          "(4) where they are in the room and how to spot them", M.HOOK_TOPIC]
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
        tmp = STATE_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"users": users, "missions": missions, "stats": stats}, f)
        os.replace(tmp, STATE_FILE)                    # never leave a half-written room.json
    except (OSError, TypeError, ValueError) as e:
        print("save error:", e, flush=True)


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
            "hooks": p.get("hooks", []), "socials": u.get("socials", {})}


def candidates(exclude, app=False, seeds=True):
    """Who an attendee can meet. The iPhone app and the web page are separate rooms: people on the app only
    meet each other (so their phones can find each other by Ultra Wideband), people on the web only meet
    each other. Emma's demo attendees are in both."""
    out = [person(s["id"]) for s in SEED] if seeds else []
    out += [person(uid) for uid, u in users.items()
            if uid != exclude and u.get("profile") and bool(u.get("app")) == app]
    return out


# ---------------------------------------------------------------------------------------------
# Language model (llm.py): Gemini when GEMINI_API_KEY is set, else one-shot `claude -p` calls.

ask_llm = llm.ask


def convo(u):
    lines = [f"{'Emma' if r == 'emma' else 'Attendee'}: {t}" for r, t in u["transcript"]]
    mem = u.get("memory")
    if mem:          # someone who came back: what they told Emma last time stays true unless they change it
        known = {k: mem.get(k, "") for k in ("name", "role", "building", "needs", "offers")}
        lines.insert(0, "(What Emma remembers from their last chat, still true unless they change it: "
                        + json.dumps(known, ensure_ascii=False) + ")")
    return "\n".join(lines)


def met(uid):
    """Everyone this person has already been introduced to, either way round."""
    return {m["b"] if m["a"] == uid else m["a"] for m in missions.values() if uid in (m["a"], m["b"])}


INTERVIEW = """You are Emma, the matchmaker of the Gen AI Summit Hackathon in Athens: warm, perceptive, a little
playful, like a friend who knows everyone in the room and loves setting people up. You are getting to
know one attendee BY VOICE so you can introduce them to the one person here they should meet.

You need five things: (1) their name and what they're building, (2) what they need most right now,
(3) what they could help someone else with in ten minutes, (4) where they are in the room and
something to spot them by (clothes, a laptop sticker, anything), (5) one thing that has nothing to do
with work that they could talk about for an hour (ask it lightly, as the fun last question).
{returning}
Rules for what you say next:
- This is spoken aloud. One short reaction (a few words, specific to what they said, never generic
  praise) then exactly ONE question. Under 25 words total. No lists, no emojis, no stage directions.
- Ask about the FIRST topic in this list that they have not already answered: {todo}
  Never ask about a later topic before an earlier one. If an answer was too vague to use, ask one
  sharper follow-up on that same topic instead.
- If they cut you off, don't repeat what you were saying: just respond to them.
- When all five are answered, set done to true and say only a short handover line like "Perfect. Give
  me a second, I'm looking around the room."

Conversation so far:
{convo}

Reply with JSON only: {{"say": "...", "done": true|false}}"""

RETURNING = """
This attendee is BACK: you met before, and the first line of the conversation is what you remember about
them. Treat everything you remember as already answered and never ask for it again. Their answer to "what's
changed" updates it; anything they don't change stays as it was. Then ask only about what is still open,
which is usually just where they are in the room today (that changes every time).
"""
RETURN_OPENER = "Welcome back, {first}. I remember what you told me last time. What's changed?"


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
hearing = None              # Emma's Parakeet speech-to-text, for the web page
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
    try:
        d = await req.json()
    except Exception:
        d = {}
    u = users.get(str(d.get("id") or ""))
    if u and u.get("profile"):      # back again: Emma remembers them and only asks what's changed
        u["memory"] = dict(u["profile"])
        say = RETURN_OPENER.format(first=(u.get("name") or "there").split()[0])
        u.update(transcript=[("emma", say)], turns=0)
        scans.pop(u["id"], None)
        pending.pop(u["id"], None)
        save()
        return web.json_response({"id": u["id"], "say": say, "code": u["code"]})
    uid = uuid.uuid4().hex[:10]
    users[uid] = {"id": uid, "name": None, "transcript": [("emma", OPENER)], "profile": None,
                  "socials": {}, "code": f"{random.randint(1000, 9999)}",
                  "color": random.choice(PALETTE), "match": None, "inbox": [], "turns": 0,
                  "app": "RoomieApp" in req.headers.get("User-Agent", "")}      # the iPhone app (WKWebView)
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
            out = await ask_llm(INTERVIEW.format(convo=convo(u), todo=todo,
                                                 returning=RETURNING if u.get("memory") else ""))
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
    u["profile"] = r.get("me") or u.get("profile") or {}
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
    seen = met(u["id"])
    room = candidates(u["id"], bool(u.get("app")))
    room = ([p for p in room if p["id"] not in seen] or room)[:14]     # people they haven't met yet
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


async def h_again(req):
    """From the home page: find someone new with what Emma already remembers, no new chat."""
    d = await req.json()
    u = users.get(d.get("id"))
    if not u or not u.get("profile"):
        raise web.HTTPNotFound()
    scans.pop(u["id"], None)
    pending[u["id"]] = asyncio.ensure_future(run_match(u))
    start_scan(u)
    return web.json_response({"ok": True})


async def h_me(req):
    """Home page: what Emma remembers about you, and everyone she has introduced you to."""
    u = users.get(req.query.get("id"))
    if not u:
        raise web.HTTPNotFound()
    contacts = []
    for mid, m in missions.items():
        if u["id"] not in (m["a"], m["b"]):
            continue
        mf = mission_for(mid, u["id"])
        if not mf["person"]:
            continue
        chat = m.get("chat") or []
        contacts.append({**mf, "you": "a" if m["a"] == u["id"] else "b", "chat": chat[-30:],
                         "at": max([m.get("created", 0)] + [c.get("at", 0) for c in chat])})
    contacts.sort(key=lambda c: -c["at"])
    return web.json_response({"me": person(u["id"]) if u.get("profile") else None,
                              "socials": u.get("socials", {}), "contacts": contacts})


def _int(v, default):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


async def run_match(u):
    app = bool(u.get("app"))
    # on the app: another app user if there is one (the first one in gets a demo attendee for now,
    # and is introduced to the next app user through their inbox)
    # and always someone new: people they've already met are left out (unless they've met everyone)
    seen = met(u["id"])
    new = lambda ps: [p for p in ps if p["id"] not in seen]
    room = (app and new(candidates(u["id"], True, seeds=False))) or new(candidates(u["id"], app)) \
        or candidates(u["id"], app)
    me = await M.profile(convo(u), ask_llm)
    if u.get("memory"):                       # back again: what they didn't mention stays as it was
        me = {**u["memory"], **{k: v for k, v in me.items() if v}}
    ids = {p["id"] for p in room} | {u["id"]}
    R = M.Room(room + [{"id": u["id"], **me}], [m for m in missions.values() if m["a"] in ids and m["b"] in ids])
    m = await M.match_one(R, u["id"], ask_llm)
    if not m:
        raise RuntimeError("nobody else in the room")
    b, sh = m["ids"][1], m["share"]
    note = lambda pid: f"{m['teases'][pid]} Your mission together: {m['mission']}"
    return {"me": me, "match_id": b, "intro_me": note(u["id"]), "intro_them": note(b), "say": m["say"],
            "overlap": {"rare": sh["rare"], "you_only": sh["first_only"], "them_only": sh["second_only"],
                        "give": sh["give"], "get": sh["get"], "ladder": m["ladder"],
                        "mission": m["mission"], "recipe": m["recipe"]}}, room


def clean_overlap(o):
    rare = [{"text": str(x.get("text", "")), "opener": str(x.get("opener", ""))}
            for x in (o.get("rare") or []) if isinstance(x, dict)][:3]
    strs = lambda v: [str(x) for x in (v or [])][:3]
    return {"rare": rare, "you_only": strs(o.get("you_only")), "them_only": strs(o.get("them_only")),
            "give": str(o.get("give", "")), "get": str(o.get("get", "")), "ladder": strs(o.get("ladder")),
            "mission": str(o.get("mission", "")), "recipe": str(o.get("recipe", ""))}


def overlap_for(o, mine):
    """The overlap seen from one side: the match sees give/get and the two sides swapped."""
    if mine:
        return o
    return {**o, "you_only": o["them_only"], "them_only": o["you_only"], "give": o["get"], "get": o["give"]}


def mission_for(mid, viewer):
    m = missions[mid]
    mine = m["a"] == viewer
    other = m["b"] if mine else m["a"]
    return {"id": mid, "intro": m["intro_a"] if mine else m["intro_b"],
            "overlap": overlap_for(m.get("overlap") or clean_overlap({}), mine),
            "person": person(other), "outcome": m.get("outcome")}


def card(p):
    return json.dumps({k: p.get(k, "") for k in ("name", "role", "building", "needs", "offers", "line")},
                      ensure_ascii=False)


async def agent_talk(mid):
    """Two agents talk first. Generated once, cached on the mission."""
    m = missions[mid]
    if m.get("talk"):
        return m["talk"]
    t = talk_tasks.get(mid)                   # kept off the mission so save() never meets a Task
    if not t:
        t = talk_tasks[mid] = asyncio.ensure_future(
            ask_llm(AGENT_TALK.format(a=card(person(m["a"])), b=card(person(m["b"]))), timeout=60))
    try:
        r = await t
    except Exception:
        talk_tasks.pop(mid, None)
        raise
    turns = [{"who": "b" if x.get("who") == "b" else "a", "text": str(x.get("text", ""))[:240]}
             for x in (r.get("turns") or [])[:10] if x.get("text")]
    m["talk"] = {"turns": turns, "fit": max(0, min(100, _int(r.get("fit"), 70))),
                 "why_a": str(r.get("why_a", "")), "why_b": str(r.get("why_b", "")), "ask": str(r.get("ask", ""))}
    if m["talk"]["ask"]:
        m.setdefault("overlap", {})["agent_ask"] = m["talk"]["ask"]   # the humans can open with what the agents found
    talk_tasks.pop(mid, None)
    save()
    return m["talk"]


talk_tasks = {}   # mission id -> running agent-to-agent talk


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
        # the chat and the yes/no live on the mission, so they are saved and still there next time
        rooms[mid] = {"chat": m.setdefault("chat", []), "decide": m.setdefault("decide", {}), "conns": {},
                      "bot": seed, "meet": m.get("outcome"), "ni": {}, "gps": {}}
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
        missions[mid]["outcome"] = R["meet"]
        if R["meet"]:
            stats["met"] += 1
        await broadcast(R, {"t": "meet", "yes": R["meet"]})
    save()


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
    if R.get("ni", {}).get(other(role)):       # the other phone's token, in case it was sent before we joined
        await ws.send_json({"t": "ni", "token": R["ni"][other(role)]})
    if R.get("gps", {}).get(other(role)):      # the other person's last known location
        await ws.send_json(R["gps"][other(role)])
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
                    R["chat"].append({"from": role, "text": text, "at": time.time()})
                    save()
                    await broadcast(R, {"t": "chat", "from": role, "text": text}, skip=role)
                    if R["bot"]:
                        asyncio.ensure_future(bot_reply(mid))
            elif t == "ni":            # Nearby Interaction token: relayed so the two iPhones can find each other
                tok = str(d.get("token", ""))[:4000]
                R.setdefault("ni", {})[role] = tok
                await broadcast(R, {"t": "ni", "token": tok}, skip=role)
            elif t == "gps":           # web finding: share each person's filtered location with the other
                try:
                    g = {"t": "gps", "lat": float(d["lat"]), "lon": float(d["lon"]), "acc": float(d.get("acc", 30))}
                except (KeyError, TypeError, ValueError):
                    continue
                R.setdefault("gps", {})[role] = g
                await broadcast(R, g, skip=role)
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
            R["chat"].append({"from": "b", "text": text, "at": time.time()})
            save()
            await broadcast(R, {"t": "chat", "from": "b", "text": text})
    except Exception as e:
        print("chat error:", e, flush=True)
    finally:
        R["replying"] = False


async def h_hear(req):
    """The web page's ears: 16 kHz mono int16 PCM in, Parakeet's text out. The browser's own recogniser
    is much less accurate, so the page sends its audio here (it falls back to the browser if this fails)."""
    if hearing is None:
        raise web.HTTPServiceUnavailable(text="no speech model")
    pcm = await req.read()
    if len(pcm) < 3200:                                  # under 0.1 s: nothing said
        return web.json_response({"text": ""})
    pcm = pcm[: 16000 * 2 * 90]                          # at most 90 s
    text = await asyncio.wrap_future(hearing.transcribe(pcm))
    return web.json_response({"text": text})


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
    global voice, hearing
    try:
        from engine.stt import Hearing
        hearing = await asyncio.to_thread(Hearing)
        print("ears ready (Parakeet)", flush=True)
    except Exception as e:                              # needs Emma's venv (mlx); the page then uses the browser's
        print(f"no Parakeet ({e}); the web page will use the browser's speech recognition", flush=True)
    print("loading Emma's voice…", flush=True)
    voice = await asyncio.to_thread(Voice)
    print(f"voice ready ({voice.engine}, {voice.load_ms:.0f} ms)", flush=True)
    for line in (OPENER, THINKING):                 # pre-render so the first seconds are instant
        await speak_wav(line)


def main():
    load()
    app = web.Application(client_max_size=8 * 1024 * 1024)
    app.router.add_post("/hear", h_hear)
    app.router.add_post("/start", h_start)
    app.router.add_post("/turn", h_turn)
    app.router.add_post("/match", h_match)
    app.router.add_get("/inbox", h_inbox)
    app.router.add_get("/talk", h_talk)
    app.router.add_get("/ws", h_ws)
    app.router.add_get("/scan", h_scan)
    app.router.add_post("/again", h_again)
    app.router.add_get("/me", h_me)
    app.router.add_post("/suggest", h_suggest)
    app.router.add_post("/speak", h_speak)
    app.router.add_get("/room", h_room)
    web_index = os.path.join(HERE, "web", "index.html")      # the web app: same flow, phone and computer layouts
    app.router.add_get("/", lambda req: web.FileResponse(web_index, headers={"Cache-Control": "no-store"}))
    app.router.add_static("/hands/", os.path.join(HERE, "web", "hands"))   # Emma's hands: three.js + Handkit (MIT)
    app.on_startup.append(on_start)
    web.run_app(app, host="0.0.0.0", port=PORT)


if __name__ == "__main__":
    main()
