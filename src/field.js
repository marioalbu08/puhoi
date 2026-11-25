// Flow fields: for every cell, the direction of the quickest way to a goal.
// Solved with the fast marching method (an Eikonal solver), so paths can run at any angle
// instead of only along the 8 grid directions.

import { INF, T_EXIT, T_STAGE, T_BAR, T_WC, isSolid, weidmann, RHO_JAM } from './model.js';

// Derives everything the simulation needs from the painted cell types.
export function analyzeGrid(W, H, types) {
  const cells = W * H;
  const solid = new Uint8Array(cells);
  let hasStage = 0, hasBar = 0, hasWc = 0;
  for (let c = 0; c < cells; c++) {
    const t = types[c];
    solid[c] = isSolid(t) ? 1 : 0;
    if (t === T_STAGE) hasStage = 1; else if (t === T_BAR) hasBar = 1; else if (t === T_WC) hasWc = 1;
  }
  // Share of walkable cells in the 3x3 block around each cell (0..255). Outside the map counts as wall.
  const open = new Uint8Array(cells);
  const nearWall = new Uint8Array(cells);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < W && ny < H && !solid[ny * W + nx]) n++;
    }
    open[y * W + x] = Math.round(n / 9 * 255);
    nearWall[y * W + x] = n < 9 ? 1 : 0;
  }
  // Label each connected group of exit cells as one exit.
  const exitId = new Uint8Array(cells);
  const exits = [];
  const stack = [];
  for (let s = 0; s < cells; s++) {
    if (types[s] !== T_EXIT || exitId[s]) continue;
    const id = Math.min(63, exits.length + 1);
    const e = { id, n: 0, x0: W, y0: H, x1: 0, y1: 0 };
    stack.push(s); exitId[s] = id;
    while (stack.length) {
      const c = stack.pop(), x = c % W, y = (c / W) | 0;
      e.n++;
      if (x < e.x0) e.x0 = x; if (x > e.x1) e.x1 = x;
      if (y < e.y0) e.y0 = y; if (y > e.y1) e.y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const nc = ny * W + nx;
        if (types[nc] === T_EXIT && !exitId[nc]) { exitId[nc] = id; stack.push(nc); }
      }
    }
    e.width = Math.max(e.x1 - e.x0 + 1, e.y1 - e.y0 + 1);
    e.cx = (e.x0 + e.x1 + 1) / 2; e.cy = (e.y0 + e.y1 + 1) / 2;
    if (exits.length < 63) exits.push(e);
    else { const last = exits[62]; last.n += e.n; last.width += e.width; }
  }
  const packed = new Uint32Array(cells);
  for (let c = 0; c < cells; c++) packed[c] = types[c] | (exitId[c] << 8) | (open[c] << 16);
  return { solid, open, nearWall, exitId, exits, packed, hasStage, hasBar, hasWc };
}

class Heap {
  constructor(cap) { this.k = new Float32Array(cap); this.v = new Int32Array(cap); this.n = 0; }
  push(key, val) {
    if (this.n === this.k.length) {
      const k = new Float32Array(this.n * 2); k.set(this.k); this.k = k;
      const v = new Int32Array(this.n * 2); v.set(this.v); this.v = v;
    }
    const K = this.k, V = this.v;
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] <= key) break;
      K[i] = K[p]; V[i] = V[p]; i = p;
    }
    K[i] = key; V[i] = val;
  }
  pop() {
    const K = this.k, V = this.v;
    const top = V[0];
    const n = --this.n;
    if (n > 0) {
      const key = K[n], val = V[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && K[c + 1] < K[c]) c++;
        if (K[c] >= key) break;
        K[i] = K[c]; V[i] = V[c]; i = c;
      }
      K[i] = key; V[i] = val;
    }
    return top;
  }
}

// Solves |grad T| = cost from the source cells and writes (dirX, dirY, T, 0) per cell into `out`.
// Options:
//   srcLabel, labelOut  each source carries a label (its exit number); labelOut receives, for every
//                       cell, the label of the source it is closest to
//   restrict            a label per cell; the solution only spreads between cells with the same
//                       label, so every cell keeps the source it was assigned
export function eikonal(W, H, solid, sources, t0, cost, out, offset = 0, opt = {}) {
  const cells = W * H;
  const { srcLabel, labelOut, restrict } = opt;
  const T = new Float32Array(cells).fill(INF);
  const done = new Uint8Array(cells);
  const heap = new Heap(cells);
  if (labelOut) labelOut.fill(0);
  for (const s of sources) {
    if (solid[s]) continue;
    T[s] = t0; heap.push(t0, s);
    if (labelOut) labelOut[s] = srcLabel ? srcLabel[s] : 1;
  }

  const relax = (n, x, y, lab) => {
    if (solid[n] || done[n]) return;
    if (restrict && restrict[n] !== lab) return;
    let a = INF, b = INF, ia = -1, ib = -1;
    if (x > 0 && done[n - 1] && (!restrict || restrict[n - 1] === lab)) { a = T[n - 1]; ia = n - 1; }
    if (x < W - 1 && done[n + 1] && T[n + 1] < a && (!restrict || restrict[n + 1] === lab)) { a = T[n + 1]; ia = n + 1; }
    if (y > 0 && done[n - W] && (!restrict || restrict[n - W] === lab)) { b = T[n - W]; ib = n - W; }
    if (y < H - 1 && done[n + W] && T[n + W] < b && (!restrict || restrict[n + W] === lab)) { b = T[n + W]; ib = n + W; }
    const f = cost[n];
    const lo = a < b ? a : b, hi = a < b ? b : a;
    let t;
    if (hi - lo >= f) t = lo + f;
    else t = 0.5 * (a + b + Math.sqrt(2 * f * f - (a - b) * (a - b)));
    if (t < T[n]) {
      T[n] = t; heap.push(t, n);
      if (labelOut) labelOut[n] = labelOut[a <= b ? ia : ib];
    }
  };

  while (heap.n) {
    const c = heap.pop();
    if (done[c]) continue;
    done[c] = 1;
    const x = c % W, y = (c / W) | 0, lab = restrict ? restrict[c] : 0;
    if (x > 0) relax(c - 1, x - 1, y, lab);
    if (x < W - 1) relax(c + 1, x + 1, y, lab);
    if (y > 0) relax(c - W, x, y - 1, lab);
    if (y < H - 1) relax(c + W, x, y + 1, lab);
  }

  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = y * W + x, o = offset + c * 4;
    const tc = T[c];
    if (solid[c] || tc >= INF) { out[o] = 0; out[o + 1] = 0; out[o + 2] = INF; out[o + 3] = 0; continue; }
    const lab = restrict ? restrict[c] : 0;
    const ok = (n) => !solid[n] && (!restrict || restrict[n] === lab);
    const l = x > 0 && ok(c - 1) ? T[c - 1] : INF;
    const r = x < W - 1 && ok(c + 1) ? T[c + 1] : INF;
    const u = y > 0 && ok(c - W) ? T[c - W] : INF;
    const d = y < H - 1 && ok(c + W) ? T[c + W] : INF;
    let gx = 0, gy = 0;
    const mx = l < r ? l : r, my = u < d ? u : d;
    if (mx < tc) gx = (l < r ? -1 : 1) * (tc - mx);
    if (my < tc) gy = (u < d ? -1 : 1) * (tc - my);
    const len = Math.hypot(gx, gy);
    if (len > 1e-6) { gx /= len; gy /= len; }
    out[o] = gx; out[o + 1] = gy; out[o + 2] = tc; out[o + 3] = 0;
  }
}

function sourcesNextTo(W, H, types, solid, type) {
  const src = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = y * W + x;
    if (solid[c]) continue;
    if ((x > 0 && types[c - 1] === type) || (x < W - 1 && types[c + 1] === type) ||
        (y > 0 && types[c - W] === type) || (y < H - 1 && types[c + W] === type)) src.push(c);
  }
  return src;
}

function baseCost(an, cells) {
  const cost = new Float32Array(cells);
  for (let c = 0; c < cells; c++) cost[c] = an.nearWall[c] ? 1.5 : 1.0;   // people keep off walls
  return cost;
}

// Layers 0..3: stage, bar, toilet, nearest exit. Returns one Float32Array with 4 layers.
// `labels`, when given, receives the catchment of every exit: for each cell, the number of its nearest exit.
export function computeStatic(W, H, types, an, labels) {
  const cells = W * H;
  const out = new Float32Array(cells * 4 * 4);
  const cost = baseCost(an, cells);
  eikonal(W, H, an.solid, sourcesNextTo(W, H, types, an.solid, T_STAGE), 0.5, cost, out, 0);
  eikonal(W, H, an.solid, sourcesNextTo(W, H, types, an.solid, T_BAR), 0.5, cost, out, cells * 4);
  eikonal(W, H, an.solid, sourcesNextTo(W, H, types, an.solid, T_WC), 0.5, cost, out, cells * 8);
  const ex = [];
  for (let c = 0; c < cells; c++) if (types[c] === T_EXIT) ex.push(c);
  eikonal(W, H, an.solid, ex, 0, cost, out, cells * 12, { srcLabel: an.exitId, labelOut: labels });
  return out;
}

// The two exit fields during an evacuation, given how crowded each cell is right now. Returns 2 layers:
//   layer 3  the way to the NEAREST exit that avoids the crowd on the way: people keep their exit,
//            but use its whole width and walk around a jam instead of all aiming at its nearest corner
//   layer 4  the way to the QUICKEST exit, which may be another one
// `dens` holds 4 floats per cell, the first one is people per m2. `labels` are the exit catchments
// from computeStatic; they are worked out here when missing.
export function computeDynamic(W, H, types, an, dens, rhoJam = RHO_JAM, labels) {
  const cells = W * H;
  const out = new Float32Array(cells * 8);
  const cost = baseCost(an, cells);
  if (dens) {
    for (let c = 0; c < cells; c++) {
      const v = weidmann(dens[c * 4], rhoJam);
      cost[c] *= v > 1 / 30 ? 1 / v : 30;          // time to cross the cell at the speed the crowd allows
    }
  }
  const ex = [];
  for (let c = 0; c < cells; c++) if (types[c] === T_EXIT) ex.push(c);
  if (!labels) {
    labels = new Uint8Array(cells);
    eikonal(W, H, an.solid, ex, 0, baseCost(an, cells), new Float32Array(cells * 4), 0, { srcLabel: an.exitId, labelOut: labels });
  }
  eikonal(W, H, an.solid, ex, 0, cost, out, 0, { restrict: labels });
  eikonal(W, H, an.solid, ex, 0, cost, out, cells * 4);
  return out;
}
