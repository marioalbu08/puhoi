// The page: picks a backend, wires the editor and the controls, and turns simulation
// counters into the numbers in the right-hand panel.

import {
  MAP_W, MAP_H, DT, LAYOUTS, RHO_JAM, STRIDE, A_X, A_Y, A_VX, A_VY, A_GOAL, A_DENS, G_GONE,
  T_FREE, T_WALL, T_EXIT, T_STAGE, T_BAR, T_WC,
  encodeLayout, decodeLayout, placeCrowd,
} from './model.js';
import { analyzeGrid } from './field.js';
import { CpuSim } from './sim-cpu.js';
import { GpuSim } from './sim-gpu.js';
import { Render2D } from './render2d.js';

// The map size depends on the plan (most are 320 x 200 m, Beach, Please! is 520 x 400 m); see setMapSize.
let W = MAP_W, H = MAP_H, CELLS = W * H;
const EGRESS_SPREAD = 900;               // normal exit: people leave over the first 15 minutes after the show
const GUIDE = 82;                       // people per metre of exit per minute (Green Guide, level ground)
const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat('ro-RO');
const f1 = new Intl.NumberFormat('ro-RO', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const compact = new Intl.NumberFormat('ro-RO', { notation: 'compact' });
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const TOOLS = [
  { id: 'pan', name: 'Mută', key: '1', color: 'transparent' },
  { id: 'wall', name: 'Gard', key: '2', type: T_WALL, color: '#8f8c85' },
  { id: 'exit', name: 'Ieșire', key: '3', type: T_EXIT, color: '#0ca30c' },
  { id: 'stage', name: 'Scenă', key: '4', type: T_STAGE, color: '#9085e9' },
  { id: 'bar', name: 'Bar', key: '5', type: T_BAR, color: '#d55181' },
  { id: 'wc', name: 'Toalete', key: '6', type: T_WC, color: '#199e70' },
  { id: 'erase', name: 'Radieră', key: '7', type: T_FREE, color: '#1a1a19' },
];
const LABELS = { [T_STAGE]: 'SCENĂ', [T_BAR]: 'BAR', [T_WC]: 'WC' };

const S = {
  sim: null, renderer: null, types: null, an: null, version: 0,
  fields: null, fieldsVersion: -1, needPlace: true, resets: 0,
  phase: 'loading', running: true, speed: 4, N: 50000, placed: 0, inside: 0,
  cam: { cx: W / 2, cy: H / 2, scale: 4 }, fitted: false,
  tool: 'pan', brush: 2, undo: [], hover: null,
  settings: { guided: 0.5, reactMax: 20, colorMode: 0, layer: 0 },
  evac: null, runs: [], dens: { maxNow: 0, maxEver: 0, crit: 0, expo: 0 },
  exitRows: new Map(), exitRate: new Map(), labels: [], cpuCap: 4,
  lastStats: null, perf: { fps: 0, speed: 0 },
};
let worker, staticBusy = false, staticDirty = false, dynBusy = false;
const dpr = Math.min(2, window.devicePixelRatio || 1);

// ------------------------------------------------------------------ boot

async function boot() {
  const q = new URLSearchParams(location.search);
  const h = new URLSearchParams(location.hash.slice(1));
  let fromLink = false;
  if (h.get('p')) {
    try {
      const lw = Number(h.get('w')) || MAP_W, lh = Number(h.get('h')) || MAP_H;
      if (!(lw >= 16 && lh >= 16 && lw * lh <= 1e6)) throw new Error('size');
      W = lw; H = lh; CELLS = W * H;
      S.types = decodeLayout(h.get('p'), CELLS); fromLink = true;
    } catch {
      W = MAP_W; H = MAP_H; CELLS = W * H;
      showMsg('Planul din link nu a putut fi citit. Am încărcat planul implicit.', 8000);
    }
  }
  // ?plan=beach opens a given starting plan
  const start = LAYOUTS.find((l) => l.id === (q.get('plan') || h.get('plan'))) || LAYOUTS[0];
  S.layoutId = start.id;
  if (!S.types) { W = start.w || MAP_W; H = start.h || MAP_H; CELLS = W * H; S.types = start.build(); }

  const view = $('view');
  let canvas = document.createElement('canvas');
  view.prepend(canvas);
  let sim = null;
  if (q.get('backend') !== 'cpu') {
    try { sim = await GpuSim.create(canvas, W, H, 160000); }
    catch (e) { console.warn('WebGPU indisponibil (' + e.message + '), simularea trece pe procesor.'); }
  }
  if (sim) S.renderer = sim;
  else {
    const c2 = document.createElement('canvas');
    canvas.replaceWith(c2); canvas = c2;
    sim = new CpuSim(W, H, 10000);
    S.renderer = new Render2D(canvas, sim);
    showMsg(window.isSecureContext
      ? 'Browserul acesta nu are WebGPU, așa că simularea rulează pe procesor, cu cel mult 10.000 de oameni. În Chrome sau Edge merge cu 100.000.'
      : 'Pagina nu e servită prin HTTPS, iar browserele dau acces la placa video doar pe HTTPS. Simularea rulează pe procesor, cu cel mult 10.000 de oameni.', 12000);
  }
  S.sim = sim;

  const counts = sim.backend === 'gpu' ? [10000, 25000, 50000, 75000, 100000, 150000] : [2000, 5000, 10000];
  const wanted = Number(q.get('n') || h.get('n')) || (sim.backend === 'gpu' ? (!fromLink && start.people) || 50000 : 5000);
  S.N = counts.includes(wanted) ? wanted : Math.min(wanted, counts[counts.length - 1]);
  if (!counts.includes(S.N)) counts.push(S.N);
  for (const c of counts.sort((a, b) => a - b)) $('people').add(new Option(nf.format(c), c, false, c === S.N));
  if (q.get('speed')) S.speed = Number(q.get('speed')) || 4;
  if (q.get('guided')) S.settings.guided = Math.min(1, Math.max(0, Number(q.get('guided')) / 100));

  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = onFields;
  worker.onerror = (e) => console.error('worker: ' + e.message);

  buildUi(fromLink);
  gridChanged();
  requestAnimationFrame(frame);
  setInterval(() => poll().catch((e) => console.error('poll: ' + e.message)), 250);
  if (q.get('auto') === 'evac' || q.get('auto') === 'egress') { S.autoEvac = Number(q.get('settle')) || 20; S.autoType = q.get('auto'); }
  window.puhoi = { S, startEvac, reset, mmss, flyTo, setLayout };
  if (!fromLink && start.note) showMsg(start.note, 9000);
}

// ------------------------------------------------------------------ grid and fields

// Switches to one of the built-in plans; a plan of another size reallocates the simulation.
function setLayout(id) {
  const l = LAYOUTS.find((x) => x.id === id); if (!l) return;
  const lw = l.w || MAP_W, lh = l.h || MAP_H;
  if (lw !== W || lh !== H) setMapSize(lw, lh); else pushUndo();
  S.layoutId = l.id;
  if ($('layout').value !== l.id) $('layout').value = l.id;
  S.types = l.build(); gridChanged();
  const want = l.people || 50000;                       // the crowd each plan opens with, on the GPU
  if (S.sim.backend === 'gpu' && S.N !== want) {
    S.N = want;
    const sel = $('people');
    if (![...sel.options].some((o) => Number(o.value) === S.N)) sel.add(new Option(nf.format(S.N), S.N));
    sel.value = String(S.N);
    showMsg(`${l.name}: ${nf.format(S.N)} de oameni. ${l.note || ''}`, 9000);
  } else if (l.note) showMsg(l.note, 9000);
  reset();
}

function setMapSize(w, h) {
  W = w; H = h; CELLS = W * H;
  stopFollow();
  if (S.sim.backend === 'gpu') S.sim.resizeMap(W, H);
  else {
    S.sim = new CpuSim(W, H, 10000);
    S.renderer = new Render2D(S.renderer.canvas, S.sim);
  }
  S.fields = null; S.fieldsVersion = -1; S.undo = []; S.lastStats = null; S.fitted = false;
}

function gridChanged() {
  S.version++;
  S.an = analyzeGrid(W, H, S.types);
  S.sim.setGrid(S.an.packed);
  S.sim.params.hasBar = S.an.hasBar; S.sim.params.hasWc = S.an.hasWc;
  S.exitRate = new Map();
  S.labels = findLabels();
  requestStatic();
  renderExits(true);
  updateGuide();
}

function requestStatic() {
  if (staticBusy) { staticDirty = true; return; }
  staticBusy = true; staticDirty = false;
  worker.postMessage({ type: 'static', W, H, types: S.types, version: S.version });
}

function onFields(e) {
  const m = e.data, sim = S.sim;
  if (m.type === 'static') {
    staticBusy = false;
    if (staticDirty) requestStatic();
    if (m.out.length !== CELLS * 16) return;          // worked out for a plan of another size
    S.fields = m.out; S.fieldsVersion = m.version;
    for (let l = 0; l < 4; l++) sim.setField(l, m.out.subarray(CELLS * 4 * l, CELLS * 4 * (l + 1)));
    sim.setField(4, m.out.subarray(CELLS * 12, CELLS * 16));
    if (S.needPlace && m.version === S.version) place();
  } else {
    dynBusy = false;
    if (m.out.length !== CELLS * 8) return;
    if (m.version === S.version && S.phase === 'evac') {
      sim.setField(3, m.out.subarray(0, CELLS * 4));          // nearest exit, around the crowd
      sim.setField(4, m.out.subarray(CELLS * 4, CELLS * 8));  // quickest exit
    }
  }
}

function place() {
  const sim = S.sim;
  S.needPlace = false;
  const crowd = placeCrowd(W, H, S.types, S.fields.subarray(0, CELLS * 4), S.fields.subarray(CELLS * 12, CELLS * 16),
    S.N, 1 + S.resets, sim.params.visitMean);
  Object.assign(sim.params, { mode: 0, evacTime: 0, time: 0, step: 0 });
  // a previous evacuation leaves crowd-aware exit fields behind; go back to the plain ones
  sim.setField(3, S.fields.subarray(CELLS * 12, CELLS * 16));
  sim.setField(4, S.fields.subarray(CELLS * 12, CELLS * 16));
  sim.setAgents(crowd.buffer, crowd.n);
  S.placed = crowd.n; S.inside = crowd.n; S.phase = 'concert'; S.evac = null; S.lastStats = null;
  S.dens = { maxNow: 0, maxEver: 0, crit: 0, expo: 0 };
  S.exitRate = new Map();
  if (crowd.n === 0) showMsg('Din niciun loc nu se poate ajunge la o ieșire. Desenează o ieșire și apasă „De la capăt”.');
  else if (crowd.n < S.N) showMsg(`Pe planul acesta încap ${nf.format(crowd.n)} de oameni.`, 6000);
  $('evac').disabled = crowd.n === 0; $('egress').disabled = crowd.n === 0;
  updateHero(); updateGuide(); drawChart(); renderExits(true);
}

function reset() {
  S.resets++; S.needPlace = true; S.phase = 'loading';
  if (S.fields && S.fieldsVersion === S.version && !staticBusy) place();
}

// Connected blocks of stage, bar and toilet cells, so each can carry a text label.
function findLabels() {
  const seen = new Uint8Array(CELLS), out = [], stack = [];
  for (let s = 0; s < CELLS; s++) {
    const t = S.types[s];
    if (!LABELS[t] || seen[s]) continue;
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    stack.push(s); seen[s] = 1;
    while (stack.length) {
      const c = stack.pop(), x = c % W, y = (c / W) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const n of [c - 1, c + 1, c - W, c + W]) {
        if (n < 0 || n >= CELLS || seen[n] || S.types[n] !== t) continue;
        if (Math.abs((n % W) - x) > 1) continue;
        seen[n] = 1; stack.push(n);
      }
    }
    out.push({ text: LABELS[t], cx: (x0 + x1 + 1) / 2, cy: (y0 + y1 + 1) / 2, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  }
  return out;
}

// ------------------------------------------------------------------ evacuation

// type 'evac': everyone leaves within the reaction time; type 'egress': the show is over and people
// leave at their own pace, spread over EGRESS_SPREAD seconds.
function startEvac(type = 'evac') {
  if (S.phase !== 'concert' || S.inside <= 0) return;
  if (!S.an.exits.length) { showMsg('Planul nu are nicio ieșire. Desenează una cu unealta „Ieșire”.', 6000); return; }
  const P = S.sim.params;
  const st = S.lastStats;
  S.evac = {
    n0: S.inside, out0: st ? st[0] : 0, removed0: st ? st[64] : 0,
    samples: [[0, S.inside]], marks: {}, prev: [0, 0], lastChange: 0, end: null, kind: null,
    type, reactMax: type === 'egress' ? EGRESS_SPREAD : S.settings.reactMax,
  };
  P.mode = 1; P.evacTime = 0; P.guided = S.settings.guided; P.reactMax = S.evac.reactMax;
  S.sim.resetRisk();
  S.dens.expo = 0; S.dens.maxEver = 0;
  S.phase = 'evac'; S.running = true;
  $('evac').disabled = true; $('egress').disabled = true;
  updateHero(); updatePlay();
}

async function finish(kind, left) {
  const E = S.evac;
  if (!E || E.kind) return;
  E.kind = kind; E.left = left;
  E.end = kind === 'complete' && E.marks[100] != null ? E.marks[100] : S.sim.params.evacTime;
  S.phase = 'done';
  const d = await S.sim.readDensity();
  if (d) onDensity(d);
  const width = S.an.exits.reduce((s, e) => s + e.width, 0);
  S.runs.push({
    type: E.type, n: E.n0, width, guided: S.settings.guided, t95: E.marks[95], t100: kind === 'complete' ? E.end : null,
    left, expo: S.dens.expo, maxD: S.dens.maxEver,
  });
  renderRuns(); updateHero(); updateGuide(); drawChart();
}

// ------------------------------------------------------------------ counters

let pollN = 0;
async function poll() {
  const sim = S.sim;
  if (!sim || S.phase === 'loading') return;
  const tE = sim.params.evacTime, tS = sim.params.time, phase = S.phase;
  const stats = await sim.readStats();
  if (!stats || S.phase !== phase) return;
  onStats(stats, tE, tS);
  if (pollN++ % 2 === 0) { const d = await sim.readDensity(); if (d && S.phase !== 'loading') onDensity(d); }
}

function onStats(stats, tE, tS) {
  S.lastStats = stats;
  const out = stats[0], removed = stats[64];
  S.inside = S.placed - out - removed;

  // flow per exit, smoothed over a few seconds of simulated time
  for (const e of S.an.exits) {
    const r = S.exitRate.get(e.id) || { t: tS, n: stats[e.id], rate: 0 };
    if (tS - r.t >= 3) {
      const inst = (stats[e.id] - r.n) / (tS - r.t) * 60;
      r.rate = r.rate ? r.rate * 0.5 + inst * 0.5 : inst;
      r.t = tS; r.n = stats[e.id];
    }
    S.exitRate.set(e.id, r);
  }

  if (S.phase === 'evac') {
    const E = S.evac;
    const o = out - E.out0, target = E.n0 - (removed - E.removed0), left = target - o;
    const [tp, op] = E.prev;
    for (const p of [50, 90, 95, 100]) {
      const need = Math.ceil(target * p / 100);
      if (E.marks[p] == null && o >= need && target > 0) E.marks[p] = o === op ? tE : tp + (tE - tp) * (need - op) / (o - op);
    }
    if (o !== op) E.lastChange = tE;
    E.prev = [tE, o];
    const last = E.samples[E.samples.length - 1];
    if (tE - last[0] >= 1 || left <= 0) E.samples.push([tE, Math.max(0, left)]);
    if (left <= 0) finish('complete', 0);
    else if (tE - E.lastChange > 60 && tE > E.reactMax + 60) finish('blocked', left);
  } else if (S.phase === 'concert' && S.autoEvac && tS >= S.autoEvac) { S.autoEvac = 0; startEvac(S.autoType); }
  updateHero(); renderExits(false); drawChart();
}

function onDensity(d) {
  let maxNow = 0, maxEver = 0, crit = 0, expo = 0;
  for (let c = 0; c < CELLS; c++) {
    const x = d[c * 4];
    if (x > maxNow) maxNow = x;
    if (d[c * 4 + 1] > maxEver) maxEver = d[c * 4 + 1];
    if (x >= 5) crit += x;
    expo += d[c * 4 + 3];
  }
  S.dens = { maxNow, maxEver, crit, expo: expo / 60 };
  if (S.phase === 'evac' && !dynBusy) {
    dynBusy = true;
    worker.postMessage({ type: 'dynamic', W, H, types: S.types, dens: d, rhoJam: RHO_JAM, version: S.version });
  }
  const st = maxNow >= 5 ? '<span class="st crit" title="pericol">●</span>' : maxNow >= 4 ? '<span class="st warn" title="atenție">▲</span>' : '';
  $('tMax').innerHTML = f1.format(maxNow) + st;
  $('tCrit').textContent = nf.format(Math.round(crit));
  $('tExpo').textContent = nf.format(Math.round(S.dens.expo));
}

// ------------------------------------------------------------------ panel

function updateHero() {
  const E = S.evac, P = S.sim.params;
  const prog = $('progress');
  if (S.phase === 'loading') { $('phase').textContent = 'Se încarcă'; $('hero').textContent = '–'; $('heroSub').textContent = ' '; prog.hidden = true; return; }
  if (S.phase === 'concert') {
    $('phase').textContent = S.running ? 'Concert' : 'Concert, pe pauză';
    $('hero').textContent = nf.format(S.inside);
    $('heroSub').textContent = 'de oameni în incintă';
    prog.hidden = true;
    return;
  }
  const o = E.n0 - Math.max(0, E.samples[E.samples.length - 1][1]);
  prog.hidden = false;
  prog.firstElementChild.style.width = (E.n0 ? Math.min(100, o / E.n0 * 100) : 0) + '%';
  if (S.phase === 'evac') {
    const what = E.type === 'egress' ? 'Ieșire' : 'Evacuare';
    $('phase').textContent = S.running ? what : what + ', pe pauză';
    $('hero').textContent = mmss(P.evacTime);
    $('heroSub').textContent = `au ieșit ${nf.format(o)} din ${nf.format(E.n0)} (${Math.floor(o / E.n0 * 100)}%)`;
  } else {
    $('phase').textContent = E.type === 'egress' ? 'Ieșire încheiată' : 'Evacuare încheiată';
    $('hero').textContent = mmss(E.end);
    $('heroSub').textContent = E.kind === 'complete' ? `toți cei ${nf.format(E.n0)} de oameni au ieșit`
      : `${nf.format(E.left)} oameni nu au ajuns la nicio ieșire`;
  }
  const cells = $('marks').tBodies[0].rows[0].cells;
  [50, 90, 95, 100].forEach((p, i) => { cells[i + 1].textContent = E.marks[p] != null ? mmss(E.marks[p]) : '–'; });
}

function guideTime(n) {
  const width = S.an.exits.reduce((s, e) => s + e.width, 0);
  return { width, t: width ? n / (width * GUIDE) * 60 : Infinity };
}

function updateGuide() {
  const n = S.evac ? S.evac.n0 : S.placed;
  const g = guideTime(n);
  let text;
  if (!g.width) text = 'Planul nu are nicio ieșire.';
  else {
    text = `Calculul din ghid dă ${mmss(g.t)} pentru ${nf.format(n)} de oameni și ${g.width} m de ieșiri.`;
    if (S.evac && S.evac.kind === 'complete') text += ` Simularea a dat ${mmss(S.evac.end)}, fiindcă ține cont de drumul până la poartă și de cozile inegale.`;
    if (S.evac && S.evac.type === 'egress') text += ` La ieșirea obișnuită oamenii nu pleacă toți deodată: pornesc treptat, în primele ${EGRESS_SPREAD / 60} minute.`;
    else text += ' El presupune că toate porțile lucrează la capacitate din prima secundă. Apasă „Evacuare” sau „Ieșire” ca să vezi cât durează în simulare.';
  }
  $('guideNote').textContent = text;
  if (!S.evac) $('marks').tBodies[0].rows[0].querySelectorAll('td').forEach((td) => { td.textContent = '–'; });
}

function renderExits(rebuild) {
  const body = $('exits').tBodies[0];
  if (rebuild) {
    body.textContent = '';
    S.exitRows = new Map();
    if (!S.an.exits.length) {
      const td = body.insertRow().insertCell(); td.colSpan = 5; td.className = 'empty'; td.textContent = 'Nicio ieșire desenată.';
    }
    for (const e of S.an.exits) {
      const tr = body.insertRow();
      const c = [0, 1, 2, 3, 4].map(() => tr.insertCell());
      c[0].textContent = e.id; c[1].textContent = e.width + ' m';
      c[4].className = 'flow';
      const wrap = document.createElement('div'); wrap.className = 'fm';
      const meter = document.createElement('div'); meter.className = 'meter';
      const fill = document.createElement('i'); meter.append(fill);
      const pct = document.createElement('span');
      wrap.append(meter, pct); c[4].append(wrap);
      S.exitRows.set(e.id, { n: c[2], now: c[3], fill, pct });
    }
  }
  const st = S.lastStats;
  for (const e of S.an.exits) {
    const row = S.exitRows.get(e.id); if (!row) continue;
    const base = S.evac ? 0 : 0;
    const n = st ? st[e.id] - base : 0;
    const rate = S.phase === 'evac' ? (S.exitRate.get(e.id) || { rate: 0 }).rate : 0;
    const share = rate / (e.width * GUIDE);
    row.n.textContent = nf.format(n);
    row.now.textContent = S.phase === 'evac' ? nf.format(Math.round(rate)) + '/min' : '–';
    row.fill.style.width = Math.min(100, share * 100) + '%';
    row.pct.textContent = S.phase === 'evac' ? Math.round(share * 100) + '%' : '–';
  }
}

function renderRuns() {
  const body = $('runs').tBodies[0];
  body.textContent = '';
  S.runs.forEach((r, i) => {
    const tr = body.insertRow();
    const prev = S.runs[i - 1];
    let total = r.t100 != null ? mmss(r.t100) : `${nf.format(r.left)} blocați`;
    if (prev && prev.t100 != null && r.t100 != null) {
      const d = r.t100 - prev.t100;
      total += ` (${d <= 0 ? '−' : '+'}${mmss(Math.abs(d))})`;
    }
    [`${i + 1} ${r.type === 'egress' ? 'ieșire' : 'evac.'}`, nf.format(r.n), r.width + ' m', r.t95 != null ? mmss(r.t95) : '–', total, nf.format(Math.round(r.expo))]
      .forEach((v) => { tr.insertCell().textContent = v; });
  });
}

// ------------------------------------------------------------------ chart: people left over time

const chart = { hover: null };
function drawChart() {
  const cv = $('chart'), box = $('chartBox');
  const w = box.clientWidth, h = box.clientHeight;
  if (!w || !h) return;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const E = S.evac;
  const n0 = E ? E.n0 : S.placed;
  const guide = guideTime(n0).t;
  const tNow = E ? (E.end != null ? E.end : S.sim.params.evacTime) : 0;
  const tMax = Math.max(120, tNow * 1.08, isFinite(guide) ? guide * 1.25 : 0);
  const m = { l: 40, r: 14, t: 16, b: 22 };
  const X = (t) => m.l + (t / tMax) * (w - m.l - m.r);
  const Y = (v) => h - m.b - (v / (n0 || 1)) * (h - m.t - m.b);
  chart.geom = { m, w, h, tMax, n0 };

  g.font = '11px system-ui, sans-serif'; g.lineWidth = 1;
  g.textBaseline = 'middle'; g.textAlign = 'right';
  for (let i = 0; i <= 2; i++) {
    const v = n0 * i / 2, y = Math.round(Y(v)) + 0.5;
    g.strokeStyle = i === 0 ? '#383835' : '#2c2c2a';
    g.beginPath(); g.moveTo(m.l, y); g.lineTo(w - m.r, y); g.stroke();
    g.fillStyle = '#898781'; g.fillText(compact.format(v), m.l - 6, y);
  }
  g.textAlign = 'center'; g.textBaseline = 'top';
  const stepMin = tMax > 1500 ? 10 : tMax > 600 ? 5 : tMax > 240 ? 2 : 1;
  for (let t = 0; t <= tMax; t += stepMin * 60) g.fillText(t === 0 ? '0' : (t / 60) + ' min', X(t), h - m.b + 6);

  if (isFinite(guide)) {
    const x = Math.round(X(guide)) + 0.5;
    g.strokeStyle = '#898781'; g.beginPath(); g.moveTo(x, m.t); g.lineTo(x, h - m.b); g.stroke();
    g.fillStyle = '#c3c2b7'; g.textAlign = x > w - 70 ? 'right' : 'left'; g.textBaseline = 'top';
    g.fillText('ghid ' + mmss(guide), x + (x > w - 70 ? -5 : 5), m.t - 14 < 0 ? 2 : m.t - 14);
  }
  if (!E) return;
  const pts = E.samples;
  g.beginPath();
  pts.forEach(([t, v], i) => { if (i) g.lineTo(X(t), Y(v)); else g.moveTo(X(t), Y(v)); });
  const lastP = pts[pts.length - 1];
  g.lineJoin = 'round'; g.lineCap = 'round'; g.strokeStyle = '#3987e5'; g.lineWidth = 2; g.stroke();
  g.lineTo(X(lastP[0]), Y(0)); g.lineTo(X(0), Y(0)); g.closePath();
  g.fillStyle = 'rgba(57,135,229,0.10)'; g.fill();
  const ex = X(lastP[0]), ey = Y(lastP[1]);
  g.beginPath(); g.arc(ex, ey, 6, 0, 6.2832); g.fillStyle = '#1a1a19'; g.fill();
  g.beginPath(); g.arc(ex, ey, 4, 0, 6.2832); g.fillStyle = '#3987e5'; g.fill();
  if (lastP[1] > 0) {
    g.fillStyle = '#f0efec'; g.textBaseline = 'bottom'; g.textAlign = ex > w - 80 ? 'right' : 'left';
    g.fillText(nf.format(lastP[1]), ex + (ex > w - 80 ? -8 : 8), ey - 4);
  }
  if (chart.hover != null) {
    const t = Math.max(0, Math.min(lastP[0], (chart.hover - m.l) / (w - m.l - m.r) * tMax));
    let i = 0; while (i < pts.length - 1 && pts[i + 1][0] <= t) i++;
    const hx = Math.round(X(pts[i][0])) + 0.5;
    g.strokeStyle = '#c3c2b7'; g.lineWidth = 1; g.beginPath(); g.moveTo(hx, m.t); g.lineTo(hx, h - m.b); g.stroke();
    const tip = $('tip');
    tip.hidden = false; tip.textContent = '';
    const b = document.createElement('b'); b.textContent = nf.format(pts[i][1]) + ' rămași';
    const sp = document.createElement('span'); sp.textContent = ' · la ' + mmss(pts[i][0]);
    tip.append(b, sp);
    tip.style.left = Math.min(w - tip.offsetWidth - 2, Math.max(0, hx + 8)) + 'px';
    tip.style.top = '0px';
  } else $('tip').hidden = true;
}

// ------------------------------------------------------------------ view, overlay, editing

// The camera eases toward a target, so zooming, throwing the map and flying to a person feel smooth.
const V = {
  target: { cx: W / 2, cy: H / 2, scale: 4 }, anchor: null, ease: 10, fit: 0,
  clock: 0, follow: -1, followAt: null, followBusy: false, pickBusy: false, followResets: 0, cardT: 0,
  rs: 1, ft: 1 / 60, rsT: 0, pending: [],   // render scale (adaptive resolution), frame time, submit times of frames the GPU has not finished
};
const smooth01 = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function resize() {
  const view = $('view');
  const w = Math.max(2, Math.round(view.clientWidth * dpr)), h = Math.max(2, Math.round(view.clientHeight * dpr));
  S.renderer.resize(Math.max(2, Math.round(w * V.rs)), Math.max(2, Math.round(h * V.rs)));
  const ov = $('overlay');
  if (ov.width !== w || ov.height !== h) { ov.width = w; ov.height = h; }
  const fit = Math.min(w / W, h / H) * 0.97;
  if (!S.fitted && w > 2) {
    // open a little zoomed out and glide in
    V.target = { cx: W / 2, cy: H / 2, scale: fit };
    S.cam.cx = W / 2; S.cam.cy = H / 2; S.cam.scale = fit * 0.6; V.ease = 3;
    S.fitted = true;
  } else if (V.fit && fit !== V.fit && Math.abs(V.target.scale - V.fit) < 1e-6) V.target.scale = fit;   // keep fitting the window
  V.fit = fit;
}

function scaleLimits() {
  const ov = $('overlay');
  return [Math.min(ov.width / W, ov.height / H) * 0.6, 140 * dpr];
}

function updateCamera(dt) {
  const c = S.cam, t = V.target, ov = $('overlay');
  if (V.follow >= 0 && V.followAt) { t.cx = V.followAt[0]; t.cy = V.followAt[1]; V.anchor = null; }
  const k = 1 - Math.exp(-dt * V.ease);
  const lt = Math.log(t.scale);
  c.scale = Math.exp(Math.log(c.scale) + (lt - Math.log(c.scale)) * k);
  if (V.anchor) {
    // zooming: the point under the cursor stays under the cursor the whole way
    const a = V.anchor;
    c.cx = a.wx - (a.px - ov.width / 2) / c.scale; c.cy = a.wy - (a.py - ov.height / 2) / c.scale;
    if (Math.abs(lt - Math.log(c.scale)) < 1e-3) V.anchor = null;
  } else { c.cx += (t.cx - c.cx) * k; c.cy += (t.cy - c.cy) * k; }
  if (V.ease !== 10 && Math.abs(lt - Math.log(c.scale)) < 3e-3 && (V.follow >= 0 || Math.hypot(t.cx - c.cx, t.cy - c.cy) * c.scale < 1)) V.ease = 10;
}

function camFor() {
  const risk = S.settings.layer === 1;
  return { cx: S.cam.cx, cy: S.cam.cy, scale: S.cam.scale * V.rs, layer: S.settings.layer, colorMode: S.settings.colorMode,
    minPx: 1.15 * dpr * V.rs, agentAlpha: risk ? 0.22 : 1, heatGain: risk ? 1 : 0.6,
    interp: acc, clock: V.clock, detail: smooth01(16, 30, S.cam.scale / dpr), follow: V.follow + 1, mode: S.sim.params.mode };
}

// Adaptive resolution: below ~40 frames/s the map is drawn with fewer pixels (down to half in each
// direction) and the browser scales it up; with headroom it climbs back to full resolution.
function adaptResolution(now, dt) {
  V.ft += (dt - V.ft) * 0.1;
  if (now - V.rsT < 600) return;
  let rs = V.rs;
  if (V.ft > 1 / 40 && rs > 0.5) rs = Math.max(0.5, rs - 0.1);
  else if (V.ft < 1 / 56 && rs < 1) rs = Math.min(1, rs + 0.05);
  if (rs !== V.rs) { V.rs = rs; V.rsT = now; }
  // laptops with two GPUs often give the browser the weaker, integrated one
  if (rs <= 0.8 && !V.hinted && S.sim.backend === 'gpu' && /intel|amd radeon\(tm\) graphics/i.test(S.sim.adapterName || '')) {
    V.hinted = true;
    showMsg('Simularea rulează pe placa video integrată. Dacă laptopul are și una dedicată, setează Chrome pe „Performanță ridicată” în Setări Windows → Sistem → Afișaj → Grafică și repornește browserul.', 12000);
  }
}

// ------------------------------------------------------------------ following one person

const DOING = ['se uită la concert', 'merge la bar', 'merge la toalete', 'iese pe cea mai apropiată ieșire',
  'iese pe ieșirea cea mai liberă (știe care porți sunt libere)', 'stă la coadă la bar', 'stă la coadă la toalete'];

async function pickAt(wx, wy) {
  if (V.pickBusy || !S.sim.n) return;
  V.pickBusy = true;
  try {
    const buf = await S.sim.readAgents();
    const f = new Float32Array(buf), u = new Uint32Array(buf), n = Math.floor(f.length / STRIDE);
    let best = -1, bd = Math.max(0.6, 10 * dpr / S.cam.scale) ** 2;
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE;
      if (u[o + A_GOAL] === G_GONE) continue;
      const dx = f[o + A_X] - wx, dy = f[o + A_Y] - wy, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0) startFollow(best, f[best * STRIDE + A_X], f[best * STRIDE + A_Y]);
    else if (V.follow >= 0) stopFollow();
  } catch (e) { console.error('pick: ' + e.message); }
  finally { V.pickBusy = false; }
}

function startFollow(i, x, y) {
  V.follow = i; V.followAt = [x, y]; V.followResets = S.resets; V.anchor = null;
  V.target.scale = Math.max(V.target.scale, 55 * dpr); V.ease = 3;
  $('fId').textContent = nf.format(i + 1);
  $('follow').hidden = false;
}
function stopFollow(text) {
  V.follow = -1; V.followAt = null;
  $('follow').hidden = true;
  if (text) showMsg(text, 4000);
}

function updateFollow(now) {
  if (V.follow < 0) return;
  if (V.followResets !== S.resets || V.follow >= S.sim.n) { stopFollow(); return; }
  if (V.followBusy) return;
  V.followBusy = true;
  S.renderer.readAgent(V.follow).then((buf) => {
    V.followBusy = false;
    if (!buf || V.follow < 0) return;
    const f = new Float32Array(buf), u = new Uint32Array(buf), g = u[A_GOAL];
    if (g === G_GONE) { stopFollow('Omul pe care îl urmăreai a ieșit din incintă.'); return; }
    V.followAt = [f[A_X], f[A_Y]];
    if (now - V.cardT < 200) return;
    V.cardT = now;
    const sp = Math.hypot(f[A_VX], f[A_VY]);
    $('fWhat').textContent = g === 0 && sp > 0.3 ? 'își face loc spre scenă' : (DOING[g] || '');
    $('fSpeed').textContent = f1.format(sp) + ' m/s';
    $('fDens').textContent = f1.format(f[A_DENS]) + ' pers./m² în jur';
  }, () => { V.followBusy = false; });
}

// Flies into the thickest part of the crowd, at real-time speed, to watch people up close.
async function closeUp() {
  stopFollow();
  let x = W / 2, y = H / 3;
  try {
    const d = await S.sim.readDensity();
    if (d) { let best = -1; for (let c = 0; c < CELLS; c++) if (d[c * 4] > best) { best = d[c * 4]; x = c % W + 0.5; y = Math.floor(c / W) + 0.5; } }
  } catch { /* keep the default spot */ }
  V.anchor = null; V.ease = 2.5;
  V.target = { cx: x, cy: y, scale: 60 * dpr };
  if (S.speed !== 1) { setSpeed(1); showMsg('Viteza e acum 1×, ca să vezi mersul în timp real.', 3500); }
}

// Moves the camera to (cx, cy) in metres at `scale` CSS pixels per metre (also handy from the console).
function flyTo(cx, cy, scale) {
  stopFollow();
  V.anchor = null; V.ease = 3;
  V.target = { cx, cy, scale: scale * dpr };
}

function fitView() {
  stopFollow();
  V.anchor = null; V.ease = 5;
  V.target = { cx: W / 2, cy: H / 2, scale: V.fit };
}

const toScreen = (x, y) => [($('overlay').width / 2) + (x - S.cam.cx) * S.cam.scale, ($('overlay').height / 2) + (y - S.cam.cy) * S.cam.scale];
function toWorld(e) {
  const ov = $('overlay'), r = ov.getBoundingClientRect();
  const px = (e.clientX - r.left) * (ov.width / r.width), py = (e.clientY - r.top) * (ov.height / r.height);
  return [(px - ov.width / 2) / S.cam.scale + S.cam.cx, (py - ov.height / 2) / S.cam.scale + S.cam.cy, px, py];
}

function drawOverlay() {
  const ov = $('overlay'), g = ov.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, ov.width, ov.height);
  const sc = S.cam.scale;
  g.textAlign = 'center'; g.textBaseline = 'middle';

  g.font = `600 ${11 * dpr}px system-ui, sans-serif`;
  for (const l of S.labels) {
    const tw = g.measureText(l.text).width;
    if (tw + 6 * dpr > l.w * sc || 13 * dpr > l.h * sc) continue;
    const [x, y] = toScreen(l.cx, l.cy);
    g.lineWidth = 3 * dpr; g.strokeStyle = 'rgba(10,10,10,0.75)'; g.strokeText(l.text, x, y);
    g.fillStyle = '#f0efec'; g.fillText(l.text, x, y);
  }
  // numbered badge next to every exit, pulled a little inside the map
  g.font = `600 ${11 * dpr}px system-ui, sans-serif`;
  for (const e of S.an ? S.an.exits : []) {
    let bx = e.cx, by = e.cy;
    const off = 9 * dpr / sc + 1.5;
    if (e.x0 === 0) bx += off; else if (e.x1 === W - 1) bx -= off;
    else if (e.y0 === 0) by += off; else if (e.y1 === H - 1) by -= off; else by -= off;
    const [x, y] = toScreen(bx, by), r = 8.5 * dpr;
    g.beginPath(); g.arc(x, y, r, 0, 6.2832);
    g.fillStyle = '#1a1a19'; g.fill(); g.lineWidth = 1.5 * dpr; g.strokeStyle = '#0ca30c'; g.stroke();
    g.fillStyle = '#f0efec'; g.fillText(String(e.id), x, y + 0.5 * dpr);
  }
  // brush outline
  if (S.hover && S.tool !== 'pan') {
    const b = S.brush, x0 = Math.floor(S.hover[0] - (b - 1) / 2), y0 = Math.floor(S.hover[1] - (b - 1) / 2);
    const [sx, sy] = toScreen(x0, y0);
    g.strokeStyle = '#f0efec'; g.lineWidth = 1 * dpr; g.strokeRect(sx + 0.5, sy + 0.5, b * sc, b * sc);
  }
  // scale bar
  const metres = [1, 2, 5, 10, 20, 50, 100].find((v) => v * sc >= 70 * dpr) || 100;
  const x = 16 * dpr, y = ov.height - 16 * dpr;
  g.strokeStyle = '#c3c2b7'; g.lineWidth = 1.5 * dpr;
  g.beginPath(); g.moveTo(x, y - 4 * dpr); g.lineTo(x, y); g.lineTo(x + metres * sc, y); g.lineTo(x + metres * sc, y - 4 * dpr); g.stroke();
  g.fillStyle = '#c3c2b7'; g.font = `${11 * dpr}px system-ui, sans-serif`; g.textAlign = 'left'; g.textBaseline = 'bottom';
  g.fillText(metres + ' m', x + 4 * dpr, y - 4 * dpr);
}

function pushUndo() { S.undo.push(S.types.slice()); if (S.undo.length > 40) S.undo.shift(); }
function undo() { const t = S.undo.pop(); if (t) { S.types = t; gridChanged(); } }

function stamp(wx, wy, type) {
  const b = S.brush, x0 = Math.floor(wx - (b - 1) / 2), y0 = Math.floor(wy - (b - 1) / 2);
  let changed = false;
  for (let y = y0; y < y0 + b; y++) for (let x = x0; x < x0 + b; x++) {
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1;
    const t = edge && type === T_FREE ? T_WALL : type;      // the outer fence can become an exit, never a hole
    if (S.types[y * W + x] !== t) { S.types[y * W + x] = t; changed = true; }
  }
  return changed;
}
function paintLine(a, b, type) {
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(d * 2));
  let changed = false;
  for (let i = 0; i <= n; i++) changed = stamp(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n, type) || changed;
  if (changed) gridChanged();
}

function setupPointer() {
  const ov = $('overlay');
  const ptrs = new Map();
  let mode = null, lastW = null, lastS = null, pinch = 0, down = null, vel = [0, 0], lastMove = 0;
  ov.addEventListener('contextmenu', (e) => e.preventDefault());
  ov.addEventListener('pointerdown', (e) => {
    ov.setPointerCapture(e.pointerId);
    const w = toWorld(e);
    ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    if (ptrs.size === 2) { mode = 'pinch'; down = null; const p = [...ptrs.values()]; pinch = Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]); return; }
    const tool = TOOLS.find((t) => t.id === S.tool);
    if (S.tool === 'pan' || e.button === 1 || e.button === 2 || e.altKey) {
      mode = 'pan'; lastS = [e.clientX, e.clientY]; vel = [0, 0]; lastMove = performance.now();
      down = { x: e.clientX, y: e.clientY, w, click: S.tool === 'pan' && e.button === 0 && !e.altKey };
      V.anchor = null;
      ov.classList.add('grabbing');
    } else { mode = 'paint'; pushUndo(); lastW = w; paintLine(w, w, tool.type); }
  });
  ov.addEventListener('pointermove', (e) => {
    const w = toWorld(e);
    S.hover = w;
    if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    if (mode === 'pinch' && ptrs.size === 2) {
      const p = [...ptrs.values()], d = Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]);
      if (pinch > 0) zoomAt(ov.width / 2, ov.height / 2, d / pinch);
      pinch = d;
    } else if (mode === 'pan') {
      if (down && down.click && Math.hypot(e.clientX - down.x, e.clientY - down.y) <= 4) return;   // still a click
      if (down) down.click = false;
      if (V.follow >= 0) stopFollow();
      const r = ov.getBoundingClientRect(), k = ov.width / r.width;
      const dx = (e.clientX - lastS[0]) * k / S.cam.scale, dy = (e.clientY - lastS[1]) * k / S.cam.scale;
      S.cam.cx -= dx; S.cam.cy -= dy; V.target.cx = S.cam.cx; V.target.cy = S.cam.cy;
      const now = performance.now(), sec = Math.max(1, now - lastMove) / 1000;
      vel = [vel[0] * 0.4 - 0.6 * dx / sec, vel[1] * 0.4 - 0.6 * dy / sec];
      lastMove = now; lastS = [e.clientX, e.clientY];
    } else if (mode === 'paint') {
      paintLine(lastW, w, TOOLS.find((t) => t.id === S.tool).type);
      lastW = w;
    }
  });
  const up = (e) => {
    if (mode === 'pan' && e.type === 'pointerup') {
      if (down && down.click) pickAt(down.w[0], down.w[1]);
      else if (performance.now() - lastMove < 80) {
        // thrown: the map glides on with the speed of the drag and slows down
        V.ease = 4;
        V.target.cx = Math.min(W, Math.max(0, V.target.cx + vel[0] / 4));
        V.target.cy = Math.min(H, Math.max(0, V.target.cy + vel[1] / 4));
      }
    }
    down = null;
    ov.classList.remove('grabbing');
    ptrs.delete(e.pointerId); if (ptrs.size === 0) mode = null; else if (mode === 'pinch') mode = null;
  };
  ov.addEventListener('pointerup', up);
  ov.addEventListener('pointercancel', up);
  ov.addEventListener('pointerleave', () => { S.hover = null; });
  ov.addEventListener('wheel', (e) => {
    e.preventDefault();
    const w = toWorld(e);
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    zoomAt(w[2], w[3], Math.exp(-dy * 0.0015));
  }, { passive: false });

  // zoom buttons over the map, the follow card, and their keys
  const centre = () => [ov.width / 2, ov.height / 2];
  $('zIn').onclick = () => zoomAt(...centre(), 1.8);
  $('zOut').onclick = () => zoomAt(...centre(), 1 / 1.8);
  $('zFit').onclick = fitView;
  $('zClose').onclick = closeUp;
  $('fStop').onclick = () => stopFollow();
  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') stopFollow();
    else if (e.key === '+' || e.key === '=') zoomAt(...centre(), 1.8);
    else if (e.key === '-' || e.key === '_') zoomAt(...centre(), 1 / 1.8);
    else if (e.key === '0') fitView();
    else if (e.key.toLowerCase() === 'c') closeUp();
  });
}

function zoomAt(px, py, factor) {
  const ov = $('overlay');
  const [min, max] = scaleLimits();
  const ts = Math.min(max, Math.max(min, V.target.scale * factor));
  if (V.follow >= 0) { V.target.scale = ts; return; }          // following someone: zoom around them
  // the zoom eases in; the world point under the cursor stays put meanwhile (see updateCamera)
  const wx = (px - ov.width / 2) / S.cam.scale + S.cam.cx, wy = (py - ov.height / 2) / S.cam.scale + S.cam.cy;
  V.anchor = { wx, wy, px, py };
  V.target.scale = ts;
  V.target.cx = wx - (px - ov.width / 2) / ts; V.target.cy = wy - (py - ov.height / 2) / ts;
  if (V.ease < 8) V.ease = 8;
}

// ------------------------------------------------------------------ controls

function setTool(id) {
  S.tool = id;
  for (const b of $('toolbox').children) { const on = b.dataset.id === id; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); }
  $('overlay').classList.toggle('pan', id === 'pan');
}
function setSpeed(v) {
  S.speed = v;
  for (const b of $('speed').children) b.classList.toggle('on', Number(b.dataset.v) === v);
}
function updatePlay() { $('play').textContent = S.running ? 'Pauză' : 'Pornește'; }

let msgTimer = 0;
function showMsg(text, ms) {
  const el = $('msg');
  el.textContent = text; el.hidden = false;
  clearTimeout(msgTimer);
  if (ms) msgTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function buildUi(fromLink) {
  const box = $('toolbox');
  for (const t of TOOLS) {
    const b = document.createElement('button');
    b.className = 'tool'; b.dataset.id = t.id; b.setAttribute('role', 'radio');
    const sw = document.createElement('i'); sw.style.background = t.color;
    const kb = document.createElement('kbd'); kb.textContent = t.key;
    b.append(sw, document.createTextNode(t.name), kb);
    b.onclick = () => setTool(t.id);
    box.append(b);
  }
  setTool('pan'); setSpeed(S.speed);

  const lay = $('layout');
  if (fromLink) lay.add(new Option('Planul din link', 'link', true, true));
  LAYOUTS.forEach((l) => lay.add(new Option(l.name, l.id, false, !fromLink && l.id === S.layoutId)));
  lay.onchange = () => setLayout(lay.value);
  $('people').onchange = () => { S.N = Number($('people').value); reset(); };
  $('play').onclick = () => { S.running = !S.running; updatePlay(); updateHero(); };
  $('speed').onclick = (e) => { if (e.target.dataset.v) setSpeed(Number(e.target.dataset.v)); };
  $('evac').onclick = () => startEvac('evac');
  $('egress').onclick = () => startEvac('egress');
  $('reset').onclick = reset;
  $('undo').onclick = undo;
  $('brush').oninput = () => { S.brush = Number($('brush').value); $('brushOut').textContent = S.brush + ' m'; };
  $('share').onclick = async () => {
    const url = location.origin + location.pathname + '#p=' + encodeLayout(S.types) + '&n=' + S.N + '&w=' + W + '&h=' + H;
    history.replaceState(null, '', url);
    try { await navigator.clipboard.writeText(url); showMsg('Linkul planului e în clipboard.', 4000); }
    catch { showMsg('Linkul planului e acum în bara de adrese.', 5000); }
  };
  $('guided').value = Math.round(S.settings.guided * 100); $('guidedOut').textContent = Math.round(S.settings.guided * 100) + '%';
  $('guided').oninput = () => { S.settings.guided = Number($('guided').value) / 100; $('guidedOut').textContent = $('guided').value + '%'; S.sim.params.guided = S.settings.guided; };
  $('react').oninput = () => { S.settings.reactMax = Number($('react').value); $('reactOut').textContent = $('react').value + ' s'; if (!S.evac || S.evac.type !== 'egress') S.sim.params.reactMax = S.settings.reactMax; };
  $('colorMode').onchange = () => { S.settings.colorMode = Number($('colorMode').value); };
  $('layer').onchange = () => { S.settings.layer = Number($('layer').value); };

  const cb = $('chartBox');
  cb.addEventListener('pointermove', (e) => { chart.hover = e.clientX - cb.getBoundingClientRect().left; if (S.evac) drawChart(); });
  cb.addEventListener('pointerleave', () => { chart.hover = null; drawChart(); });
  window.addEventListener('resize', () => { drawChart(); });

  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = TOOLS.find((x) => x.key === e.key);
    if (t) setTool(t.id);
    else if (e.key === ' ') { e.preventDefault(); $('play').click(); }
    else if (e.key.toLowerCase() === 'e') startEvac('evac');
    else if (e.key.toLowerCase() === 'i') startEvac('egress');
    else if (e.key.toLowerCase() === 'r') reset();
  });
  setupPointer();
  updatePlay();
}

// ------------------------------------------------------------------ frame loop

let lastT = performance.now(), acc = 0, perfT = lastT, frames = 0, steps = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
  resize();
  const sim = S.sim;
  // If the GPU is still busy with a frame sent more than 120 ms ago it has fallen behind: skip the
  // simulation steps this frame, so the simulation slows down instead of the page freezing.
  const gpuBusy = sim.backend === 'gpu' && V.pending.length > 0 && now - V.pending[0] > 120;
  if (S.running && (S.phase === 'concert' || S.phase === 'evac') && sim.n > 0 && !gpuBusy) {
    acc += dt * S.speed / DT;
    let k = Math.floor(acc); acc -= k;
    const cap = sim.backend === 'gpu' ? 24 : S.cpuCap;
    if (k > cap) { k = cap; acc = 0; }
    if (k > 0) {
      const t0 = performance.now();
      sim.step(k); steps += k;
      if (sim.backend === 'cpu') S.cpuCap = Math.max(1, Math.floor(14 / ((performance.now() - t0) / k)));
    }
  }
  if (S.running) V.clock += dt;
  updateFollow(now); updateCamera(dt);
  S.renderer.render(camFor());
  if (sim.backend === 'gpu') { V.pending.push(now); sim.flush().then(() => { V.pending.shift(); }); }
  drawOverlay();
  adaptResolution(now, dt);
  frames++;
  if (now - perfT >= 500) {
    const s = (now - perfT) / 1000;
    S.perf = { fps: frames / s, speed: steps * DT / s };
    const where = sim.backend === 'gpu' ? 'placa video' + (sim.adapterName ? ' ' + sim.adapterName : '') : 'procesor';
    const res = V.rs < 0.999 ? ` · rezoluție ${Math.round(V.rs * 100)}%` : '';
    $('perf').textContent = `${nf.format(sim.n)} agenți · ${Math.round(S.perf.fps)} cadre/s${res} · timp ×${f1.format(S.perf.speed)} · ${where}`;
    perfT = now; frames = 0; steps = 0;
  }
}

boot().catch((e) => { console.error(e); showMsg('Simulatorul nu a putut porni: ' + e.message); });
