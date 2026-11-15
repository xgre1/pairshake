// The matching screen in 3D: your hand in the middle of a ring of agents' hands. The agents wait
// quietly; your hand reaches out and shakes each one's hand as your agent asks them, and a good
// answer gets a thumbs-up. At the end the camera closes in on your hand shaking your match's, and they hold on.
// The motion is baked (tools/bake_ring.mjs); this only plays and blends it.
//
//   await Ring.init()            load; the picture lives in Ring.stage, a fixed layer that
//   Ring.follow(el | 'right')    sits over el (or the right part of the window), gliding there
//   Ring.start(), Ring.park()    the ring from the top; put it away
//   Ring.greet(i)                your hand shakes agent i's (skipped while it is busy)
//   Ring.react(i)                agent i gives a thumbs-up
//   Ring.seat(i, color, k, a)    agent i's hand: tinted toward color by k, faded to a
//   Ring.screen(i), center()     where things are, in CSS px of el (for labels)
//   await Ring.finale(i, color)  the two of you shake hands and hold on (and keep holding, the
//                                camera slowly circling, until park())
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { handMaterial, mixFrames } from './hands.js';

const BASE = new URL('./', import.meta.url);
const J = 17, STRIDE = J * 8 + 14, BLEND = 0.5;
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const dark = () => matchMedia('(prefers-color-scheme: dark)').matches;
const GHOST = () => new THREE.Color(dark() ? 0x4a4a50 : 0xbcbcc4);   // agents not heard from yet; yours is white

// Int16 frames -> the Float32 layout mixFrames works on (per joint t3 r4 s1, then weights)
function unpack(buf, meta, clip) {
  const per = meta.per, n = clip.frames, hands = clip.hands;
  const src = new Int16Array(buf, clip.offset, n * hands * per);
  const out = Array.from({ length: hands }, () => new Float32Array(n * STRIDE));
  for (let f = 0; f < n; f++) for (let h = 0; h < hands; h++) {
    let i = (f * hands + h) * per, o = f * STRIDE;
    const d = out[h];
    for (let j = 0; j < J; j++, o += 8) {
      d[o] = src[i++] / 1e4; d[o + 1] = src[i++] / 1e4; d[o + 2] = src[i++] / 1e4;
      const x = src[i++] / 32767, y = src[i++] / 32767, z = src[i++] / 32767, w = src[i++] / 32767;
      const l = Math.hypot(x, y, z, w) || 1; d[o + 3] = x / l; d[o + 4] = y / l; d[o + 5] = z / l; d[o + 6] = w / l; d[o + 7] = 1;
    }
    for (let k = 0; k < 14; k++) d[o + k] = src[i++] / 32767;
  }
  return { n, frames: out, grip: clip.grip, hold: clip.hold };
}

// One hand on screen, driven by one hand of a clip at a time, crossing over when that changes.
class Hand {
  constructor(proto, joints, parent, color) {
    this.root = clone(proto);
    this.nodes = joints.map(() => null);
    this.root.traverse((o) => {
      const i = joints.indexOf(o.name); if (i >= 0) this.nodes[i] = o;
      if (o.isSkinnedMesh) { this.mesh = o; o.material = handMaterial(color); o.frustumCulled = false; }
    });
    this.cur = new Float32Array(STRIDE); this.from = new Float32Array(STRIDE); this.next = new Float32Array(STRIDE);
    this.src = null; this.at = -1e9;
    this.seed = Math.random() * 100; this.sway = 1; this.q = new THREE.Quaternion(); this.e = new THREE.Euler();
    parent.add(this.root);
  }
  // play hand h of clip from page time t0 (ms); loop, or stop at `freeze` seconds in
  play(clip, h, t0, { loop = false, freeze = null, blend = true } = {}) {
    if (blend && this.src) { this.from.set(this.cur); this.at = performance.now(); } else this.at = -1e9;
    this.src = { clip, h, t0, loop, freeze };
  }
  // speed: how fast a looping clip plays (1 = as baked); a loop keeps its own clock so a change of speed
  // never jumps. Handshakes and thumbs-ups always play at full speed.
  update(now, calm = true, speed = 1) {
    const s = this.src; if (!s) return;
    let t = (now - s.t0) / 1000;
    if (s.loop) { s.tc = s.tc == null ? t : s.tc + Math.max(0, now - (this.lastNow ?? now)) / 1000 * speed; t = s.tc; }
    this.lastNow = now;
    if (s.freeze != null) t = Math.min(t, s.freeze);
    const n = s.clip.n;
    let f = t * 20;
    if (s.loop) f = ((f % n) + n) % n; else f = Math.max(0, Math.min(f, n - 1.001));
    const i = Math.floor(f), a = f - i, j = s.loop ? (i + 1) % n : Math.min(i + 1, n - 1), d = s.clip.frames[s.h];
    mixFrames(d.subarray(i * STRIDE, (i + 1) * STRIDE), d.subarray(j * STRIDE, (j + 1) * STRIDE), a, this.next, J);
    const w = smooth((now - this.at) / 1000 / BLEND);
    if (w < 1) mixFrames(this.from, this.next, w, this.cur, J); else this.cur.set(this.next);
    const c = this.cur;
    for (let k = 0; k < J; k++) {
      const node = this.nodes[k]; if (!node) continue; const o = k * 8;
      node.position.set(c[o], c[o + 1], c[o + 2]); node.quaternion.set(c[o + 3], c[o + 4], c[o + 5], c[o + 6]);
    }
    // a faint, never-repeating sway at the wrist and in the fingers, so even a resting hand is
    // alive; it lets go while the hand holds another (a grip must stay put)
    this.sway += ((calm ? 1 : 0) - this.sway) * 0.06;
    if (this.sway > 0.01) {
      const t = now / 1000 + this.seed, w = this.sway, S = Math.sin;
      this.e.set(w * (0.045 * S(t * 0.63) + 0.02 * S(t * 1.71)), w * 0.03 * S(t * 0.47 + 1.3), w * (0.035 * S(t * 0.52 + 2.1) + 0.012 * S(t * 1.37)));
      this.nodes[1].quaternion.multiply(this.q.setFromEuler(this.e));
      for (const k of [3, 6, 9, 12]) {   // middle joints of the four fingers: a slow, uneven curl
        const n = this.nodes[k]; if (!n) continue;
        this.e.set(w * 0.06 * (0.5 + 0.5 * S(t * 0.41 + k * 0.9)), 0, 0);
        n.quaternion.multiply(this.q.setFromEuler(this.e));
      }
    }
    const inf = this.mesh.morphTargetInfluences;
    if (inf) for (let k = 0; k < 14 && k < inf.length; k++) inf[k] = c[J * 8 + k];
  }
  palm(out) { return this.nodes[1].getWorldPosition(out); }
}

export const Ring = {
  ok: false,
  async init() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      // one fixed layer for the whole matching -> introduction stretch, so the picture never
      // restarts: it is laid over whatever placeholder the page gives it and glides between them
      const stage = (this.stage = document.createElement('div'));
      stage.id = 'stage3d';
      stage.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2;pointer-events:none;display:none';
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none';
      const r = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
      r.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); r.outputColorSpace = THREE.SRGBColorSpace; r.setClearColor(0, 0);
      this.renderer = r; this.canvas = canvas;
      const scene = (this.scene = new THREE.Scene());
      scene.add(new THREE.HemisphereLight(0xffffff, 0x8e94a3, 1.5));
      const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(-0.4, 1, 0.8); scene.add(key);
      const fill = new THREE.DirectionalLight(0xffffff, 0.5); fill.position.set(0.7, 0.2, 0.6); scene.add(fill);
      this.camera = new THREE.PerspectiveCamera(30, 1, 0.05, 10);

      const [meta, buf, gltf] = await Promise.all([
        fetch(new URL('ring.json', BASE)).then((x) => x.json()),
        fetch(new URL('ring.bin', BASE)).then((x) => x.arrayBuffer()),
        new GLTFLoader().loadAsync(new URL('hand_r_lo.glb', BASE).href),
      ]);
      this.meta = meta;
      this.loopClip = unpack(buf, meta, meta.ring);
      this.centerClip = unpack(buf, meta, meta.center);
      this.greets = meta.greet.map((g) => unpack(buf, meta, g));
      this.reacts = meta.react.map((g) => unpack(buf, meta, g));
      this.world = new THREE.Group(); scene.add(this.world);
      this.hands = meta.seats.map(() => new Hand(gltf.scene, meta.joints, this.world, GHOST()));
      this.me = new Hand(gltf.scene, meta.joints, this.world, 0xffffff);
      this.state = this.hands.map(() => ({ k: 0, a: 1, color: new THREE.Color() }));
      this.v = new THREE.Vector3(); this.camPos = new THREE.Vector3(); this.camAim = new THREE.Vector3();
      stage.append(canvas); document.body.append(stage);
      this.rect = { x: 0, y: 0, w: 0, h: 0 };
      this.tick = this.tick.bind(this);
      this.ok = true;
    })().catch((e) => { console.warn('[ring] off:', e); });
    return this.ready;
  },

  resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h || this.size === w + 'x' + h) return;
    this.size = w + 'x' + h; this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // the ring with its hands (about 0.95 m across, 0.7 m tall as seen from above) fills the box
    const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    this.dist = Math.max(0.95 / this.camera.aspect, 0.85) / 2 / tan;
    this.camera.updateProjectionMatrix();
  },

  // where the picture goes: over element el, or 'right' (the right part of a wide window)
  follow(target, glide = true) {
    if (!this.ok) return;
    this.target = target;
    this.glide = glide && this.stage.style.display !== 'none' ? { from: { ...this.rect }, at: performance.now() } : null;
    this.stage.style.display = 'block';
    this.place(performance.now());
  },
  targetRect() {
    if (this.target === 'right') { const x = Math.round(innerWidth * 0.44); return { x, y: 0, w: innerWidth - x, h: innerHeight }; }
    const r = this.target?.getBoundingClientRect?.();
    // over an element the layer is part of the page (document coordinates), so it scrolls and rubber-bands
    // with it natively; chasing the element from script every frame lagged a touch behind and stuttered
    return r ? { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height } : this.rect;
  },
  place(now) {
    let r = this.targetRect();
    if (this.glide) {
      const k = smooth((now - this.glide.at) / 900), f = this.glide.from;
      if (k >= 1) this.glide = null;
      else r = { x: f.x + (r.x - f.x) * k, y: f.y + (r.y - f.y) * k, w: f.w + (r.w - f.w) * k, h: f.h + (r.h - f.h) * k };
    }
    const q = this.rect;
    if (Math.abs(q.x - r.x) + Math.abs(q.y - r.y) + Math.abs(q.w - r.w) + Math.abs(q.h - r.h) < 0.5) return;
    Object.assign(q, r);
    this.stage.style.position = this.target === 'right' ? 'fixed' : 'absolute';
    Object.assign(this.stage.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
  },

  start() {
    if (!this.ok) return;
    const now = performance.now();
    this.t0 = now; this.busyUntil = 0; this.fin = null; this.pace = 1; clearTimeout(this.back);
    this.hands.forEach((h, i) => h.play(this.loopClip, i, now, { loop: true, blend: false }));
    this.me.play(this.centerClip, 0, now, { loop: true, blend: false });
    // every hand fades in, one after another around the ring, whether or not an agent sits there
    this.state.forEach((s, i) => { s.k = 0; s.a = 1; s.shown = 0; s.born = now + 250 + i * 160; s.color.copy(GHOST()); });
    this.running = true;
    cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(this.tick);
  },
  stop() { this.running = false; cancelAnimationFrame(this.raf); },
  park() { this.stop(); if (this.stage) this.stage.style.display = 'none'; this.target = null; },

  // your hand shakes agent i's; false when it is still busy with the last one
  greet(i, opts = {}) {
    if (!this.ok || !this.running || (this.fin && !opts.force) || (!opts.force && performance.now() < this.busyUntil)) return false;
    const s = i % this.hands.length, g = this.greets[s], now = performance.now();
    this.me.play(g, 0, now, opts); this.hands[s].play(g, 1, now, opts);
    const dur = (g.n / 20) * 1000;
    this.busyUntil = now + dur;
    if (opts.freeze == null) this.back = setTimeout(() => {   // back to what they were doing
      if (this.fin || this.hands[s].src?.clip !== g) return;
      this.hands[s].play(this.loopClip, s, this.t0, { loop: true });
      this.me.play(this.centerClip, 0, performance.now(), { loop: true });
    }, dur - 50);
    return true;
  },

  react(i) {
    if (!this.ok || !this.running || this.fin) return;
    const s = i % this.hands.length, h = this.hands[s], r = this.reacts[s];
    if (h.src?.clip !== this.loopClip) return;   // busy shaking hands
    h.play(r, 0, performance.now());
    setTimeout(() => { if (h.src?.clip === r && !this.fin) h.play(this.loopClip, s, this.t0, { loop: true }); }, (r.n / 20) * 1000 - 50);
  },

  seat(i, color, k, a) {
    if (!this.ok) return;
    const s = this.state[i % this.hands.length];
    s.k = k; s.a = a; if (color) s.color.set(color);
  },

  project(p) {
    p.project(this.camera);
    return { x: (p.x + 1) / 2 * this.canvas.clientWidth, y: (1 - p.y) / 2 * this.canvas.clientHeight };
  },
  screen(i) { return this.ok && this.size ? this.project(this.hands[i % this.hands.length].palm(this.v)) : null; },
  center() { return this.ok && this.size ? this.project(this.v.set(0, -0.07, 0)) : null; },

  // shake agent i's hand and keep holding it; whatever your hand was doing, it turns to them
  // (blended, no waiting). Resolves once they hold on.
  async finale(i, color) {
    if (!this.ok) return;
    const s = i % this.hands.length;
    if (color) { this.state[s].color.set(color); this.state[s].k = 1; this.state[s].a = 1; }
    clearTimeout(this.back);
    this.fin = { s, at: performance.now() };
    this.greet(s, { freeze: this.greets[s].hold, force: true });
    await new Promise((r) => setTimeout(r, (this.greets[s].hold + 0.5) * 1000));
  },

  tick(now) {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.tick);
    this.place(now);
    if (!this.canvas.clientWidth) return;
    this.resize();
    const T = now / 1000, S = Math.sin, dt = Math.min(0.05, (now - (this.last || now)) / 1000); this.last = now;
    // the finale: the others fade out over a second, the camera comes down over two
    const fk = this.fin ? smooth((now - this.fin.at) / 1000 / 2.0) : 0, fade = this.fin ? smooth((now - this.fin.at) / 1000 / 1.0) : 0;
    const ghost = GHOST();
    // how lively the ring is: Ring.pace (1 while your agent is talking to others, low while it waits), eased
    this.speed = (this.speed ?? 1) + ((this.pace ?? 1) - (this.speed ?? 1)) * (1 - Math.exp(-dt / 0.8));
    this.hands.forEach((h, i) => {
      h.update(now, !this.greets.includes(h.src?.clip), this.speed);
      const st = this.state[i];
      let a = now < st.born ? 0 : st.a;
      if (this.fin) a = this.fin.s !== i ? a * (1 - fade) : 1;
      // the shown alpha eases toward its target, so nothing pops
      st.shown = (st.shown ?? a) + (a - (st.shown ?? a)) * (1 - Math.exp(-dt / 0.3));
      const mat = h.mesh.material;
      mat.color.copy(ghost).lerp(st.color, st.k);
      mat.opacity = st.shown; mat.transparent = st.shown < 0.995;
      h.root.visible = st.shown > 0.04;
    });
    this.me.update(now, this.me.src?.clip === this.centerClip, this.speed);
    // your hand stands a little taller and bigger than the agents' while it waits in the middle,
    // and comes down to their size to shake hands (the handshakes are baked at that size)
    const waiting = this.me.src?.clip === this.centerClip ? 1 : 0;
    this.big = (this.big ?? 1) + (waiting - (this.big ?? 1)) * (1 - Math.exp(-dt / 0.25));
    this.me.root.scale.setScalar(1 + 0.35 * this.big); this.me.root.position.y = 0.05 * this.big;
    // the two of you, holding on: breathing together (both roots move as one, the grip stays)
    if (this.fin) {
      const b = 0.004 * S(T * 1.1) * fk;
      this.me.root.position.y += b; this.hands[this.fin.s].root.position.y = b;
    }
    this.world.updateMatrixWorld();

    // camera: looking down on the ring from the front, drifting; for the finale it comes down
    // beside the two hands, looking across the handshake
    const d = this.dist || 1.4, el = 0.8 + 0.015 * S(T * 0.17), yaw = 0.03 * S(T * 0.11);
    this.camPos.set(d * S(yaw) * Math.cos(el), d * S(el), d * Math.cos(yaw) * Math.cos(el));
    this.camAim.set(0, -0.02, 0);
    if (this.fin) {
      const seat = new THREE.Vector3(...this.meta.seats[this.fin.s]).applyMatrix4(this.world.matrixWorld);
      const mid = seat.clone().multiplyScalar(0.5).setY(-0.01);
      const r = seat.clone().setY(0).normalize(), side = new THREE.Vector3(r.z, 0, -r.x);
      if (side.z < 0) side.negate();   // the side toward where the camera already is
      // once it is there, it keeps circling slowly around the two hands
      const since = (now - this.fin.at) / 1000, orbit = 0.32 * S(since * 0.12) * smooth((since - 1.5) / 3);
      side.applyAxisAngle(new THREE.Vector3(0, 1, 0), orbit);
      const df = d * 0.42, lift = 0.28 + 0.06 * S(since * 0.09);
      const pos = mid.clone().addScaledVector(side, df * Math.cos(lift)).add(new THREE.Vector3(0, df * S(lift), 0));
      this.camPos.lerp(pos, fk); this.camAim.lerp(mid, fk);
    }
    this.camera.position.copy(this.camPos); this.camera.lookAt(this.camAim);
    this.renderer.render(this.scene, this.camera);
  },
};
window.Ring = Ring;
