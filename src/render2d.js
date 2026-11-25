// Canvas 2D renderer, used only when the browser has no WebGPU. Same colours as the shaders and,
// close up, the same idea: people drawn between the last two steps as little figures seen from above.
// The plan (fences, stage, bars, toilets, exits) is painted once into an offscreen canvas and reused
// until the plan changes.

import {
  STRIDE, A_X, A_Y, A_VX, A_VY, A_R, A_GOAL, A_SEED, A_DENS, A_AUX, G_GONE,
  T_WALL, T_EXIT, T_STAGE, T_BAR, T_WC, rnd,
} from './model.js';

const OBJ = { [T_WALL]: [143, 140, 133], [T_EXIT]: [12, 163, 12], [T_STAGE]: [144, 133, 233], [T_BAR]: [213, 81, 129], [T_WC]: [25, 158, 112] };
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const LUT_N = 64 * 7;   // densities from 0 to 7 people per m2
const HAIR = ['#1a1412', '#38261a', '#5c3d26', '#9e7a4d', '#ccad73', '#7a381f'];
const shade = (c, k) => `rgb(${(c[0] * k) | 0},${(c[1] * k) | 0},${(c[2] * k) | 0})`;
const S0 = [26, 26, 25], B1 = [13, 54, 107], B2 = [24, 79, 149], B3 = [37, 106, 191], WARN = [250, 178, 25], CRIT = [208, 59, 59];

function heat(d, gain) {
  let c = mix(S0, B1, clamp01(d));
  c = mix(c, B2, clamp01(d - 1));
  c = mix(c, B3, clamp01((d - 2) * 0.5));
  c = mix(c, [WARN[0] * gain, WARN[1] * gain, WARN[2] * gain], smooth(3.6, 4.2, d));
  c = mix(c, [CRIT[0] * gain, CRIT[1] * gain, CRIT[2] * gain], smooth(4.7, 5.2, d));
  return c;
}

export class Render2D {
  constructor(canvas, sim) {
    this.canvas = canvas; this.sim = sim;
    this.ctx = canvas.getContext('2d');
    const mk = (k = 1) => { const c = document.createElement('canvas'); c.width = sim.W * k; c.height = sim.H * k; return c; };
    this.objScale = sim.W * sim.H <= 80000 ? 8 : 4;        // pixels per metre in the cached plan
    this.heatC = mk(); this.baseC = mk(); this.shadeC = mk(); this.objC = mk(this.objScale);
    this.heatImg = this.heatC.getContext('2d').createImageData(sim.W, sim.H);
    this.baseImg = this.baseC.getContext('2d').createImageData(sim.W, sim.H);
    this.shadeImg = this.shadeC.getContext('2d').createImageData(sim.W, sim.H);
  }

  // Paints the plan: flat blocks in the legend colours with a soft shadow and an outline, plus a
  // light grid on the stage, awning stripes on bars, cabins on toilets and chevrons on exits.
  drawObjects() {
    const { sim } = this, { W, H } = sim, S = this.objScale, grid = sim.grid;
    const T = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : grid[y * W + x] & 255);
    const bd = this.baseImg.data, sd = this.shadeImg.data;
    for (let c = 0; c < W * H; c++) {
      const t = grid[c] & 255, o = c * 4, ob = OBJ[t];
      if (ob) { bd[o] = ob[0]; bd[o + 1] = ob[1]; bd[o + 2] = ob[2]; bd[o + 3] = 255; } else bd[o + 3] = 0;
      sd[o] = 0; sd[o + 1] = 0; sd[o + 2] = 0; sd[o + 3] = ob && t !== T_EXIT ? 130 : 0;
    }
    this.baseC.getContext('2d').putImageData(this.baseImg, 0, 0);
    this.shadeC.getContext('2d').putImageData(this.shadeImg, 0, 0);

    const g = this.objC.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W * S, H * S);
    g.imageSmoothingEnabled = true;                         // the enlarged 1 px mask gives a soft edge
    g.drawImage(this.shadeC, 0.3 * S, 0.4 * S, W * S, H * S);
    g.imageSmoothingEnabled = false;
    g.drawImage(this.baseC, 0, 0, W * S, H * S);
    g.setTransform(S, 0, 0, S, 0, 0);
    g.lineCap = 'round'; g.lineJoin = 'round';

    // how long the bar runs through each of its cells, so the stripes go across the short side
    const runH = new Uint16Array(W * H), runV = new Uint16Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0, a = -1; x <= W; x++) {
      const on = x < W && T(x, y) === T_BAR;
      if (on && a < 0) a = x;
      if (!on && a >= 0) { for (let k = a; k < x; k++) runH[y * W + k] = x - a; a = -1; }
    }
    for (let x = 0; x < W; x++) for (let y = 0, a = -1; y <= H; y++) {
      const on = y < H && T(x, y) === T_BAR;
      if (on && a < 0) a = y;
      if (!on && a >= 0) { for (let k = a; k < y; k++) runV[k * W + x] = y - a; a = -1; }
    }

    const edges = { [T_WALL]: [], [T_EXIT]: [], [T_STAGE]: [], [T_BAR]: [], [T_WC]: [] };
    const stageGrid = new Path2D(), stripes = new Path2D(), cabins = new Path2D(), chevrons = new Path2D();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const t = grid[y * W + x] & 255;
      if (!OBJ[t]) continue;
      const e = edges[t];
      if (T(x - 1, y) !== t) e.push(x, y, x, y + 1);
      if (T(x + 1, y) !== t) e.push(x + 1, y, x + 1, y + 1);
      if (T(x, y - 1) !== t) e.push(x, y, x + 1, y);
      if (T(x, y + 1) !== t) e.push(x, y + 1, x + 1, y + 1);
      if (t === T_STAGE) {
        if (x % 2 === 0) { stageGrid.moveTo(x, y); stageGrid.lineTo(x, y + 1); }
        if (y % 2 === 0) { stageGrid.moveTo(x, y); stageGrid.lineTo(x + 1, y); }
      } else if (t === T_BAR) {
        const c = y * W + x;
        if (((runH[c] >= runV[c] ? x : y) & 1) === 0) stripes.rect(x, y, 1, 1);
      } else if (t === T_WC) cabins.rect(x + 0.1, y + 0.1, 0.8, 0.8);
      else if (t === T_EXIT) {
        let dx = 0, dy = 0;                                  // chevrons point out of the map
        const m = Math.min(x, W - 1 - x, y, H - 1 - y);
        if (m === x) dx = -1; else if (m === W - 1 - x) dx = 1; else if (m === y) dy = -1; else dy = 1;
        const cx = x + 0.5, cy = y + 0.5, qx = -dy, qy = dx;
        chevrons.moveTo(cx - 0.15 * dx + 0.26 * qx, cy - 0.15 * dy + 0.26 * qy);
        chevrons.lineTo(cx + 0.17 * dx, cy + 0.17 * dy);
        chevrons.lineTo(cx - 0.15 * dx - 0.26 * qx, cy - 0.15 * dy - 0.26 * qy);
      }
    }
    g.fillStyle = 'rgba(255,255,255,0.20)'; g.fill(stripes);
    g.fillStyle = 'rgba(255,255,255,0.26)'; g.fill(cabins);
    g.lineWidth = 1 / S; g.strokeStyle = 'rgba(255,255,255,0.16)'; g.stroke(stageGrid);
    g.lineWidth = 0.12; g.strokeStyle = 'rgba(236,255,236,0.92)'; g.stroke(chevrons);
    for (const t of [T_WALL, T_EXIT, T_BAR, T_WC, T_STAGE]) {
      const e = edges[t];
      if (!e.length) continue;
      const path = new Path2D();
      for (let k = 0; k < e.length; k += 4) { path.moveTo(e[k], e[k + 1]); path.lineTo(e[k + 2], e[k + 3]); }
      // a darker outline for everything, a lighter purple rim for the stage
      g.lineWidth = (t === T_STAGE ? 2 : 1) / S;
      g.strokeStyle = t === T_STAGE ? '#c4bdf6' : shade(OBJ[t], 0.55);
      g.stroke(path);
    }
  }
  resize(w, h) { if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; } }

  render(cam) {
    const { ctx, sim } = this, { W, H } = sim;
    const cw = this.canvas.width, ch = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0d0d0d'; ctx.fillRect(0, 0, cw, ch);

    // heat colours come from a lookup table (one entry per 1/64 person per m2), rebuilt only when the gain changes
    if (this.lutGain !== cam.heatGain) {
      this.lutGain = cam.heatGain;
      this.lut = new Uint8Array(LUT_N * 3);
      for (let i = 0; i < LUT_N; i++) { const col = heat(i / 64, cam.heatGain); this.lut.set([col[0], col[1], col[2]], i * 3); }
    }
    const hd = this.heatImg.data, off = cam.layer === 1 ? 1 : 0, lut = this.lut, dens = sim.dens;
    for (let c = 0; c < W * H; c++) {
      const o = c * 4;
      let k = (dens[o + off] * 64) | 0; if (k >= LUT_N) k = LUT_N - 1;
      hd[o] = lut[k * 3]; hd[o + 1] = lut[k * 3 + 1]; hd[o + 2] = lut[k * 3 + 2]; hd[o + 3] = 255;
    }
    this.heatC.getContext('2d').putImageData(this.heatImg, 0, 0);
    // fences, stage, bar and toilets only change when the plan is edited
    let sum = 0;
    for (let c = 0; c < W * H; c++) sum = (Math.imul(sum, 31) + (sim.grid[c] & 255) * (c + 1)) | 0;
    if (sum !== this.gridSum) { this.gridSum = sum; this.drawObjects(); }

    ctx.setTransform(cam.scale, 0, 0, cam.scale, cw / 2 - cam.cx * cam.scale, ch / 2 - cam.cy * cam.scale);
    ctx.imageSmoothingEnabled = true; ctx.drawImage(this.heatC, 0, 0);
    ctx.imageSmoothingQuality = 'high'; ctx.drawImage(this.objC, 0, 0, W, H);

    if (cam.agentAlpha <= 0 || sim.n === 0) return;
    const n = sim.n, f = sim.fA, u = sim.uA, fp = sim.fB, up = sim.uB;
    const t = cam.interp ?? 1, detail = cam.detail ?? 0;
    if (!this.px || this.px.length < n) { this.px = new Float32Array(n); this.py = new Float32Array(n); }
    const px = this.px, py = this.py;
    // between the last two steps, so motion is smooth at any frame rate
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE;
      if (u[o + A_GOAL] === G_GONE) { px[i] = NaN; continue; }
      let x = f[o + A_X], y = f[o + A_Y];
      if (up[o + A_GOAL] !== G_GONE) {
        const bx = fp[o + A_X], by = fp[o + A_Y];
        if (Math.abs(x - bx) + Math.abs(y - by) < 0.5) { x = bx + (x - bx) * t; y = by + (y - by) * t; }
      }
      px[i] = x; py[i] = y;
    }
    const bucketOf = (o) => {
      const g = u[o + A_GOAL];
      if (cam.colorMode === 0) { const d = f[o + A_DENS]; return d >= 4.95 ? 2 : d >= 3.9 ? 1 : 0; }
      if (cam.colorMode === 1) { const v = Math.hypot(f[o + A_VX], f[o + A_VY]); return v < 0.15 ? 0 : v < 0.8 ? 1 : 2; }
      return g === 1 ? 1 : g === 2 ? 2 : g === 3 || g === 4 ? 3 : g >= 5 ? 4 : 0;
    };
    const buckets = cam.colorMode === 0 ? ['#6da7ec', '#fab219', '#d03b3b']
      : cam.colorMode === 1 ? ['#898781', '#9ec5f4', '#cde2fb']
      : ['#9085e9', '#d55181', '#199e70', '#0ca30c', '#f0efec'];
    ctx.globalAlpha = cam.agentAlpha;

    if (detail < 0.5) {
      const minR = cam.minPx / cam.scale;
      for (let b = 0; b < buckets.length; b++) {
        ctx.fillStyle = buckets[b];
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const o = i * STRIDE;
          if (px[i] !== px[i] || bucketOf(o) !== b) continue;
          const r = Math.max(f[o + A_R], minR);
          ctx.rect(px[i] - r, py[i] - r, 2 * r, 2 * r);
        }
        ctx.fill();
      }
    } else {
      // figures, only for the people on screen
      const hw = cw / 2 / cam.scale + 1, hh = ch / 2 / cam.scale + 1;
      const vis = [];
      for (let i = 0; i < n; i++) {
        if (px[i] !== px[i] || Math.abs(px[i] - cam.cx) > hw || Math.abs(py[i] - cam.cy) > hh) continue;
        const o = i * STRIDE, vx = f[o + A_VX], vy = f[o + A_VY], sp = Math.hypot(vx, vy);
        let ang;
        if (sp > 0.15) ang = Math.atan2(vy, vx);
        else {
          const g = u[o + A_GOAL], layer = g === 5 ? 1 : g === 6 ? 2 : g;
          const cx = Math.min(W - 1, Math.max(0, Math.floor(px[i]))), cy = Math.min(H - 1, Math.max(0, Math.floor(py[i])));
          const q = (layer * W * H + cy * W + cx) * 4;
          ang = layer <= 4 && sim.fields[q + 2] < 1e8 ? Math.atan2(sim.fields[q + 1], sim.fields[q]) : -Math.PI / 2;
        }
        const seed = u[o + A_SEED];
        const swing = Math.sin((f[o + A_AUX] + rnd(seed, 40)) * 6.2831853) * Math.min(1, sp / 1.1);
        vis.push(i, ang, swing);
      }
      const each = (fn) => { for (let k = 0; k < vis.length; k += 3) fn(vis[k], vis[k + 1], vis[k + 2]); };
      const ell = (x, y, a, b, ang) => { ctx.moveTo(x + a * Math.cos(ang), y + a * Math.sin(ang)); ctx.ellipse(x, y, a, b, ang, 0, 6.2832); };
      const circ = (x, y, r) => { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, 6.2832); };
      ctx.fillStyle = 'rgba(0,0,0,0.38)'; ctx.beginPath();
      each((i, ang) => { const r = f[i * STRIDE + A_R]; ell(px[i] + 0.05, py[i] + 0.07, 0.55 * r, 0.95 * r, ang); });
      ctx.fill();
      ctx.fillStyle = '#212124'; ctx.beginPath();
      each((i, ang, sw) => {
        const r = f[i * STRIDE + A_R], c = Math.cos(ang), s = Math.sin(ang);
        for (const side of [-1, 1]) {
          const fw = -side * sw * 0.55 * r, lat = side * 0.36 * r;
          circ(px[i] + c * fw - s * lat, py[i] + s * fw + c * lat, 0.17 * r);
        }
      });
      ctx.fill();
      ctx.strokeStyle = '#0a0a0b'; ctx.lineWidth = 1.2 / cam.scale;
      for (let b = 0; b < buckets.length; b++) {
        ctx.fillStyle = buckets[b]; ctx.beginPath();
        each((i, ang) => { if (bucketOf(i * STRIDE) === b) { const r = f[i * STRIDE + A_R]; ell(px[i], py[i], 0.5 * r, 0.88 * r, ang); } });
        ctx.fill(); ctx.stroke();
      }
      for (let h = 0; h < HAIR.length; h++) {
        ctx.fillStyle = HAIR[h]; ctx.beginPath();
        each((i, ang) => {
          const o = i * STRIDE;
          if (Math.min(5, Math.floor(rnd(u[o + A_SEED], 32) * 6)) !== h) return;
          const r = f[o + A_R];
          circ(px[i] + Math.cos(ang) * 0.06 * r, py[i] + Math.sin(ang) * 0.06 * r, 0.43 * r);
        });
        ctx.fill();
      }
    }
    if (cam.follow > 0 && px[cam.follow - 1] === px[cam.follow - 1]) {
      const i = cam.follow - 1, r = Math.max(f[i * STRIDE + A_R] * 2.1, 9 / cam.scale);
      ctx.globalAlpha = 0.75 + 0.25 * Math.sin((cam.clock || 0) * 5);
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2 / cam.scale;
      ctx.beginPath(); ctx.arc(px[i], py[i], r, 0, 6.2832); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // One person's record from the current step (the camera uses it to follow someone).
  async readAgent(i) {
    if (i < 0 || i >= this.sim.n) return null;
    return this.sim.uA.buffer.slice(i * STRIDE * 4, (i + 1) * STRIDE * 4);
  }
}
