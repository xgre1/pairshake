// Bakes the matching screen's hands: a ring of agents' hands waiting quietly (one loop), a
// thumbs-up per agent for when it answers, your hand in the middle (a loop), and your hand shaking each agent's hand (one
// clip per seat; the last one is also the match). Solving handshakes is slow, so it is done here
// once and the page only plays frames.
//
//   node hands/tools/bake_ring.mjs        -> hands/ring.bin, hands/ring.json
//
// ring.bin holds Int16 frames: per frame, per hand, 17 joints x (t*1e4 [3], r*32767 [4]) then 14
// corrective weights *32767. ring.json says where each clip starts and which hands it has.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url)), dir = path.join(here, '..');
const m = await import(path.join(dir, 'handkit_wasm.js'));
m.initSync({ module: fs.readFileSync(path.join(dir, 'handkit_wasm_bg.wasm')) });

const FPS = 20, SEATS = 10, RADIUS = 0.34, LOOP = 14;
const BONES = ['forearm', 'hand', 'index_mcp', 'index_pip', 'index_dip', 'middle_mcp', 'middle_pip', 'middle_dip',
  'ring_mcp', 'ring_pip', 'ring_dip', 'pinky_mcp', 'pinky_pip', 'pinky_dip', 'thumb_cmc', 'thumb_mcp', 'thumb_ip'].map((b) => b + '_R');

// ------------------------------------------------------------------ vectors and frames
const add = (a, b) => a.map((v, i) => v + b[i]);
const mul = (a, k) => a.map((v) => v * k);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => mul(a, 1 / Math.hypot(...a));
const r4 = (a) => a.map((v) => Math.round(v * 1e4) / 1e4);
const UP = [0, 1, 0];
// a frame: origin, x, y (up), z. Local vectors are written the way the gesture library writes
// them (z toward the one being talked to).
const frame = (o, z) => { z = norm(z); return { o, x: cross(UP, z), y: UP, z }; };
const vec = (F, v) => r4(add(add(mul(F.x, v[0]), mul(F.y, v[1])), mul(F.z, v[2])));
const pt = (F, v) => r4(add(F.o, vec(F, v)));
function place(F, p) {
  const out = {};
  for (const [k, v] of Object.entries(p)) out[k] = k === 'wrist' ? pt(F, v) : vec(F, v);
  return out;
}

// ------------------------------------------------------------------ the ring
const seat = (i) => { const a = (i / SEATS) * Math.PI * 2; return [RADIUS * Math.sin(a), 0, RADIUS * Math.cos(a)]; };
// each agent faces the middle of the ring
const seatFrame = (i) => frame(seat(i), mul(seat(i), -1));
const H = (i) => `p${i}.right`;

// Shapes in a seat's frame (palm toward the middle, fingers up).
const REST = { from: 'relaxed', place: { wrist: [0, -0.04, 0], palm_facing: [0, 0.25, 1], fingers_toward: [0, 1, -0.25], forearm_toward: [0, -1, -0.3] } };
const pose = (i, p) => ({ ...p, place: place(seatFrame(i), p.place) });

function wave(i, t) {
  const at = (x) => pose(i, { from: 'spread_palm', place: { wrist: [0, 0.015, 0.01], palm_facing: [0, 0, 1], fingers_toward: [x, 1, 0], forearm_toward: [0, -1, -0.2] } });
  return [[t + 0.35, at(0)], [t + 0.52, at(-0.4), 1], [t + 0.69, at(0.4), 1], [t + 0.86, at(-0.4), 1], [t + 1.05, at(0.1)], [t + 1.6, pose(i, REST)]];
}
function talk(i, t) {
  const at = (dy, g = 'offering_palm') => pose(i, { from: g, place: { wrist: [0, -0.02 + dy, 0.02], palm_facing: [0, 1, 0.4], fingers_toward: [0, -0.35, 1], forearm_toward: [0, -1, -0.4] } });
  return [[t + 0.4, at(0)], [t + 0.65, at(0.025), 1], [t + 0.9, at(0), 1], [t + 1.15, at(0.025), 1], [t + 1.45, at(0, 'relaxed')], [t + 2.0, pose(i, REST)]];
}
function thumbs(i, t) {
  const at = (dy) => pose(i, { from: 'thumbs_up', place: { wrist: [0, 0 + dy, 0.02], palm_facing: [0, 0.27, 0.96], fingers_toward: [-0.86, 0.49, -0.14] } });
  return [[t + 0.4, at(0)], [t + 0.9, at(0.012)], [t + 1.5, pose(i, REST)]];
}
const SOLO = [wave, talk, thumbs];

// Your hand stands in the middle of the ring, facing the camera side.
const ME = 'me.right', P = 'p.right';
const CENTER = { from: 'relaxed', place: { wrist: [0, -0.03, 0], palm_facing: [0, 0.3, 1], fingers_toward: [0, 1, -0.3], forearm_toward: [0, -1, -0.25] } };

// Your hand reaching out to agent i and shaking theirs: the library's handshake demo (ana from
// -x, palms facing z) laid along the line from the middle to the seat, quicker, both hands
// starting and ending where they rest.
const DEMO = JSON.parse(fs.readFileSync(path.join(here, 'demo_handshake.json'), 'utf8'));
const SPEED = 0.55, T0 = 0.95, T1 = 4.25, LEAD_IN = 0.45;
function greet(i) {
  const r = norm(seat(i)), mid = mul(seat(i), 0.5);
  const F = frame(add(mid, [0, -0.005, 0]), cross(r, UP));   // x runs from the middle to the seat
  const rename = (k) => (k === 'ana.right' ? ME : k === 'ben.right' ? P : k);
  const keys = [{ t: 0, hands: { [ME]: structuredClone(CENTER), [P]: pose(i, REST) } }];
  let grip = null, hold = null, end = 0;
  for (const k of DEMO.keys) {
    if (k.t < T0 || k.t > T1) continue;
    const out = { t: Math.round((LEAD_IN + (k.t - T0) * SPEED) * 1000) / 1000 };
    if (k.hands) {
      out.hands = {};
      for (const [h, v] of Object.entries(k.hands)) { const c = structuredClone(v); if (c.place) c.place = place(F, c.place); if (k.pass) c.pass = true; out.hands[rename(h)] = c; }
    } else if (k.pass) out.pass = true;
    if (k.goals) { out.goals = k.goals.map((g) => ({ ...g, grip: g.grip.map(rename) })); grip ??= out.t; hold = out.t; }
    keys.push(out); end = out.t;
  }
  keys.push({ t: end + 0.55, hands: { [ME]: structuredClone(CENTER), [P]: pose(i, REST) } });
  return { clip: { version: 1, fps: FPS, idle: { amount: 0 }, collide: true, duration: end + 0.6, keys }, grip, hold };
}

// ------------------------------------------------------------------ small things hands do
// While they wait, hands are never quite still: they turn a little, curl and uncurl the fingers,
// tap a finger, open up, tilt. Each of these is slow and small (smooth easing, a few cm and a few
// tens of degrees at most) and starts and ends at rest. Written in a hand's own frame F (palm
// toward z, fingers up), at wrist height y.
const CURL = { index: { mcp_flex: 48, pip_flex: 62, dip_flex: 30 }, middle: { mcp_flex: 52, pip_flex: 66, dip_flex: 32 },
  ring: { mcp_flex: 55, pip_flex: 66, dip_flex: 30 }, pinky: { mcp_flex: 58, pip_flex: 62, dip_flex: 28 } };
function fidgets(F, y) {
  const at = (g, { dx = 0, dy = 0, palm = [0, 0.25, 1], fingers = [0, 1, -0.25] } = {}, extra = {}) =>
    ({ ...(g ? { from: g } : {}), ...extra, ease: 'smooth', place: place(F, { wrist: [dx, y + dy, 0], palm_facing: palm, fingers_toward: fingers, forearm_toward: [0, -1, -0.3] }) });
  const rest = () => at('relaxed');
  const side = () => (rand() < 0.5 ? -1 : 1);
  return [
    // turn the palm a little to one side and back
    (t) => { const s = side(); return [[t + 0.9, at('relaxed', { palm: [0.45 * s, 0.25, 0.9], fingers: [0.1 * s, 1, -0.25] })], [t + 1.8, at('relaxed', { palm: [0.4 * s, 0.25, 0.9], fingers: [0.08 * s, 1, -0.25] })], [t + 2.7, rest()]]; },
    // curl the fingers in, as if thinking, and let them go
    (t) => [[t + 0.8, at(null, {}, { ...structuredClone(CURL), cascade: 0.09 })], [t + 1.5, at(null, { dy: 0.004 }, { ...structuredClone(CURL) })], [t + 2.4, { ...rest(), cascade: 0.07 }]],
    // tap the index finger twice
    (t) => [[t + 0.4, at(null, {}, { index: { mcp_flex: 42, pip_flex: 35 } })], [t + 0.7, rest()], [t + 1.0, at(null, {}, { index: { mcp_flex: 42, pip_flex: 35 } })], [t + 1.4, rest()]],
    // open the hand, lift it a little, settle
    (t) => [[t + 0.8, at('open_palm', { dy: 0.012, palm: [0, 0.4, 0.9], fingers: [0, 0.9, -0.4] })], [t + 1.6, at('open_palm', { dy: 0.01, palm: [0, 0.42, 0.9], fingers: [0, 0.9, -0.42] })], [t + 2.5, { ...rest(), cascade: 0.06 }]],
    // a slow sideways tilt, there and back
    (t) => { const s = side(); return [[t + 0.8, at('relaxed', { dx: 0.006 * s, fingers: [0.3 * s, 1, -0.25] })], [t + 1.7, at('relaxed', { dx: -0.004 * s, fingers: [-0.18 * s, 1, -0.25] })], [t + 2.6, rest()]]; },
    // a small wave
    (t) => [[t + 0.5, at('spread_palm', { dy: 0.008, palm: [0, 0.1, 1], fingers: [0.2, 1, -0.1] })], [t + 0.85, at('spread_palm', { dy: 0.008, palm: [0, 0.1, 1], fingers: [-0.2, 1, -0.1] })], [t + 1.2, at('spread_palm', { dy: 0.008, palm: [0, 0.1, 1], fingers: [0.15, 1, -0.1] })], [t + 2.0, rest()]],
  ];
}
// a hand's day: one small thing after another with pauses between, the wave rare
function schedule(name, F, y, until) {
  const acts = fidgets(F, y), keys = [];
  let t = 0.2 + rand() * 1.5, last = -1;
  while (t < until) {
    let k; do { k = Math.floor(rand() * acts.length); } while (k === last || (k === 5 && rand() < 0.6));
    last = k;
    const ks = acts[k](t);
    for (const [kt, h] of ks) keys.push({ t: kt, hands: { [name]: h } });
    t = ks[ks.length - 1][0] + 0.5 + rand() * 1.6;
  }
  return keys;
}
function merge(list) {
  const byT = new Map();
  for (const k of list) {
    const t = Math.round(k.t * 100) / 100, have = byT.get(t);
    if (!have) byT.set(t, { ...k, t }); else Object.assign(have.hands, k.hands);
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

// ------------------------------------------------------------------ the ring's loop
// The agents wait, each busy with its own small things, out of step with each other. The loop is
// baked a little long and its end blended into its start (BLEND_S), so it has no seam.
let seed = 7;
const rand = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
const BLEND_S = 1.5;
const all = (p) => Object.fromEntries([...Array(SEATS)].map((_, i) => [H(i), pose(i, p)]));
const ring = { version: 1, fps: FPS, idle: { amount: 0.7 }, collide: false, duration: LOOP + BLEND_S, loopBlend: BLEND_S, soften: true,
  keys: [{ t: 0, hands: all(REST) }, ...merge([...Array(SEATS)].flatMap((_, i) => schedule(H(i), seatFrame(i), -0.04, LOOP + BLEND_S - 2.8)))] };

// an agent that answers well gives a thumbs-up, from rest back to rest
const react = (i) => ({ version: 1, fps: FPS, idle: { amount: 0 }, collide: false, duration: 1.9, soften: true,
  keys: [{ t: 0, hands: { [H(i)]: pose(i, REST) } }, ...thumbs(i, 0).map(([t, p]) => ({ t, hands: { [H(i)]: p } }))] });

// your hand while it waits: small things too, a little calmer
const center = { version: 1, fps: FPS, idle: { amount: 0.6 }, collide: false, duration: 10 + BLEND_S, loopBlend: BLEND_S, soften: true,
  keys: [{ t: 0, hands: { [ME]: structuredClone(CENTER) } }, ...merge(schedule(ME, frame([0, 0, 0], [0, 0, 1]), -0.03, 10 + BLEND_S - 2.8))] };

// ------------------------------------------------------------------ bake
function bake(clip, names) {
  const { loopBlend = 0, soften, ...spec } = clip;
  const c = new m.Clip(JSON.stringify(spec)), total = Math.round(spec.duration * FPS), n = Math.round((spec.duration - loopBlend) * FPS), B = Math.round(loopBlend * FPS);
  const per = BONES.length * 7 + 14, F = [];
  for (let f = 0; f < total; f++) {
    const b = JSON.parse(c.bones(f / FPS));
    F.push(names.map((h) => { const hb = b.hands[h]; return { j: BONES.map((j) => hb.joints[j]), w: hb.morph?.skin_R || [] }; }));
  }
  c.free();
  // soften: two passes of a [1 2 1] filter over time on every joint (a loop wraps around), which
  // takes the edge off the solver's occasional one-frame snap of a finger and rounds every move
  if (clip.soften) for (let pass = 0; pass < 2; pass++) {
    const G = F.map((fr) => fr.map((h) => ({ j: h.j.map((J) => ({ t: [...J.t], r: [...J.r] })), w: [...h.w] })));
    for (let f = 0; f < total; f++) {
      const pf = clip.loopBlend ? (f - 1 + total) % total : Math.max(0, f - 1), nf = clip.loopBlend ? (f + 1) % total : Math.min(total - 1, f + 1);
      F[f].forEach((h, k) => {
        h.j.forEach((J, i) => {
          const a = G[pf][k].j[i], b = G[f][k].j[i], c = G[nf][k].j[i];
          const sa = a.r.reduce((x, v, q) => x + v * b.r[q], 0) < 0 ? -1 : 1, sc = c.r.reduce((x, v, q) => x + v * b.r[q], 0) < 0 ? -1 : 1;
          const r = b.r.map((v, q) => (sa * a.r[q] + 2 * v + sc * c.r[q]) / 4), l = Math.hypot(...r);
          J.r = r.map((v) => v / l); J.t = b.t.map((v, q) => (a.t[q] + 2 * v + c.t[q]) / 4);
        });
        h.w = h.w.map((v, q) => ((G[pf][k].w[q] || 0) + 2 * v + (G[nf][k].w[q] || 0)) / 4);
      });
    }
  }
  // a loop: the first B frames become the overrun (frames n..n+B) crossing over into them
  const at = (f, k) => {
    if (f >= B) return F[f][k];
    const a = F[n + f][k], b = F[f][k], s = f / B, w = s * s * (3 - 2 * s);
    return { j: a.j.map((ja, i) => {
      const jb = b.j[i], d = ja.r.reduce((x, v, q) => x + v * jb.r[q], 0) < 0 ? -1 : 1;
      const r = ja.r.map((v, q) => v + (d * jb.r[q] - v) * w), l = Math.hypot(...r);
      return { t: ja.t.map((v, q) => v + (jb.t[q] - v) * w), r: r.map((v) => v / l) };
    }), w: [...Array(14)].map((_, q) => (a.w[q] || 0) + ((b.w[q] || 0) - (a.w[q] || 0)) * w) };
  };
  const out = new Int16Array(n * names.length * per);
  for (let f = 0; f < n; f++) names.forEach((_, k) => {
    const h = at(f, k); let o = (f * names.length + k) * per;
    for (const J of h.j) { for (const v of J.t) out[o++] = Math.round(v * 1e4); for (const v of J.r) out[o++] = Math.round(v * 32767); }
    for (let i = 0; i < 14; i++) out[o++] = Math.round((h.w[i] || 0) * 32767);
  });
  return { n, data: out };
}
const t0 = Date.now(), parts = [], meta = { fps: FPS, per: BONES.length * 7 + 14, joints: BONES, seats: [...Array(SEATS)].map((_, i) => seat(i)) };
let offset = 0;
const put = (b, hands, extra = {}) => { parts.push(Buffer.from(b.data.buffer)); const e = { hands, frames: b.n, offset, ...extra }; offset += b.data.length * 2; return e; };
meta.ring = put(bake(ring, [...Array(SEATS)].map((_, i) => H(i))), SEATS);
console.log('ring', ((Date.now() - t0) / 1000).toFixed(1), 's');
meta.center = put(bake(center, [ME]), 1);
meta.react = [...Array(SEATS)].map((_, i) => put(bake(react(i), [H(i)]), 1));
meta.greet = [];
for (let i = 0; i < SEATS; i++) { const g = greet(i); meta.greet.push(put(bake(g.clip, [ME, P]), 2, { grip: g.grip, hold: g.hold })); process.stdout.write(`\rgreet ${i + 1}/${SEATS}`); }
const buf = Buffer.concat(parts);
fs.writeFileSync(path.join(dir, 'ring.bin'), buf);
fs.writeFileSync(path.join(dir, 'ring.json'), JSON.stringify(meta));
console.log(`\nring.bin ${(buf.length / 1024).toFixed(0)} KB in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
