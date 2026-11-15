// node --test edge/test/judge.test.mjs   (no network: the Decisions API is replaced by a fake)
import { test } from "node:test";
import assert from "node:assert/strict";
import * as M from "../src/matching.js";
import { decide, DECIDE } from "../src/llm.js";

const person = (id, name, extra = {}) => ({ id, name, role: "builder", building: `${name}'s project`, needs: "", offers: "", hooks: [], ...extra });

/** A fake judge: answers come from `table[name]` = {a, b, kinds}, found by the name each question names. */
function fakeDecide(table, calls = []) {
  return async (input, questions) => {
    calls.push({ input, questions });
    const out = {};
    for (const [key, q] of Object.entries(questions)) {
      const name = q.instructions.match(/#\d+ \(([^)]+)\)/)[1];
      const row = table[name] || { a: 0.5, b: 0.5, kinds: { none: 1 } };
      if (key[0] === "a") out[key] = { type: "noul", noul: row.a, confidence: 0.9 };
      if (key[0] === "b") out[key] = { type: "noul", noul: row.b, confidence: 0.9 };
      if (key[0] === "k") {
        const probabilities = { useful: 0, twin: 0, pain: 0, clash: 0, none: 0, ...row.kinds };
        out[key] = { type: "choice", choice: Object.entries(probabilities).sort((x, y) => y[1] - x[1])[0][0], probabilities, confidence: 0.9 };
      }
    }
    return out;
  };
}

test("three valid questions per person, five kinds to choose from, at most 1,000 per call", () => {
  const me = person("m", "Maya");
  const group = Array.from({ length: 333 }, (_, i) => person(`p${i}`, `Person ${i}`));
  const q = M.judgeQuestions(me, group);
  assert.equal(Object.keys(q).length, 999);
  for (const k of Object.keys(q)) assert.match(k, /^[A-Za-z0-9_-]{1,64}$/);
  assert.deepEqual(Object.keys(q.k0.criteria).sort(), ["clash", "none", "pain", "twin", "useful"]);
  assert.equal(q.a0.type, "noul");
  assert.equal(q.b0.type, "noul");
  assert.equal(q.k0.type, "choice");
  const input = M.judgeInput(me, group.slice(0, 2));
  assert.match(input, /#0 Person 0: /);
  assert.match(input, /#1 Person 1: /);
});

test("a big room is split into calls of at most 1,000 questions, and everyone is judged", async () => {
  const me = person("m", "Maya");
  const people = Array.from({ length: 400 }, (_, i) => person(`p${i}`, `Person ${i}`));
  const calls = [];
  const cache = await M.judge(me, people, fakeDecide({}, calls));
  assert.equal(calls.length, 2);
  for (const c of calls) assert.ok(Object.keys(c.questions).length <= 1000);
  assert.equal(Object.keys(cache).length, 400);
});

test("both sides count: wanted by one side only scores below a pair that suits both", async () => {
  const me = person("m", "Maya");
  const people = [person("x", "Xena"), person("y", "Yann")];
  const cache = await M.judge(me, people, fakeDecide({
    Xena: { a: 0.95, b: 0.05, kinds: { useful: 0.9, none: 0.1 } },
    Yann: { a: 0.7, b: 0.7, kinds: { useful: 0.9, none: 0.1 } },
  }));
  const { fits } = M.fitsFrom(cache, "m", ["x", "y"]);
  assert.ok(fits.y > fits.x, JSON.stringify(fits));
  assert.ok(fits.x < 25);
});

test("no reason to talk means a low pull, and the kind of pair comes from the judge", async () => {
  const me = person("m", "Maya");
  const people = [person("x", "Xena"), person("y", "Yann")];
  const cache = await M.judge(me, people, fakeDecide({
    Xena: { a: 0.9, b: 0.9, kinds: { none: 0.9, useful: 0.1 } },
    Yann: { a: 0.8, b: 0.8, kinds: { twin: 0.7, useful: 0.2, none: 0.1 } },
  }));
  const { fits, recipes } = M.fitsFrom(cache, "m", ["x", "y"]);
  assert.ok(fits.x <= 10, JSON.stringify(fits));
  assert.equal(recipes.y, "twin");
});

test("a pair is judged once, again only when either profile changes, and is read from both sides", async () => {
  const me = person("m", "Maya");
  const xena = person("x", "Xena");
  const yann = person("y", "Yann");
  const cache = await M.judge(me, [xena, yann], fakeDecide({ Xena: { a: 0.9, b: 0.3, kinds: { useful: 1 } } }));
  assert.deepEqual(M.toJudge(cache, me, [xena, yann]), []);
  const xena2 = { ...xena, offers: "now also design" };
  assert.deepEqual(M.toJudge(cache, me, [xena2, yann]).map(p => p.id), ["x"]);
  const me2 = { ...me, needs: "a designer" };
  assert.deepEqual(M.toJudge(cache, me2, [xena, yann]).map(p => p.id).sort(), ["x", "y"]);
  assert.deepEqual(M.toJudge(cache, xena, [me, yann]).map(p => p.id), ["y"]);    // Xena's pair with Maya is already known
  const mine = M.fitsFrom(cache, "m", ["x"]).fits.x, hers = M.fitsFrom(cache, "x", ["m"]).fits.m;
  assert.equal(mine, hers);
});

test("a failed call or a broken answer never throws, and leaves only those people out", async () => {
  const me = person("m", "Maya");
  const people = [person("x", "Xena"), person("y", "Yann")];
  assert.deepEqual(await M.judge(me, people, async () => { throw new Error("decision 503"); }), {});
  const cache = await M.judge(me, people, async () => ({ a0: { noul: 0.8 }, b0: { noul: 0.8 }, k0: { probabilities: { useful: 1 } }, a1: { noul: "x" } }));
  assert.deepEqual(Object.keys(cache), ["m|x"]);
});

test("pick follows the judge in a full room, with the judge's kind of pair", async () => {
  const people = Array.from({ length: 9 }, (_, i) => person(`p${i}`, `Person ${i}`));
  const me = people[0];
  const table = {};
  for (let i = 1; i < 9; i++) table[`Person ${i}`] = { a: 0.3, b: 0.3, kinds: { useful: 0.5, none: 0.5 } };
  table["Person 6"] = { a: 0.9, b: 0.85, kinds: { pain: 0.8, none: 0.2 } };
  const cache = await M.judge(me, people.slice(1), fakeDecide(table));
  const R = new M.Room(people, [], M.makeRng(1));
  const { fits, recipes } = M.fitsFrom(cache, me.id, people.slice(1).map(p => p.id));
  const p = await M.pick(R, me.id, null, fits, recipes);
  assert.equal(p.b, "p6");
  assert.equal(p.recipe, "pain");
  assert.equal(p.mode, "room");
});

test("with no answers at all, pick still makes a match from the cards", async () => {
  const people = Array.from({ length: 9 }, (_, i) => person(`p${i}`, `Person ${i}`));
  const R = new M.Room(people, [], M.makeRng(1));
  const p = await M.pick(R, "p0", null, {}, {});
  assert.ok(p && p.b && p.b !== "p0");
  assert.equal(p.by, "cards");
});

test("the persona is read by the judge and changes the fingerprint", () => {
  const plain = person("m", "Maya");
  const rich = { ...plain, persona: { goals: { looking_for: ["a UX designer"] }, offers: ["Python backends"], rare: ["ran a hostel in Naxos"] } };
  const c = M.judgeCard(rich);
  assert.deepEqual(c.looking_for, ["a UX designer"]);
  assert.deepEqual(c.rare, ["ran a hostel in Naxos"]);
  assert.equal(c.id, undefined);
  assert.notEqual(M.sig(plain), M.sig(rich));
});

test("decide() posts to the Decisions API with the key and model, and retries once when busy", async () => {
  const real = globalThis.fetch;
  const seen = [];
  let n = 0;
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init });
    if (n++ === 0) return new Response("busy", { status: 503 });
    return new Response(JSON.stringify({ answers: { a0: { type: "noul", noul: 0.7 } }, usage: {} }), { status: 200 });
  };
  try {
    const out = await decide({ GEMINI_API_KEY: "k" }, "text", { a0: { type: "noul", instructions: "?" } });
    assert.equal(out.a0.noul, 0.7);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].url, "https://generativelanguage.googleapis.com/v1beta/decisions");
    assert.equal(seen[0].init.headers["x-goog-api-key"], "k");
    const body = JSON.parse(seen[0].init.body);
    assert.equal(body.model, DECIDE);
    assert.equal(body.input, "text");
    n = 0;
    globalThis.fetch = async () => new Response("bad", { status: 400 });
    await assert.rejects(() => decide({ GEMINI_API_KEY: "k" }, "text", {}), /decision 400/);
  } finally {
    globalThis.fetch = real;
  }
});

test("rate() judges only who is new, and a slow judge doesn't hold the match: late answers are kept", async () => {
  const me = person("m", "Maya");
  const people = [person("x", "Xena"), person("y", "Yann")];
  const cache = {}, calls = [];
  const quick = fakeDecide({ Xena: { a: 0.9, b: 0.9, kinds: { useful: 1 } } }, calls);
  const r1 = await M.rate(cache, me, people, quick, 5);
  assert.equal(r1.asked, 2);
  assert.equal(r1.fits.x, 90);
  const r2 = await M.rate(cache, me, people, quick, 5);
  assert.equal(r2.asked, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(r2.fits, r1.fits);

  const late = {};
  let release;
  const slow = async (input, questions) => { await new Promise(r => { release = r; }); return quick(input, questions); };
  const t0 = Date.now();
  const r3 = await M.rate(late, me, people, slow, 0.05);
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual(r3.fits, {});
  release();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(M.fitsFrom(late, "m", ["x"]).fits.x, 90);

  assert.deepEqual((await M.rate({}, me, people, null)).fits, {});
});

test("the agents talk to the chosen person first, then the next best", () => {
  assert.deepEqual(M.talkTo({ a: 40, b: 90, c: 70, d: 10 }, "c"), ["c", "b", "a"]);
  assert.deepEqual(M.talkTo({ a: 40 }, "z"), ["z", "a"]);
});

/** Traits in the shape of room.js traitsOf(): {v: {key: 0-1}, c: {key: 0-1}}, every key read with confidence `c`. */
const tr = (v, c = 0.8) => ({ v, c: Object.fromEntries(Object.keys(v).map(k => [k, c])) });

test("the tone comes from three traits, each only when read with confidence of at least 0.4", () => {
  assert.equal(M.tone([null, null]), "");
  assert.equal(M.tone(undefined), "");
  const sure = (c) => [tr({ playfulness: 0.9, directness: 0.9, openness_to_strangers: 0.1 }, c), tr({ playfulness: 0.9, openness_to_strangers: 0.2 }, c)];
  assert.equal(M.tone(sure(0.39)), "");
  const line = M.tone(sure(0.4));
  assert.equal(line, "Tone: make the mission more playful than usual; make the first question easy to answer and the mission low-pressure; make the questions direct, no small talk.\n");
  assert.equal(M.tone([tr({ playfulness: 0.5, directness: 0.5, openness_to_strangers: 0.5 }), tr({ playfulness: 0.5 })]), "");
  assert.match(M.tone([tr({ playfulness: 0.8 }), tr({ playfulness: 0.7 })]), /more playful/);
  assert.equal(M.tone([tr({ playfulness: 0.8 }), null]), "");                        // playful only when both are
  assert.equal(M.tone([tr({ playfulness: 0.8 }), tr({ playfulness: 0.9 }, 0.2)]), "");
  assert.equal(M.tone([tr({ openness_to_strangers: 0.2 }), tr({ openness_to_strangers: 0.8 })]), "");
  assert.equal(M.tone([null, tr({ directness: 0.9 })]), "Tone: make the questions direct, no small talk.\n");
  assert.equal(M.tone([tr({ extraversion: 0.9, warmth: 0.1 }), tr({ extraversion: 0.9, warmth: 0.1 })]), "");   // other traits never count
  for (const w of ["playfulness", "directness", "openness", "stranger", "0."]) assert.ok(!line.includes(w), w);    // no trait names or numbers
});

test("spark() puts the tone line in both halves of the prompt, and nothing without usable traits", async () => {
  const R = new M.Room([person("a", "Ana"), person("b", "Ben")], [], M.makeRng(1));
  const prompts = [];
  const llm = async p => { prompts.push(p); return {}; };
  await M.spark(R, ["a", "b"], "useful", llm, null, [tr({ directness: 0.9 }), null]);
  assert.equal(prompts.length, 2);
  for (const p of prompts) assert.match(p, /\nTone: make the questions direct, no small talk\.\n/);
  const withTone = prompts.splice(0);
  await M.spark(R, ["a", "b"], "useful", llm, null, [null, null]);
  await M.spark(R, ["a", "b"], "useful", llm);
  assert.equal(prompts.length, 4);
  for (const p of prompts) assert.ok(!p.includes("Tone"));
  assert.deepEqual(withTone.map(p => p.replace("Tone: make the questions direct, no small talk.\n", "")).sort(), prompts.slice(2).sort());
});

test("after a no, the choice goes to the next person talked to whose agent said yes, else to nobody", () => {
  const order = ["a", "b", "c"];
  assert.equal(M.saidYes(order, { a: { no: true }, b: { no: true }, c: { no: false } }), "c");
  assert.equal(M.saidYes(order, { a: { no: true }, c: { no: false }, b: { no: false } }), "b");
  assert.equal(M.saidYes(order, { a: { no: true }, b: { no: true } }), null);     // c's talk never came back
  assert.equal(M.saidYes(order, {}), null);
});
