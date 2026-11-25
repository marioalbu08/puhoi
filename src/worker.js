// Computes flow fields off the main thread, so painting the map never stalls the simulation.
import { analyzeGrid, computeStatic, computeDynamic } from './field.js';

let cache = null;        // exit catchments of the last plan, reused by every update during an evacuation

self.onmessage = (e) => {
  const m = e.data;
  const an = analyzeGrid(m.W, m.H, m.types);
  let out;
  if (m.type === 'static') {
    const labels = new Uint8Array(m.W * m.H);
    out = computeStatic(m.W, m.H, m.types, an, labels);
    cache = { version: m.version, cells: m.W * m.H, labels };
  } else {
    const labels = cache && cache.version === m.version && cache.cells === m.W * m.H ? cache.labels : undefined;
    out = computeDynamic(m.W, m.H, m.types, an, m.dens, m.rhoJam, labels);
  }
  self.postMessage({ type: m.type, version: m.version, out }, [out.buffer]);
};
