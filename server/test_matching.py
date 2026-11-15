"""Checks for matching.py, and a live run that prints who Emma would introduce.

    python3 test_matching.py            # the rules, no model
    python3 test_matching.py --live     # one round for 30 people + one newcomer, sparks written by the model
"""
import asyncio
import random
import sys

import llm as L
import matching as M

# name, role, building, needs, offers, hooks
PEOPLE = [
    ("Eleni Markou", "Product designer, ex-fintech", "A language tutor that notices when you're lost.",
     "A backend engineer who has shipped agents.", "Interface design, Figma, a finished-looking demo in one night.",
     ["Designed banking apps for four years", "Keeps bees on her roof"]),
    ("Tom Becker", "Voice infrastructure engineer", "Voice agents you can interrupt mid-sentence.",
     "A designer and a real use case with real users.", "Streaming speech, websockets, latency tuning.",
     ["Measures everything in milliseconds", "Plays bouzouki badly"]),
    ("Nikos Alexiou", "Medical student", "An agent that writes the hospital discharge letter while the doctor talks.",
     "Someone strong on frontend, and help with small models.", "Knows how clinics work, ten doctors ready to test.",
     ["Watched doctors lose two hours a day to paperwork", "Night shifts in an emergency room"]),
    ("Priya Raman", "ML engineer, small models", "Agents that run on a 3B model on a laptop, no cloud.",
     "Real users and help telling the story on stage.", "Fine-tuning, evals, small models doing big-model jobs.",
     ["Thinks startups pay for model size they don't need", "Competitive chess as a teenager"]),
    ("Dimitra Kosta", "Founder of a language school", "Speaking practice for 400 students too shy to talk in class.",
     "Anyone who can build a voice agent.", "400 students to test with tomorrow, Greek market know-how.",
     ["Has zero engineers", "Taught Greek to sailors one summer"]),
    ("Sam Okafor", "Full-stack developer", "Nothing yet. Wants to join the best idea in the room.",
     "A good idea and a designer.", "React, Swift, backend, deploys. A working URL by tonight.",
     ["Won two hackathons by joining someone else's idea", "Runs marathons"]),
    ("Lena Vogt", "Angel investor, pre-seed", "Looking for teams whose agent does a real job end to end.",
     "To see agents doing work, not slides.", "Pitch feedback and intros to European seed funds.",
     ["Will ask to see the agent, not the deck", "Former competitive sailor"]),
    ("Yusuf Demir", "Robotics and sensors", "A robot arm that sorts recycling by listening to you.",
     "Speech recognition and a nicer interface.", "Hardware, sensors, a robot arm he brought with him.",
     ["Brought a robot arm nobody has asked about", "Repairs old radios"]),
    ("Maria Papadaki", "Growth marketer", "Helping one team here go viral by Monday.",
     "A team with a demo worth filming.", "Distribution, short-form video, launch copy, 10k followers.",
     ["Films everything on her phone", "Was a wedding DJ"]),
    ("Chen Wei", "Audio ML researcher", "Speech models that understand elderly speakers.",
     "A designer and people to test with.", "Speech recognition, voice cloning, audio models.",
     ["Speech is the only interface his grandmother uses", "Plays bouzouki, learned in Thessaloniki"]),
    ("Kai Lindqvist", "iOS developer, ex-bank", "An agent that reads restaurant menus in any language.",
     "A designer, and travellers to test it.", "iOS, Swift, on-device models.",
     ["Left a bank job last month", "Has eaten in 40 countries"]),
    ("Sofia Reyes", "Travel blogger", "A trip planner that argues with you about your budget.",
     "Someone technical to build the agent.", "30k travellers who read her newsletter, storytelling.",
     ["Lived out of a backpack for three years", "Hates airports"]),
    ("Giorgos Pappas", "Beekeeper and data analyst", "Hive monitoring that warns before a colony collapses.",
     "Hardware help with sensors and a mobile app.", "Data pipelines, dashboards, statistics.",
     ["Keeps forty hives on Hymettus", "Sells honey at the Saturday market"]),
    ("Aisha Bello", "Nurse turned product manager", "Shift handover notes written by an agent.",
     "An ML engineer for small private models.", "Hospital workflows, user interviews, nurses to test with.",
     ["Ten years of night shifts", "Thinks most health apps are built by people who never saw a ward"]),
    ("Marco Ferri", "Game designer", "A dungeon master agent that remembers your campaign.",
     "Voice and audio so the dungeon master can speak.", "Game feel, narrative design, playtesting.",
     ["Has run the same tabletop campaign for nine years", "Competitive chess, still plays blitz"]),
    ("Hana Sato", "Linguist", "Pronunciation feedback for tonal languages.",
     "An engineer for real-time speech.", "Phonetics, annotation, five languages.",
     ["Can tell your home town from three sentences", "Sings in a choir"]),
    ("Petros Vlachos", "Lawyer", "An agent that reads rental contracts and flags the traps.",
     "A full-stack developer and first users.", "Greek contract law, landlords and tenants to test with.",
     ["Lost his own deposit twice", "Sails every August"]),
    ("Zoe Carter", "Backend engineer, payments", "An agent that reconciles invoices for small shops.",
     "A designer and a shop owner to test with.", "Backend, databases, payment APIs, agents in production.",
     ["Spent five years at a bank and escaped", "Bakes sourdough"]),
    ("Omar Haddad", "Cafe owner", "Wants an agent that does his supplier orders.",
     "Any engineer. He cannot code.", "A real cafe to test in, suppliers, daily invoices.",
     ["Does his accounting at 2am", "Roasts his own coffee"]),
    ("Ingrid Solberg", "Climate researcher", "Agents that read satellite images for wildfire risk.",
     "Frontend and someone who knows maps.", "Remote sensing, Python, grant writing.",
     ["Was evacuated from a wildfire in 2021", "Runs marathons"]),
    ("Theo Mavros", "Frontend developer, maps", "Open to ideas. Loves anything with a map.",
     "A project with real data.", "React, map rendering, animations.",
     ["Draws maps of imaginary islands", "Repairs old radios with his father"]),
    ("Lucia Gomez", "Teacher", "Homework feedback that sounds like a kind teacher, not a robot.",
     "An engineer and a small model that runs offline.", "A class of 28 students, lesson design.",
     ["Her school has no reliable internet", "Was a wedding singer"]),
    ("Dev Malhotra", "DevOps engineer", "Agents that fix their own failed deploys.",
     "A story. Nobody understands why it matters.", "Infrastructure, deploys, on-call war stories.",
     ["Was paged 14 times in one night", "Roasts his own coffee"]),
    ("Anna Kowalska", "Journalist", "An agent that checks quotes against recordings.",
     "Speech recognition that handles accents.", "Interviewing, editing, storytelling on stage.",
     ["Once misquoted a minister and never forgot it", "Sings in a choir"]),
    ("Ravi Iyer", "Student, first hackathon", "Not sure yet. Came to learn.",
     "A team that will let him help.", "Python, enthusiasm, free all weekend.",
     ["First hackathon, knows nobody here", "Speedcubes"]),
    ("Elif Kaya", "UX researcher", "Testing whether people trust agents that admit doubt.",
     "Teams with a working agent to study.", "User testing, interview scripts, twenty testers on call.",
     ["Thinks confident agents are the dangerous ones", "Bakes sourdough"]),
    ("Jonas Weber", "Hardware hacker", "A badge that vibrates when your match is near.",
     "A backend for presence and someone for the app.", "Electronics, Bluetooth, soldering, 3D printing.",
     ["Carries a soldering iron everywhere", "Speedcubes"]),
    ("Carmen Ortiz", "Opera singer and coder", "A vocal coach agent for breathing exercises.",
     "Audio models and a designer.", "Voice technique, stage presence, Python.",
     ["Sang at La Scala once", "Thinks most voice apps are built by people who cannot sing"]),
    ("Stavros Nikolaou", "Farmer's son, agronomist", "An agent that tells farmers when to irrigate, by phone call.",
     "Voice agents in Greek.", "Farmers to test with, soil data, Greek dialects.",
     ["His father will not use an app", "Keeps bees with his grandfather"]),
    ("Mei Tanaka", "Accessibility engineer", "Screen reader agents for elderly users.",
     "Elderly people to test with.", "Accessibility audits, frontend, screen readers.",
     ["Built her grandmother's first phone setup", "Hates airports"]),
]


def people(n=len(PEOPLE)):
    return [{"id": f"p{i + 1}", "name": a, "role": b, "building": c, "needs": d, "offers": e, "hooks": f}
            for i, (a, b, c, d, e, f) in enumerate(PEOPLE[:n])]


def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def check():
    # a round: everyone is in exactly one group
    room = M.Room(people(30), rng=random.Random(1))
    ms = run(M.match_round(room))
    seen = [i for m in ms for i in m["ids"]]
    assert len(ms) == 15 and sorted(seen) == sorted(room.people), "round of 30: 15 pairs, everyone once"
    assert all(m["teases"].keys() == set(m["ids"]) and m["mission"] for m in ms), "every group has a spark"

    # an odd number: one trio, nobody left out
    room = M.Room(people(29), rng=random.Random(1))
    ms = run(M.match_round(room))
    assert sorted(len(m["ids"]) for m in ms) == [2] * 13 + [3], "29 people: 13 pairs and a trio"
    assert sum(len(m["ids"]) for m in ms) == 29

    # a second round never repeats a pair
    room = M.Room(people(30), rng=random.Random(2))
    r1 = {frozenset(m["ids"]) for m in run(M.match_round(room))}
    r2 = {frozenset(m["ids"]) for m in run(M.match_round(room))}
    assert not r1 & r2, "round two: all new pairs"

    # people arriving one by one: nobody holds more than MAX_OPEN open introductions while others are free
    room = M.Room(people(30), rng=random.Random(3))
    for pid in list(room.people):
        m = run(M.match_one(room, pid))
        assert m and m["ids"][0] == pid
    assert max(room.open.values()) <= M.MAX_OPEN + 1, room.open       # +1: the one they asked for themselves
    assert all(room.intros.get(p) for p in room.people), "everyone has at least one introduction"

    # three people: each meets the other two, then it still returns someone
    room = M.Room(people(3), rng=random.Random(4))
    got = [run(M.match_one(room, "p1"))["ids"][1] for _ in range(3)]
    assert set(got[:2]) == {"p2", "p3"} and got[2] in ("p2", "p3"), got

    # alone in the room: no match
    assert run(M.match_one(M.Room(people(1)), "p1")) is None

    # a rare shared detail outranks a common one
    room = M.Room(people(30))
    bees = room.links("p1", "p29")            # Eleni and Stavros both keep bees
    assert "bees" in bees["shared"], bees
    assert room.idf("bees") > room.idf("voice"), "rare words weigh more than common ones"

    # the model inventing an id, or failing, still gives a match
    async def liar(prompt):
        return {"picks": [{"id": "nobody", "recipe": "useful", "pull": 99}]}

    async def broken(prompt):
        raise RuntimeError("down")

    for llm in (liar, broken):
        m = run(M.match_one(M.Room(people(30), rng=random.Random(5)), "p25", llm))
        assert m and m["ids"][1] in {f"p{i}" for i in range(1, 31)} and m["teases"]["p25"]

    # a big room: some wildcards, still everyone once
    big = [dict(p, id=f"{p['id']}-{k}") for k in range(3) for p in people(30)]
    room = M.Room(big, rng=random.Random(6))
    ms = run(M.match_round(room))
    assert len(ms) == 45 and any(m["mode"] == "wildcard" for m in ms)
    print("all checks passed")


async def live():
    llm = L.ask
    print("model:", L.ENGINE)
    room = M.Room(people(29), rng=random.Random(7))
    name = lambda i: room.people[i]["name"]
    show = lambda m: print(f"\n{' + '.join(name(i) for i in m['ids'])}   [{m['recipe']}, {m['mode']}]\n"
                           + "".join(f"  to {M.first(room.people[i])}: {t}\n" for i, t in m["teases"].items())
                           + f"  mission: {m['mission']}\n  ladder: {' / '.join(m['ladder'])}")
    print("=== a round for 29 people ===")
    for m in await M.match_round(room, llm):
        show(m)
    print("\n=== a newcomer arrives ===")
    new = people(30)[29]
    room.add(new)
    m = await M.match_one(room, new["id"], llm)
    show(m)
    print(f"  Emma says: {m['say']}")


if __name__ == "__main__":
    run(live()) if "--live" in sys.argv else check()
