"""Roomie server: Emma interviews each attendee by voice, finds the one person in the room they
should meet, and gives both of them an icebreaker mission instead of a DM.

Runs on the Mac with Emma's Python environment and speaks in Emma's voice (ElevenLabs, with the
local Kokoro voice as fallback) by importing Emma's own engine/tts.py.

    ~/Desktop/emma/.venv/bin/python server.py          # listens on 0.0.0.0:8780

Phones reach it through Cloudflare (see ../edge): the web page directly, the iPhone app through the
small server inside the app. API: ../docs/api.md.
"""
import asyncio
import hashlib
import hmac
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
MAX_TURNS = 6
STATE_FILE = os.path.join(HERE, "room.json")

OPENER = ("Hi, I'm Emma. I know pretty much everyone in this room, and I'd love to introduce you to someone. "
          "First, what's your name, and what are you building?")
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
            "socials": u.get("socials", {})}


def candidates(exclude, app=False, seeds=True):
    """Who an attendee can meet. The iPhone app and the web page are separate rooms: people on the app only
    meet each other (so their phones can find each other by Ultra Wideband), people on the web only meet
    each other. Emma's demo attendees are in both."""
    out = [person(s["id"]) for s in SEED] if seeds else []
    out += [person(uid) for uid, u in users.items()
            if uid != exclude and u.get("profile") and bool(u.get("app")) == app and not u.get("test")]
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
    lines = [f"{'Emma' if r == 'emma' else 'Attendee'}: {t}" for r, t in u["transcript"]]
    mem = u.get("memory")
    if mem:          # someone who came back: what they told Emma last time stays true unless they change it
        known = {k: mem.get(k, "") for k in ("name", "role", "building", "needs", "offers")}
        lines.insert(0, "(What Emma remembers from their last chat, still true unless they change it: "
                        + json.dumps(known, ensure_ascii=False) + ")")
    return "\n".join(lines)


KNOWN = ("name", "building", "needs", "offers", "spot")


def known_of(u):
    """What Emma has worked out about this attendee so far in the chat (kept from turn to turn, so she never
    asks for something twice). Someone who came back starts with what she remembers, except where they are."""
    k = dict.fromkeys(KNOWN, "")
    mem = u.get("memory") or {}
    k.update({f: str(mem.get(f) or "") for f in KNOWN if f != "spot"})
    k.update({f: v for f, v in (u.get("known") or {}).items() if f in k and v})
    return k


def met(uid):
    """Everyone this person has already been introduced to, either way round."""
    return {m["b"] if m["a"] == uid else m["a"] for m in missions.values() if uid in (m["a"], m["b"])}


INTERVIEW = """You are Emma, the matchmaker of the Gen AI Summit Hackathon in Athens: warm, perceptive, a little
playful, like a friend who knows everyone in the room and loves setting people up. You are getting to
know one attendee BY VOICE so you can introduce them to the one person here they should meet.

You need five things: their name; what they're building; what they need most right now; what they could
help someone else with in ten minutes; where they are in the room and something to spot them by (clothes,
a laptop sticker, anything).
{returning}
What you had worked out before their latest answer (JSON, an empty string means not known yet):
{known}

First, update what you know from the WHOLE conversation:
- People answer out of order and several things at once. "I'm Nikos, backend guy, I need a designer" gives
  you a name, something to offer and a need; "I need people to try it" is a need. Anything they said
  counts as answered, even in passing, even in reply to a different question, even in their very first
  sentence.
- A rough answer is enough. Don't dig for precision and don't ask them to confirm what they said.
- This is speech recognition, so words come out garbled: take a name or a word as it is, or guess the
  obvious meaning, and never ask them to repeat or spell it.

Then decide what to say:
- NEVER ask for something you already know, and never ask the same question twice, not even in other
  words. If they didn't answer what you asked (they talked about something else, or it came out garbled),
  don't repeat the question: come at it once from a different side, tied to what they just said. If that
  doesn't land either, leave it empty and move on.
- This is spoken aloud, by a friend, not a form. One short reaction that shows you really heard them (pick
  up a detail of what they said; never generic praise), then exactly ONE question about the first thing
  still missing, in this order: building, needs, offers, spot.
- Say their first name once, the first time you hear it, and not again after that.
- Every question has to get you one of the missing things. One sentence about what they're building is
  enough: don't ask for more detail about their project, their users or their tech out of curiosity.
- Make the question easy to answer without thinking: let it grow out of what they just said and give it
  something to hold on to, a guess or two options ("is it more the model side, or finding users?"). Never
  a bare checklist question like "What do you need?".
- Under 30 words in total. No lists, no emojis, no stage directions.
- If they cut you off, don't repeat what you were saying: just respond to them.
- When nothing is missing, set done to true and say only a short handover line like "Perfect. Give me a
  second, I'm looking around the room."

Conversation so far:
{convo}

Reply with JSON only:
{{"known": {{"name": "", "building": "", "needs": "", "offers": "", "spot": ""}}, "say": "...", "done": true|false}}"""

RETURNING = """
This attendee is BACK: you met before, and the first line of the conversation is what you remember about
them. You opened by bringing up what they were doing last time. Treat everything you remember as already
answered and never ask for it again. Whatever they say has changed replaces what you remembered; anything
they don't change stays as it was. Then ask only about what is still open, which is usually just where
they are in the room today (that changes every time).
"""
RETURN_OPENER = "Welcome back, {first}. Last time you told me about what you were building. Are you still on it, or has something moved?"

BACK = """You are Emma, the matchmaker of the Gen AI Summit Hackathon in Athens: warm, a little playful, a friend
who knows everyone in the room. Someone you already know has just come back to talk to you again.

What you remember about them (JSON):
{memory}

Who you introduced them to before: {met}

Write the one thing you say to greet them, spoken aloud. They may not remember what they told you, so YOU
bring it up, the way a friend does who remembers: mention what they were building or what they were looking
for, in your own words and in concrete terms, and, if you introduced them to someone, that person by first
name. Then ask ONE easy, open question about how it stands now ("are you still on that?", "did you find
your designer?", "did you two get to talk?"). Use their first name once. Never ask "what's changed" and
never say "I remember what you told me": show it by what you bring up. Under 35 words, no lists, no emojis.

Reply with JSON only: {{"say": "..."}}"""


async def welcome_back(u):
    """What Emma says to someone who comes back: something of theirs, brought up by her."""
    src = u.get("profile") or u.get("memory") or {}
    mem = {k: src.get(k, "") for k in ("name", "role", "building", "needs", "offers")}
    names = [n for n in ((person(pid) or {}).get("name") for pid in met(u["id"])) if n]
    try:
        out = await ask_llm(BACK.format(memory=json.dumps(mem, ensure_ascii=False),
                                        met=", ".join(names) or "nobody yet"), timeout=15)
        say = str(out.get("say", "")).strip()
        if say:
            return say
    except Exception as e:
        print("welcome back error:", e, flush=True)
    return RETURN_OPENER.format(first=(u.get("name") or "there").split()[0])


async def prepare_back(u):
    """Written right after a match, so it is ready the moment they come back."""
    u["back"] = await welcome_back(u)
    save()

MATCH = """You are Emma, the matchmaker of the Gen AI Summit Hackathon in Athens (36 hours, teams of 1-5,
build an agent that does real work). Below is your voice chat with one attendee, then everyone else in the room.

Chat:
{convo}

People in the room (JSON):
{room}

Do three things.
1. Write the attendee's profile from the chat, in short plain sentences (if the chat starts with what Emma
   remembers, keep everything they didn't change).
2. Pick the ONE person they should meet. Prefer complementary needs (one needs what the other offers,
   ideally both ways) over similar topics. Be concrete. If they said who would waste their time, respect it.
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
  "say": "what Emma says aloud when revealing the match, the way a friend introduces someone at a party. Three short spoken sentences: who they are (their name and what they do), what they are building right now, in concrete terms taken from their card, and why the two of them should talk (what the attendee gets, and what they can give back). Use the attendee's first name. Never say where they are. 45 to 65 words, no lists."}}"""


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
        # her greeting was written when she last matched them (no wait); if not, it is written now
        say = u.pop("back", None) or await welcome_back(u)
        u.update(transcript=[("emma", say)], turns=0, known={})
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
            prompt = INTERVIEW.format(convo=convo(u), known=json.dumps(known_of(u), ensure_ascii=False),
                                      returning=RETURNING if u.get("memory") else "")
            try:
                out = await ask_llm(prompt)
            except Exception as e:          # one quiet second try before she has to ask them to go on
                print("interview retry:", e, flush=True)
                out = await ask_llm(prompt)
            # what Emma knows only grows: once she has all five she stops asking, whatever the model says
            got = out.get("known") if isinstance(out.get("known"), dict) else {}
            u["known"] = {k: str(got.get(k) or "").strip() or v for k, v in known_of(u).items()}
            if all(u["known"].values()):
                out["done"] = True
        except Exception as e:
            print("interview error:", e, flush=True)
            # (their answer is already written down: she never asks them to repeat it)
            out = {"say": random.choice(["Mm, go on.", "Okay. Tell me a bit more?", "Right. And then?"]), "done": False}
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
    u.pop("cancelled", None)
    task = pending.pop(u["id"], None) or asyncio.ensure_future(run_match(u))
    try:
        r, room = await task
    except Exception as e:
        print("match error:", e, flush=True)
        return web.json_response({"error": str(e)}, status=502)
    if u.pop("cancelled", None):                       # they stopped looking meanwhile
        return web.json_response({"cancelled": True}, status=409)
    u["profile"] = r.get("me") or u.get("profile") or {}
    u["name"] = u["profile"].get("name") or u.get("name")
    them = person(r.get("match_id")) or room[0]
    mid = uuid.uuid4().hex[:8]
    missions[mid] = {"id": mid, "a": u["id"], "b": them["id"], "intro_a": r.get("intro_me", ""),
                     "intro_b": r.get("intro_them", ""), "overlap": clean_overlap(r.get("overlap") or {}),
                     "created": time.time(), "outcome": None}
    u["match"] = mid
    asyncio.ensure_future(agent_talk(mid))          # agents start talking while Emma reveals the match
    asyncio.ensure_future(prepare_back(u))          # and her greeting for next time is written
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


QUICK_ASK = ("Tell me about yourself: what you're working on, what you need most, what you can give someone, "
             "and what you're like.")
QUICK_NOTE = "(Written for me by ChatGPT, from what it knows about me from our past chats.)\n"


async def h_quick(req):
    """No talking: the attendee asked ChatGPT, which already knows them, to answer Emma's questions (with the
    prompt on the first page) and pasted its answer here. It stands in for the voice chat, and the matching
    starts at once, just as when Emma has heard enough."""
    d = await req.json()
    text = str(d.get("text") or "").strip()[:6000]
    if len(text) < 40:
        return web.json_response({"error": "That's too short. Paste ChatGPT's whole answer."}, status=400)
    spot = str(d.get("spot") or "").strip()[:200]
    u = users.get(str(d.get("id") or "")) or new_user("RoomieApp" in req.headers.get("User-Agent", ""))
    if u.get("profile"):               # someone Emma knows: anything ChatGPT doesn't mention stays as it was
        u["memory"] = dict(u["profile"])
    transcript = [("emma", QUICK_ASK), ("you", QUICK_NOTE + text)]
    if spot:
        transcript += [("emma", "And where are you in the room?"), ("you", spot)]
    u.update(transcript=transcript, turns=0, known={}, via="chatgpt")
    u.pop("cancelled", None)
    scans.pop(u["id"], None)
    pending[u["id"]] = asyncio.ensure_future(run_match(u))     # think while they add their handles
    start_scan(u)
    save()
    return web.json_response({"id": u["id"], "code": u["code"], "say": THINKING})


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
                              "socials": u.get("socials", {}), "contacts": contacts,
                              "email": u.get("email"), "name": u.get("name")})


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


# ---------------------------------------------------------------------------------------------
# Test match (the iPhone app's test button): two phones that tap it are introduced to each other at once,
# each as a made-up attendee and without talking to Emma, so the room, meeting and finding by Ultra
# Wideband can be tried. The first phone waits (it asks again every 2 s) until a second one taps.

TEST_PEOPLE = [
    ("Alex Rivera", "iOS developer", "A travel app that plans a day around the weather.",
     "Someone to test it on the streets of Athens.", "Swift, SwiftUI and App Store reviews."),
    ("Mina Park", "Product designer", "A calm budgeting app for students.",
     "An engineer who has shipped a mobile app.", "Design systems and user interviews."),
    ("Leo Costa", "ML engineer", "Live captions that translate a conversation in the room.",
     "A designer who cares about accessibility.", "Speech models and on-device inference."),
    ("Sara Kim", "Founder, edtech", "An AI tutor for kids learning to read.",
     "A technical cofounder.", "Fundraising decks and teacher networks."),
    ("Theo Laskaris", "Backend engineer", "A booking agent for small Greek restaurants.",
     "Restaurant owners to pilot it.", "APIs, Postgres and keeping servers up."),
    ("Nora Haddad", "Hardware hacker", "A wristband that finds your friends at festivals.",
     "Someone who knows Ultra Wideband on iPhone.", "Soldering, BLE and 3D printing."),
]
test_wait = {}    # user id -> when it last asked for a test match (it is waiting for a second phone)


def test_user(app):
    """A made-up attendee for one phone, with a full profile so the room and introductions work."""
    taken = {users[w]["name"] for w in test_wait if w in users}
    name, role, building, needs, offers = random.choice([t for t in TEST_PEOPLE if t[0] not in taken] or TEST_PEOPLE)
    uid = uuid.uuid4().hex[:10]
    users[uid] = {"id": uid, "name": name, "transcript": [], "socials": {}, "code": f"{random.randint(1000, 9999)}",
                  "color": random.choice(PALETTE), "match": None, "inbox": [], "turns": 0, "app": app, "test": True,
                  "profile": {"name": name, "role": role, "building": building, "needs": needs, "offers": offers,
                              "spot": "Holding the other test phone", "line": f"{name.split()[0]} is testing Roomie."}}
    return users[uid]


def test_mission(a, b):
    mid = uuid.uuid4().hex[:8]
    pa, pb = a["profile"], b["profile"]
    missions[mid] = {
        "id": mid, "a": a["id"], "b": b["id"], "test": True, "created": time.time(),
        "outcome": True, "decide": {"a": True, "b": True},      # both said yes already: straight to finding
        "intro_a": f"A test match: {b['name'].split()[0]} is on the other phone. Say yes to meet, then follow the arrow.",
        "intro_b": f"A test match: {a['name'].split()[0]} is on the other phone. Say yes to meet, then follow the arrow.",
        "overlap": clean_overlap({
            "rare": [{"text": "You're both testing Roomie right now", "opener": "Which phone are you on?"},
                     {"text": "Both your phones can find each other by Ultra Wideband", "opener": "Ready to find each other?"}],
            "you_only": [pa["building"], pa["offers"]], "them_only": [pb["building"], pb["offers"]],
            "give": pa["offers"], "get": pb["offers"],
            "ladder": ["What are you building?", "What's the hardest part so far?", "What would make tonight a win?"]}),
    }
    a["match"] = b["match"] = mid
    b["inbox"].append(mid)
    return mid


# ---------------------------------------------------------------------------------------------
# Accounts: an email and a password that lead back to the same person (what Emma remembers, the people
# she introduced) on any phone or computer. Without one, you are who this device's saved id says.
# Passwords are kept only as salted scrypt hashes.

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
login_fails = {}  # email -> [failures, time of the last one]


def pw_hash(pw, salt):
    return hashlib.scrypt(pw.encode(), salt=bytes.fromhex(salt), n=2 ** 14, r=8, p=1, dklen=32).hex()


def by_email(email):
    return next((u for u in users.values() if u.get("email") == email), None)


def new_user(app):
    uid = uuid.uuid4().hex[:10]
    users[uid] = {"id": uid, "name": None, "transcript": [("emma", OPENER)], "profile": None,
                  "socials": {}, "code": f"{random.randint(1000, 9999)}",
                  "color": random.choice(PALETTE), "match": None, "inbox": [], "turns": 0, "app": app}
    return users[uid]


async def h_account(req):
    d = await req.json()
    action = d.get("action")
    email = str(d.get("email") or "").strip().lower()[:200]
    pw = str(d.get("password") or "")[:200]
    no = lambda msg, code=400: web.json_response({"error": msg}, status=code)
    if action == "signup":
        if not EMAIL_RE.match(email):
            return no("That email doesn't look right.")
        if len(pw) < 6:
            return no("Use at least 6 characters for the password.")
        if by_email(email):
            return no("There's already an account with that email. Sign in instead.", 409)
        u = users.get(str(d.get("id") or "")) or new_user("RoomieApp" in req.headers.get("User-Agent", ""))
        if u.get("email"):
            return no(f"This device is already signed in as {u['email']}.", 409)
        salt = os.urandom(16).hex()
        u["email"], u["pw"] = email, {"salt": salt, "hash": await asyncio.to_thread(pw_hash, pw, salt)}
        save()
        return web.json_response({"id": u["id"], "email": email})
    if action == "login":
        n, last = login_fails.get(email, (0, 0))
        if n >= 5 and time.time() - last < 60:
            return no("Too many tries. Wait a minute and try again.", 429)
        u = by_email(email)
        ok = u and hmac.compare_digest(u["pw"]["hash"], await asyncio.to_thread(pw_hash, pw, u["pw"]["salt"]))
        if not ok:
            login_fails[email] = (n + 1, time.time())
            return no("Wrong email or password.", 401)
        login_fails.pop(email, None)
        return web.json_response({"id": u["id"], "email": email})
    if action == "delete":                              # everything about this person goes
        u = users.pop(str(d.get("id") or ""), None)
        if u:
            for t in (scans, pending, test_wait):
                t.pop(u["id"], None)
            save()
        return web.json_response({"ok": True})
    return no("Unknown action.")


async def h_profile(req):
    """Settings: your name and where people can follow you."""
    d = await req.json()
    u = users.get(str(d.get("id") or ""))
    if not u:
        raise web.HTTPNotFound()
    if isinstance(d.get("socials"), dict):
        u["socials"] = {k: str(v).strip().lstrip("@")[:100] for k, v in d["socials"].items()
                        if k in ("x", "instagram", "linkedin", "github") and str(v).strip()}
    name = str(d.get("name") or "").strip()[:80]
    if name:
        u["name"] = name
        if u.get("profile"):
            u["profile"]["name"] = name
    save()
    return web.json_response({"me": person(u["id"]) if u.get("profile") else None, "socials": u["socials"],
                              "name": u.get("name"), "email": u.get("email")})


async def h_match_cancel(req):
    """The search was stopped on the phone: when the match comes back, it is dropped."""
    d = await req.json()
    u = users.get(str(d.get("id") or ""))
    if u:
        u["cancelled"] = True
        scans.pop(u["id"], None)
    return web.json_response({"ok": True})


async def h_test_match(req):
    try:
        d = await req.json()
    except Exception:
        d = {}
    app = "RoomieApp" in req.headers.get("User-Agent", "")
    u = users.get(str(d.get("id") or ""))
    if not u or not u.get("test"):
        u = test_user(app)
    now = time.time()
    if d.get("cancel"):
        test_wait.pop(u["id"], None)
        return web.json_response({"me": person(u["id"])})
    mid = u.pop("test_mid", None)                     # the other phone tapped first and matched us
    if not mid:
        for w, at in list(test_wait.items()):
            if now - at > 8 or w not in users:          # stopped asking: that phone left
                test_wait.pop(w, None)
        other = next((users[w] for w in test_wait if w != u["id"] and bool(users[w].get("app")) == bool(app)), None)
        if other:
            test_wait.pop(other["id"], None)
            mid = test_mission(u, other)
            other["test_mid"] = mid
    if not mid:
        test_wait[u["id"]] = now
        save()
        return web.json_response({"waiting": True, "me": person(u["id"])})
    test_wait.pop(u["id"], None)
    save()
    them = missions[mid]["b"] if missions[mid]["a"] == u["id"] else missions[mid]["a"]
    return web.json_response({"say": f"Test match with {users[them]['name'].split()[0]}.",
                              "me": person(u["id"]), "mission": mission_for(mid, u["id"])})


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
    app.router.add_post("/quick", h_quick)
    app.router.add_post("/match", h_match)
    app.router.add_post("/test/match", h_test_match)
    app.router.add_post("/match/cancel", h_match_cancel)
    app.router.add_post("/account", h_account)
    app.router.add_post("/profile", h_profile)
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
