// Suna — keeps the beach between sessions (localStorage, 16-bit per value).

import { Sim } from './sim.js';

const KEY = 'suna.beach.v1';
const RANGE = { b: 40, w: 16, g: 40, l: 40 };

function encode(field, range) {
  const n = field.length;
  const bytes = new Uint8Array(n * 2);
  const k = 65535 / range;
  for (let i = 0; i < n; i++) {
    let v = (field[i] * k + 0.5) | 0;
    if (v < 0) v = 0; else if (v > 65535) v = 65535;
    bytes[i * 2] = v >> 8; bytes[i * 2 + 1] = v & 255;
  }
  let str = '';
  for (let i = 0; i < bytes.length; i += 0x6000) {
    str += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x6000));
  }
  return btoa(str);
}

function decode(text, field, range) {
  const str = atob(text);
  if (str.length !== field.length * 2) throw new Error('saved field has the wrong size');
  const k = range / 65535;
  for (let i = 0; i < field.length; i++) {
    field[i] = ((str.charCodeAt(i * 2) << 8) | str.charCodeAt(i * 2 + 1)) * k;
  }
}

export function save(sim, meta) {
  if (!sim) return false;
  try {
    const data = {
      W: sim.W, H: sim.H, tick: sim.tick, meta,
      springs: sim.springs.map((s) => ({ x: s.x, y: s.y, rate: s.rate, r: s.r })),
    };
    for (const f of Object.keys(RANGE)) data[f] = encode(sim[f], RANGE[f]);
    localStorage.setItem(KEY, JSON.stringify(data));
    return true;
  } catch (err) {
    console.warn('could not save the beach', err);
    return false;
  }
}

/**
 * Returns { sim, meta }, or null when nothing is saved or the saved beach has
 * a very different shape from the screen (width / height) it would be shown on.
 * A slightly different shape is fine: the view crops a little.
 */
export function load(screenAspect) {
  let raw;
  try { raw = localStorage.getItem(KEY); } catch { return null; }
  if (!raw) return null;
  const data = JSON.parse(raw);
  const W = data.W | 0, H = data.H | 0;
  if (W < 64 || W > 256 || H < 64 || H > 512) return null;
  if (screenAspect > 0 && Math.abs((W / H) / screenAspect - 1) > 0.12) return null;
  const sim = new Sim(W, H);
  for (const f of Object.keys(RANGE)) decode(data[f], sim[f], RANGE[f]);
  for (const s of data.springs || []) {
    sim.springs.push({ x: +s.x, y: +s.y, rate: +s.rate || 0, r: +s.r || 2.5 });
  }
  if (!sim.springs.length) return null;
  sim.tick = data.tick | 0;
  sim.rescan();
  return { sim, meta: data.meta || {} };
}

export function clearSave() {
  try { localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
}
