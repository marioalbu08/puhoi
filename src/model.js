// Constants and pure helpers shared by the page, the field worker and the Node tests.
// The GPU shaders in sim-gpu.js mirror these values; change them in both places.

export const MAP_W = 320;            // metres, one cell is 1 m x 1 m
export const MAP_H = 200;
export const K = 16;                 // slots per cell in the neighbour grid
export const DT = 0.05;              // seconds per simulation step
export const LAYERS = 5;             // flow fields: stage, bar, toilet, nearest exit, least busy exit
export const INF = 1e9;

// Cell types
export const T_FREE = 0, T_WALL = 1, T_EXIT = 2, T_STAGE = 3, T_BAR = 4, T_WC = 5;
export const isSolid = (t) => t === T_WALL || t === T_STAGE || t === T_BAR || t === T_WC;

// Agent goals. Goals 0..4 are also the index of the flow field the agent follows.
export const G_STAGE = 0, G_BAR = 1, G_WC = 2, G_EXIT = 3, G_EXIT_DYN = 4,
  G_SERVE_BAR = 5, G_SERVE_WC = 6, G_GONE = 9;

// Agent record: 12 words of 32 bits (48 bytes), same layout on CPU and GPU.
export const STRIDE = 12;
export const A_X = 0, A_Y = 1, A_VX = 2, A_VY = 3, A_V0 = 4, A_R = 5, A_PREF = 6, A_TIMER = 7,
  A_GOAL = 8, A_SEED = 9, A_DENS = 10, A_AUX = 11;

// Stats buffer: [0] people who left, [1..63] per exit, [64] people removed by editing.
export const STATS_LEN = 72;

// Weidmann (1993) speed-density relation for pedestrians.
export const GAMMA = 1.913;
export const RHO_JAM = 5.4;          // people per m2 at which walking stops
export const V_MEAN = 1.34, V_SD = 0.26;
export const R_MIN = 0.21, R_SPAN = 0.035; // body radius in metres; tight packing then tops out near 5.4 people per m2
export const HEADWAY = 0.3;          // seconds: a walker keeps at least this much time to the person ahead
export const HEAD_RANGE = 0.4;       // metres beyond body contact within which the person ahead matters
export const LOOK = 0.25;             // metres ahead at which a walker reads the crowd density

export function weidmann(rho, rhoJam = RHO_JAM) {
  if (rho < 0.05) return 1;
  if (rho >= rhoJam) return 0;
  return 1 - Math.exp(-GAMMA * (1 / rho - 1 / rhoJam));
}

// Integer hash, identical to the WGSL version.
export function hash32(x) {
  x = x >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}
export function rnd(seed, salt) {
  return (hash32((seed ^ Math.imul(salt, 0x9e3779b9)) >>> 0) >>> 8) / 16777216;
}

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- layouts

function rect(g, W, x0, y0, x1, y1, t) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) g[y * W + x] = t;
}
function border(g, W, H) {
  rect(g, W, 0, 0, W - 1, 0, T_WALL); rect(g, W, 0, H - 1, W - 1, H - 1, T_WALL);
  rect(g, W, 0, 0, 0, H - 1, T_WALL); rect(g, W, W - 1, 0, W - 1, H - 1, T_WALL);
}
function arena(W, H) {
  const g = new Uint8Array(W * H);
  border(g, W, H);
  rect(g, W, 120, 6, 199, 21, T_STAGE);          // main stage, 80 x 16 m
  rect(g, W, 119, 1, 119, 21, T_WALL);           // backstage fences
  rect(g, W, 200, 1, 200, 21, T_WALL);
  rect(g, W, 154, 78, 165, 85, T_WALL);          // front-of-house mixing tower
  rect(g, W, 100, 100, 102, 102, T_WALL);        // delay towers
  rect(g, W, 217, 100, 219, 102, T_WALL);
  rect(g, W, 28, 84, 31, 113, T_BAR);            // bars along both sides
  rect(g, W, 288, 84, 291, 113, T_BAR);
  rect(g, W, 20, 186, 49, 189, T_WC);            // toilets in the back corners
  rect(g, W, 270, 186, 299, 189, T_WC);
  return g;
}

// ---------------------------------------------------------------- Beach, Please! 2026

// Drawing helpers for the larger plan; all clip to the map.
function put(g, W, H, x, y, t) { if (x >= 0 && y >= 0 && x < W && y < H) g[y * W + x] = t; }
function box(g, W, H, x0, y0, x1, y1, t) { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) put(g, W, H, x, y, t); }
function frame(g, W, H, x0, y0, x1, y1, t) {
  box(g, W, H, x0, y0, x1, y0, t); box(g, W, H, x0, y1, x1, y1, t);
  box(g, W, H, x0, y0, x0, y1, t); box(g, W, H, x1, y0, x1, y1, t);
}
function line(g, W, H, x0, y0, x1, y1, t) {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2);
  for (let i = 0; i <= n; i++) {
    const x = Math.round(x0 + (x1 - x0) * i / n), y = Math.round(y0 + (y1 - y0) * i / n);
    put(g, W, H, x, y, t); put(g, W, H, x + 1, y, t);                 // two cells wide, so diagonals stay closed
  }
}
function disk(g, W, H, cx, cy, r, t) {
  for (let y = Math.floor(cy - r); y <= cy + r; y++) for (let x = Math.floor(cx - r); x <= cx + r; x++) {
    if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) put(g, W, H, x, y, t);
  }
}
// A rectangle turned to face direction (fx, fy): halfLen across the front, halfDepth front to back.
function turned(g, W, H, cx, cy, fx, fy, halfLen, halfDepth, t) {
  const R = Math.ceil(Math.hypot(halfLen, halfDepth));
  for (let y = Math.floor(cy - R); y <= cy + R; y++) for (let x = Math.floor(cx - R); x <= cx + R; x++) {
    const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
    if (Math.abs(dx * fx + dy * fy) <= halfDepth && Math.abs(-dx * fy + dy * fx) <= halfLen) put(g, W, H, x, y, t);
  }
}

// The site on the official 2026 map (beach-please.ro/map), NIBIRU resort, Costinești: drawn north up,
// sea to the east, 1 cell = 1 m. Positions are read off the map, which is schematic, so they are
// approximate; the size (520 x 400 m, about 21 ha) matches the 20-22 ha the organisers give.
// The organisers have not published exit widths or an evacuation plan: the two public gates are
// assumed to be 24 m wide each.
function beachPlease(W, H, emergency) {
  const g = new Uint8Array(W * H);
  border(g, W, H);
  // north-east: the fence follows the curve of the camping field
  for (let x = 290; x < W; x++) { const y = Math.round(0.22 * (x - 290)); box(g, W, H, x, y, x, y + 1, T_WALL); }

  // A, main stage (south-west), facing north over the big lawn; side towers; fenced backstage behind
  box(g, W, H, 79, 326, 158, 353, T_STAGE);
  box(g, W, H, 30, 336, 78, 346, T_STAGE);
  box(g, W, H, 159, 336, 205, 346, T_STAGE);
  box(g, W, H, 29, 336, 29, H - 1, T_WALL); box(g, W, H, 206, 336, 206, H - 1, T_WALL);
  box(g, W, H, 112, 262, 123, 269, T_WALL);                      // front-of-house mixing tower
  // C, Nibiru Arena (south edge), facing north
  box(g, W, H, 254, 326, 315, 353, T_STAGE);
  box(g, W, H, 222, 334, 253, 348, T_STAGE);
  box(g, W, H, 316, 334, 349, 348, T_STAGE);
  box(g, W, H, 221, 334, 221, H - 1, T_WALL); box(g, W, H, 350, 334, 350, H - 1, T_WALL);
  // B, Essence stage (north-east), turned to face south-west; backstage closed off towards the fence
  turned(g, W, H, 466, 72, -0.7071, 0.7071, 32, 6, T_STAGE);
  line(g, W, H, 443, 49, 460, 31, T_WALL); line(g, W, H, 489, 95, 519, 65, T_WALL);
  // D, The Fool stand-up stage (centre-east)
  box(g, W, H, 366, 234, 384, 243, T_STAGE);

  // buildings and attractions
  box(g, W, H, 2, 125, 40, 168, T_WALL);                          // hospital
  frame(g, W, H, 8, 183, 62, 284, T_WALL);                        // VIP zone, fenced (own access)
  box(g, W, H, 14, 190, 20, 214, T_WC); box(g, W, H, 40, 196, 52, 199, T_BAR);
  box(g, W, H, 120, 10, 166, 52, T_WALL);                         // F, amusement park rides
  disk(g, W, H, 56, 162, 13, T_WALL);                             // roller rink
  disk(g, W, H, 73, 118, 8, T_WALL);                              // dinner in the sky
  disk(g, W, H, 345, 191, 19, T_WALL);                            // I, Nibiru space theatre dome
  box(g, W, H, 362, 266, 428, 300, T_WALL);                       // E, hype gaming area
  box(g, W, H, 370, 310, 426, 360, T_WALL);
  box(g, W, H, 490, 102, W - 1, 131, T_WALL);                     // Lidl store
  frame(g, W, H, 195, 85, 224, 108, T_WALL);                      // basket court
  frame(g, W, H, 227, 85, 249, 108, T_WALL);                      // padel courts
  for (const [x, y] of [[81, 149], [122, 149], [151, 160], [143, 87], [228, 207]]) box(g, W, H, x - 4, y - 3, x + 4, y + 3, T_WALL);
  for (const [x, y] of [[114, 232], [100, 137], [237, 149], [282, 216], [361, 149]]) disk(g, W, H, x, y, 3.5, T_WALL);

  // food corner: rows of stalls with gaps between them
  for (let x = 183; x < 250; x += 17) box(g, W, H, x, 48, x + 14, 52, T_BAR);
  for (let x = 266; x < 360; x += 24) box(g, W, H, x, 46, x + 20, 51, T_BAR);
  for (let x = 266; x < 358; x += 23) box(g, W, H, x, 141, x + 19, 146, T_BAR);
  box(g, W, H, 303, 108, 325, 118, T_BAR); box(g, W, H, 330, 108, 357, 118, T_BAR); box(g, W, H, 303, 124, 357, 129, T_BAR);
  box(g, W, H, 400, 155, 412, 165, T_BAR); box(g, W, H, 418, 158, 434, 168, T_BAR); box(g, W, H, 402, 178, 432, 186, T_BAR);
  box(g, W, H, 112, 100, 128, 106, T_BAR); box(g, W, H, 140, 104, 156, 110, T_BAR); box(g, W, H, 165, 112, 181, 118, T_BAR);
  // cocktail bars
  for (const [x0, y0, x1, y1] of [[160, 31, 170, 34], [238, 120, 248, 123], [390, 70, 400, 73], [452, 122, 462, 125],
    [464, 228, 467, 240], [225, 168, 228, 180], [240, 272, 250, 275], [328, 316, 338, 319], [64, 200, 67, 212], [355, 220, 365, 223]]) {
    box(g, W, H, x0, y0, x1, y1, T_BAR);
  }
  // toilets
  box(g, W, H, 10, 68, 17, 92, T_WC); box(g, W, H, 370, 44, 390, 49, T_WC);
  box(g, W, H, 334, 296, 348, 302, T_WC); box(g, W, H, 458, 330, 472, 336, T_WC);

  // the two public gates ("Fast Lane"): north-west from the parking, across the railway; south-east
  // at Henri Coandă x Emil Costinescu
  box(g, W, H, 0, 16, 0, 39, T_EXIT);
  box(g, W, H, W - 1, 355, W - 1, 378, T_EXIT);
  if (emergency) {
    // invented for comparison: 10 m emergency exits to the camping field (north), Emil Costinescu
    // street (east) and Costinești (south); none on the railway side
    box(g, W, H, 60, 0, 69, 0, T_EXIT); box(g, W, H, 200, 0, 209, 0, T_EXIT);
    box(g, W, H, W - 1, 150, W - 1, 159, T_EXIT); box(g, W, H, W - 1, 250, W - 1, 259, T_EXIT);
    box(g, W, H, 208, H - 1, 217, H - 1, T_EXIT); box(g, W, H, 440, H - 1, 449, H - 1, T_EXIT);
  }
  return g;
}

export const LAYOUTS = [
  {
    id: 'festival', name: 'Festival, 7 ieșiri',
    build(W = MAP_W, H = MAP_H) {
      const g = arena(W, H);
      rect(g, W, 152, H - 1, 167, H - 1, T_EXIT);  // main gate, 16 m
      rect(g, W, 0, 96, 0, 103, T_EXIT);           // side gates, 8 m
      rect(g, W, W - 1, 96, W - 1, 103, T_EXIT);
      rect(g, W, 0, 30, 0, 33, T_EXIT);            // emergency exits near the stage, 4 m
      rect(g, W, W - 1, 30, W - 1, 33, T_EXIT);
      rect(g, W, 70, H - 1, 73, H - 1, T_EXIT);    // back corners, 4 m
      rect(g, W, 246, H - 1, 249, H - 1, T_EXIT);
      return g;
    },
  },
  {
    id: 'poarta', name: 'Festival, o singură poartă',
    build(W = MAP_W, H = MAP_H) {
      const g = arena(W, H);
      rect(g, W, 152, H - 1, 167, H - 1, T_EXIT);
      return g;
    },
  },
  {
    id: 'gol', name: 'Teren gol',
    build(W = MAP_W, H = MAP_H) {
      const g = new Uint8Array(W * H);
      border(g, W, H);
      rect(g, W, 130, 6, 189, 17, T_STAGE);
      rect(g, W, 154, H - 1, 165, H - 1, T_EXIT);
      return g;
    },
  },
  {
    // w, h: map size when it is not MAP_W x MAP_H; people: the crowd it opens with
    id: 'beach', name: 'Beach, Please! 2026 (aproximativ, doar porțile publice)', w: 520, h: 400, people: 120000,
    note: 'Plan aproximativ, după harta oficială 2026 (Costinești, NIBIRU). Organizatorii nu au publicat planul de evacuare: cele două porți publice au aici câte 24 m, presupus.',
    build(W = 520, H = 400) { return beachPlease(W, H, false); },
  },
  {
    id: 'beach-urgenta', name: 'Beach, Please! 2026 + ieșiri de urgență ipotetice', w: 520, h: 400, people: 120000,
    note: 'Aceleași două porți publice, plus 6 ieșiri de urgență de câte 10 m inventate pentru comparație. Ele nu apar în planul real.',
    build(W = 520, H = 400) { return beachPlease(W, H, true); },
  },
];

// Run-length encoding of a layout, for share links.
export function encodeLayout(g) {
  const out = [];
  let i = 0;
  while (i < g.length) {
    const t = g[i]; let n = 1;
    while (i + n < g.length && g[i + n] === t) n++;
    i += n;
    out.push(t);
    while (n >= 128) { out.push((n & 127) | 128); n >>>= 7; }
    out.push(n);
  }
  let s = '';
  for (const b of out) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decodeLayout(str, cells) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const g = new Uint8Array(cells);
  let p = 0, i = 0;
  while (p < s.length && i < cells) {
    const t = s.charCodeAt(p++);
    let n = 0, shift = 0, b;
    do { b = s.charCodeAt(p++); n |= (b & 127) << shift; shift += 7; } while (b & 128 && p < s.length);
    if (t > T_WC) throw new Error('plan invalid');
    g.fill(t, i, Math.min(cells, i + n));
    i += n;
  }
  if (i !== cells) throw new Error('plan invalid');
  return g;
}

// ---------------------------------------------------------------- crowd

// Places n people as a concert crowd: packed in front of the stage, thinning out with distance.
// `stage` and `exits` are flow-field layers (dx, dy, dist, 0 per cell).
export function placeCrowd(W, H, types, stage, exits, N, seed = 1, visitMean = 1200) {
  const rand = mulberry32(seed);
  const gauss = () => {
    let u = 0; while (u < 1e-9) u = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(6.2831853 * rand());
  };
  const cand = [], dist = [];
  let hasStage = false;
  for (let c = 0; c < W * H; c++) {
    if (types[c] !== T_FREE || exits[c * 4 + 2] > 1e8) continue;   // must be able to reach an exit
    const d = stage[c * 4 + 2];
    cand.push(c);
    if (d < 1e8) { dist.push(d); hasStage = true; } else dist.push(-1);
  }
  const buffer = new ArrayBuffer(Math.max(N, 1) * STRIDE * 4);
  if (!cand.length || N <= 0) return { buffer, n: 0 };

  const L = 40, RMIN = 0.12, RCAP = 4.0;
  const n = Math.min(N, Math.floor(cand.length * RCAP));
  const rho = new Float32Array(cand.length);
  const fill = (r0) => {
    let s = 0;
    for (let i = 0; i < cand.length; i++) {
      const d = dist[i];
      const r = !hasStage ? Math.min(RCAP, r0)
        : d < 0 ? RMIN : Math.min(RCAP, Math.max(RMIN, r0 * Math.exp(-d / L)));
      rho[i] = r; s += r;
    }
    return s;
  };
  let lo = 0, hi = 1e7;
  for (let it = 0; it < 60; it++) {
    const mid = (lo + hi) / 2;
    if (fill(mid) < n) lo = mid; else hi = mid;
  }
  fill(hi);

  const count = new Uint16Array(cand.length);
  let total = 0;
  for (let i = 0; i < cand.length; i++) {
    const c = Math.floor(rho[i]) + (rand() < rho[i] - Math.floor(rho[i]) ? 1 : 0);
    count[i] = c; total += c;
  }
  let guard = 0;
  while (total !== n && guard++ < 50_000_000) {
    const i = Math.floor(rand() * cand.length);
    if (total > n) { if (count[i] > 0) { count[i]--; total--; } }
    else if (rand() * RCAP < rho[i] && count[i] < 6) { count[i]++; total++; }
  }

  const f = new Float32Array(buffer), u = new Uint32Array(buffer);
  let k = 0;
  for (let i = 0; i < cand.length && k < n; i++) {
    const c = cand[i], cx = c % W, cy = (c / W) | 0;
    for (let j = 0; j < count[i] && k < n; j++, k++) {
      const o = k * STRIDE;
      f[o + A_X] = cx + 0.05 + 0.9 * rand();
      f[o + A_Y] = cy + 0.05 + 0.9 * rand();
      f[o + A_VX] = 0; f[o + A_VY] = 0;
      f[o + A_V0] = Math.min(1.9, Math.max(0.85, V_MEAN + V_SD * gauss()));
      f[o + A_R] = R_MIN + R_SPAN * rand();
      // most people are content where they stand; some want to get a little closer
      f[o + A_PREF] = Math.min(4.5, Math.max(0.5, rho[i] * (0.9 + 0.25 * rand()) + 0.1));
      f[o + A_TIMER] = -Math.log(1 - rand()) * visitMean;
      u[o + A_GOAL] = G_STAGE;
      u[o + A_SEED] = hash32(k + Math.imul(seed, 7919));
      f[o + A_DENS] = rho[i];
      f[o + A_AUX] = 0;
    }
  }
  return { buffer, n: k };
}
