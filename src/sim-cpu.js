// Reference implementation of the crowd model, on the CPU.
// It is the fallback for browsers without WebGPU and the version the Node tests measure.
// sim-gpu.js runs the same three passes (bin, step, density) as compute shaders.

import {
  K, DT, STRIDE, STATS_LEN, GAMMA, RHO_JAM, LOOK, HEADWAY, HEAD_RANGE,
  A_X, A_Y, A_VX, A_VY, A_V0, A_R, A_PREF, A_TIMER, A_GOAL, A_SEED, A_DENS, A_AUX,
  G_STAGE, G_BAR, G_WC, G_EXIT, G_EXIT_DYN, G_SERVE_BAR, G_SERVE_WC, G_GONE,
  T_EXIT, isSolid, rnd,
} from './model.js';

const OX = [1, -1, 0, 0, 1, -1, 1, -1];
const OY = [0, 0, 1, -1, 1, 1, -1, -1];

export function defaultParams() {
  return {
    mode: 0,            // 0 concert, 1 evacuation
    evacTime: 0,        // seconds since the evacuation started
    guided: 0.5,        // share of people who know which exits are busy
    reactMax: 20,       // people start moving after a random delay up to this many seconds
    hasBar: 0, hasWc: 0,
    visitMean: 1200,    // mean seconds between trips to the bar or toilet
    rhoJam: RHO_JAM,
    time: 0, step: 0,
  };
}

export class CpuSim {
  constructor(W, H, maxAgents) {
    this.backend = 'cpu';
    this.W = W; this.H = H; this.cells = W * H; this.max = maxAgents;
    const a = new ArrayBuffer(maxAgents * STRIDE * 4), b = new ArrayBuffer(maxAgents * STRIDE * 4);
    this.fA = new Float32Array(a); this.uA = new Uint32Array(a);
    this.fB = new Float32Array(b); this.uB = new Uint32Array(b);
    this.grid = new Uint32Array(this.cells);
    this.fields = new Float32Array(this.cells * 4 * 5);
    for (let i = 2; i < this.fields.length; i += 4) this.fields[i] = 1e9;
    this.cellCount = new Uint32Array(this.cells);
    this.cellItems = new Uint32Array(this.cells * K);
    this.dens = new Float32Array(this.cells * 4);     // density, max density, seconds above 5, person-seconds above 5
    this.stats = new Uint32Array(STATS_LEN);
    this.n = 0;
    this.params = defaultParams();
    this.wrapX = false;                               // test only: the map wraps around horizontally
  }

  setGrid(packed) { this.grid.set(packed); }
  setField(layer, data) { this.fields.set(data, layer * this.cells * 4); }
  setAgents(buffer, n) {
    this.uA.set(new Uint32Array(buffer, 0, n * STRIDE));
    this.n = n;
    this.stats.fill(0);
    this.primeDensity();
  }
  resetRisk() { for (let c = 0; c < this.cells; c++) { this.dens[c * 4 + 1] = 0; this.dens[c * 4 + 2] = 0; this.dens[c * 4 + 3] = 0; } }
  async readStats() { return this.stats.slice(); }
  async readDensity() { return this.dens.slice(); }
  async readAgents() { return this.uA.buffer.slice(0, this.n * STRIDE * 4); }

  step(count = 1) {
    for (let s = 0; s < count; s++) {
      this.bin();
      for (let i = 0; i < this.n; i++) this.stepAgent(i);
      this.density();
      let t = this.fA; this.fA = this.fB; this.fB = t;
      t = this.uA; this.uA = this.uB; this.uB = t;
      const P = this.params;
      P.time += DT; P.step++;
      if (P.mode === 1) P.evacTime += DT;
    }
  }

  bin() {
    const { W, H, fA, uA, cellCount, cellItems } = this;
    cellCount.fill(0);
    for (let i = 0; i < this.n; i++) {
      const o = i * STRIDE;
      if (uA[o + A_GOAL] === G_GONE) continue;
      let cx = Math.floor(fA[o + A_X]), cy = Math.floor(fA[o + A_Y]);
      cx = cx < 0 ? 0 : cx >= W ? W - 1 : cx; cy = cy < 0 ? 0 : cy >= H ? H - 1 : cy;
      const c = cy * W + cx;
      const slot = cellCount[c]++;
      if (slot < K) cellItems[c * K + slot] = i;
    }
  }

  cellType(x, y) {
    if (this.wrapX) x = (x + this.W) % this.W;
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return 1;
    return this.grid[y * this.W + x] & 255;
  }

  // Bilinear sample of a flow field. Returns [dirX, dirY, dist] in this.fs.
  sampleField(layer, px, py) {
    const { W, H, fields } = this;
    const qx = px - 0.5, qy = py - 0.5;
    const fx0 = Math.floor(qx), fy0 = Math.floor(qy);
    const tx = qx - fx0, ty = qy - fy0;
    const base = layer * this.cells;
    let ax = 0, ay = 0, ad = 0, ws = 0;
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      let x = fx0 + i; const y = fy0 + j;
      if (this.wrapX) x = (x + W) % W;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const o = (base + y * W + x) * 4;
      const d = fields[o + 2];
      if (d > 1e8) continue;
      const w = (i ? tx : 1 - tx) * (j ? ty : 1 - ty) + 1e-4;
      ax += fields[o] * w; ay += fields[o + 1] * w; ad += d * w; ws += w;
    }
    const fs = this.fs || (this.fs = [0, 0, 0]);
    if (ws <= 0) { fs[0] = 0; fs[1] = 0; fs[2] = 1e9; return fs; }
    const l = Math.hypot(ax, ay);
    if (l > 1e-4) { fs[0] = ax / l; fs[1] = ay / l; } else { fs[0] = 0; fs[1] = 0; }
    fs[2] = ad / ws;
    return fs;
  }

  // Bilinear sample of the smoothed density field; -1 when the point is inside a wall or off the map.
  sampleDens(px, py) {
    const { W, H, dens, grid } = this;
    const qx = px - 0.5, qy = py - 0.5;
    const fx0 = Math.floor(qx), fy0 = Math.floor(qy);
    const tx = qx - fx0, ty = qy - fy0;
    let acc = 0, ws = 0;
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      let x = fx0 + i; const y = fy0 + j;
      if (this.wrapX) x = (x + W) % W;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const c = y * W + x;
      if (isSolid(grid[c] & 255)) continue;
      const w = (i ? tx : 1 - tx) * (j ? ty : 1 - ty) + 1e-4;
      acc += dens[c * 4] * w; ws += w;
    }
    return ws > 0 ? acc / ws : -1;
  }

  // Fills the density field from the current positions, so the first steps do not see an empty map.
  primeDensity() {
    this.bin();
    this.dens.fill(0);
    this.density(1);
  }

  stepAgent(i) {
    const { W, H, fA, uA, fB, uB, grid, cellCount, cellItems, stats } = this;
    const P = this.params;
    const o = i * STRIDE;
    for (let k = 0; k < STRIDE; k++) uB[o + k] = uA[o + k];
    let goal = uA[o + A_GOAL];
    if (goal === G_GONE) return;

    const px = fA[o + A_X], py = fA[o + A_Y];
    const v0 = fA[o + A_V0], rad = fA[o + A_R], pref = fA[o + A_PREF], seed = uA[o + A_SEED];
    let cx = Math.floor(px), cy = Math.floor(py);
    cx = cx < 0 ? 0 : cx >= W ? W - 1 : cx; cy = cy < 0 ? 0 : cy >= H ? H - 1 : cy;
    const c = cy * W + cx;
    const g = grid[c];

    // Standing inside something that was just built: step out, or be removed if boxed in.
    if (isSolid(g & 255)) {
      let found = false;
      for (let k = 0; k < 8 && !found; k++) {
        if (!isSolid(this.cellType(cx + OX[k], cy + OY[k]))) {
          const dx = cx + OX[k] + 0.5 - px, dy = cy + OY[k] + 0.5 - py;
          const d = Math.hypot(dx, dy), m = Math.min(d, 2.0 * DT) / (d || 1);
          fB[o + A_X] = px + dx * m; fB[o + A_Y] = py + dy * m;
          found = true;
        }
      }
      if (!found) { uB[o + A_GOAL] = G_GONE; fB[o + A_X] = -10; fB[o + A_Y] = -10; stats[64]++; }
      fB[o + A_VX] = 0; fB[o + A_VY] = 0;
      return;
    }

    // Evacuation: everyone heads for an exit after a personal reaction delay.
    if (P.mode === 1 && goal !== G_EXIT && goal !== G_EXIT_DYN) {
      if (P.evacTime >= rnd(seed, 77) * P.reactMax) {
        goal = rnd(seed, 78) < P.guided ? G_EXIT_DYN : G_EXIT;
      }
    }

    let timer = fA[o + A_TIMER];
    if (goal === G_STAGE) {
      timer -= DT;
      if (timer <= 0 && P.mode === 0) {
        const u = rnd(seed, P.step + 1000);
        if (P.hasBar === 1 && (P.hasWc === 0 || u < 0.55)) { goal = G_BAR; timer = 0; }
        else if (P.hasWc === 1) { goal = G_WC; timer = 0; }
        else timer = P.visitMean;
      }
    } else if (goal === G_BAR || goal === G_WC) {
      timer += DT;
      if (timer > 900) { goal = G_STAGE; timer = -Math.log(1 - rnd(seed, P.step + 2000)) * P.visitMean; }
    } else if (goal === G_SERVE_BAR || goal === G_SERVE_WC) {
      timer -= DT;
      if (timer <= 0) { goal = G_STAGE; timer = -Math.log(1 - rnd(seed, P.step + 2000)) * P.visitMean; }
    }

    let ex = 0, ey = 0, dist = 1e9;
    if (goal <= 4) { const fs = this.sampleField(goal, px, py); ex = fs[0]; ey = fs[1]; dist = fs[2]; }
    if (dist > 1e8 && (goal === G_BAR || goal === G_WC)) {
      goal = G_STAGE; timer = -Math.log(1 - rnd(seed, P.step + 2000)) * P.visitMean;
    }

    // Neighbours: comfort spacing, overlap correction, sidestepping, and the gap to whoever is ahead.
    let sx = 0, sy = 0, kx = 0, ky = 0, vlim = 1e9;
    const hasE = ex * ex + ey * ey > 0.5;
    const rx = -ey, ry = ex;                               // right-hand side of the walking direction
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      let nx = cx + dx; const ny = cy + dy;
      if (this.wrapX) nx = (nx + W) % W;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const cc = ny * W + nx;
      const cnt = cellCount[cc] < K ? cellCount[cc] : K;
      for (let s = 0; s < cnt; s++) {
        const j = cellItems[cc * K + s];
        if (j === i) continue;
        const q = j * STRIDE;
        let ox = px - fA[q + A_X]; const oy = py - fA[q + A_Y];
        if (this.wrapX) { if (ox > W / 2) ox -= W; else if (ox < -W / 2) ox += W; }
        const rs = rad + fA[q + A_R];
        const sr = rs + 0.08, far = rs + HEAD_RANGE;
        const d2 = ox * ox + oy * oy;
        if (d2 >= far * far) continue;
        const d = Math.sqrt(d2);
        let nxn, nyn;
        if (d > 1e-4) { nxn = ox / d; nyn = oy / d; }
        else { const ang = rnd((seed ^ j) >>> 0, 5) * 6.2831853; nxn = Math.cos(ang); nyn = Math.sin(ang); }
        if (hasE && nxn * ex + nyn * ey < -0.7) {
          // someone straight ahead: never walk faster than the gap closes in HEADWAY seconds
          const vj = fA[q + A_VX] * ex + fA[q + A_VY] * ey;
          const lim = (d > rs ? d - rs : 0) / HEADWAY + (vj > 0 ? vj : 0);
          if (lim < vlim) vlim = lim;
        }
        if (d >= sr) continue;
        const qq = 1 - d / sr;
        sx += nxn * qq; sy += nyn * qq;
        if (d < rs) { const ov = (rs - d) * 0.5; kx += nxn * ov; ky += nyn * ov; }
        if (hasE && nxn * ex + nyn * ey < -0.3 && fA[q + A_VX] * ex + fA[q + A_VY] * ey < -0.1) {
          sx += rx * qq * 0.8; sy += ry * qq * 0.8;        // sidestep to the right when someone comes head-on
        }
      }
    }
    // Walking speed follows the crowd density a little way ahead (people per m2 over about 9 m2).
    const here = this.sampleDens(px, py);
    let rho = hasE ? this.sampleDens(px + ex * LOOK, py + ey * LOOK) : here;
    if (rho < 0) rho = here < 0 ? 0 : here;

    const wd = rho < 0.05 ? 1 : rho >= P.rhoJam ? 0 : 1 - Math.exp(-GAMMA * (1 / rho - 1 / P.rhoJam));
    let vd = 0;
    if (goal === G_STAGE) {
      if (dist < 1e8 && dist > 1.2) {
        let f = (pref - rho) / 0.6; f = f < 0 ? 0 : f > 1 ? 1 : f;
        vd = v0 * wd * f;
      }
    } else if (goal === G_BAR || goal === G_WC) {
      if (dist < 1.6) {
        if (goal === G_BAR) { goal = G_SERVE_BAR; timer = 20 + 40 * rnd(seed, P.step + 3000); }
        else { goal = G_SERVE_WC; timer = 45 + 60 * rnd(seed, P.step + 3000); }
      } else if (dist < 1e8) vd = v0 * wd;
    } else if (goal === G_EXIT || goal === G_EXIT_DYN) {
      if (dist < 1e8) vd = v0 * wd;
    }

    if (vd > vlim) vd = vlim;

    let vx = fA[o + A_VX], vy = fA[o + A_VY];
    vx += ((ex * vd - vx) / 0.5 + sx * 1.2) * DT;
    vy += ((ey * vd - vy) / 0.5 + sy * 1.2) * DT;
    const sp = Math.hypot(vx, vy), vmax = v0 * 1.3;
    if (sp > vmax) { vx *= vmax / sp; vy *= vmax / sp; }
    kx *= 0.6; ky *= 0.6;
    const kl = Math.hypot(kx, ky);
    if (kl > 0.06) { kx *= 0.06 / kl; ky *= 0.06 / kl; }
    let npx = px + vx * DT + kx, npy = py + vy * DT + ky;

    // Walls: push the body out of any solid cell it touches.
    for (let it = 0; it < 2; it++) {
      const ncx = Math.floor(npx), ncy = Math.floor(npy);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = ncx + dx, y = ncy + dy;
        if (!isSolid(this.cellType(x, y))) continue;
        const qx = npx < x ? x : npx > x + 1 ? x + 1 : npx;
        const qy = npy < y ? y : npy > y + 1 ? y + 1 : npy;
        const ddx = npx - qx, ddy = npy - qy;
        const dl = Math.hypot(ddx, ddy);
        if (dl < rad) {
          if (dl > 1e-5) {
            const nnx = ddx / dl, nny = ddy / dl;
            npx += nnx * (rad - dl); npy += nny * (rad - dl);
            const vn = vx * nnx + vy * nny;
            if (vn < 0) { vx -= nnx * vn; vy -= nny * vn; }
          } else { npx = px; npy = py; vx = 0; vy = 0; }
        }
      }
    }
    if (this.wrapX) npx = (npx + W) % W;
    npx = npx < 0.01 ? 0.01 : npx > W - 0.01 ? W - 0.01 : npx;
    npy = npy < 0.01 ? 0.01 : npy > H - 0.01 ? H - 0.01 : npy;

    // Reaching an exit cell while leaving removes the person and counts them.
    const eg = grid[Math.floor(npy) * W + Math.floor(npx)];
    if ((eg & 255) === T_EXIT && (goal === G_EXIT || goal === G_EXIT_DYN)) {
      stats[0]++; stats[(eg >>> 8) & 63]++;
      uB[o + A_GOAL] = G_GONE; fB[o + A_X] = -10; fB[o + A_Y] = -10; fB[o + A_VX] = 0; fB[o + A_VY] = 0;
      return;
    }
    fB[o + A_X] = npx; fB[o + A_Y] = npy; fB[o + A_VX] = vx; fB[o + A_VY] = vy;
    fB[o + A_TIMER] = timer; uB[o + A_GOAL] = goal;
    let ph = fA[o + A_AUX] + Math.hypot(vx, vy) * DT / 1.4;   // walk phase, one gait cycle per 1.4 m
    ph -= Math.floor(ph);
    fB[o + A_DENS] = here < 0 ? 0 : here; fB[o + A_AUX] = ph;
  }

  // People per m2 averaged over the 3x3 block around each cell, smoothed in time.
  density(alphaOverride) {
    const { W, H, grid, cellCount, dens } = this;
    const alpha = alphaOverride || 1 - Math.exp(-DT / 0.7);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const c = y * W + x, o = c * 4;
      if (isSolid(grid[c] & 255)) { dens[o] = 0; continue; }
      let sum = 0, area = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        let nx = x + dx; const ny = y + dy;
        if (this.wrapX) nx = (nx + W) % W;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const cc = ny * W + nx;
        if (isSolid(grid[cc] & 255)) continue;
        sum += cellCount[cc]; area += 1;
      }
      const d = dens[o] + (sum / area - dens[o]) * alpha;
      dens[o] = d;
      if (d > dens[o + 1]) dens[o + 1] = d;
      if (d >= 5) { dens[o + 2] += DT; dens[o + 3] += DT * cellCount[c]; }
    }
  }
}
