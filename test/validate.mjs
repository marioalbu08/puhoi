// Measures the crowd model against published pedestrian data.
// Run with: node test/validate.mjs [fd|gate|evac|all] [people] [guided shares, e.g. 0,50,100]
//   fd    speed and flow at fixed densities in a corridor, against Weidmann's relation
//   gate  how many people per metre per second get through a gate of a given width
//   evac  full evacuation of the default festival layout

import {
  MAP_W, MAP_H, STRIDE, T_WALL, T_EXIT, G_EXIT, V_MEAN, V_SD, LAYOUTS, R_MIN, R_SPAN,
  A_X, A_Y, A_VX, A_V0, A_R, A_PREF, A_GOAL, A_SEED,
  weidmann, mulberry32, hash32, placeCrowd,
} from '../src/model.js';
import { analyzeGrid, computeStatic, computeDynamic } from '../src/field.js';
import { CpuSim } from '../src/sim-cpu.js';

const which = process.argv[2] || 'all';
const fmt = (x, d = 2) => x.toFixed(d);

function makeAgents(n, place, seed = 7) {
  const rand = mulberry32(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(6.2831853 * rand());
  const buf = new ArrayBuffer(n * STRIDE * 4);
  const f = new Float32Array(buf), u = new Uint32Array(buf);
  for (let i = 0; i < n; i++) {
    const o = i * STRIDE, [x, y] = place(rand);
    f[o + A_X] = x; f[o + A_Y] = y;
    f[o + A_V0] = Math.min(1.9, Math.max(0.85, V_MEAN + V_SD * gauss()));
    f[o + A_R] = R_MIN + R_SPAN * rand();
    f[o + A_PREF] = 3;
    u[o + A_GOAL] = G_EXIT;
    u[o + A_SEED] = hash32(i + 1);
  }
  return buf;
}

// ---- 1. speed at a fixed density: a 60 m corridor, 10 m wide, that wraps around
function fundamentalDiagram() {
  console.log('\n1. Viteză și debit la densitate fixă (coridor 60 x 10 m, în buclă)');
  console.log('   densitate | viteză simulată | Weidmann | debit simulat | debit Weidmann');
  const W = 60, H = 12;
  const rows = [];
  for (const rho of [0.5, 1, 1.5, 2, 2.5, 3, 4, 5]) {
    const sim = new CpuSim(W, H, 4000);
    sim.wrapX = true;
    const packed = new Uint32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const wall = y === 0 || y === H - 1;
      const open = wall ? 0 : (y === 1 || y === H - 2) ? 6 / 9 : 1;
      packed[y * W + x] = (wall ? T_WALL : 0) | (Math.round(open * 255) << 16);
    }
    sim.setGrid(packed);
    const field = new Float32Array(W * H * 4);
    for (let c = 0; c < W * H; c++) { field[c * 4] = 1; field[c * 4 + 2] = 100; }
    sim.setField(G_EXIT, field);
    const n = Math.round(rho * W * (H - 2));
    sim.setAgents(makeAgents(n, (r) => [r() * W, 1.3 + r() * (H - 2.6)]), n);
    sim.params.mode = 1; sim.params.reactMax = 0; sim.params.guided = 0;
    sim.step(60 / 0.05);
    let sum = 0, cnt = 0;
    for (let s = 0; s < 30 / 0.05; s += 10) {
      sim.step(10);
      for (let i = 0; i < n; i++) { sum += sim.fA[i * STRIDE + A_VX]; cnt++; }
    }
    const v = sum / cnt, vw = V_MEAN * weidmann(rho);
    rows.push({ rho, v, vw });
    console.log(`   ${fmt(rho, 1).padStart(6)} /m2 | ${fmt(v).padStart(10)} m/s | ${fmt(vw).padStart(4)} m/s | ${fmt(rho * v).padStart(8)} /m/s | ${fmt(rho * vw).padStart(9)} /m/s`);
  }
  const peak = rows.reduce((a, b) => (b.rho * b.v > a.rho * a.v ? b : a));
  console.log(`   Debit maxim simulat: ${fmt(peak.rho * peak.v)} pers./m/s la ${peak.rho} pers./m2 (Weidmann: 1,22 la 1,75)`);
  return rows;
}

// ---- 2. flow through a gate: a 40 x 30 m pen with one exit of a given width
function gateFlow() {
  console.log('\n2. Debit printr-o poartă (țarc 40 x 30 m, 2.800 de oameni)');
  console.log('   lățime | pers./s | pers./m/s | pers./min/m   (ghid Green Guide: 82 pers./min/m = 1,37 pers./m/s)');
  const W = 44, H = 32;
  const out = [];
  for (const w of [2, 4, 6, 8, 12]) {
    const types = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (x === 0 || y === 0 || x === W - 1 || y === H - 1) types[y * W + x] = T_WALL;
    const y0 = Math.floor(H / 2 - w / 2);
    for (let y = y0; y < y0 + w; y++) types[y * W + W - 1] = T_EXIT;
    const an = analyzeGrid(W, H, types);
    const st = computeStatic(W, H, types, an);
    const sim = new CpuSim(W, H, 3000);
    sim.setGrid(an.packed);
    const cells = W * H;
    sim.setField(G_EXIT, st.subarray(cells * 12, cells * 16));
    const n = 2800;
    sim.setAgents(makeAgents(n, (r) => [1.3 + r() * (W - 4.6), 1.3 + r() * (H - 2.6)]), n);
    sim.params.mode = 1; sim.params.reactMax = 0; sim.params.guided = 0;
    sim.step(20 / 0.05);
    const a = sim.stats[0];
    sim.step(40 / 0.05);
    const b = sim.stats[0];
    const flow = (b - a) / 40;
    let maxD = 0;
    for (let c = 0; c < cells; c++) if (sim.dens[c * 4] > maxD) maxD = sim.dens[c * 4];
    out.push({ w, flow, spec: flow / w, maxD });
    console.log(`   ${String(w).padStart(4)} m | ${fmt(flow, 1).padStart(7)} | ${fmt(flow / w).padStart(9)} | ${fmt(flow / w * 60, 0).padStart(8)}        (densitate maximă în coadă: ${fmt(maxD, 1)} pers./m2)`);
  }
  return out;
}

// ---- 3. full evacuation of a layout
function evacuation(N = 10000, guided = 0.5, layout = 'festival', quiet = false) {
  const W = MAP_W, H = MAP_H, cells = W * H;
  const types = LAYOUTS.find((l) => l.id === layout).build();
  const an = analyzeGrid(W, H, types);
  const labels = new Uint8Array(cells);
  const st = computeStatic(W, H, types, an, labels);
  const sim = new CpuSim(W, H, N);
  sim.setGrid(an.packed);
  for (let l = 0; l < 4; l++) sim.setField(l, st.subarray(cells * 4 * l, cells * 4 * (l + 1)));
  sim.setField(4, st.subarray(cells * 12, cells * 16));
  const crowd = placeCrowd(W, H, types, st.subarray(0, cells * 4), st.subarray(cells * 12, cells * 16), N, 1);
  sim.setAgents(crowd.buffer, crowd.n);
  Object.assign(sim.params, { hasBar: an.hasBar, hasWc: an.hasWc, guided });
  const t0 = performance.now();
  sim.step(30 / 0.05);                                   // let the crowd settle
  const settle = (performance.now() - t0) / 600;
  let front = 0, frontN = 0;
  for (let c = 0; c < cells; c++) { const y = (c / W) | 0, x = c % W; if (y >= 22 && y < 32 && x >= 130 && x < 190) { front += sim.dens[c * 4]; frontN++; } }
  sim.resetRisk();
  sim.params.mode = 1; sim.params.evacTime = 0;
  const width = an.exits.reduce((s, e) => s + e.width, 0);
  const marks = { 50: 0, 90: 0, 95: 0, 100: 0 };
  let t = 0;
  while (t < 3600) {
    sim.step(20); t += 1;
    if (t % 4 === 0) {
      const dyn = computeDynamic(W, H, types, an, sim.dens, undefined, labels);
      sim.setField(3, dyn.subarray(0, cells * 4)); sim.setField(4, dyn.subarray(cells * 4));
    }
    const outN = sim.stats[0];
    for (const p of [50, 90, 95, 100]) if (!marks[p] && outN >= crowd.n * p / 100) marks[p] = t;
    if (outN >= crowd.n) break;
  }
  let maxD = 0, expo = 0;
  for (let c = 0; c < cells; c++) { if (sim.dens[c * 4 + 1] > maxD) maxD = sim.dens[c * 4 + 1]; expo += sim.dens[c * 4 + 3]; }
  const guide = crowd.n / (width * 82 / 60);
  const res = { n: crowd.n, width, guide, marks, maxD, expo: expo / 60, msPerStep: settle, front: front / frontN, exits: an.exits.map((e) => ({ id: e.id, width: e.width, n: sim.stats[e.id] })) };
  if (!quiet) {
    const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
    console.log(`   ${crowd.n} oameni, ${width} m de ieșiri, ghidare ${Math.round(guided * 100)}%  (${fmt(settle, 1)} ms pe pas, pe procesor)`);
    console.log(`   densitate în fața scenei înainte de evacuare: ${fmt(res.front, 1)} pers./m2`);
    console.log(`   au ieșit 50% în ${mmss(marks[50])}, 90% în ${mmss(marks[90])}, 95% în ${mmss(marks[95])}, toți în ${mmss(marks[100])}`);
    console.log(`   calcul din ghid (82 pers./min/m): ${mmss(guide)}`);
    console.log(`   densitate maximă: ${fmt(maxD, 1)} pers./m2, expunere peste 5 pers./m2: ${fmt(res.expo, 0)} persoane-minut`);
    console.log('   pe ieșiri: ' + res.exits.map((e) => `#${e.id} (${e.width} m): ${e.n}`).join(', '));
  }
  return res;
}

if (which === 'fd' || which === 'all') fundamentalDiagram();
if (which === 'gate' || which === 'all') gateFlow();
if (which === 'evac' || which === 'all') {
  const n = Number(process.argv[3]) || 10000;
  console.log(`\n3. Evacuarea planului implicit`);
  const shares = (process.argv[4] || '0,50,100').split(',').map(Number);
  for (const g of shares) evacuation(n, g / 100);
}
