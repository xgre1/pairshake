// Solves Handkit clips off the main thread. A clip takes ~0.4 s to parse and each frame ~7 ms to
// solve, so frames are baked here in time order and streamed back in small batches; the page
// starts playing as soon as the first ones arrive.
import init, { Clip, gesture, solve } from './handkit_wasm.js';
import { plan, still, loop, setup, SHAPE_NAMES, BITS } from './planner.js';

// each library hand shape solved once into plain joint angles (no goals left to solve per frame)
const ready = init({ module_or_path: new URL('./handkit_wasm_bg.wasm', import.meta.url) }).then(() => {
  const shapes = {};
  for (const n of SHAPE_NAMES) { const { place, ...joints } = JSON.parse(solve(gesture(n))).hands.right; shapes[n] = joints; }
  setup(shapes);
});
let current = 0;   // the newest bake request; older ones stop early
let saying = 0;    // lines being baked right now

// Fixed layout of one frame: per joint t(3) r(4) s(1), then each hand's corrective shape weights.
const SIDES = ['R', 'L'];
const BONES = ['forearm', 'hand', 'index_mcp', 'index_pip', 'index_dip', 'middle_mcp', 'middle_pip', 'middle_dip',
  'ring_mcp', 'ring_pip', 'ring_dip', 'pinky_mcp', 'pinky_pip', 'pinky_dip', 'thumb_cmc', 'thumb_mcp', 'thumb_ip'];
const JOINTS = SIDES.flatMap((s) => BONES.map((b) => `${b}_${s}`));
const MORPHS = 14;
const STRIDE = JOINTS.length * 8 + MORPHS * 2;

function pack(b, out, o) {
  for (const name of JOINTS) {
    const j = b.joints[name];
    if (j) { out.set(j.t, o); out.set(j.r, o + 3); out[o + 7] = j.s ?? 1; }
    else { out[o + 6] = 1; out[o + 7] = 1; }
    o += 8;
  }
  for (const s of SIDES) {
    const w = b.morph?.[`skin_${s}`];
    if (w) for (let i = 0; i < MORPHS; i++) out[o + i] = w[i] ?? 0;
    o += MORPHS;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

self.onmessage = async (e) => {
  const m = e.data;
  await ready;
  if (m.type === 'pose') {   // one still pose (idle, listening, thinking ...), solved right away
    try {
      const clip = new Clip(JSON.stringify(still(m.name))), buf = new Float32Array(STRIDE);
      pack(JSON.parse(clip.bones(0)), buf, 0); clip.free();
      self.postMessage({ type: 'pose', name: m.name, data: buf }, [buf.buffer]);
    } catch (err) { self.postMessage({ type: 'error', name: m.name, error: String(err.message || err) }); }
    return;
  }
  if (m.type === 'loop') {   // one of a mode's loops (idle, idle:drum, thinking:chin ...), baked whole
    try {
      // the last frame is the first again: the page plays the loops one after another
      const clip = new Clip(JSON.stringify(loop(m.name))), fps = 30, n = Math.round(clip.duration * fps) + 1;
      const buf = new Float32Array(n * STRIDE);
      for (let f = 0; f < n; f++) {
        pack(JSON.parse(clip.bones(Math.min(f / fps, clip.duration))), buf, f * STRIDE);
        // the extra loops are baked in the background: a line she says always goes first
        if (m.bg && f % 6 === 5) { await tick(); while (saying) await new Promise((r) => setTimeout(r, 40)); }
      }
      clip.free();
      self.postMessage({ type: 'loop', name: m.name, fps, n, data: buf }, [buf.buffer]);
    } catch (err) { self.postMessage({ type: 'error', name: m.name, error: String(err.message || err) }); }
    return;
  }
  if (m.type !== 'say') return;
  const id = (current = m.id);
  saying++;
  try { await say(m, id); } finally { saying--; }
};

async function say(m, id) {
  let clip, spec;
  try { spec = plan(m.text, m.duration, id); const { _events, ...c } = spec; clip = new Clip(JSON.stringify(c)); }
  catch (err) { self.postMessage({ type: 'error', id, error: String(err.message || err), spec }); return; }
  if (current !== id) { clip.free(); return; }
  const fps = m.fps || 30, n = Math.ceil(clip.duration * fps) + 1, batch = 4;
  self.postMessage({ type: 'start', id, fps, frames: n, stride: STRIDE, duration: clip.duration, events: spec._events });
  for (let i = 0; i < n; i += batch) {
    if (current !== id) { clip.free(); return; }
    const k = Math.min(batch, n - i), buf = new Float32Array(k * STRIDE);
    for (let f = 0; f < k; f++) pack(JSON.parse(clip.bones((i + f) / fps)), buf, f * STRIDE);
    self.postMessage({ type: 'frames', id, from: i, data: buf }, [buf.buffer]);
    await tick();   // let a newer request in
  }
  clip.free();
  self.postMessage({ type: 'done', id });
}

self.postMessage({ type: 'layout', joints: JOINTS, morphs: MORPHS, stride: STRIDE, bits: BITS });
