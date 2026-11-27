// The crowd model as WebGPU compute shaders, plus the renderer.
// Three passes per step, mirroring sim-cpu.js line for line:
//   bin      sorts people into 1 m cells with atomic counters
//   step     moves each person, reading neighbours from the 3x3 cells around them
//   density  updates the smoothed people-per-m2 map and the risk counters

import { K, DT, STRIDE, STATS_LEN, LAYERS, T_FREE } from './model.js';
import { defaultParams } from './sim-cpu.js';

const STRUCTS = /* wgsl */`
struct Params {
  w: u32, h: u32, n: u32, k: u32,
  dt: f32, time: f32, evacTime: f32, guided: f32,
  mode: u32, step: u32, hasBar: u32, hasWc: u32,
  visitMean: f32, reactMax: f32, rhoJam: f32, densAlpha: f32,
  resetRisk: u32, pad1: u32, pad2: u32, pad3: u32,
}
struct Agent {
  pos: vec2f, vel: vec2f,
  v0: f32, radius: f32, pref: f32, timer: f32,
  goal: u32, seed: u32, dens: f32, aux: f32,
}
const G_STAGE = 0u; const G_BAR = 1u; const G_WC = 2u; const G_EXIT = 3u; const G_EXIT_DYN = 4u;
const G_SERVE_BAR = 5u; const G_SERVE_WC = 6u; const G_GONE = 9u;
fn solid(t: u32) -> bool { return t == 1u || t == 3u || t == 4u || t == 5u; }
`;

const BIN_WGSL = STRUCTS + /* wgsl */`
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> A: array<Agent>;
@group(0) @binding(2) var<storage, read_write> cellCount: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> cellItems: array<u32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.n) { return; }
  if (A[i].goal == G_GONE) { return; }
  let p = A[i].pos;
  let cx = u32(clamp(i32(floor(p.x)), 0, i32(P.w) - 1));
  let cy = u32(clamp(i32(floor(p.y)), 0, i32(P.h) - 1));
  let c = cy * P.w + cx;
  let slot = atomicAdd(&cellCount[c], 1u);
  if (slot < P.k) { cellItems[c * P.k + slot] = i; }
}
`;

const STEP_WGSL = STRUCTS + /* wgsl */`
const LOOK = 0.25;
const HEADWAY = 0.3;
const HEAD_RANGE = 0.4;
const GAMMA = 1.913;

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> A: array<Agent>;
@group(0) @binding(2) var<storage, read_write> B: array<Agent>;
@group(0) @binding(3) var<storage, read> cellCount: array<u32>;
@group(0) @binding(4) var<storage, read> cellItems: array<u32>;
@group(0) @binding(5) var<storage, read> grid: array<u32>;
@group(0) @binding(6) var<storage, read> fields: array<vec4f>;
@group(0) @binding(7) var<storage, read_write> stats: array<atomic<u32>>;
@group(0) @binding(8) var<storage, read> dens: array<vec4f>;

fn hash32(x0: u32) -> u32 {
  var x = x0;
  x ^= x >> 16u; x *= 0x7feb352du;
  x ^= x >> 15u; x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}
fn rnd(seed: u32, salt: u32) -> f32 {
  return f32(hash32(seed ^ (salt * 0x9e3779b9u)) >> 8u) / 16777216.0;
}
fn cellType(x: i32, y: i32) -> u32 {
  if (x < 0 || y < 0 || x >= i32(P.w) || y >= i32(P.h)) { return 1u; }
  return grid[u32(y) * P.w + u32(x)] & 255u;
}

// Bilinear sample of a flow field: xy is the unit direction, z the distance to the goal.
fn sampleField(layer: u32, p: vec2f) -> vec3f {
  let q = p - vec2f(0.5);
  let f0 = floor(q);
  let t = q - f0;
  let x0 = i32(f0.x); let y0 = i32(f0.y);
  let base = layer * P.w * P.h;
  var acc = vec3f(0.0); var ws = 0.0;
  for (var j = 0; j < 2; j++) {
    for (var i = 0; i < 2; i++) {
      let x = x0 + i; let y = y0 + j;
      if (x < 0 || y < 0 || x >= i32(P.w) || y >= i32(P.h)) { continue; }
      let v = fields[base + u32(y) * P.w + u32(x)];
      if (v.z > 1e8) { continue; }
      let w = select(1.0 - t.x, t.x, i == 1) * select(1.0 - t.y, t.y, j == 1) + 1e-4;
      acc += v.xyz * w; ws += w;
    }
  }
  if (ws <= 0.0) { return vec3f(0.0, 0.0, 1e9); }
  let l = length(acc.xy);
  var dir = vec2f(0.0);
  if (l > 1e-4) { dir = acc.xy / l; }
  return vec3f(dir, acc.z / ws);
}

// Bilinear sample of the smoothed density; -1 inside walls or off the map.
fn sampleDens(p: vec2f) -> f32 {
  let q = p - vec2f(0.5);
  let f0 = floor(q);
  let t = q - f0;
  let x0 = i32(f0.x); let y0 = i32(f0.y);
  var acc = 0.0; var ws = 0.0;
  for (var j = 0; j < 2; j++) {
    for (var i = 0; i < 2; i++) {
      let x = x0 + i; let y = y0 + j;
      if (x < 0 || y < 0 || x >= i32(P.w) || y >= i32(P.h)) { continue; }
      let c = u32(y) * P.w + u32(x);
      if (solid(grid[c] & 255u)) { continue; }
      let w = select(1.0 - t.x, t.x, i == 1) * select(1.0 - t.y, t.y, j == 1) + 1e-4;
      acc += dens[c].x * w; ws += w;
    }
  }
  if (ws > 0.0) { return acc / ws; }
  return -1.0;
}

fn nextVisit(seed: u32) -> f32 {
  return -log(1.0 - rnd(seed, P.step + 2000u)) * P.visitMean;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.n) { return; }
  var a = A[i];
  if (a.goal == G_GONE) { B[i] = a; return; }

  let W = i32(P.w); let H = i32(P.h);
  let p = a.pos;
  let cx = clamp(i32(floor(p.x)), 0, W - 1);
  let cy = clamp(i32(floor(p.y)), 0, H - 1);
  let g = grid[u32(cy) * P.w + u32(cx)];

  // Standing inside something that was just built: step out, or be removed if boxed in.
  if (solid(g & 255u)) {
    var offs = array<vec2i, 8>(vec2i(1, 0), vec2i(-1, 0), vec2i(0, 1), vec2i(0, -1),
                               vec2i(1, 1), vec2i(-1, 1), vec2i(1, -1), vec2i(-1, -1));
    // nearest free cell; a fenced-off one (no way to any exit) only when there is nothing else
    var found = false; var best = 1e9; var bd = vec2f(0.0);
    for (var k = 0; k < 8; k++) {
      let o = offs[k];
      let nx = cx + o.x; let ny = cy + o.y;
      if (!solid(cellType(nx, ny))) {
        let d = vec2f(f32(nx) + 0.5, f32(ny) + 0.5) - p;
        let shut = select(0.0, 100.0, fields[G_EXIT * P.w * P.h + u32(ny) * P.w + u32(nx)].z > 1e8);
        if (length(d) + shut < best) { best = length(d) + shut; bd = d; found = true; }
      }
    }
    if (found) {
      let l = length(bd);
      a.pos = p + bd * (min(l, 2.0 * P.dt) / max(l, 1e-6));
    }
    if (!found) { a.goal = G_GONE; a.pos = vec2f(-10.0); atomicAdd(&stats[64], 1u); }
    a.vel = vec2f(0.0);
    B[i] = a;
    return;
  }

  // Evacuation: everyone heads for an exit after a personal reaction delay.
  var goal = a.goal;
  if (P.mode == 1u && goal != G_EXIT && goal != G_EXIT_DYN) {
    if (P.evacTime >= rnd(a.seed, 77u) * P.reactMax) {
      goal = select(G_EXIT, G_EXIT_DYN, rnd(a.seed, 78u) < P.guided);
    }
  }

  var timer = a.timer;
  if (goal == G_STAGE) {
    timer -= P.dt;
    if (timer <= 0.0 && P.mode == 0u) {
      let u = rnd(a.seed, P.step + 1000u);
      if (P.hasBar == 1u && (P.hasWc == 0u || u < 0.55)) { goal = G_BAR; timer = 0.0; }
      else if (P.hasWc == 1u) { goal = G_WC; timer = 0.0; }
      else { timer = P.visitMean; }
    }
  } else if (goal == G_BAR || goal == G_WC) {
    timer += P.dt;
    if (timer > 900.0) { goal = G_STAGE; timer = nextVisit(a.seed); }
  } else if (goal == G_SERVE_BAR || goal == G_SERVE_WC) {
    timer -= P.dt;
    if (timer <= 0.0) { goal = G_STAGE; timer = nextVisit(a.seed); }
  }

  var e = vec2f(0.0); var dist = 1e9;
  if (goal <= 4u) { let fs = sampleField(goal, p); e = fs.xy; dist = fs.z; }
  if (dist > 1e8 && (goal == G_BAR || goal == G_WC)) { goal = G_STAGE; timer = nextVisit(a.seed); }

  // Neighbours: comfort spacing, overlap correction, sidestepping, and the gap to whoever is ahead.
  var sep = vec2f(0.0); var cor = vec2f(0.0); var vlim = 1e9;
  let hasE = dot(e, e) > 0.5;
  let right = vec2f(-e.y, e.x);
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let nx = cx + dx; let ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) { continue; }
      let cc = u32(ny) * P.w + u32(nx);
      let cnt = min(cellCount[cc], P.k);
      for (var s = 0u; s < cnt; s++) {
        let j = cellItems[cc * P.k + s];
        if (j == i) { continue; }
        let bpos = A[j].pos;
        let o = p - bpos;
        let rs = a.radius + A[j].radius;
        let sr = rs + 0.08;
        let far = rs + HEAD_RANGE;
        let d2 = dot(o, o);
        if (d2 >= far * far) { continue; }
        let d = sqrt(d2);
        var nn = vec2f(0.0);
        if (d > 1e-4) { nn = o / d; }
        else { let ang = rnd(a.seed ^ j, 5u) * 6.2831853; nn = vec2f(cos(ang), sin(ang)); }
        if (hasE && dot(nn, e) < -0.7) {
          // someone straight ahead: never walk faster than the gap closes in HEADWAY seconds
          vlim = min(vlim, max(d - rs, 0.0) / HEADWAY + max(dot(A[j].vel, e), 0.0));
        }
        if (d >= sr) { continue; }
        let qq = 1.0 - d / sr;
        sep += nn * qq;
        if (d < rs) { cor += nn * ((rs - d) * 0.5); }
        if (hasE && dot(nn, e) < -0.3 && dot(A[j].vel, e) < -0.1) { sep += right * (qq * 0.8); }
      }
    }
  }

  // Walking speed follows the crowd density a little way ahead (Weidmann's relation).
  let here = sampleDens(p);
  var rho = here;
  if (hasE) { rho = sampleDens(p + e * LOOK); }
  if (rho < 0.0) { rho = max(here, 0.0); }
  var wd = 0.0;
  if (rho < 0.05) { wd = 1.0; }
  else if (rho < P.rhoJam) { wd = 1.0 - exp(-GAMMA * (1.0 / rho - 1.0 / P.rhoJam)); }

  var vd = 0.0;
  if (goal == G_STAGE) {
    if (dist < 1e8 && dist > 1.2) { vd = a.v0 * wd * clamp((a.pref - rho) / 0.6, 0.0, 1.0); }
  } else if (goal == G_BAR || goal == G_WC) {
    if (dist < 1.6) {
      if (goal == G_BAR) { goal = G_SERVE_BAR; timer = 20.0 + 40.0 * rnd(a.seed, P.step + 3000u); }
      else { goal = G_SERVE_WC; timer = 45.0 + 60.0 * rnd(a.seed, P.step + 3000u); }
    } else if (dist < 1e8) { vd = a.v0 * wd; }
  } else if (goal == G_EXIT || goal == G_EXIT_DYN) {
    if (dist < 1e8) { vd = a.v0 * wd; }
  }

  vd = min(vd, vlim);

  var v = a.vel;
  v += ((e * vd - v) / 0.5 + sep * 1.2) * P.dt;
  let sp = length(v); let vmax = a.v0 * 1.3;
  if (sp > vmax) { v *= vmax / sp; }
  cor *= 0.6;
  let cl = length(cor);
  if (cl > 0.06) { cor *= 0.06 / cl; }
  var np = p + v * P.dt + cor;

  // Walls: push the body out of any solid cell it touches.
  for (var it = 0; it < 2; it++) {
    let ncx = i32(floor(np.x)); let ncy = i32(floor(np.y));
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        let x = ncx + dx; let y = ncy + dy;
        if (!solid(cellType(x, y))) { continue; }
        let lo = vec2f(f32(x), f32(y));
        let dv = np - clamp(np, lo, lo + vec2f(1.0));
        let dl = length(dv);
        if (dl < a.radius) {
          if (dl > 1e-5) {
            let wn = dv / dl;
            np += wn * (a.radius - dl);
            let vn = dot(v, wn);
            if (vn < 0.0) { v -= wn * vn; }
          } else { np = p; v = vec2f(0.0); }
        }
      }
    }
  }
  np = clamp(np, vec2f(0.01), vec2f(f32(W) - 0.01, f32(H) - 0.01));

  // Reaching an exit cell while leaving removes the person and counts them.
  let eg = grid[u32(floor(np.y)) * P.w + u32(floor(np.x))];
  if ((eg & 255u) == 2u && (goal == G_EXIT || goal == G_EXIT_DYN)) {
    atomicAdd(&stats[0], 1u);
    atomicAdd(&stats[(eg >> 8u) & 63u], 1u);
    a.goal = G_GONE; a.pos = vec2f(-10.0); a.vel = vec2f(0.0);
    B[i] = a;
    return;
  }
  a.pos = np; a.vel = v; a.timer = timer; a.goal = goal;
  a.dens = max(here, 0.0); a.aux = fract(a.aux + length(v) * P.dt / 1.4);   // walk phase, one gait cycle per 1.4 m
  B[i] = a;
}
`;

const DENS_WGSL = STRUCTS + /* wgsl */`
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> cellCount: array<u32>;
@group(0) @binding(2) var<storage, read> grid: array<u32>;
@group(0) @binding(3) var<storage, read_write> dens: array<vec4f>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= P.w || gid.y >= P.h) { return; }
  let c = gid.y * P.w + gid.x;
  var d = dens[c];
  if (solid(grid[c] & 255u)) { d.x = 0.0; dens[c] = d; return; }
  var sum = 0.0; var area = 0.0;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let x = i32(gid.x) + dx; let y = i32(gid.y) + dy;
      if (x < 0 || y < 0 || x >= i32(P.w) || y >= i32(P.h)) { continue; }
      let cc = u32(y) * P.w + u32(x);
      if (solid(grid[cc] & 255u)) { continue; }
      sum += f32(cellCount[cc]); area += 1.0;
    }
  }
  d.x = d.x + (sum / area - d.x) * P.densAlpha;
  if (P.resetRisk == 1u) { d.y = 0.0; d.z = 0.0; d.w = 0.0; }
  d.y = max(d.y, d.x);
  if (d.x >= 5.0) { d.z += P.dt; d.w += P.dt * f32(cellCount[c]); }
  dens[c] = d;
}
`;

const RENDER_COMMON = /* wgsl */`
struct Cam {
  center: vec2f, viewport: vec2f,
  scale: f32, minPx: f32, layer: u32, colorMode: u32,
  w: u32, h: u32, agentAlpha: f32, heatGain: f32,
  interp: f32,      // 0..1: how far the picture is between the previous step and the current one
  clock: f32,       // seconds of running time, drives the dance and the pulses
  detail: f32,      // 0 far away (dots) .. 1 close up (people drawn as figures)
  follow: u32,      // index + 1 of the person the camera follows, 0 for nobody
  mode: u32,        // 0 concert, 1 evacuation
  pad0: u32, pad1: u32, pad2: u32,
}
const NORMAL = vec3f(0.427, 0.655, 0.925);
const WARN = vec3f(0.980, 0.698, 0.098);
const CRIT = vec3f(0.816, 0.231, 0.231);
fn toClip(world: vec2f, C: Cam) -> vec4f {
  let ndc = (world - C.center) * C.scale / (C.viewport * 0.5);
  return vec4f(ndc.x, -ndc.y, 0.0, 1.0);
}
`;

const GRID_WGSL = RENDER_COMMON + /* wgsl */`
@group(0) @binding(0) var<uniform> C: Cam;
@group(0) @binding(1) var<storage, read> grid: array<u32>;
@group(0) @binding(2) var<storage, read> dens: array<vec4f>;
@group(0) @binding(3) var<storage, read> sdf: array<vec2f>;  // x: metres to the edge of the cell's own block (+ in fences and buildings, - on open ground); y: cast shadow on the ground

struct VOut { @builtin(position) pos: vec4f, @location(0) world: vec2f }

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  var corners = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
                                vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
  let world = corners[vi] * vec2f(f32(C.w), f32(C.h));
  var o: VOut;
  o.pos = toClip(world, C);
  o.world = world;
  return o;
}

const LIGHT = vec3f(-0.42, -0.56, 0.71);   // sun from the top left of the map
const BEAT = 12.986;                         // 124 bpm in radians per second

fn solidT(t: u32) -> bool { return t == 1u || t == 3u || t == 4u || t == 5u; }

fn typeAt(x: i32, y: i32) -> u32 {
  if (x < 0 || y < 0 || x >= i32(C.w) || y >= i32(C.h)) { return 1u; }
  return grid[u32(y) * C.w + u32(x)] & 255u;
}

fn sdfCell(x: i32, y: i32) -> vec2f {
  if (x < 0 || y < 0 || x >= i32(C.w) || y >= i32(C.h)) { return vec2f(0.5, 0.0); }
  return sdf[u32(y) * C.w + u32(x)];
}

// Bilinear sample of the distance field (the zero line is the smooth outline of every block) and of the shadow.
fn sdfShade(p: vec2f) -> vec2f {
  let q = p - vec2f(0.5);
  let f0 = floor(q);
  let t = q - f0;
  let x = i32(f0.x); let y = i32(f0.y);
  return mix(mix(sdfCell(x, y), sdfCell(x + 1, y), t.x), mix(sdfCell(x, y + 1), sdfCell(x + 1, y + 1), t.x), t.y);
}
fn sdfAt(p: vec2f) -> f32 { return sdfShade(p).x; }
// The same sample plus the slope of the distance (d/dx, d/dy) from those four cells: no extra reads.
fn sdfGrad(p: vec2f) -> vec4f {
  let q = p - vec2f(0.5);
  let f0 = floor(q);
  let t = q - f0;
  let x = i32(f0.x); let y = i32(f0.y);
  let a = sdfCell(x, y); let b = sdfCell(x + 1, y); let c = sdfCell(x, y + 1); let d = sdfCell(x + 1, y + 1);
  let v = mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
  return vec4f(v, mix(b.x - a.x, d.x - c.x, t.y), mix(c.x - a.x, d.x - b.x, t.x));
}

fn heat(d: f32) -> vec3f {
  let s0 = vec3f(0.102, 0.102, 0.098);
  var c = mix(s0, vec3f(0.051, 0.212, 0.420), clamp(d, 0.0, 1.0));
  c = mix(c, vec3f(0.094, 0.310, 0.584), clamp(d - 1.0, 0.0, 1.0));
  c = mix(c, vec3f(0.145, 0.416, 0.749), clamp((d - 2.0) * 0.5, 0.0, 1.0));
  c = mix(c, WARN * C.heatGain, smoothstep(3.6, 4.2, d));
  c = mix(c, CRIT * C.heatGain, smoothstep(4.7, 5.2, d));
  return c;
}

// Toilet cabins are 1.2 m squares; e is the distance to the nearest cabin wall.
fn cabinEdge(p: vec2f) -> f32 {
  let l = fract(p / 1.2) * 1.2;
  return min(min(l.x, 1.2 - l.x), min(l.y, 1.2 - l.y));
}

// Height of the roof at p (metres), used only for shading: s is the distance inside the block.
fn roofHeight(t: u32, s: f32, p: vec2f) -> f32 {
  if (t == 1u) { return 0.4 * smoothstep(0.0, 0.3, s) + 0.8 * smoothstep(0.6, 1.2, s); }   // fence panels; buildings rise higher
  if (t == 3u) { return 1.4 * smoothstep(0.0, 1.1, s); }                  // stage roof: bevelled edge, flat top
  if (t == 4u) { return 0.8 * min(s, 3.5); }                              // bar tent: pitched up to the ridge
  return 0.7 * smoothstep(0.03, 0.16, cabinEdge(p)) * smoothstep(0.0, 0.12, s);   // toilet cabins
}

// What each kind of block looks like from above. g is the direction up the roof.
fn surface(t: u32, p: vec2f, s: f32, g: vec2f) -> vec3f {
  if (t == 1u) {
    // galvanised crowd barrier: steel frame and a diamond mesh
    let m = min(abs(fract((p.x + p.y) * 2.5) - 0.5), abs(fract((p.x - p.y) * 2.5) - 0.5));
    let mesh = 1.0 - smoothstep(0.04, 0.1, m);
    let fence = mix(vec3f(0.62, 0.61, 0.58), vec3f(0.42, 0.42, 0.41), 0.55 * mesh);
    // anything thicker than a fence is a building: a flat grey roof in 3 m panels
    let pn = abs(p - round(p / 3.0) * 3.0);
    let roof = vec3f(0.50, 0.50, 0.49) * (0.94 + 0.06 * smoothstep(0.03, 0.08, min(pn.x, pn.y)));
    return mix(fence, roof, smoothstep(0.7, 1.0, s));
  }
  if (t == 3u) {
    // stage roof: black membrane over a truss grid, with an LED rim that pulses on the beat
    var c = vec3f(0.19, 0.17, 0.28);
    let g2 = abs(p - round(p * 0.5) * 2.0);
    let g8 = abs(p - round(p * 0.125) * 8.0);
    let truss = max(0.55 * (1.0 - smoothstep(0.03, 0.07, min(g2.x, g2.y))), 1.0 - smoothstep(0.07, 0.13, min(g8.x, g8.y)));
    return mix(c, vec3f(0.42, 0.40, 0.55), truss);
  }
  if (t == 4u) {
    // bar: a striped awning over a wooden counter that runs round the edge; the stripes run down
    // the slope of each side of the roof
    let along = select(p.x, p.y, abs(g.x) > abs(g.y));
    let across = select(p.y, p.x, abs(g.x) > abs(g.y));
    let stripe = smoothstep(0.22, 0.28, abs(fract(along * 0.5) - 0.5));
    let awning = mix(vec3f(0.84, 0.32, 0.51), vec3f(0.96, 0.82, 0.88), stripe);
    let grain = 0.9 + 0.1 * sin(along * 23.0 + sin(across * 7.0) * 1.5);
    let wood = vec3f(0.52, 0.35, 0.21) * grain;
    return mix(wood, awning, smoothstep(0.32, 0.4, s));
  }
  // toilets: pale roofs with a vent, green walls, dark gaps between cabins
  let e = cabinEdge(p);
  var c = mix(vec3f(0.10, 0.62, 0.44), vec3f(0.80, 0.85, 0.83), smoothstep(0.12, 0.2, e));
  let vent = length(fract(p / 1.2) * 1.2 - vec2f(0.6));
  c = mix(vec3f(0.36, 0.42, 0.40), c, smoothstep(0.09, 0.12, vent));
  return mix(vec3f(0.04, 0.05, 0.05), c, smoothstep(0.015, 0.04, e));
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let p = in.world;
  let px = 1.0 / C.scale;
  let W = i32(C.w); let H = i32(C.h);
  let x = clamp(i32(floor(p.x)), 0, W - 1);
  let y = clamp(i32(floor(p.y)), 0, H - 1);
  let tc = typeAt(x, y);

  if (tc == 2u) {
    // exit: chevrons pointing out of the venue, streaming outwards during the evacuation
    var n = vec2f(0.0, 1.0);
    if (x == 0) { n = vec2f(-1.0, 0.0); } else if (x == W - 1) { n = vec2f(1.0, 0.0); }
    else if (y == 0) { n = vec2f(0.0, -1.0); }
    let u = dot(p, n); let v = dot(p, vec2f(-n.y, n.x));
    let run = select(0.0, 1.6, C.mode == 1u);
    let chev = fract(u * 1.4 - abs(fract(v * 0.7) - 0.5) * 1.4 - C.clock * run);
    let mark = (smoothstep(0.42, 0.5, chev) - smoothstep(0.72, 0.8, chev)) * smoothstep(7.0, 14.0, C.scale);
    var g = vec3f(0.047, 0.639, 0.047);
    if (C.mode == 1u) { g = mix(g, vec3f(0.30, 0.85, 0.30), 0.5 + 0.5 * sin(C.clock * 6.0)); }
    return vec4f(mix(g, vec3f(0.82, 1.0, 0.82), 0.7 * mark), 1.0);
  }

  let sg = sdfGrad(p);
  let ss = sg.xy;
  let s = ss.x;
  var col = vec3f(0.0);
  if (s < px) {
    // open ground: crowd density
    let q = p - vec2f(0.5);
    let f0 = floor(q);
    let tt = q - f0;
    var acc = 0.0; var ws = 0.0;
    for (var j = 0; j < 2; j++) {
      for (var i = 0; i < 2; i++) {
        let sx = i32(f0.x) + i; let sy = i32(f0.y) + j;
        if (sx < 0 || sy < 0 || sx >= W || sy >= H) { continue; }
        let c = u32(sy) * C.w + u32(sx);
        if (solidT(grid[c] & 255u)) { continue; }
        let w = select(1.0 - tt.x, tt.x, i == 1) * select(1.0 - tt.y, tt.y, j == 1) + 1e-4;
        let dv = dens[c];
        acc += select(dv.x, dv.y, C.layer == 1u) * w; ws += w;
      }
    }
    var d = 0.0;
    if (ws > 0.0) { d = acc / ws; }
    // close up the figures carry the colour, so the ground under them steps back
    col = heat(d) * (1.0 - 0.5 * C.detail) + vec3f(0.03 * C.detail);
    // faint ground grid: every 10 m always, every metre once people are drawn as figures
    let g1 = abs(p - round(p));
    let l1 = 1.0 - smoothstep(0.0, px, min(g1.x, g1.y));
    let g10 = abs(p * 0.1 - round(p * 0.1)) * 10.0;
    let l10 = 1.0 - smoothstep(0.0, 1.2 * px, min(g10.x, g10.y));
    col += vec3f(0.035 * l1 * C.detail + 0.028 * l10);
    // contact shadow at the foot of every block; the cast shadows were worked out per cell on the CPU
    col *= 1.0 - max(0.3 * smoothstep(-0.9, 0.0, s), ss.y);
  }
  if (s > -px) {
    // fences and buildings; just outside the outline, take the block next door
    var t = tc;
    if (!solidT(t)) {
      if (solidT(typeAt(x - 1, y)) && fract(p.x) < 0.5) { t = typeAt(x - 1, y); }
      else if (solidT(typeAt(x + 1, y)) && fract(p.x) >= 0.5) { t = typeAt(x + 1, y); }
      else if (solidT(typeAt(x, y - 1)) && fract(p.y) < 0.5) { t = typeAt(x, y - 1); }
      else if (solidT(typeAt(x, y + 1))) { t = typeAt(x, y + 1); }
    }
    if (solidT(t)) {
      // light the roof from its slope, found by finite differences of the height
      let si = max(s, 0.0);
      let e = 0.04;
      let h = roofHeight(t, si, p);
      // slope = how the height changes with depth into the block, times the slope of that depth,
      // plus the part that depends on position alone (the toilet cabins)
      let dhds = (roofHeight(t, si + e, p) - h) / e;
      let slope = dhds * sg.zw + vec2f(roofHeight(t, si, p + vec2f(e, 0.0)) - h, roofHeight(t, si, p + vec2f(0.0, e)) - h) / e;
      let nrm = normalize(vec3f(-slope, 1.0));
      let lit = 0.45 + 0.75 * max(dot(nrm, LIGHT), 0.0);
      var up = vec2f(1.0, 0.0);
      if (dot(slope, slope) > 1e-6) { up = normalize(slope); }
      // far away the patterns would only shimmer: fade them into the legend colour of the block
      let fine = smoothstep(5.0, 14.0, C.scale);
      var legend = vec3f(0.60, 0.59, 0.56);
      if (t == 3u) { legend = vec3f(0.565, 0.522, 0.914); }
      else if (t == 4u) { legend = vec3f(0.835, 0.318, 0.506); }
      else if (t == 5u) { legend = vec3f(0.098, 0.620, 0.439); }
      var oc = mix(legend, surface(t, p, si, up) * lit, fine);
      if (t == 3u) {
        // the stage roof is ringed by LED strip that pulses on the beat during the concert
        var led = vec3f(0.62, 0.57, 1.0);
        if (C.mode == 0u) { led *= 0.7 + 0.55 * pow(0.5 + 0.5 * cos(C.clock * BEAT), 6.0); }
        oc = mix(oc, led, (1.0 - smoothstep(0.1, 0.1 + max(0.25, 2.0 * px), si)) * fine);
      }
      col = mix(col, oc, clamp(s / px + 0.5, 0.0, 1.0));
    }
  }
  return vec4f(col, 1.0);
}
`;

const AGENT_WGSL = RENDER_COMMON + /* wgsl */`
struct Agent {
  pos: vec2f, vel: vec2f,
  v0: f32, radius: f32, pref: f32, timer: f32,
  goal: u32, seed: u32, dens: f32, aux: f32,
}
@group(0) @binding(0) var<uniform> C: Cam;
@group(0) @binding(1) var<storage, read> A: array<Agent>;     // this step
@group(0) @binding(2) var<storage, read> Ap: array<Agent>;    // the step before; drawing in between keeps motion smooth
@group(0) @binding(3) var<storage, read> fields: array<vec4f>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) off: vec2f,                         // metres from the person's centre, map axes
  @location(1) @interpolate(flat) shirt: vec3f,
  @location(2) @interpolate(flat) dir: vec2f,      // which way the person faces
  @location(3) @interpolate(flat) shape: vec4f,    // body radius, gait swing (-1..1), dot radius, unused
  @location(4) @interpolate(flat) hair: vec3f,
  @location(5) @interpolate(flat) skin: vec3f,
  @location(6) @interpolate(flat) pose: vec4f,     // arms up, jump (0..1), followed, sideways sway
  @location(7) @interpolate(flat) ext: vec2f,      // half size of the quad along (facing, side)
}

fn hash32(x0: u32) -> u32 {
  var x = x0;
  x ^= x >> 16u; x *= 0x7feb352du;
  x ^= x >> 15u; x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}
fn rnd(seed: u32, salt: u32) -> f32 {
  return f32(hash32(seed ^ (salt * 0x9e3779b9u)) >> 8u) / 16777216.0;
}

// black through brown to blond, and a few redheads
fn hairColor(u: f32) -> vec3f {
  if (u > 0.92) { return vec3f(0.48, 0.22, 0.12); }
  let t = u / 0.92;
  let dark = mix(vec3f(0.08, 0.07, 0.06), vec3f(0.34, 0.23, 0.14), smoothstep(0.0, 0.6, t));
  return mix(dark, vec3f(0.78, 0.65, 0.42), smoothstep(0.62, 1.0, t));
}

// Bilinear sample of a flow field: xy points toward the goal, z is the distance to it.
fn fieldAt(layer: u32, p: vec2f) -> vec3f {
  let q = p - vec2f(0.5);
  let f0 = floor(q);
  let t = q - f0;
  let base = layer * C.w * C.h;
  var acc = vec3f(0.0); var ws = 0.0;
  for (var j = 0; j < 2; j++) {
    for (var i = 0; i < 2; i++) {
      let x = i32(f0.x) + i; let y = i32(f0.y) + j;
      if (x < 0 || y < 0 || x >= i32(C.w) || y >= i32(C.h)) { continue; }
      let v = fields[base + u32(y) * C.w + u32(x)];
      if (v.z > 1e8) { continue; }
      let w = select(1.0 - t.x, t.x, i == 1) * select(1.0 - t.y, t.y, j == 1) + 1e-4;
      acc += v.xyz * w; ws += w;
    }
  }
  if (ws <= 0.0) { return vec3f(0.0, 0.0, 1e9); }
  return vec3f(acc.xy, acc.z / ws);
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
                                vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  var o: VOut;
  let a = A[ii];
  if (a.goal == 9u) { o.pos = vec4f(2.0, 2.0, 2.0, 1.0); return o; }

  // Draw each person between the last two steps, so they glide instead of hopping 20 times a second.
  let b = Ap[ii];
  var p = a.pos; var v = a.vel; var ph = a.aux;
  if (b.goal != 9u && distance(a.pos, b.pos) < 0.5) {
    p = mix(b.pos, a.pos, C.interp);
    v = mix(b.vel, a.vel, C.interp);
    let dp = a.aux - b.aux;
    ph = b.aux + (dp - round(dp)) * C.interp;
  }
  let mpp = 1.0 / C.scale;
  // off screen: skip everything below (when zoomed in, that is nearly everyone)
  let halfView = C.viewport * (0.5 * mpp) + vec2f(1.5);
  if (any(abs(p - C.center) > halfView) && C.follow != ii + 1u) { o.pos = vec4f(2.0, 2.0, 2.0, 1.0); return o; }
  let speed = length(v);
  let dotR = max(a.radius, C.minPx * mpp);

  var col = NORMAL;
  if (C.colorMode == 0u) {
    col = mix(NORMAL, WARN, smoothstep(3.6, 4.2, a.dens));
    col = mix(col, CRIT, smoothstep(4.7, 5.2, a.dens));
  } else if (C.colorMode == 1u) {
    col = mix(vec3f(0.537, 0.529, 0.506), vec3f(0.804, 0.886, 0.984), clamp(speed / 1.2, 0.0, 1.0));
  } else {
    col = vec3f(0.565, 0.522, 0.914);
    if (a.goal == 1u) { col = vec3f(0.835, 0.318, 0.506); }
    else if (a.goal == 2u) { col = vec3f(0.098, 0.620, 0.439); }
    else if (a.goal == 3u || a.goal == 4u) { col = vec3f(0.047, 0.639, 0.047); }
    else if (a.goal == 5u || a.goal == 6u) { col = vec3f(0.941, 0.937, 0.925); }
  }

  var dir = vec2f(0.0, -1.0);
  var r = a.radius; var swing = 0.0; var jump = 0.0; var armsUp = 0.0; var sway = 0.0;
  var ext = vec2f(dotR);           // half size of the quad, along (facing, side)
  if (C.detail > 0.0) {
    // Facing: the way they walk; standing still, whatever they are waiting for (stage, bar, toilet, exit).
    var layer = a.goal;
    if (layer == 5u) { layer = 1u; } else if (layer == 6u) { layer = 2u; }
    var goalDist = 1e9;
    if (layer <= 4u) {
      let fs = fieldAt(layer, p);
      if (dot(fs.xy, fs.xy) > 1e-4) { dir = normalize(fs.xy); }
      goalDist = fs.z;
    }
    let moving = smoothstep(0.08, 0.4, speed);
    if (speed > 1e-3) {
      let m = mix(dir, v / speed, moving);
      if (dot(m, m) > 1e-4) { dir = normalize(m); }
    }
    // Gait: feet and arms swing with the distance walked, the body rocks from foot to foot.
    let gaitAmp = clamp(speed / 1.1, 0.0, 1.0);
    let g = sin((ph + rnd(a.seed, 40u)) * 6.2831853);
    swing = g * gaitAmp;
    sway = g * 0.06 * gaitAmp;
    // Concert: people standing near the stage jump to the beat (124 bpm), some with their hands up.
    if (C.mode == 0u && a.goal == 0u) {
      let idle = 1.0 - moving;
      let near = 1.0 - smoothstep(6.0, 50.0, goalDist);
      let dancer = step(rnd(a.seed, 22u), 0.3 + 0.6 * near);
      let beat = fract(C.clock * 2.0667 + rnd(a.seed, 21u) * 0.22);
      jump = idle * dancer * sin(beat * 3.14159265) * mix(0.3, 1.0, near);
      armsUp = idle * dancer * step(rnd(a.seed, 23u), 0.12 + 0.5 * near);
    }
    r = a.radius * (1.0 + 0.14 * jump);
    // the figure reaches 0.85 r forward (a stepping foot) and 0.95 r sideways (the arms), plus its shadow
    let room = 0.06 + 0.12 * jump + 1.5 * mpp;
    ext = max(vec2f(dotR), vec2f(0.88 * r, 0.98 * r) + vec2f(room));
  }
  let followed = select(0.0, 1.0, C.follow == ii + 1u);
  if (followed > 0.0) { ext = max(ext, vec2f(max(r * 2.1, 9.0 * mpp) + 2.0 * mpp)); }

  let q = corners[vi] * ext;
  let off = dir * q.x + vec2f(-dir.y, dir.x) * q.y;
  o.pos = toClip(p + off, C);
  o.off = off;
  o.ext = ext * 1.0607;   // the ellipse through the quad's edge midpoints scaled to just contain the figure
  o.dir = dir;
  o.shape = vec4f(r, swing, dotR, 0.0);
  o.hair = hairColor(rnd(a.seed, 32u));
  o.skin = mix(vec3f(0.96, 0.80, 0.69), vec3f(0.40, 0.27, 0.18), pow(rnd(a.seed, 33u), 1.6));
  o.shirt = col * mix(1.0, 0.84 + 0.3 * rnd(a.seed, 31u), C.detail);   // close up, shirts vary a little in shade
  o.pose = vec4f(armsUp, jump, followed, sway);
  return o;
}

fn sdEllipse(p: vec2f, ab: vec2f) -> f32 {
  let k0 = length(p / ab);
  let k1 = length(p / (ab * ab));
  if (k1 < 1e-6) { return -min(ab.x, ab.y); }
  return k0 * (k0 - 1.0) / k1;
}
fn cover(d: f32, px: f32) -> f32 { return clamp(0.5 - d / px, 0.0, 1.0); }
// paints colour c with coverage a over a premultiplied colour
fn over(acc: vec4f, c: vec3f, a: f32) -> vec4f { return vec4f(c * a + acc.rgb * (1.0 - a), a + acc.a * (1.0 - a)); }

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let px = 1.0 / C.scale;
  // the corners of the quad never hold anything: drop them before any shading
  let lq = vec2f(dot(in.off, in.dir), dot(in.off, vec2f(-in.dir.y, in.dir.x))) / in.ext;
  if (dot(lq, lq) > 1.0 && in.pose.z == 0.0) { discard; }

  // far away: one soft dot per person
  let dotR = in.shape.z;
  let r2 = dot(in.off, in.off) / (dotR * dotR);
  let dotA = select(0.0, 1.0 - smoothstep(0.6, 1.0, r2), r2 <= 1.0);
  var res = vec4f(in.shirt * dotA, dotA);

  // close up: a person seen from above
  if (C.detail > 0.0) {
    var acc = vec4f(0.0);
    let f = in.dir;
    let rg = vec2f(-f.y, f.x);
    let r = in.shape.x; let swing = in.shape.y;
    let armsUp = in.pose.x; let jump = in.pose.y; let sway = in.pose.w;
    let L = vec2f(dot(in.off, f), dot(in.off, rg));          // x forward, y to the side
    let hc = vec2f(0.06 * r, sway * r * 0.5);

    // shadow on the ground, further off and softer mid-jump
    let so = in.off - (vec2f(0.035, 0.05) + jump * vec2f(0.07, 0.09));
    let S = vec2f(dot(so, f), dot(so, rg));
    let ds = min(sdEllipse(S, vec2f(0.5 * r, 0.92 * r)), length(S - hc) - 0.38 * r);
    acc = over(acc, vec3f(0.0), 0.42 * (1.0 - 0.45 * jump) * (1.0 - smoothstep(-0.03, 0.05 + 0.06 * jump, ds)));

    // feet, stepping in turn (standing still they hide under the body)
    if (abs(swing) > 0.08) {
      let fL = sdEllipse(L - vec2f(swing * 0.55 * r, -0.36 * r), vec2f(0.3 * r, 0.15 * r));
      let fR = sdEllipse(L - vec2f(-swing * 0.55 * r, 0.36 * r), vec2f(0.3 * r, 0.15 * r));
      acc = over(acc, vec3f(0.13, 0.13, 0.14), cover(min(fL, fR), px));
    }

    // arms swing against the legs; dancers hold them up instead
    let T = L - vec2f(0.0, sway * r);
    // arms hang and swing, or (dancers) rise from the shoulders to hands just in front of the face
    let up = 0.24 * r + 0.06 * r * jump;
    var arms: f32;
    if (armsUp > 0.5) {
      arms = min(sdEllipse(T - vec2f(0.5 * up, -0.66 * r), vec2f(0.24 * r, 0.12 * r)),
                 sdEllipse(T - vec2f(0.5 * up, 0.66 * r), vec2f(0.24 * r, 0.12 * r)));
    } else {
      arms = min(sdEllipse(T - vec2f(-swing * 0.42 * r, -0.8 * r), vec2f(0.27 * r, 0.14 * r)),
                 sdEllipse(T - vec2f(swing * 0.42 * r, 0.8 * r), vec2f(0.27 * r, 0.14 * r)));
    }
    let torso = sdEllipse(T, vec2f(0.5 * r, 0.88 * r));
    let head = length(L - hc) - 0.37 * r;
    let body = min(min(torso, head), arms);
    acc = over(acc, vec3f(0.04, 0.04, 0.045), 0.85 * cover(body - 1.3 * px, px));   // dark rim keeps neighbours apart
    if (armsUp < 0.5) { acc = over(acc, in.shirt * 0.72, cover(arms, px)); }
    let lit = 0.74 + 0.36 * sqrt(clamp(-torso / (0.45 * r), 0.0, 1.0));
    acc = over(acc, in.shirt * lit, cover(torso, px));
    if (armsUp > 0.5) {
      acc = over(acc, vec3f(0.04, 0.04, 0.045), 0.7 * cover(arms - px, px));
      acc = over(acc, in.shirt * 0.86, cover(arms, px));
    }
    // head: hair on top, the face shows at the front
    let hl = 0.8 + 0.35 * clamp(-head / (0.34 * r), 0.0, 1.0);
    acc = over(acc, in.hair * hl, cover(head, px));
    let face = max(head + 0.015 * r, 0.2 * r - (L.x - hc.x));
    acc = over(acc, in.skin, cover(face, px));
    // raised hands, above everything else
    if (armsUp > 0.5) {
      let hands = min(length(T - vec2f(up + 0.1 * r, -0.6 * r)), length(T - vec2f(up + 0.1 * r, 0.6 * r))) - 0.13 * r;
      acc = over(acc, vec3f(0.04, 0.04, 0.045), 0.8 * cover(hands - px, px));
      acc = over(acc, in.skin, cover(hands, px));
    }
    res = mix(res, acc, C.detail);
  }

  // the person the camera follows wears a pulsing ring
  if (in.pose.z > 0.0) {
    let R = max(in.shape.x * 2.1, 9.0 * px);
    let d = abs(length(in.off) - R) - px;
    res = over(res, vec3f(1.0), (0.75 + 0.25 * sin(C.clock * 5.0)) * cover(d, px));
  }
  if (res.a <= 0.002) { discard; }
  return vec4f(res.rgb / res.a, res.a * C.agentAlpha);
}
`;

async function compile(device, code, label) {
  const mod = device.createShaderModule({ code, label });
  const info = await mod.getCompilationInfo();
  for (const m of info.messages) {
    const text = `[${label}] ${m.type} ${m.lineNum}:${m.linePos} ${m.message}`;
    if (m.type === 'error') console.error(text); else console.warn(text);
  }
  if (info.messages.some((m) => m.type === 'error')) throw new Error('shader ' + label);
  return mod;
}

export class GpuSim {
  static async create(canvas, W, H, maxAgents) {
    if (!navigator.gpu) throw new Error('no-webgpu');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('no-adapter');
    if (adapter.limits.maxStorageBuffersPerShaderStage < 8) throw new Error('limits');
    const device = await adapter.requestDevice();
    const sim = new GpuSim();
    await sim.init(canvas, adapter, device, W, H, maxAgents);
    return sim;
  }

  async init(canvas, adapter, device, W, H, maxAgents) {
    this.backend = 'gpu';
    this.device = device; this.canvas = canvas;
    this.W = W; this.H = H; this.cells = W * H; this.max = maxAgents; this.n = 0;
    this.params = defaultParams();
    this.cur = 0;
    this.adapterName = (adapter.info && (adapter.info.description || adapter.info.device || adapter.info.vendor)) || '';
    this.lost = false;
    device.lost.then((i) => { this.lost = true; console.error('GPU device lost: ' + i.message); });
    device.addEventListener('uncapturederror', (e) => console.error('GPU error: ' + e.error.message));

    this.ctx = canvas.getContext('webgpu');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.ctx.configure({ device, format: this.format, alphaMode: 'opaque' });

    const U = GPUBufferUsage;
    const buf = (size, usage, label) => device.createBuffer({ size, usage, label });
    this.bAgents = [0, 1].map((i) => buf(maxAgents * STRIDE * 4, U.STORAGE | U.COPY_DST | U.COPY_SRC, 'agents' + i));
    this.bStats = buf(STATS_LEN * 4, U.STORAGE | U.COPY_DST | U.COPY_SRC, 'stats');
    this.bParams = buf(80, U.UNIFORM | U.COPY_DST, 'params');
    this.bCam = buf(80, U.UNIFORM | U.COPY_DST, 'cam');
    this.rStats = buf(STATS_LEN * 4, U.MAP_READ | U.COPY_DST, 'statsRead');
    this.rAgents = null;
    this.paramData = new ArrayBuffer(80);
    this.camData = new ArrayBuffer(80);

    const [mBin, mStep, mDens, mGrid, mAgent] = await Promise.all([
      compile(device, BIN_WGSL, 'bin'), compile(device, STEP_WGSL, 'step'), compile(device, DENS_WGSL, 'density'),
      compile(device, GRID_WGSL, 'grid'), compile(device, AGENT_WGSL, 'agents'),
    ]);

    const C = GPUShaderStage.COMPUTE, V = GPUShaderStage.VERTEX, F = GPUShaderStage.FRAGMENT;
    const layout = (vis, kinds) => device.createBindGroupLayout({
      entries: kinds.map((type, binding) => ({ binding, visibility: vis, buffer: { type } })),
    });
    const RO = 'read-only-storage', RW = 'storage', UN = 'uniform';
    const lBin = layout(C, [UN, RO, RW, RW]);
    const lStep = layout(C, [UN, RO, RW, RO, RO, RO, RO, RW, RO]);
    const lDens = layout(C, [UN, RO, RO, RW]);
    const lGrid = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: V | F, buffer: { type: UN } },
      { binding: 1, visibility: F, buffer: { type: RO } },
      { binding: 2, visibility: F, buffer: { type: RO } },
      { binding: 3, visibility: F, buffer: { type: RO } },     // distance to the edge of each block
    ] });
    const lAgent = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: V | F, buffer: { type: UN } },
      { binding: 1, visibility: V, buffer: { type: RO } },     // agents, this step
      { binding: 2, visibility: V, buffer: { type: RO } },     // agents, previous step
      { binding: 3, visibility: V, buffer: { type: RO } },     // flow fields, for which way people face
    ] });
    const pl = (l) => device.createPipelineLayout({ bindGroupLayouts: [l] });
    const compute = (l, module) => device.createComputePipelineAsync({ layout: pl(l), compute: { module, entryPoint: 'main' } });
    const blend = {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
    };
    [this.pBin, this.pStep, this.pDens, this.pGrid, this.pAgent] = await Promise.all([
      compute(lBin, mBin), compute(lStep, mStep), compute(lDens, mDens),
      device.createRenderPipelineAsync({
        layout: pl(lGrid), vertex: { module: mGrid, entryPoint: 'vs' },
        fragment: { module: mGrid, entryPoint: 'fs', targets: [{ format: this.format }] },
        primitive: { topology: 'triangle-list' },
      }),
      device.createRenderPipelineAsync({
        layout: pl(lAgent), vertex: { module: mAgent, entryPoint: 'vs' },
        fragment: { module: mAgent, entryPoint: 'fs', targets: [{ format: this.format, blend }] },
        primitive: { topology: 'triangle-list' },
      }),
    ]);

    this.layouts = { lBin, lStep, lDens, lGrid, lAgent };
    this.resizeMap(W, H);
  }

  // (Re)allocates everything sized by the map, so one simulator can switch between plans of any size.
  resizeMap(W, H) {
    const device = this.device, U = GPUBufferUsage, cells = W * H;
    for (const b of [this.bGrid, this.bSdf, this.bFields, this.bCount, this.bItems, this.bDens, this.rDens]) if (b) b.destroy();
    this.W = W; this.H = H; this.cells = cells; this.n = 0;
    const buf = (size, usage, label) => device.createBuffer({ size, usage, label });
    this.bGrid = buf(cells * 4, U.STORAGE | U.COPY_DST, 'grid');
    this.bSdf = buf(cells * 8, U.STORAGE | U.COPY_DST, 'blockDistance');
    this.bFields = buf(cells * 16 * LAYERS, U.STORAGE | U.COPY_DST, 'fields');
    this.bCount = buf(cells * 4, U.STORAGE | U.COPY_DST, 'cellCount');
    this.bItems = buf(cells * K * 4, U.STORAGE, 'cellItems');
    this.bDens = buf(cells * 16, U.STORAGE | U.COPY_DST | U.COPY_SRC, 'dens');
    this.rDens = buf(cells * 16, U.MAP_READ | U.COPY_DST, 'densRead');
    this.gridCpu = new Uint32Array(cells);
    this.sdfCpu = new Float32Array(cells * 2);
    this._dLast = null;

    const { lBin, lStep, lDens, lGrid, lAgent } = this.layouts;
    const bg = (l, buffers) => device.createBindGroup({
      layout: l, entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
    this.gBin = [0, 1].map((i) => bg(lBin, [this.bParams, this.bAgents[i], this.bCount, this.bItems]));
    this.gStep = [0, 1].map((i) => bg(lStep, [this.bParams, this.bAgents[i], this.bAgents[1 - i],
      this.bCount, this.bItems, this.bGrid, this.bFields, this.bStats, this.bDens]));
    this.gDens = bg(lDens, [this.bParams, this.bCount, this.bGrid, this.bDens]);
    this.gGrid = bg(lGrid, [this.bCam, this.bGrid, this.bDens, this.bSdf]);
    this.gAgent = [0, 1].map((i) => bg(lAgent, [this.bCam, this.bAgents[i], this.bAgents[1 - i], this.bFields]));

    // empty fields: every goal unreachable until the worker delivers real ones
    const empty = new Float32Array(cells * 4 * LAYERS);
    for (let i = 2; i < empty.length; i += 4) empty[i] = 1e9;
    device.queue.writeBuffer(this.bFields, 0, empty);
  }

  resize(w, h) {
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
  }

  setGrid(packed) {
    this.gridCpu.set(packed); this.device.queue.writeBuffer(this.bGrid, 0, packed);
    blockDistance(this.W, this.H, packed, this.sdfCpu);
    this.device.queue.writeBuffer(this.bSdf, 0, this.sdfCpu);
  }
  setField(layer, data) { this.device.queue.writeBuffer(this.bFields, layer * this.cells * 16, data); }

  setAgents(buffer, n) {
    const q = this.device.queue;
    this.n = n;
    if (n > 0) q.writeBuffer(this.bAgents[this.cur], 0, buffer, 0, n * STRIDE * 4);
    q.writeBuffer(this.bStats, 0, new Uint32Array(STATS_LEN));
    q.writeBuffer(this.bDens, 0, primeDensity(this.W, this.H, this.gridCpu, buffer, n));
  }

  resetRisk() { this._resetRisk = true; }

  step(count = 1) {
    if (this.lost || this.n === 0) return;
    const d = this.device, P = this.params;
    const u = new Uint32Array(this.paramData), f = new Float32Array(this.paramData);
    for (let s = 0; s < count; s++) {
      u[0] = this.W; u[1] = this.H; u[2] = this.n; u[3] = K;
      f[4] = DT; f[5] = P.time; f[6] = P.evacTime; f[7] = P.guided;
      u[8] = P.mode; u[9] = P.step; u[10] = P.hasBar; u[11] = P.hasWc;
      f[12] = P.visitMean; f[13] = P.reactMax; f[14] = P.rhoJam; f[15] = 1 - Math.exp(-DT / 0.7);
      u[16] = this._resetRisk ? 1 : 0; this._resetRisk = false;
      d.queue.writeBuffer(this.bParams, 0, this.paramData);
      const enc = d.createCommandEncoder();
      enc.clearBuffer(this.bCount);
      const groups = Math.ceil(this.n / 64);
      let p = enc.beginComputePass();
      p.setPipeline(this.pBin); p.setBindGroup(0, this.gBin[this.cur]); p.dispatchWorkgroups(groups); p.end();
      p = enc.beginComputePass();
      p.setPipeline(this.pStep); p.setBindGroup(0, this.gStep[this.cur]); p.dispatchWorkgroups(groups); p.end();
      p = enc.beginComputePass();
      p.setPipeline(this.pDens); p.setBindGroup(0, this.gDens);
      p.dispatchWorkgroups(Math.ceil(this.W / 8), Math.ceil(this.H / 8)); p.end();
      d.queue.submit([enc.finish()]);
      this.cur = 1 - this.cur;
      P.time += DT; P.step++;
      if (P.mode === 1) P.evacTime += DT;
    }
  }

  // cam: { cx, cy, scale, layer, colorMode, minPx, agentAlpha, heatGain, interp, clock, detail, follow, mode }
  render(cam) {
    if (this.lost) return;
    const d = this.device;
    const f = new Float32Array(this.camData), u = new Uint32Array(this.camData);
    f[0] = cam.cx; f[1] = cam.cy; f[2] = this.canvas.width; f[3] = this.canvas.height;
    f[4] = cam.scale; f[5] = cam.minPx; u[6] = cam.layer; u[7] = cam.colorMode;
    u[8] = this.W; u[9] = this.H; f[10] = cam.agentAlpha; f[11] = cam.heatGain;
    f[12] = cam.interp ?? 1; f[13] = cam.clock ?? 0; f[14] = cam.detail ?? 0;
    u[15] = cam.follow ?? 0; u[16] = cam.mode ?? this.params.mode;
    d.queue.writeBuffer(this.bCam, 0, this.camData);
    const enc = d.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{
      view: this.ctx.getCurrentTexture().createView(),
      clearValue: { r: 0.051, g: 0.051, b: 0.051, a: 1 }, loadOp: 'clear', storeOp: 'store',
    }] });
    pass.setPipeline(this.pGrid); pass.setBindGroup(0, this.gGrid); pass.draw(6);
    if (this.n > 0 && cam.agentAlpha > 0) {
      pass.setPipeline(this.pAgent); pass.setBindGroup(0, this.gAgent[this.cur]); pass.draw(6, this.n);
    }
    pass.end();
    d.queue.submit([enc.finish()]);
  }

  async _read(src, dst, size, Type) {
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(src, 0, dst, 0, size);
    this.device.queue.submit([enc.finish()]);
    await dst.mapAsync(GPUMapMode.READ, 0, size);
    const out = new Type(dst.getMappedRange(0, size).slice(0));
    dst.unmap();
    return out;
  }
  async readStats() {
    if (this._sBusy) return this._sLast;
    this._sBusy = true;
    try { this._sLast = await this._read(this.bStats, this.rStats, STATS_LEN * 4, Uint32Array); }
    finally { this._sBusy = false; }
    return this._sLast;
  }
  async readDensity() {
    if (this._dBusy) return this._dLast;
    this._dBusy = true;
    try {
      this._dLast = await this._read(this.bDens, this.rDens, this.cells * 16, Float32Array);
    } finally { this._dBusy = false; }
    return this._dLast;
  }
  async readAgents() {
    const size = this.n * STRIDE * 4;
    if (!this.rAgents) this.rAgents = this.device.createBuffer({ size: this.max * STRIDE * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const out = await this._read(this.bAgents[this.cur], this.rAgents, size, Uint32Array);
    return out.buffer;
  }
  // One person's record from the current step (the camera uses it to follow someone).
  async readAgent(i) {
    if (this._oneBusy || i < 0 || i >= this.n) return null;
    this._oneBusy = true;
    try {
      if (!this.rOne) this.rOne = this.device.createBuffer({ size: STRIDE * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const enc = this.device.createCommandEncoder();
      enc.copyBufferToBuffer(this.bAgents[this.cur], i * STRIDE * 4, this.rOne, 0, STRIDE * 4);
      this.device.queue.submit([enc.finish()]);
      await this.rOne.mapAsync(GPUMapMode.READ);
      const out = this.rOne.getMappedRange().slice(0);
      this.rOne.unmap();
      return out;
    } finally { this._oneBusy = false; }
  }
  // Resolves when the GPU has finished everything submitted so far (used to time steps).
  flush() { return this.device.queue.onSubmittedWorkDone(); }
}

// For each cell, two numbers for the renderer (out[2c], out[2c+1]):
//  - the signed distance in metres from the cell centre to the edge of its own block: positive inside
//    fences, stages, bars and toilets, negative on open ground (exits count as ground). Sampled
//    bilinearly it gives smooth outlines and bevelled roofs. Two-pass chamfer transform.
//  - how much shadow the blocks cast on that ground cell, with the sun at the top left of the map.
export function blockDistance(W, H, packed, both) {
  const cells = W * H, cls = new Uint8Array(cells);
  const out = new Float32Array(cells);
  for (let c = 0; c < cells; c++) { const t = packed[c] & 255; cls[c] = t === 1 || t >= 3 ? t : 0; }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = y * W + x, k = cls[c];
    const edge = (x > 0 && cls[c - 1] !== k) || (x < W - 1 && cls[c + 1] !== k) ||
      (y > 0 && cls[c - W] !== k) || (y < H - 1 && cls[c + W] !== k);
    out[c] = edge ? 0.5 : 1e9;
  }
  const D = Math.SQRT2;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = y * W + x, k = cls[c];
    let d = out[c];
    if (x > 0 && cls[c - 1] === k && out[c - 1] + 1 < d) d = out[c - 1] + 1;
    if (y > 0) {
      if (cls[c - W] === k && out[c - W] + 1 < d) d = out[c - W] + 1;
      if (x > 0 && cls[c - W - 1] === k && out[c - W - 1] + D < d) d = out[c - W - 1] + D;
      if (x < W - 1 && cls[c - W + 1] === k && out[c - W + 1] + D < d) d = out[c - W + 1] + D;
    }
    out[c] = d;
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const c = y * W + x, k = cls[c];
    let d = out[c];
    if (x < W - 1 && cls[c + 1] === k && out[c + 1] + 1 < d) d = out[c + 1] + 1;
    if (y < H - 1) {
      if (cls[c + W] === k && out[c + W] + 1 < d) d = out[c + W] + 1;
      if (x < W - 1 && cls[c + W + 1] === k && out[c + W + 1] + D < d) d = out[c + W + 1] + D;
      if (x > 0 && cls[c + W - 1] === k && out[c + W - 1] + D < d) d = out[c + W - 1] + D;
    }
    out[c] = d;
  }
  for (let c = 0; c < cells; c++) { const d = Math.min(out[c], 60); out[c] = cls[c] ? d : -d; }

  const at = (px, py) => {                     // bilinear, like the shader
    const qx = px - 0.5, qy = py - 0.5, x = Math.floor(qx), y = Math.floor(qy), tx = qx - x, ty = qy - y;
    const v = (i, j) => (i < 0 || j < 0 || i >= W || j >= H ? 0.5 : out[j * W + i]);
    return (v(x, y) * (1 - tx) + v(x + 1, y) * tx) * (1 - ty) + (v(x, y + 1) * (1 - tx) + v(x + 1, y + 1) * tx) * ty;
  };
  const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = y * W + x;
    both[2 * c] = out[c];
    if (cls[c]) { both[2 * c + 1] = 0; continue; }
    const px = x + 0.5, py = y + 0.5;
    let sh = 0.4 * sm(-0.2, 0.3, at(px - 0.32, py - 0.42));            // every block, a short shadow
    const fx = Math.floor(px - 1.3), fy = Math.floor(py - 1.75);       // stage, bar and toilets are taller
    if (fx >= 0 && fy >= 0 && cls[fy * W + fx] >= 3) sh = Math.max(sh, 0.42 * sm(-0.3, 0.4, at(px - 1.3, py - 1.75)));
    both[2 * c + 1] = sh;
  }
  return both;
}

// People per m2 around each cell, computed once on the CPU when a crowd is placed.
export function primeDensity(W, H, grid, buffer, n) {
  const cells = W * H;
  const count = new Uint16Array(cells);
  const f = new Float32Array(buffer, 0, n * STRIDE), u = new Uint32Array(buffer, 0, n * STRIDE);
  for (let i = 0; i < n; i++) {
    if (u[i * STRIDE + 8] === 9) continue;
    const x = Math.min(W - 1, Math.max(0, Math.floor(f[i * STRIDE]))), y = Math.min(H - 1, Math.max(0, Math.floor(f[i * STRIDE + 1])));
    count[y * W + x]++;
  }
  const out = new Float32Array(cells * 4);
  const isSolid = (t) => t === 1 || t === 3 || t === 4 || t === 5;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = y * W + x;
    if ((grid[c] & 255) !== T_FREE && isSolid(grid[c] & 255)) continue;
    let sum = 0, area = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (isSolid(grid[ny * W + nx] & 255)) continue;
      sum += count[ny * W + nx]; area++;
    }
    out[c * 4] = sum / area; out[c * 4 + 1] = out[c * 4];
  }
  return out;
}
