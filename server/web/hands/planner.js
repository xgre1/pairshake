// Turns one line Emma says into a Handkit clip for her two hands, timed to the audio, and
// gives her hands something to do while she waits, listens and thinks.
//
// Not sign language: the hands talk the way people do over coffee in Athens or Naples. Words
// that carry an image get a gesture of their own (a shrug on a question, a wag on "no", a palm
// raised on "what", two fingers rubbed together on "meet", a ball shaped on "build", a thumb up
// on "good", fingers counted on "first, second"); the phrases in between get one of the
// everyday strokes (a small beat, an open palm offered, a chop, rolling hands). Between them the
// hands rest, the way a person's do: no two lines are gestured at the same size or speed, the
// second hand trails the first by a few frames, and the hand that is not talking moves a little
// with the one that is.
//
// Coordinates are Handkit's: meters, seen from the front, +Y up, +Z toward the viewer, and the
// signer's right is -X (her right hand sits on the viewer's left).

const mirror = (v) => [-v[0], v[1], v[2]];
const r3 = (x) => Math.round(x * 1000) / 1000;

// Handkit can keep the hands out of each other, but that costs 0.6-0.9 s per clip before the
// first frame, so the gestures keep their own distance instead (checked with `handkit check`).
export let COLLIDE = false;
let SHAPES = {};
export const SHAPE_NAMES = ['relaxed', 'open_palm', 'spread_palm', 'offering_palm', 'point', 'claw', 'beckon',
  'fist', 'thumbs_up', 'ok', 'pinch', 'peace', 'three', 'four', 'cupped', 'stop', 'crossed_fingers', 'shaka', 'tripod', 'steeple'];
// A key only changes the joints it names; the rest stay as the last shape left them (a bent
// wrist, curled fingertips). So every shape names every joint, and a pose is the same pose
// whatever came before it.
export function setup(shapes) {
  SHAPES = {};
  for (const [n, s] of Object.entries(shapes)) {
    const o = { palm_cup: 0, twist: 0, wrist_flex: 0, wrist_dev: 0, ...structuredClone(s) };
    for (const f of ['index', 'middle', 'ring', 'pinky']) if (o[f] && o[f].dip_flex === undefined) o[f].dip_flex = r3((o[f].pip_flex * 2) / 3);
    SHAPES[n] = o;
  }
  buildPoses();
}
export const setCollide = (v) => { COLLIDE = v; };

// The hands work this much further apart than the numbers below say, unless they touch (near).
const SPREAD = 0.04;

// A hand at a place: palm/fingers/wrist given for the right hand, mirrored for the left.
// `from` is a library shape's name or a shape made here (mix, bend).
function hand(side, from, wrist, palm, fingers, extra = {}) {
  const L = side === 'left';
  if (!extra.near) wrist = [Math.max(-0.15, wrist[0] - SPREAD), wrist[1], wrist[2]];
  const h = { place: { wrist: L ? mirror(wrist) : wrist, palm_facing: L ? mirror(palm) : palm, fingers_toward: L ? mirror(fingers) : fingers } };
  // library shapes come pre-solved as plain joint angles: their touch goals would otherwise be
  // solved again on every frame (up to 40 ms each)
  if (from && typeof from === 'object') Object.assign(h, structuredClone(from));
  else if (from && SHAPES[from]) Object.assign(h, structuredClone(SHAPES[from]));
  else if (from) h.from = from;
  if (extra.forearm) h.place.forearm_toward = L ? mirror(extra.forearm) : extra.forearm;
  return h;
}
const both = (from, wrist, palm, fingers, extra) => ({ right: hand('right', from, wrist, palm, fingers, extra), left: hand('left', from, wrist, palm, fingers, extra) });
const other = (side) => (side === 'right' ? 'left' : 'right');

// A shape part of the way from one to another (joint angles), and one with fingers bent further.
const shapeOf = (s) => (typeof s === 'string' ? SHAPES[s] : s) || {};
function mix(a, b, w) {
  const go = (x, y) => {
    if (typeof x === 'number') return typeof y === 'number' ? r3(x + (y - x) * w) : x;
    if (x && typeof x === 'object') { const o = {}; for (const k of Object.keys(x)) o[k] = go(x[k], y?.[k]); return o; }
    return x;
  };
  return go(shapeOf(a), shapeOf(b));
}
function bend(s, fingers, deg) {
  const o = structuredClone(shapeOf(s));
  for (const f of fingers) if (o[f]) o[f].mcp_flex = (o[f].mcp_flex || 0) + deg;
  return o;
}

// Palm/finger directions for the right hand.
const UP_IN = [[0.55, 0.6, 0.6], [0.2, 0.6, -0.75]];    // palm turned up and toward the listener
const UP_OUT = [[0.35, 0.8, 0.5], [-0.45, -0.12, 0.5]];  // palm up, held out to the listener
const DOWN = [[0, -0.75, -0.65], [0.25, 0.6, -0.72]];  // palm down (the back of the hand shows)
const SIDE = [[1, 0.05, 0.1], [0, 0.55, 0.85]];        // edge of the hand down, palm in: a chop
const OPEN_IN = [[0.7, 0.25, 0.65], [-0.2, 0.95, 0.15]]; // palms half toward each other, half to the listener
const FRONT = [[0.15, 0, 1], [0, 1, 0.05]];            // palm to the listener, fingers up
const LOOSE = [[0.5, 0.65, 0.55], [0.2, 0.6, 0.75]];   // a hand hanging in the air, half open
const FLAT = [[0.05, -0.98, 0.15], [0.45, 0.15, 0.85]]; // palm flat down, fingers forward (on a table)
const BACK = [[0.15, 0.1, -1], [0.15, 1, 0.1]];        // the back of the hand to the listener, fingers up

// Poses the hands come back to (rebuilt once the shapes are solved, so they use them).
export const POSES = {};
function buildPoses() {
  Object.assign(POSES, {
  idle: both('relaxed', [-0.115, -0.125, 0.0], [0.6, 0.55, 0.55], [0.12, 0.8, 0.6], { forearm: [-0.2, -1, -0.35] }),
  listening: both('relaxed', [-0.105, -0.14, 0.01], [0.65, 0.6, 0.45], [0.1, 0.7, 0.7], { forearm: [-0.15, -1, -0.45] }),
  ready: both('relaxed', [-0.1, -0.09, 0.04], [0.5, 0.65, 0.55], [0.2, 0.6, 0.75], { forearm: [-0.25, -1, -0.3] }),
  // a lower place to rest between phrases
  low: both('relaxed', [-0.108, -0.115, 0.02], [0.58, 0.58, 0.55], [0.14, 0.75, 0.65], { forearm: [-0.22, -1, -0.33] }),
  });
  POSES.thinking = { right: structuredClone(POSES.idle.right), left: structuredClone(POSES.idle.left) };
}
buildPoses();

// A small repeatable random source: the same line and seed always give the same clip.
function rng(seed) {
  let a = (seed | 0) || 1;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// How the next gesture is performed: its speed, its size, a nudge to where it happens, how far
// the left hand trails the right, and where the other hand waits meanwhile.
const PLAIN = { tempo: 1, amp: 1, off: [0, 0, 0], lag: 0, rest: 'ready' };
let V = PLAIN;
export const vary = (v) => { V = { ...PLAIN, ...v }; };

// --------------------------------------------------------------------------- gestures
// Each one is a list of steps [dt, hands, key options]; the first shape lands LEAD after the
// move starts (that is when its word is said).

const LEAD = 0.42;   // long, overlapping moves keep the hands flowing

// Hands that come close (near) turn into their shape while still apart, then close in, and
// open out again before turning away: turning while close swings the thumbs into each other.
function widen(hands, dx) {
  const out = structuredClone(hands);
  for (const [side, h] of Object.entries(out)) if (h.place?.wrist) h.place.wrist[0] += side === 'left' ? dx : -dx;
  return out;
}

const QUIET = new WeakSet();   // the hand that waits while the other one talks

function seq(steps, { near = false } = {}) {
  const v = V, n = steps.length;
  // hands that touch keep their size and place: only free gestures are varied
  const amp = near ? 1 : v.amp, off = near ? [0, v.off[1] * 0.5, v.off[2] * 0.5] : v.off, lag = near ? 0 : v.lag;
  const first = {};
  let qSide = null, q0 = null, mSide = null, m0 = null;
  const out = steps.map(([dt, hands, o], i) => {
    const hs = {};
    for (const [side, h] of Object.entries(hands)) {
      if (QUIET.has(h)) { hs[side] = h; qSide = side; q0 = h; continue; }
      if (!first[side]) first[side] = h.place.wrist;
      const c = structuredClone(h), b = first[side], sx = side === 'left' ? 1 : -1;
      c.place.wrist = h.place.wrist.map((x, k) => r3(b[k] + (x - b[k]) * amp + off[k] * (k === 0 ? sx : 1)));
      hs[side] = c;
      if (i === 0 && !mSide) { mSide = side; m0 = c.place.wrist; }
    }
    // the waiting hand moves a little with the talking one
    if (i > 0 && qSide && !hs[qSide] && hs[mSide]) {
      const e = structuredClone(q0), w = hs[mSide].place.wrist;
      e.place.wrist[1] = r3(e.place.wrist[1] + 0.22 * (w[1] - m0[1]));
      e.place.wrist[2] = r3(e.place.wrist[2] + 0.22 * (w[2] - m0[2]));
      hs[qSide] = e;
    }
    return [i ? dt * v.tempo : 0, hs, o];
  });
  let dur = LEAD + lag;
  for (const [dt] of out.slice(1)) dur += dt;
  if (near) dur += 0.22;
  // `move`: seconds the hands take to get to the first shape, when they come from a rest
  return { dur: dur + 0.12, keys: (t, move = 0) => {
    let at = t + LEAD;
    const keys = [];
    out.forEach(([dt, hands, o = {}], i) => {
      if (i > 0) at += dt;
      const k = { ...o };
      // the first shape: move all the way from the last one (Handkit's default), so no holds
      if (i === 0) { if (move && !near) k.move = move; }
      else if (i < n - 1 && k.pass === undefined) k.pass = true;   // flow through, don't stop
      else if (i === n - 1) k.ease = 'smooth';
      if (lag && hands.right && hands.left) {
        keys.push({ t: r3(at), hands: { right: hands.right }, ...k });
        keys.push({ t: r3(at + lag), hands: { left: hands.left }, ...k });
      } else keys.push({ t: r3(at), hands, ...k });
    });
    if (near) {
      keys.unshift({ t: r3(t + LEAD - 0.2), hands: widen(out[0][1], 0.06), pass: true });
      if (move) keys[0].move = move;
      keys[1].move = 0.2;
      // (both hands open out, also one that had nothing to do in the last steps)
      const last = Object.assign({}, ...out.map(([, hands]) => hands));
      keys.push({ t: r3(at + 0.22), hands: widen(last, 0.06), pass: true });
    }
    return keys;
  } };
}
const one = (side, from, w, dir) => ({ [side]: hand(side, from, w, dir[0], dir[1]) });
const quiet = (side) => { const h = structuredClone(POSES[V.rest][other(side)]); QUIET.add(h); return { [other(side)]: h }; };
const snap = {};   // (no snapping: it reads as stop-start)

const G = {
  // an open palm offered out to the listener
  offer: (s = 'right') => seq([
    [0, { ...one(s, 'offering_palm', [-0.075, -0.09, 0.04], UP_IN), ...quiet(s) }],
    [0.26, one(s, 'offering_palm', [-0.07, -0.075, 0.095], UP_OUT), snap],
    [0.34, one(s, 'offering_palm', [-0.065, -0.085, 0.085], UP_OUT)],
  ]),
  // both palms up and apart: "what can you do", a question
  shrug: () => seq([
    [0, both('offering_palm', [-0.09, -0.1, 0.03], ...UP_IN)],
    [0.28, both('offering_palm', [-0.09, -0.065, 0.06], ...UP_OUT), snap],
    [0.42, both('offering_palm', [-0.085, -0.07, 0.06], ...UP_OUT)],
  ]),
  // one open hand raised palm up and lifted twice: "what?", "how?", "so?"
  well: (s = 'right') => seq([
    [0, { ...one(s, 'offering_palm', [-0.07, -0.08, 0.05], UP_OUT), ...quiet(s) }],
    [0.2, one(s, 'offering_palm', [-0.075, -0.05, 0.06], UP_OUT)],
    [0.2, one(s, 'offering_palm', [-0.07, -0.075, 0.055], UP_OUT)],
    [0.2, one(s, 'offering_palm', [-0.075, -0.05, 0.06], UP_OUT)],
  ]),
  // the edge of the hand chopping down twice: the point being made
  chop: (s = 'right') => seq([
    [0, { ...one(s, 'open_palm', [-0.075, -0.025, 0.05], SIDE), ...quiet(s) }],
    [0.17, one(s, 'open_palm', [-0.07, -0.095, 0.06], SIDE), snap],
    [0.2, one(s, 'open_palm', [-0.075, -0.04, 0.05], SIDE)],
    [0.17, one(s, 'open_palm', [-0.07, -0.1, 0.06], SIDE), snap],
  ]),
  // both hands rolling forward: "and so on", explaining
  roll: () => {
    const steps = [], c = [-0.105, -0.08, 0.04], r = 0.03;
    for (let i = 0; i <= 8; i++) {
      const a = (i / 4) * Math.PI * 2;
      const R = [c[0], c[1] + Math.sin(a) * r, c[2] + Math.cos(a) * r];
      const L = [c[0], c[1] + Math.sin(a + Math.PI) * r, c[2] + Math.cos(a + Math.PI) * r];
      steps.push([i ? 0.13 : 0, { right: hand('right', 'relaxed', R, ...LOOSE), left: hand('left', 'relaxed', L, ...LOOSE) }, i < 8 ? { pass: true } : {}]);
    }
    return seq(steps);
  },
  // palm down turned over to palm up: "but", "or", "maybe"
  flip: (s = 'right') => seq([
    [0, { ...one(s, 'open_palm', [-0.085, -0.075, 0.05], DOWN), ...quiet(s) }],
    [0.3, one(s, 'offering_palm', [-0.08, -0.08, 0.07], UP_OUT), snap],
    [0.3, one(s, 'offering_palm', [-0.08, -0.085, 0.07], UP_OUT)],
  ]),
  // the index finger jabbed toward the listener: "exactly", "that's it"
  jab: (s = 'right') => {
    const D = [[0.15, -1, 0.1], [0.05, 0.2, 1]];
    return seq([
      [0, { ...one(s, 'point', [-0.06, -0.06, 0.05], D), ...quiet(s) }],
      [0.18, one(s, 'point', [-0.06, -0.065, 0.085], D)],
      [0.2, one(s, 'point', [-0.06, -0.06, 0.055], D)],
      [0.18, one(s, 'point', [-0.06, -0.065, 0.085], D)],
    ]);
  },
  // index up, wagging side to side: "no"
  wag: () => {
    const at = (x) => one('right', 'point', [-0.06, -0.035, 0.05], [[0.15, 0, 1], [x, 1, 0.05]]);
    return seq([[0, { ...at(0.3), ...quiet('right') }], [0.14, at(-0.35), snap], [0.14, at(0.35), snap], [0.14, at(-0.35), snap], [0.18, at(0)]]);
  },
  // both hands to her chest: "I", "me"
  me: () => seq([
    [0, { right: hand('right', 'open_palm', [-0.07, -0.095, -0.05], [0, 0.05, -1], [0.12, 1, 0], { near: true }), left: hand('left', 'open_palm', [-0.075, -0.125, -0.04], [0, 0.05, -1], [0.12, 1, 0], { near: true }) }],
    [0.42, { right: hand('right', 'open_palm', [-0.07, -0.09, -0.045], [0, 0.05, -1], [0.12, 1, 0], { near: true }) }],
  ], { near: true }),
  // an open palm held out to the listener, a little push: "you"
  you: (s = 'right') => seq([
    [0, { ...one(s, 'offering_palm', [-0.06, -0.085, 0.08], UP_OUT), ...quiet(s) }],
    [0.25, one(s, 'offering_palm', [-0.06, -0.08, 0.11], UP_OUT), snap],
    [0.25, one(s, 'offering_palm', [-0.06, -0.085, 0.1], UP_OUT)],
  ]),
  // two index fingers side by side, rubbed together: "those two", "meet", "together"
  together: () => {
    const P = [[0, -0.75, -0.3], [0.15, 0.2, 0.95]];
    const k = (dz) => ({ right: hand('right', 'point', [-0.07, -0.075, 0.04 + dz], ...P, { near: true }), left: hand('left', 'point', [-0.07, -0.075, 0.04 - dz], ...P, { near: true }) });
    return seq([[0, k(0)], [0.14, k(0.018), snap], [0.14, k(-0.018), snap], [0.14, k(0.018), snap], [0.18, k(0)]], { near: true });
  },
  // shaping a ball between clawed hands, turned over: "build", "make", "project"
  ball: () => {
    const P = [[1, 0.1, 0.15], [0, 0.6, 0.8]];
    const k = (dy) => ({ right: hand('right', 'claw', [-0.09, -0.07 + dy, 0.05], ...P, { near: true }), left: hand('left', 'claw', [-0.09, -0.07 - dy, 0.05], ...P, { near: true }) });
    return seq([[0, k(0)], [0.2, k(0.025), { pass: true }], [0.2, k(0)], [0.2, k(-0.025), { pass: true }], [0.2, k(0)]], { near: true });
  },
  // tapping the temple: "think", "idea", "know"
  temple: () => {
    const at = (dy) => one('right', 'point', [-0.025, -0.005 + dy, -0.04], [[0.6, 0, 0.8], [0.4, 0.9, -0.1]]);
    return seq([[0, { ...at(0), ...quiet('right') }], [0.15, at(0.012), snap], [0.15, at(0)], [0.15, at(0.012), snap]]);
  },
  // fingertips together, flung open wide: "great", "amazing", "so many"
  burst: () => seq([
    [0, both('relaxed', [-0.09, -0.09, 0.05], ...UP_IN)],
    [0.2, both('spread_palm', [-0.135, -0.04, 0.07], [0.35, 0.15, 1], [-0.35, 1, 0.1]), snap],
    [0.4, both('spread_palm', [-0.13, -0.045, 0.065], [0.35, 0.15, 1], [-0.35, 1, 0.1])],
  ]),
  // palms facing, pulled wide apart: "everyone", "big", "the whole room"
  wide: () => seq([
    [0, both('open_palm', [-0.055, -0.08, 0.05], ...OPEN_IN)],
    [0.3, both('spread_palm', [-0.14, -0.07, 0.045], ...OPEN_IN), snap],
    [0.35, both('spread_palm', [-0.135, -0.075, 0.045], ...OPEN_IN)],
  ]),
  // palms down, both pressed down firmly: "yes", "sure", "really"
  press: () => seq([
    [0, both('open_palm', [-0.08, -0.04, 0.05], ...DOWN)],
    [0.18, both('open_palm', [-0.085, -0.1, 0.055], ...DOWN), snap],
    [0.3, both('open_palm', [-0.085, -0.095, 0.055], ...DOWN)],
  ]),
  // the hand curled in, beckoning: "come", "find", "look"
  beckon: () => {
    const at = (g) => one('right', g, [-0.07, -0.075, 0.07], [[0, 1, 0.1], [0, -0.1, 1]]);
    return seq([[0, { ...at('offering_palm'), ...quiet('right') }], [0.18, at('beckon')], [0.18, at('offering_palm')], [0.18, at('beckon')]]);
  },
  // open hands held up close together, palms facing, bobbed twice: "please", "thank you"
  plead: () => {
    const k = (dy) => both('open_palm', [-0.062, -0.1 + dy, 0.03], [1, 0, 0.15], [0, 1, 0.05], { near: true });
    return seq([[0, k(0)], [0.2, k(-0.022)], [0.2, k(0)], [0.2, k(-0.022)]], { near: true });
  },
  // a wave: "hi", "hello", "bye"
  wave: () => {
    const at = (x) => one('right', 'spread_palm', [-0.085, -0.055, 0.04], [FRONT[0], [x, 1, 0.05]]);
    return seq([[0, { ...at(0), ...quiet('right') }], [0.15, at(-0.35)], [0.15, at(0.3)], [0.15, at(-0.35)], [0.15, at(0.1)]]);
  },
  // a flat hand rocked side to side, palm down: "a little", "a bit", "kind of"
  little: () => {
    const at = (r) => one('right', 'open_palm', [-0.065, -0.07, 0.05], [[r, -0.75, -0.65], [0.25, 0.6, -0.72]]);
    return seq([[0, { ...at(0.3), ...quiet('right') }], [0.18, at(-0.35)], [0.18, at(0.35)], [0.18, at(-0.3)], [0.2, at(0)]]);
  },

  // a loose hand beating time, twice: the stroke people make most
  beat: (s = 'right') => seq([
    [0, { ...one(s, 'relaxed', [-0.08, -0.06, 0.05], LOOSE), ...quiet(s) }],
    [0.16, one(s, 'relaxed', [-0.08, -0.086, 0.06], LOOSE)],
    [0.2, one(s, 'relaxed', [-0.08, -0.066, 0.054], LOOSE)],
    [0.16, one(s, 'relaxed', [-0.08, -0.088, 0.06], LOOSE)],
  ]),
  // both loose hands beating once together
  beats: () => seq([
    [0, both('relaxed', [-0.085, -0.06, 0.05], ...LOOSE)],
    [0.18, both('relaxed', [-0.085, -0.088, 0.06], ...LOOSE)],
    [0.3, both('relaxed', [-0.085, -0.08, 0.058], ...LOOSE)],
  ]),
  // open hands facing each other, holding the idea between them, set down twice
  frame: () => seq([
    [0, both('open_palm', [-0.07, -0.06, 0.05], ...OPEN_IN)],
    [0.18, both('open_palm', [-0.07, -0.09, 0.055], ...OPEN_IN)],
    [0.2, both('open_palm', [-0.072, -0.07, 0.052], ...OPEN_IN)],
    [0.18, both('open_palm', [-0.07, -0.092, 0.055], ...OPEN_IN)],
  ]),
  // both palms opening outward from the middle: "open", "start", "welcome"
  open: () => seq([
    [0, both('offering_palm', [-0.09, -0.09, 0.04], ...UP_IN)],
    [0.3, both('offering_palm', [-0.108, -0.07, 0.07], ...UP_OUT)],
    [0.35, both('offering_palm', [-0.105, -0.075, 0.068], ...UP_OUT)],
  ]),
  // thumb and index pinched, set down on the exact spot: "small", "detail", "precisely"
  pinch: (s = 'right') => {
    const D = [[0.85, -0.3, 0.3], [0.1, 0.7, 0.7]];
    return seq([
      [0, { ...one(s, 'pinch', [-0.075, -0.05, 0.06], D), ...quiet(s) }],
      [0.16, one(s, 'pinch', [-0.075, -0.075, 0.075], D)],
      [0.2, one(s, 'pinch', [-0.075, -0.058, 0.066], D)],
      [0.16, one(s, 'pinch', [-0.075, -0.077, 0.075], D)],
    ]);
  },
  // a thumb up, pushed toward the listener: "good", "nice"
  thumb: (s = 'right') => {
    const D = [[1, 0, -0.25], [0.25, 0.15, 0.95]];
    return seq([
      [0, { ...one(s, 'thumbs_up', [-0.075, -0.075, 0.05], D), ...quiet(s) }],
      [0.2, one(s, 'thumbs_up', [-0.075, -0.06, 0.09], D)],
      [0.22, one(s, 'thumbs_up', [-0.075, -0.068, 0.08], D)],
      [0.2, one(s, 'thumbs_up', [-0.075, -0.06, 0.09], D)],
    ]);
  },
  // thumb and index in a ring, shown to the listener: "ok", "fine", "perfect"
  ok: () => seq([
    [0, { ...one('right', 'ok', [-0.08, -0.06, 0.05], FRONT), ...quiet('right') }],
    [0.2, one('right', 'ok', [-0.08, -0.05, 0.08], FRONT)],
    [0.3, one('right', 'ok', [-0.08, -0.055, 0.075], FRONT)],
  ]),
  // fingers held up and counted: "first", "second", "three"
  num: (shape) => seq([
    [0, { ...one('right', shape, [-0.075, -0.05, 0.05], FRONT), ...quiet('right') }],
    [0.2, one('right', shape, [-0.075, -0.04, 0.08], FRONT)],
    [0.35, one('right', shape, [-0.075, -0.045, 0.075], FRONT)],
  ]),
  // a flat hand pushed out: "wait", "stop", "hold on"
  stop: () => seq([
    [0, { ...one('right', 'stop', [-0.075, -0.055, 0.05], FRONT), ...quiet('right') }],
    [0.2, one('right', 'stop', [-0.075, -0.045, 0.095], FRONT)],
    [0.4, one('right', 'stop', [-0.075, -0.048, 0.09], FRONT)],
  ]),
  // a fist shaken down, knuckles forward: "strong", "hard", "work"
  fist: (s = 'right') => {
    const D = [[1, 0, 0.1], [0, 0.3, 0.95]];
    return seq([
      [0, { ...one(s, 'fist', [-0.075, -0.045, 0.05], D), ...quiet(s) }],
      [0.15, one(s, 'fist', [-0.075, -0.08, 0.06], D)],
      [0.18, one(s, 'fist', [-0.075, -0.055, 0.053], D)],
      [0.15, one(s, 'fist', [-0.075, -0.082, 0.06], D)],
    ]);
  },
  // two palms weighed against each other like scales: "or", "compare", "depends"
  scales: () => {
    const k = (d) => ({ right: hand('right', 'offering_palm', [-0.09, -0.075 + d, 0.06], ...UP_OUT), left: hand('left', 'offering_palm', [-0.09, -0.075 - d, 0.06], ...UP_OUT) });
    return seq([[0, k(0)], [0.24, k(0.024)], [0.3, k(-0.024)], [0.3, k(0.018)], [0.26, k(0)]]);
  },
  // an open palm lifted: "more", "grow", "better"
  up: (s = 'right') => seq([
    [0, { ...one(s, 'offering_palm', [-0.075, -0.1, 0.05], UP_OUT), ...quiet(s) }],
    [0.32, one(s, 'offering_palm', [-0.075, -0.04, 0.065], UP_OUT)],
    [0.3, one(s, 'offering_palm', [-0.075, -0.045, 0.063], UP_OUT)],
  ]),
  // a palm patting the air down: "less", "slow", "calm", "easy"
  calm: (s = 'right') => seq([
    [0, { ...one(s, 'open_palm', [-0.08, -0.045, 0.05], DOWN), ...quiet(s) }],
    [0.2, one(s, 'open_palm', [-0.08, -0.08, 0.055], DOWN)],
    [0.22, one(s, 'open_palm', [-0.08, -0.06, 0.052], DOWN)],
    [0.2, one(s, 'open_palm', [-0.08, -0.09, 0.055], DOWN)],
  ]),
  // a flat hand swept outward: "always", "all the way", "years"
  sweep: (s = 'right') => seq([
    [0, { ...one(s, 'open_palm', [-0.045, -0.07, 0.055], DOWN), ...quiet(s) }],
    [0.3, one(s, 'open_palm', [-0.105, -0.068, 0.05], DOWN)],
    [0.3, one(s, 'open_palm', [-0.11, -0.072, 0.048], DOWN)],
  ]),
  // an open palm carried off to the side: "anyway", "forget it", "before"
  aside: (s = 'right') => {
    const OUT = [[0.15, 0.85, 0.5], [-0.5, -0.2, 0.55]];
    return seq([
      [0, { ...one(s, 'offering_palm', [-0.06, -0.085, 0.06], UP_OUT), ...quiet(s) }],
      [0.26, one(s, 'offering_palm', [-0.09, -0.07, 0.05], OUT)],
      [0.3, one(s, 'offering_palm', [-0.09, -0.076, 0.048], OUT)],
    ]);
  },
  // a cupped hand carried forward: "give", "share", "help"
  cup: (s = 'right') => seq([
    [0, { ...one(s, 'cupped', [-0.07, -0.09, 0.045], UP_OUT), ...quiet(s) }],
    [0.28, one(s, 'cupped', [-0.068, -0.078, 0.1], UP_OUT)],
    [0.32, one(s, 'cupped', [-0.068, -0.082, 0.095], UP_OUT)],
  ]),
  // fingertips rubbed against the thumb: "money", "price"
  money: () => {
    const at = (g, dy) => one('right', g, [-0.075, -0.065 + dy, 0.065], UP_IN);
    return seq([[0, { ...at('tripod', 0), ...quiet('right') }], [0.16, at('pinch', 0.004)], [0.16, at('tripod', 0)], [0.16, at('pinch', 0.004)], [0.18, at('tripod', 0)]]);
  },
  // fingers crossed, given a little shake: "hope", "luck"
  luck: () => {
    const at = (dy) => one('right', 'crossed_fingers', [-0.075, -0.05 + dy, 0.05], [[0, 0.1, -1], [0.1, 1, 0.1]]);
    return seq([[0, { ...at(0), ...quiet('right') }], [0.16, at(0.014)], [0.16, at(0)], [0.16, at(0.014)], [0.2, at(0.004)]]);
  },
  // thumb and little finger out, rocked: "cool", "chill", "relax"
  shaka: () => {
    const at = (x) => one('right', 'shaka', [-0.08, -0.055, 0.05], [[0, 0, -1], [x, 1, 0]]);
    return seq([[0, { ...at(0.25), ...quiet('right') }], [0.16, at(-0.25)], [0.16, at(0.25)], [0.16, at(-0.2)], [0.18, at(0)]]);
  },
  // the index pointed down at the spot, twice: "now", "here", "today"
  here: () => {
    const D = [[0, -0.93, -0.35], [0.05, -0.35, 0.93]];
    return seq([
      [0, { ...one('right', 'point', [-0.065, -0.05, 0.05], D), ...quiet('right') }],
      [0.16, one('right', 'point', [-0.065, -0.08, 0.06], D)],
      [0.2, one('right', 'point', [-0.065, -0.058, 0.053], D)],
      [0.16, one('right', 'point', [-0.065, -0.082, 0.06], D)],
    ]);
  },
  // the index pointed off to the side: "there", "those"
  there: () => {
    const D = [[0.2, -0.9, 0.4], [-0.55, 0.25, 0.8]];
    return seq([
      [0, { ...one('right', 'point', [-0.07, -0.06, 0.05], D), ...quiet('right') }],
      [0.22, one('right', 'point', [-0.095, -0.05, 0.075], D)],
      [0.32, one('right', 'point', [-0.092, -0.054, 0.072], D)],
    ]);
  },
};

// Words that call for a gesture of their own (priority 3).
const LEX = new Map();
const put = (ws, f) => ws.split(' ').forEach((w) => LEX.set(w, f));
put('hi hello hey bye goodbye', G.wave);
put('what how why which whats hows', () => G.well());
put('no not never nope dont cant wont isnt nothing', G.wag);
put('i me my im ive mine myself', G.me);
put('you your youre yourself yours', () => G.you());
put('meet introduce intro connect match matched together pair both couple', G.together);
put('build building built make making create creating project startup app', G.ball);
put('think thinking idea know remember guess wonder', G.temple);
put('great amazing awesome love wow incredible brilliant beautiful fantastic', G.burst);
put('everyone everybody people room all whole big huge lots many everything', G.wide);
put('yes sure really definitely absolutely totally course', G.press);
put('exactly precisely right point', () => G.jab());
put('but maybe though however actually instead', () => G.flip());
put('come find look', G.beckon);
put('please thanks thank sorry', G.plead);
put('little bit quick kinda', G.little);
put('good nice congrats congratulations', () => G.thumb());
put('ok okay fine alright perfect', G.ok);
put('first firstly', () => G.num('point'));
put('second secondly two twice', () => G.num('peace'));
put('third three', () => G.num('three'));
put('fourth four', () => G.num('four'));
put('fifth five', () => G.num('spread_palm'));
put('wait stop hold hang careful', G.stop);
put('strong hard power work working push fight must', () => G.fist());
put('or versus compare either choice choose option options depends balance', G.scales);
put('more grow growing growth higher better bigger increase', () => G.up());
put('less lower slow slowly calm easy gentle', () => G.calm());
put('always every forever years long far across entire', () => G.sweep());
put('anyway whatever forget skip away before ago past', () => G.aside());
put('give share offer help support bring', () => G.cup());
put('money pay paid price cost funding invest investor investors revenue', G.money);
put('hope hopefully luck lucky wish', G.luck);
put('cool chill relax fun', G.shaka);
put('now here today', G.here);
put('there those', G.there);
put('small tiny detail details specific', () => G.pinch());
put('open start begin welcome', G.open);

// Everyday strokes for phrases with nothing special in them: [how often, the stroke, one-handed].
// The right hand does most of the one-handed ones, as a right-handed person's does.
const FILLERS = [
  [3, G.beat, true], [2, G.offer, true], [1.6, G.chop, true], [1.2, G.flip, true], [1, G.roll], [1.2, G.frame], [1, G.beats],
  [0.7, G.shrug], [0.7, G.well, true], [0.6, G.jab, true], [0.6, G.pinch, true], [0.6, G.open], [0.5, G.cup, true], [0.4, G.aside, true],
];
function pickFiller(rnd, last) {
  let total = 0;
  FILLERS.forEach(([w], i) => { if (i !== last) total += w; });
  let x = rnd() * total, idx = 0;
  for (let i = 0; i < FILLERS.length; i++) { if (i === last) continue; idx = i; x -= FILLERS[i][0]; if (x <= 0) break; }
  const [, f, sided] = FILLERS[idx];
  return { idx, make: () => (sided ? f(rnd() < 0.72 ? 'right' : 'left') : f()) };
}

// --------------------------------------------------------------------------- timing

// Each word's start time in the audio, from its length and the punctuation after it.
function timeWords(text, duration) {
  const raw = text.match(/\S+/g) || [];
  const items = raw.map((w) => {
    const clean = w.replace(/[^A-Za-z0-9']/g, '');
    const pause = /[.!?]["')]*$/.test(w) ? 7 : /[,;:—–-]["')]*$/.test(w) ? 3.5 : 0;
    return { word: clean.toLowerCase().replace(/'/g, ''), q: /\?["')]*$/.test(w), weight: 2.2 + clean.length, pause };
  });
  const total = items.reduce((s, x) => s + x.weight + x.pause, 0) || 1;
  const lead = Math.min(0.15, duration * 0.05), speak = Math.max(0.1, duration - lead - 0.1);
  let acc = 0;
  for (const x of items) { x.t = lead + (acc / total) * speak; acc += x.weight + x.pause; x.end = lead + (acc / total) * speak; }
  return items;
}

// --------------------------------------------------------------------------- the clip

export function plan(text, duration, seed = 1) {
  const rnd = rng(seed * 7919 + text.length * 31);
  const words = timeWords(text, duration);
  const loud = text.includes('!');
  // every gesture gets its own speed, size and place; an excited line is gestured bigger
  const fresh = () => vary({
    tempo: 0.92 + rnd() * 0.22, amp: (loud ? 1.0 : 0.82) + rnd() * 0.28,
    off: [rnd() * 0.012, (rnd() - 0.5) * 0.02, (rnd() - 0.5) * 0.016],
    lag: 0.03 + rnd() * 0.05, rest: rnd() < 0.6 ? 'ready' : 'low',
  });
  const want = [];
  let lastF = null, lastAt = -9;
  words.forEach((w, i) => {
    const f = LEX.get(w.word);
    if (f && !(f === lastF && w.t - lastAt < 1.6)) { fresh(); want.push({ ...f(), at: w.t, i, pri: 3 }); lastF = f; lastAt = w.t; }
    if (w.q) { fresh(); want.push({ ...G.shrug(), at: Math.max(0, w.t - 0.15), i, pri: 3.5 }); }
    // (not on the last word of a sentence: the hands are already coming to rest there)
    else if (w.word.length > 3 && (w.pause < 7 || i === 0)) want.push({ fill: true, at: w.t, i, pri: 1 });
  });
  for (const e of want) e.start = Math.max(0.02, e.at - LEAD);

  // the meaningful ones first, then everyday strokes into the gaps, none overlapping
  const placed = [];
  const clash = (s, d, pad = 0.04) => placed.find((p) => s < p.start + p.dur + pad && p.start < s + d + pad);
  for (const e of want.filter((x) => !x.fill).sort((a, b) => b.pri - a.pri || a.start - b.start)) {
    let s = e.start, c;
    while ((c = clash(s, e.dur)) && c.start + c.dur + 0.05 - e.start <= 0.3) s = c.start + c.dur + 0.05;
    if (clash(s, e.dur) || s + e.dur > duration + 0.6) continue;
    e.start = s;
    placed.push(e);
  }
  // the strokes leave a breath between themselves and their neighbours, never the same length
  let lastFill = -1;
  for (const e of want.filter((x) => x.fill)) {
    fresh();
    const pick = pickFiller(rnd, lastFill), g = pick.make(), pad = 0.05 + rnd() * 0.3;
    if (clash(e.start, g.dur, pad) || e.start + g.dur > duration + 0.4) continue;
    Object.assign(e, g); lastFill = pick.idx;
    placed.push(e);
  }
  placed.sort((a, b) => a.start - b.start);

  const keys = [{ t: 0, hands: structuredClone(POSES.ready) }];
  let lastT = 0;
  placed.forEach((e, n) => {
    // after a rest the hands wait, then go: they don't creep toward the next gesture
    const ks = e.keys(e.start, e.start + LEAD - lastT > 0.75 ? 0.48 : 0);
    keys.push(...ks);
    lastT = ks[ks.length - 1].t;
    const end = e.start + e.dur, next = placed[n + 1];
    // come back to rest when nothing follows soon: sometimes up and ready, sometimes lower
    if (!next || next.start - end > 0.9) {
      const rest = structuredClone(POSES[rnd() < 0.55 ? 'ready' : 'low']);
      rest[rnd() < 0.5 ? 'right' : 'left'].place.wrist[1] += r3(rnd() * 0.012);
      lastT = r3(end + 0.5 + rnd() * 0.2);
      keys.push({ t: lastT, ease: 'smooth', hands: rest });
    }
  });
  vary({});
  keys.sort((a, b) => a.t - b.t);
  for (let i = 1; i < keys.length; i++) if (keys[i].t <= keys[i - 1].t) keys[i].t = r3(keys[i - 1].t + 0.01);
  const endT = keys[keys.length - 1].t;
  return {
    version: 1, fps: 30, idle: { amount: 1 }, collide: COLLIDE, duration: r3(Math.max(duration, endT) + 0.2), keys,
    _events: placed.map((e) => (e.fill ? '·' : '') + words[e.i].word),
  };
}

// --------------------------------------------------------------------------- waiting, listening, thinking
// Each mode has one quiet loop (breathing) and a handful of small things people do with their
// hands meanwhile. Every one starts and ends in the mode's pose, so the page can play them one
// after another in any order.

const at = (t, hands, o = {}) => ({ t, hands, ...o });
const PASS = { pass: true };
const lift = (p, dy, turn = 0) => { const h = structuredClone(p); h.place.wrist[1] += dy; h.place.palm_facing[0] += turn; return h; };
const shift = (p, d) => { const h = structuredClone(p); h.place.wrist = h.place.wrist.map((x, i) => r3(x + d[i])); return h; };
// keys from the mode's pose `p` and back: k(seconds after the last key, hands, options)
function track(p, build) {
  const keys = [at(0, structuredClone(p))];
  let t = 0;
  build((dt, hands, o = { ease: 'smooth' }) => keys.push(at(r3(t += dt), hands, o)));
  keys.push(at(r3(t + 0.01), structuredClone(p)));   // (exactly the pose it started in)
  return keys;
}
const home = (p) => structuredClone(p);

// Both hands' fingertips pressed together in a tent, tipped `deg` forward from upright, the
// hands `dx` apart from touching.
function steeple(y, z, deg, dx = 0) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return both('steeple', [-0.1002 - dx, y, z], [1, -0.364 * c, -0.364 * s], [0.364, c, s], { near: true });
}
const NEAR = { near: true };
// the head is out of frame, above and behind the hands
const chin = (dy) => hand('right', 'relaxed', [-0.03, -0.035 + dy, -0.035], [0.7, 0, -0.7], [0.3, 0.9, 0.1], NEAR);
const temple = (dy) => hand('right', 'point', [-0.03, -0.005 + dy, -0.04], [0.6, 0, 0.8], [0.4, 0.9, -0.1], NEAR);
const tucked = () => hand('left', 'relaxed', [-0.13, -0.13, 0.02], [0.6, 0.55, 0.55], [0.12, 0.8, 0.6], NEAR);

// breathing and a slow alternate lift of the hands
const breathe = (a, T = 5) => (p) => [
  at(0, structuredClone(p)),
  at(r3(T * 0.34), { right: lift(p.right, a, 0.08), left: lift(p.left, -a * 0.5) }, { ease: 'smooth' }),
  at(r3(T * 0.68), { right: lift(p.right, -a * 0.5), left: lift(p.left, a, -0.08) }, { ease: 'smooth' }),
  at(T, structuredClone(p), { ease: 'smooth' }),
];
// fingers drumming on a table, little finger to index
const drum = (rounds) => (p) => track(p, (k) => {
  const soft = mix('relaxed', 'open_palm', 0.55), W = [-0.085, -0.115, 0.035];
  const tap = (f) => ({ right: hand('right', f ? bend(soft, [f], 26) : soft, W, ...FLAT) });
  k(0.8, tap());
  for (let r = 0; r < rounds; r++) {
    for (const f of ['pinky', 'ring', 'middle', 'index']) k(0.085, tap(f), PASS);
    k(0.11, tap(), PASS);
    k(r % 2 ? 0.5 : 0.16, tap());
  }
  k(0.9, home(p));
});
// the chin rested on the hand for a while
const chinRest = (hold) => (p) => track(p, (k) => {
  k(1.0, { right: chin(0), left: tucked() });
  k(hold * 0.3, { right: chin(0.006) });
  k(hold * 0.4, { right: chin(0) });
  k(hold * 0.3, { right: chin(0.005) });
  k(1.0, home(p));
});
// the fingertips brought together in a tent and held; `taps` pats them together
const tent = (y, deg, hold, taps = 0) => (p) => track(p, (k) => {
  k(1.0, steeple(y, 0, deg, 0.04));
  k(0.45, steeple(y + 0.004, 0, deg, 0));
  for (let i = 0; i < taps; i++) { k(0.2, steeple(y + 0.004, 0, deg, 0.011), PASS); k(0.2, steeple(y + 0.004, 0, deg, 0), i < taps - 1 ? PASS : undefined); }
  k(hold * 0.5, steeple(y + 0.007, 0, deg - 4, 0));
  k(hold * 0.5, steeple(y + 0.004, 0, deg + 2, 0));
  k(0.45, steeple(y, 0, deg, 0.04));
  k(1.0, home(p));
});
// two palms weighed against each other, slowly
const weigh = (p) => track(p, (k) => {
  const w = (d) => ({ right: hand('right', 'offering_palm', [-0.09, -0.085 + d, 0.05], ...UP_OUT), left: hand('left', 'offering_palm', [-0.09, -0.085 - d, 0.05], ...UP_OUT) });
  k(0.9, w(0)); k(0.6, w(0.022)); k(0.8, w(-0.022)); k(0.8, w(0.018)); k(0.6, w(0));
  k(0.9, home(p));
});

const BIT = {
  idle: breathe(0.011),
  // the weight moved from one side to the other
  'idle:shift': (p) => track(p, (k) => {
    k(1.5, { right: shift(p.right, [0.012, 0.006, 0.01]), left: shift(p.left, [0.012, -0.004, 0]) });
    k(1.7, { right: shift(p.right, [-0.006, -0.003, 0]), left: shift(p.left, [-0.008, 0.006, 0.01]) });
    k(1.5, home(p));
  }),
  'idle:drum': drum(2),
  // fingers stretched wide, curled up, let go
  'idle:stretch': (p) => track(p, (k) => {
    const D = [[0.2, -0.5, 0.85], [0.1, 0.85, 0.5]];
    k(0.9, both('open_palm', [-0.085, -0.085, 0.05], ...D));
    k(0.5, both('spread_palm', [-0.09, -0.07, 0.07], ...D));
    k(0.7, both('spread_palm', [-0.09, -0.067, 0.072], ...D));
    k(0.6, both(mix('relaxed', 'claw', 0.8), [-0.085, -0.09, 0.05], ...D));
    k(0.5, both('relaxed', [-0.088, -0.1, 0.04], ...D));
    k(0.9, home(p));
  }),
  // a look at her nails: the hand turned over, tilted, the fingers opened
  'idle:nails': (p) => track(p, (k) => {
    const N = (s, t = 0) => ({ right: hand('right', s, [-0.075, -0.065, 0.03], [0.15 + t, 0.15, -1], [0.2 - t, 0.95, 0.15]) });
    const curled = mix('relaxed', 'claw', 0.5);
    k(1.0, N(curled)); k(0.9, N(curled, 0.15)); k(0.8, N('spread_palm')); k(0.8, N('spread_palm', -0.1)); k(0.6, N('relaxed'));
    k(1.0, home(p));
  }),
  'idle:steeple': tent(-0.12, 50, 2.6),
  // the hands shaken loose
  'idle:shake': (p) => track(p, (k) => {
    const s = (a, b) => ({ right: hand('right', 'relaxed', [-0.09, -0.1 + a, 0.05], ...LOOSE), left: hand('left', 'relaxed', [-0.09, -0.1 + b, 0.05], ...LOOSE) });
    k(0.6, s(0, 0));
    for (let i = 0; i < 6; i++) k(0.1, i % 2 ? s(-0.01, 0.012) : s(0.012, -0.01), PASS);
    k(0.3, s(0, 0));
    k(0.8, home(p));
  }),

  listening: breathe(0.006),
  // a small double dip of the hands, the way a nod goes through the body
  'listening:nod': (p) => track(p, (k) => {
    const d = (a, b) => ({ right: lift(p.right, a), left: lift(p.left, b) });
    k(0.24, d(-0.012, -0.01)); k(0.26, d(0.003, 0.002)); k(0.24, d(-0.01, -0.009)); k(0.45, home(p)); k(1.6, home(p));
  }),
  'listening:chin': chinRest(4.2),
  // a finger laid along the cheek
  'listening:cheek': (p) => track(p, (k) => {
    k(1.0, { right: temple(-0.012), left: tucked() });
    k(1.6, { right: temple(-0.008) }); k(1.8, { right: temple(-0.012) });
    k(1.0, home(p));
  }),
  // an open palm turned out to the speaker: "go on"
  'listening:goon': (p) => track(p, (k) => {
    k(0.5, { right: hand('right', 'offering_palm', [-0.08, -0.1, 0.04], ...UP_IN) });
    k(0.35, { right: hand('right', 'offering_palm', [-0.075, -0.085, 0.09], ...UP_OUT) });
    k(0.6, { right: hand('right', 'offering_palm', [-0.075, -0.088, 0.086], ...UP_OUT) });
    k(0.9, home(p));
  }),
  // the palms turned up a little, open to what is being said
  'listening:tilt': (p) => track(p, (k) => {
    k(1.1, both('relaxed', [-0.1, -0.125, 0.03], ...UP_IN));
    k(1.6, both('relaxed', [-0.1, -0.12, 0.034], ...UP_IN));
    k(1.1, home(p));
  }),
  'listening:steeple': tent(-0.115, 42, 4),

  thinking: breathe(0.008, 2.6),
  // scratching her head
  'thinking:scratch': (p) => track(p, (k) => {
    const scratch = (dx, s) => ({ right: hand('right', s, [-0.035 + dx, 0.03, -0.07], [0.2, -0.6, -0.75], [0.1, 0.6, -0.5], NEAR) });
    k(0.8, scratch(0, 'claw'), {});
    for (let i = 1; i <= 7; i++) k(0.17, scratch(i % 2 ? 0.014 : -0.008, i % 2 ? 'relaxed' : 'claw'), PASS);
    k(0.25, scratch(0, 'relaxed'));
    k(1.0, home(p));
  }),
  'thinking:chin': chinRest(2.2),
  // tapping her temple
  'thinking:temple': (p) => track(p, (k) => {
    k(0.9, { right: temple(0), left: tucked() });
    k(0.18, { right: temple(0.012) }, PASS); k(0.18, { right: temple(0) }, PASS); k(0.18, { right: temple(0.012) }, PASS);
    k(0.25, { right: temple(0) }); k(0.7, { right: temple(0.003) });
    k(0.9, home(p));
  }),
  // counting it off on her fingers
  'thinking:count': (p) => track(p, (k) => {
    const c = (s, dy = 0) => ({ right: hand('right', s, [-0.08, -0.055 + dy, 0.04], ...BACK) });
    k(0.9, c('fist')); k(0.45, c('point', 0.006)); k(0.5, c('peace', 0.003)); k(0.5, c('three', 0.008)); k(0.6, c('three', 0.004)); k(0.4, c('relaxed'));
    k(0.9, home(p));
  }),
  // a finger drawing small circles in the air
  'thinking:circle': (p) => track(p, (k) => {
    const D = [[0.3, -0.55, 0.75], [0.1, 0.8, 0.6]], c = [-0.075, -0.045, 0.06], r = 0.016;
    const pt = (a) => ({ right: hand('right', 'point', [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r, c[2]], ...D) });
    k(0.8, pt(0), {});
    for (let i = 1; i <= 16; i++) k(0.11, pt((i / 8) * Math.PI * 2), PASS);
    k(0.4, pt(0));
    k(0.9, home(p));
  }),
  'thinking:steeple': tent(-0.11, 38, 1.6, 3),
  'thinking:drum': drum(3),
  'thinking:weigh': weigh,
};

// The modes' loops by name; the first of each mode is its quiet one.
export const BITS = { idle: [], listening: [], thinking: [] };
for (const name of Object.keys(BIT)) BITS[name.split(':')[0]].push(name);

// One loop as a clip (first key = last key).
export function loop(name) {
  const mode = name.split(':')[0];
  const keys = (BIT[name] || BIT.idle)(POSES[mode] || POSES.idle);
  for (let i = 1; i < keys.length; i++) if (keys[i].t <= keys[i - 1].t) keys[i].t = r3(keys[i - 1].t + 0.01);
  return { version: 1, fps: 30, idle: { amount: 0 }, collide: false, duration: keys[keys.length - 1].t, keys };
}

export function still(name) {
  const p = POSES[name] || POSES.ready;
  const k = { hands: structuredClone(p) };
  return { version: 1, fps: 30, idle: { amount: 0 }, duration: 0.1, keys: [{ t: 0, ...k }] };
}
export { G };   // for tests
