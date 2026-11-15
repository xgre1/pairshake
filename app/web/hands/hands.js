// Emma's two hands, in place of her orb. three.js draws the Handkit hand meshes (wrist to
// fingertips, the forearm cut off) in white; worker.js plans what they sign for each line
// she says and solves the frames.
//
//   Hands.mount(el)            put the canvas in el (on a computer: behind the page, full screen)
//   Hands.unmount()            take it off the page
//   Hands.mode(m)              idle | listening | thinking | speaking
//   Hands.say(text, seconds)   sign along with a line that starts playing now
//   Hands.stop()               back to the mode's pose
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const BASE = new URL('./', import.meta.url);
const BLEND = 0.55;          // seconds to cross from one source to the next
const C = (h) => new THREE.Color(h);
const COL = { sky: C('#8FD3FF'), blush: C('#FFB8CF'), iris: C('#6E6BF2'), lilac: C('#B9A7FF'), glow: C('#F4F0FF') };

const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

// White skin, edges shaded a touch darker so the hands still read on a white page, and the
// forearm cut off cleanly just below the wrist (the forearm runs up +Y to the wrist at 0.26 m).
export function handMaterial(color = 0xffffff) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0, side: THREE.DoubleSide });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBind;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBind = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBind;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n  if (vBind.y < 0.236) discard;')
      // the inside of the cut wrist, seen through the opening, is lit as a flat solid end
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n  if (!gl_FrontFacing) normal = vec3(0.0, 0.0, 1.0);')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  float fr = pow(1.0 - abs(dot(normal, normalize(vViewPosition))), 2.0);
  diffuseColor.rgb *= 1.0 - 0.22 * fr;
}`);
  };
  return m;
}

class EmmaHands {
  constructor() {
    this.ok = false;
    this.ready = this.boot().then(() => (this.ok = true)).catch((e) => { console.warn('[hands] off:', e); });
  }

  async boot() {
    const canvas = document.createElement('canvas');
    canvas.className = 'hands-canvas';
    const r = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
    if (!r.capabilities.isWebGL2) throw new Error('no WebGL2');
    r.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.setClearColor(0x000000, 0);
    this.renderer = r; this.canvas = canvas;

    const scene = (this.scene = new THREE.Scene());
    this.camera = new THREE.PerspectiveCamera(25, 1, 0.05, 5);
    this.camera.position.set(0, 0.07, 0.95);
    this.camera.lookAt(0, -0.035, 0);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8e94a3, 1.5));
    const key = new THREE.DirectionalLight(0xffffff, 1.7); key.position.set(-0.4, 0.8, 1); scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5); fill.position.set(0.7, 0.1, 0.6); scene.add(fill);

    this.worker = new Worker(new URL('./worker.js', BASE), { type: 'module' });
    const layout = new Promise((res) => (this.onLayout = res));
    this.poses = {}; this.waiting = {};
    this.worker.onmessage = (e) => this.onWorker(e.data);

    const loader = new GLTFLoader();
    const [gr, gl, lay] = await Promise.all([
      loader.loadAsync(new URL('hand_r.glb', BASE).href), loader.loadAsync(new URL('hand_l.glb', BASE).href), layout,
    ]);
    this.layout = lay;
    this.nodes = lay.joints.map(() => null);
    this.meshes = [];
    for (const [g, side] of [[gr, 'right'], [gl, 'left']]) {
      g.scene.traverse((o) => {
        const i = lay.joints.indexOf(o.name);
        if (i >= 0) this.nodes[i] = o;
        if (o.isSkinnedMesh) { o.material = handMaterial(); o.frustumCulled = false; this.meshes[side === 'right' ? 0 : 1] = o; }
      });
      scene.add(g.scene);
    }
    this.roots = [lay.joints.indexOf('forearm_R'), lay.joints.indexOf('forearm_L')];
    this.stride = lay.stride;
    this.shown = new Float32Array(this.stride);
    this.from = new Float32Array(this.stride);
    this.target = new Float32Array(this.stride);

    // each mode has a quiet loop (named like the mode) and small things the hands do meanwhile
    // (idle:drum, thinking:chin ...). The quiet ones are baked before the hands show; the rest
    // in the background, the ones for thinking first (they are needed soonest).
    this.loops = {}; this.bits = lay.bits || {}; this.bags = {};
    await Promise.all([this.pose('ready'), ...['idle', 'listening', 'thinking'].map((n) => this.bakeLoop(n))]);
    const more = ['thinking', 'listening', 'idle'].map((m) => (this.bits[m] || []).filter((n) => n !== m));
    (async () => { for (let i = 0; more.some((l) => l[i]); i++) for (const l of more) if (l[i]) await this.bakeLoop(l[i], true); })();
    this.shown.set(this.poses.ready); this.from.set(this.poses.ready);
    this.src = { kind: 'loop', mode: 'idle', name: 'idle', at: performance.now() }; this.switchAt = -1e9; this.m = 'idle';
    this.prev = performance.now();
    this.clipId = 0; this.level = 0;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  pose(name) {
    if (this.poses[name]) return Promise.resolve(this.poses[name]);
    return new Promise((res) => { (this.waiting[name] ||= []).push(res); this.worker.postMessage({ type: 'pose', name }); });
  }

  bakeLoop(name, bg = false) {
    return new Promise((res) => { (this.waiting['loop:' + name] ||= []).push(res); this.worker.postMessage({ type: 'loop', name, bg }); });
  }

  // One of the mode's small actions, each used once before any comes round again.
  action(mode) {
    let bag = this.bags[mode];
    if (!bag?.length) {
      bag = (this.bits[mode] || []).filter((n) => n !== mode && this.loops[n] && n !== this.lastBit);
      for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; }
      this.bags[mode] = bag;
    }
    return bag.pop() || null;
  }

  // What the hands do after the loop `cur`: people fidget now and then while they wait, hardly
  // while they listen, and nearly all the time while they think.
  after(mode, cur) {
    const quiet = cur === mode;
    const chance = quiet ? ({ idle: 0.45, listening: 0.4, thinking: 0.9 }[mode] ?? 0.3) : mode === 'thinking' ? 0.45 : 0;
    const next = Math.random() < chance ? this.action(mode) : null;
    if (next) this.lastBit = next;
    return next || mode;
  }

  onWorker(m) {
    if (m.type === 'layout') return this.onLayout(m);
    if (m.type === 'loop') { this.loops[m.name] = m; (this.waiting['loop:' + m.name] || []).forEach((f) => f()); return; }
    if (m.type === 'pose') { this.poses[m.name] = m.data; (this.waiting[m.name] || []).forEach((f) => f(m.data)); delete this.waiting[m.name]; return; }
    if (m.type === 'error') { console.warn('[hands]', m.error, m.spec || ''); if (m.name) [m.name, 'loop:' + m.name].forEach((k) => (this.waiting[k] || []).forEach((f) => f())); return; }
    const c = this.clip;
    if (!c || m.id !== c.id) return;
    if (m.type === 'start') { c.fps = m.fps; c.n = m.frames; c.data = new Float32Array(m.frames * this.stride); c.have = 0; c.dur = m.duration; c.events = m.events; }
    else if (m.type === 'frames') {
      c.data.set(m.data, m.from * this.stride); c.have = m.from + m.data.length / this.stride;
      // start playing (crossing over from whatever is on screen) once there is something to play;
      // the clip catches up with her voice by starting a little in
      if (this.src.kind !== 'clip' && this.m === 'speaking') {
        c.tc = Math.min((performance.now() - c.start) / 1000, Math.max(0, (c.have - 1) / c.fps - 0.3), 0.6);
        this.use({ kind: 'clip', id: c.id });
      }
    }
  }

  mount(el) {
    if (!el || !this.canvas) return;
    // on a computer the hands fill the whole window behind the page; on a phone they sit in el
    // (unless el asks to keep them inline: the home page of someone Emma already knows)
    const wide = matchMedia('(min-width: 900px)').matches, full = wide && !el.dataset.inline;
    // el can frame the hands closer ("width,height" in meters): data-fit on a phone, data-fit-wide on a computer
    const want = full ? '' : wide ? el.dataset.fitWide : el.dataset.fit;
    const fit = want ? want.split(',').map(Number) : null;
    if (String(fit) !== String(this.fit)) { this.fit = fit; this.size = ''; }
    const host = full ? document.body : el;
    this.canvas.classList.toggle('hands-full', full);
    if (this.canvas.parentNode !== host) host.prepend(this.canvas);
    el.classList.add('hands-on');
    if (!this.onWide) { this.onWide = () => this.last && this.mount(this.last); matchMedia('(min-width: 900px)').addEventListener('change', this.onWide); }
    this.last = el;
    this.resize();
  }

  unmount() { this.canvas?.remove(); this.last = null; }

  resize() {
    const c = this.canvas, w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    if (this.size !== w + 'x' + h) {
      this.size = w + 'x' + h;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      // fit the space the hands move in: [width, height] in meters around (0, -0.035)
      const [W, H] = this.canvas.classList.contains('hands-full') ? [0.64, 0.5] : this.fit || [0.48, 0.38];
      // (a little margin for the camera's drift)
      this.dist = 1.06 * Math.max(H, W / this.camera.aspect) / 2 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
      this.camera.updateProjectionMatrix();
      this.drift(performance.now() / 1000);
    }
  }

  // A camera that is never quite still: it drifts slowly around the hands (a few degrees left and
  // right, up and down, a little closer and further) with a faint hand-held shake on top.
  drift(t) {
    if (!this.dist) return;
    const S = Math.sin;
    const yaw = 0.11 * S(t * 0.11) + 0.05 * S(t * 0.29 + 1.7) + 0.006 * S(t * 1.3 + 0.4) + 0.003 * S(t * 2.3);
    const pitch = 0.11 + 0.045 * S(t * 0.15 + 2.1) + 0.02 * S(t * 0.37) + 0.005 * S(t * 1.7 + 0.9) + 0.002 * S(t * 2.9);
    const roll = 0.014 * S(t * 0.21 + 0.5) + 0.003 * S(t * 1.1);
    const d = this.dist * (1 + 0.03 * S(t * 0.17 + 0.9));
    const tx = 0.006 * S(t * 0.23), ty = -0.035 + 0.004 * S(t * 0.31 + 1.2);
    this.camera.position.set(tx + d * S(yaw) * Math.cos(pitch), ty + d * S(pitch), d * Math.cos(yaw) * Math.cos(pitch));
    this.camera.up.set(S(roll), Math.cos(roll), 0);
    this.camera.lookAt(tx, ty, 0);
  }

  // switch what drives the hands, crossing over from what is on screen now
  use(src) { this.from.set(this.shown); this.switchAt = performance.now(); this.src = src; }

  mode(m) {
    if (!this.ok) return;
    this.m = m;
    if (m === 'speaking') return;   // the hands keep their loop until her line's clip is ready
    this.clip = null;
    const was = this.src?.kind === 'loop' ? this.src.mode : 'speaking';
    const mode = this.loops[m] ? m : 'idle';
    // thinking starts with something to do; her turn handed over starts with "go on"
    let name = mode;
    if (mode === 'thinking') name = this.action(mode) || mode;
    else if (mode === 'listening' && was === 'speaking' && this.loops['listening:goon']) name = 'listening:goon';
    this.use({ kind: 'loop', mode, name, at: performance.now() });
  }

  say(text, seconds) {
    if (!this.ok || !text) return;
    const id = ++this.clipId;
    this.clip = { id, start: performance.now(), have: 0, data: null, tc: 0 };
    this.worker.postMessage({ type: 'say', id, text, duration: seconds, fps: 30 });
  }

  stop() { if (this.ok) this.mode(this.m === 'speaking' ? 'idle' : this.m); }

  // the source's frame at `now` (dt seconds after the last) into `out`
  sample(now, dt, out) {
    const s = this.src, st = this.stride, J = this.layout.joints.length;
    const at = (data, n, f, wrap) => {   // frame f (fractional) of n frames
      const i = Math.floor(f), a = f - i, j = wrap ? (i + 1) % n : Math.min(i + 1, n - 1);
      const A = data.subarray(i * st, (i + 1) * st);
      if (a < 1e-3) out.set(A); else mixFrames(A, data.subarray(j * st, (j + 1) * st), a, out, J);
    };
    if (s.kind === 'loop') {
      let L = this.loops[s.name] || this.loops.idle;
      if (!L) { out.set(this.poses.ready); return; }
      // every loop ends in the pose the next one starts in, so they follow on without a seam
      let e = (now - s.at) / 1000;
      const dur = (L.n - 1) / L.fps;
      if (e >= dur) {
        s.name = this.after(s.mode, s.name);
        s.at = e - dur < 0.1 ? s.at + dur * 1000 : now;   // (now: the page was in the background)
        L = this.loops[s.name] || L;
        e = Math.max(0, (now - s.at) / 1000);
      }
      at(L.data, L.n, Math.min(e * L.fps, L.n - 1), false);
      return;
    }
    if (s.kind === 'pose') { out.set(this.poses[s.name] || this.poses.ready); return; }
    const c = this.clip;
    if (!c || c.id !== s.id || !c.have) { out.set(this.shown); return; }
    // the clip's own clock: it never runs past the frames solved so far, it slows down instead
    const ahead = (c.have - 1) / c.fps - c.tc;
    c.tc += dt * Math.max(0, Math.min(1, ahead / 0.3));
    if (c.tc >= c.dur - 1e-3) {
      this.use({ kind: this.m === 'speaking' ? 'pose' : 'loop', mode: this.m, name: this.m === 'speaking' ? 'ready' : this.m, at: now });
      return this.sample(now, dt, out);
    }
    at(c.data, c.have, Math.min(c.tc * c.fps, c.have - 1), false);
  }

  loop(now) {
    requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, (now - this.prev) / 1000); this.prev = now;
    if (!this.canvas.isConnected || !this.canvas.clientWidth) return;
    this.sample(now, dt, this.target);
    this.drift(now / 1000);
    const w = smooth((now - this.switchAt) / 1000 / BLEND);
    const n = this.layout.joints.length;
    if (w < 1) mixFrames(this.from, this.target, w, this.shown, n); else this.shown.set(this.target);
    this.apply(now);
    this.renderer.render(this.scene, this.camera);
  }

  apply(now) {
    const d = this.shown, n = this.layout.joints.length;
    const lvl = window.EmmaLevel ? window.EmmaLevel() : 0;
    this.level += (lvl - this.level) * 0.25;
    const t = now / 1000;
    for (let j = 0; j < n; j++) {
      const node = this.nodes[j]; if (!node) continue;
      const o = j * 8;
      node.position.set(d[o], d[o + 1], d[o + 2]);
      node.quaternion.set(d[o + 3], d[o + 4], d[o + 5], d[o + 6]);
      node.scale.setScalar(d[o + 7] || 1);
    }
    // breathing, and a little lift with her voice
    this.roots.forEach((j, k) => {
      const node = this.nodes[j]; if (!node) return;
      node.position.y += Math.sin(t * 1.5 + k * 1.3) * 0.0022 + this.level * 0.007;
      node.position.x += Math.sin(t * 0.9 + k * 2.1) * 0.0012;
    });
    const mo = n * 8, M = this.layout.morphs;
    this.meshes.forEach((mesh, k) => {
      const inf = mesh?.morphTargetInfluences; if (!inf) return;
      for (let i = 0; i < M && i < inf.length; i++) inf[i] = d[mo + k * M + i];
    });
  }
}

// a..b by w. Rotations by normalised lerp, corrective weights linearly. The two root joints
// (forearm_R, forearm_L) sit at the elbow, 0.26 m below the wrist: their positions are mixed at
// the wrist, or the hand would swing off its path whenever the forearm turns.
const ARM = 0.26, ROOTS = [0, 17];
export function mixFrames(a, b, w, out, joints) {
  for (let j = 0; j < joints; j++) {
    const o = j * 8;
    let dot = a[o + 3] * b[o + 3] + a[o + 4] * b[o + 4] + a[o + 5] * b[o + 5] + a[o + 6] * b[o + 6];
    const sgn = dot < 0 ? -1 : 1;
    let x = a[o + 3] + (sgn * b[o + 3] - a[o + 3]) * w, y = a[o + 4] + (sgn * b[o + 4] - a[o + 4]) * w;
    let z = a[o + 5] + (sgn * b[o + 5] - a[o + 5]) * w, q = a[o + 6] + (sgn * b[o + 6] - a[o + 6]) * w;
    const l = Math.hypot(x, y, z, q) || 1;
    out[o + 3] = x / l; out[o + 4] = y / l; out[o + 5] = z / l; out[o + 6] = q / l;
    out[o + 7] = a[o + 7] + (b[o + 7] - a[o + 7]) * w;
    if (ROOTS.includes(j)) {
      const wa = up(a, o), wb = up(b, o), wo = up(out, o);
      for (let k = 0; k < 3; k++) out[o + k] = (a[o + k] + wa[k]) + ((b[o + k] + wb[k]) - (a[o + k] + wa[k])) * w - wo[k];
    } else for (let k = 0; k < 3; k++) out[o + k] = a[o + k] + (b[o + k] - a[o + k]) * w;
  }
  for (let i = joints * 8; i < out.length; i++) out[i] = a[i] + (b[i] - a[i]) * w;
}
// the joint's rotation applied to (0, ARM * scale, 0): from the elbow to the wrist
function up(d, o) {
  const x = d[o + 3], y = d[o + 4], z = d[o + 5], q = d[o + 6], L = ARM * (d[o + 7] || 1);
  return [2 * (x * y - q * z) * L, (1 - 2 * (x * x + z * z)) * L, 2 * (y * z + q * x) * L];
}
export const Hands = new EmmaHands();
window.Hands = Hands;
